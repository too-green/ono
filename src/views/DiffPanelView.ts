import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type OpenCodePlugin from "../../main";
import { aggregateDiffFiles, diffFilesFromMessage, latestUserTurnId, messageId, type DiffFileSummary } from "../diff-utils";
import type { JsonObject, OpenCodeMessageBundle } from "../services/opencode-types";

export const VIEW_TYPE_OPENCODE_DIFF_PANEL = "opencode-diff-panel";

export interface DiffPanelContext {
  sessionId?: string;
  sessionTitle?: string;
  sessionDirectory?: string;
}

/** Renders session-level and latest-turn file diffs in Obsidian's right sidebar. */
export class DiffPanelView extends ItemView {
  private context: DiffPanelContext = {};
  private loading = false;
  private refreshSerial = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(leaf);
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_DIFF_PANEL;
  }

  /** Returns the tab title displayed in the right sidebar. */
  getDisplayText(): string {
    return "OpenCode diffs";
  }

  /** Returns the Lucide icon used by the diff panel tab. */
  getIcon(): string {
    return "git-compare";
  }

  /** Initializes panel DOM and adopts the plugin's current active-session context. */
  async onOpen(): Promise<void> {
    this.contentEl.addClass("opencode-diff-panel");
    this.context = this.plugin.getDiffPanelContext();
    await this.refresh();
  }

  /** Releases no external resources; required by Obsidian ItemView lifecycle. */
  async onClose(): Promise<void> {
    this.refreshSerial += 1;
  }

  /** Applies active session context from SessionView and reloads the displayed diff summaries. */
  async setContext(context: DiffPanelContext): Promise<void> {
    const changed = JSON.stringify(this.context) !== JSON.stringify(context);
    this.context = { ...context };
    if (changed || !this.loading) await this.refresh();
  }

  /** Reloads all message summaries for the active session and renders session/latest-turn diff lists. */
  async refresh(): Promise<void> {
    const serial = (this.refreshSerial += 1);
    if (!this.context.sessionId) {
      this.renderEmpty();
      return;
    }

    this.loading = true;
    if (!this.contentEl.hasChildNodes()) this.renderLoading();
    try {
      const service = this.plugin.requireOpenCodeService();
      const [session, messages] = await Promise.all([service.getSession(this.context.sessionId), service.listMessages(this.context.sessionId)]);
      if (serial !== this.refreshSerial) return;
      const sessionDirectory = this.context.sessionDirectory ?? this.readString(session, ["directory", "cwd"]);
      const chronological = [...messages].sort((a, b) => this.messageTime(a) - this.messageTime(b));
      const turnMessageId = latestUserTurnId(chronological);
      const sessionDiffs = aggregateDiffFiles(chronological.flatMap(diffFilesFromMessage));
      const turnDiffs = await this.loadTurnDiffs(chronological, turnMessageId);
      if (serial !== this.refreshSerial) return;
      this.renderDiffs({
        sessionTitle: this.context.sessionTitle ?? this.readString(session, ["title"]),
        sessionDirectory,
        turnMessageId,
        sessionDiffs,
        turnDiffs,
      });
    } catch (error) {
      if (serial === this.refreshSerial) this.renderError(error);
    } finally {
      if (serial === this.refreshSerial) this.loading = false;
    }
  }

  /** Renders the inactive-state copy shown before an OpenCode session tab is focused. */
  private renderEmpty(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-diff-panel__state" });
    state.createDiv({ text: "No OpenCode session selected.", cls: "opencode-diff-panel__state-title" });
    state.createDiv({ text: "Open an agent session to see session and turn diffs here.", cls: "opencode-diff-panel__state-text" });
  }

  /** Renders a lightweight loading state while message summaries are fetched. */
  private renderLoading(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-diff-panel__state" });
    state.createDiv({ cls: "opencode-diff-panel__spinner" });
    state.createDiv({ text: "Loading diffs…", cls: "opencode-diff-panel__state-text" });
  }

  /** Renders connection or payload errors for the active diff panel. */
  private renderError(error: unknown): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-diff-panel__state" });
    state.createDiv({ text: "Unable to load diffs.", cls: "opencode-diff-panel__state-title" });
    state.createDiv({ text: error instanceof Error ? error.message : "Unknown error", cls: "opencode-diff-panel__state-text" });
  }

  /** Renders the full session and latest-turn diff sections. */
  private renderDiffs(input: { sessionTitle?: string; sessionDirectory?: string; turnMessageId?: string; sessionDiffs: DiffFileSummary[]; turnDiffs: DiffFileSummary[] }): void {
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "opencode-diff-panel__header" });
    const titleWrap = header.createDiv({ cls: "opencode-diff-panel__title-wrap" });
    titleWrap.createDiv({ text: input.sessionTitle ?? this.context.sessionId ?? "Active session", cls: "opencode-diff-panel__title" });
    if (input.sessionDirectory) titleWrap.createDiv({ text: input.sessionDirectory, cls: "opencode-diff-panel__subtitle" });
    const refresh = header.createEl("button", { attr: { "aria-label": "Refresh OpenCode diffs" }, cls: "opencode-diff-panel__refresh clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    this.renderSection("Session changes", input.sessionDiffs, input.sessionDirectory, "No summarized file changes for this session yet.");
    this.renderSection("Latest turn changes", input.turnDiffs, input.sessionDirectory, input.turnMessageId ? "No file changes summarized for the latest turn." : "No user turn found.");
  }

  /** Renders one compact Outline-like diff section with file rows and addition/deletion columns. */
  private renderSection(title: string, diffs: DiffFileSummary[], sessionDirectory: string | undefined, emptyText: string): void {
    const section = this.contentEl.createDiv({ cls: "opencode-diff-panel__section" });
    const heading = section.createDiv({ cls: "opencode-diff-panel__section-heading" });
    heading.createSpan({ text: title });

    if (diffs.length === 0) {
      section.createDiv({ text: emptyText, cls: "opencode-diff-panel__empty" });
      return;
    }

    const list = section.createDiv({ cls: "opencode-diff-panel__list" });
    for (const diff of diffs) this.renderDiffRow(list, diff, sessionDirectory);
  }

  /** Renders one three-column diff file row: path/name, additions, and deletions. */
  private renderDiffRow(container: HTMLElement, diff: DiffFileSummary, sessionDirectory: string | undefined): void {
    const row = container.createDiv({ cls: "opencode-diff-panel__row", attr: { title: diff.file } });
    this.renderDisplayPath(row.createSpan({ cls: "opencode-diff-panel__path" }), diff.file, sessionDirectory);
    row.createSpan({ text: `+${diff.additions}`, cls: "opencode-diff-panel__stat opencode-diff-panel__stat--add" });
    row.createSpan({ text: `−${diff.deletions}`, cls: "opencode-diff-panel__stat opencode-diff-panel__stat--del" });
  }

  /** Renders a muted path prefix and normal basename according to the collapsed filesystem-tool visual policy. */
  private renderDisplayPath(container: HTMLElement, rawPath: string, sessionDirectory: string | undefined): void {
    const display = this.displayPath(rawPath, sessionDirectory);
    const split = this.splitPath(display);
    if (split.prefix) container.createSpan({ text: split.prefix, cls: "opencode-diff-panel__path-prefix" });
    container.createSpan({ text: split.basename, cls: "opencode-diff-panel__path-basename" });
  }

  /** Loads turn diffs from message summaries, falling back to the OpenCode message-diff endpoint. */
  private async loadTurnDiffs(messages: OpenCodeMessageBundle[], turnMessageId: string | undefined): Promise<DiffFileSummary[]> {
    if (!turnMessageId || !this.context.sessionId) return [];
    const message = messages.find((item) => messageId(item) === turnMessageId);
    const summaryDiffs = message ? diffFilesFromMessage(message) : [];
    if (summaryDiffs.length > 0) return summaryDiffs;
    const endpointDiffs = await this.plugin.requireOpenCodeService().getSessionDiff(this.context.sessionId, turnMessageId);
    return endpointDiffs.flatMap((item) => this.normalizeEndpointDiff(item));
  }

  /** Normalizes endpoint diff objects by reusing the message-summary extraction shape. */
  private normalizeEndpointDiff(diff: JsonObject): DiffFileSummary[] {
    return diffFilesFromMessage({ info: { summary: { diffs: [diff] } }, parts: [] });
  }

  /** Displays internal paths relative to the session directory and external paths from filesystem root. */
  private displayPath(rawPath: string, sessionDirectory: string | undefined): string {
    const absolute = this.toAbsolutePath(rawPath, sessionDirectory);
    const root = sessionDirectory ? this.normalizePath(sessionDirectory) : undefined;
    if (root && this.isInsidePath(absolute, root)) return this.relativePath(root, absolute) || this.basename(absolute);
    return this.compactHomePath(absolute);
  }

  /** Resolves relative paths against the session directory before normalizing dot segments. */
  private toAbsolutePath(rawPath: string, sessionDirectory: string | undefined): string {
    if (rawPath === "~" || rawPath.startsWith("~/")) {
      const home = this.homeDirectory();
      if (home) return this.normalizePath(rawPath === "~" ? home : `${home}/${rawPath.slice(2)}`);
    }
    if (rawPath.startsWith("/")) return this.normalizePath(rawPath);
    if (!sessionDirectory) return this.normalizePath(rawPath);
    return this.normalizePath(`${sessionDirectory}/${rawPath}`);
  }

  /** Replaces the desktop user's home directory with ~ for shorter external absolute paths. */
  private compactHomePath(path: string): string {
    const home = this.homeDirectory();
    if (!home) return path;
    const normalizedHome = this.normalizePath(home).replace(/\/$/, "");
    if (path === normalizedHome) return "~";
    if (path.startsWith(`${normalizedHome}/`)) return `~/${path.slice(normalizedHome.length + 1)}`;
    return path;
  }

  /** Returns the desktop user's home directory when available in Obsidian/Electron. */
  private homeDirectory(): string | undefined {
    const home = process.env.HOME || process.env.USERPROFILE;
    return home ? this.normalizePath(home) : undefined;
  }

  /** Normalizes POSIX paths without relying on Node's path module in the Obsidian renderer. */
  private normalizePath(path: string): string {
    const absolute = path.startsWith("/");
    const segments: string[] = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
        else if (!absolute) segments.push(segment);
        continue;
      }
      segments.push(segment);
    }
    return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
  }

  /** Checks path containment on segment boundaries. */
  private isInsidePath(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
  }

  /** Returns a relative path from the session directory to an internal file. */
  private relativePath(root: string, path: string): string {
    const normalizedRoot = root.replace(/\/$/, "");
    return path === normalizedRoot ? "" : path.slice(normalizedRoot.length + 1);
  }

  /** Splits display paths while preserving the slash after a muted prefix. */
  private splitPath(path: string): { prefix: string; basename: string } {
    const normalized = path.replace(/\/$/, "");
    if (normalized === "") return { prefix: "", basename: "/" };
    if (normalized === "~") return { prefix: "", basename: "~" };
    const index = normalized.lastIndexOf("/");
    if (index < 0) return { prefix: "", basename: normalized };
    return { prefix: normalized.slice(0, index + 1), basename: normalized.slice(index + 1) };
  }

  /** Returns the final segment of a path for root/session-directory fallbacks. */
  private basename(path: string): string {
    return this.splitPath(path).basename;
  }

  /** Returns message creation time for stable chronological rendering. */
  private messageTime(bundle: OpenCodeMessageBundle): number {
    const time = this.readObject(bundle.info, "time");
    const created = time?.created;
    return typeof created === "number" ? created : 0;
  }

  /** Reads a nested object field from a loosely typed OpenCode object. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    return undefined;
  }

  /** Reads the first string-like value from a loosely typed OpenCode object. */
  private readString(source: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }
}
