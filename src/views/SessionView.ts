import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, type ViewStateResult, setIcon } from "obsidian";
import type OpenCodePlugin from "../../main";
import type { OpenCodeEventSubscription } from "../services/opencode-events";
import type { JsonObject, OpenCodeMessageBundle } from "../services/opencode-types";

export const VIEW_TYPE_OPENCODE_SESSION = "opencode-session";

const CONTEXT_TOOLS = new Set(["read", "read_file", "glob", "grep", "list"]);
const PRIMARY_ARG_KEYS = ["description", "query", "path", "filePath", "filepath", "pattern", "name", "command"];
type MessageRenderKind = "none" | "user" | "assistant-text" | "assistant-compact" | "assistant-mixed";

interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
}

/** Renders one OpenCode session in an Obsidian tab; opened from AgentPanelView session rows. */
export class SessionView extends ItemView {
  private sessionId?: string;
  private sessionTitle?: string;
  private sessionDirectory?: string;
  private loading = false;
  private refreshTimer?: number;
  private eventSubscription?: OpenCodeEventSubscription;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(leaf);
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_SESSION;
  }

  /** Returns the tab title for this OpenCode session. */
  getDisplayText(): string {
    return this.sessionTitle ?? this.sessionId ?? "OpenCode session";
  }

  /** Returns the Lucide icon used by the session tab. */
  getIcon(): string {
    return "message-square";
  }

  /** Restores persisted view state when Obsidian reopens this custom tab. */
  getState(): Record<string, unknown> {
    return { sessionId: this.sessionId, sessionTitle: this.sessionTitle };
  }

  /** Applies a new session id and reloads the view; referenced by OpenCodePlugin.openSessionTab. */
  async setState(state: SessionViewState, _result: ViewStateResult): Promise<void> {
    this.sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
    this.sessionTitle = typeof state.sessionTitle === "string" ? state.sessionTitle : undefined;
    this.refreshLeafTitle();
    await this.refresh();
  }

  /** Initializes live refresh for the session tab. */
  async onOpen(): Promise<void> {
    this.contentEl.addClass("opencode-session-view");
    this.subscribeToServerEvents();
    await this.refresh();
  }

  /** Releases event streams and timers when the tab closes. */
  async onClose(): Promise<void> {
    this.eventSubscription?.close();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  /** Reloads the session and messages from read-only OpenCode endpoints. */
  async refresh(): Promise<void> {
    if (this.loading) return;
    if (!this.sessionId) {
      this.renderEmpty();
      return;
    }

    this.loading = true;
    this.renderLoading();
    try {
      const service = this.plugin.requireOpenCodeService();
      const [session, messages] = await Promise.all([service.getSession(this.sessionId), service.listMessages(this.sessionId)]);
      await this.renderSession(session, messages);
    } catch (error) {
      this.renderError(error);
    } finally {
      this.loading = false;
    }
  }

  /** Subscribes to OpenCode events and debounces message refreshes for this tab. */
  private subscribeToServerEvents(): void {
    this.eventSubscription?.close();
    this.eventSubscription = this.plugin.requireOpenCodeService().subscribeToEvents({
      onEvent: (event) => {
        if (!this.eventReferencesCurrentSession(event.properties)) return;
        this.scheduleRefresh();
      },
    });
  }

  /** Debounces streaming updates so markdown rendering is not invoked for every token event. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 500);
  }

  /** Checks common event payload fields for the active session id. */
  private eventReferencesCurrentSession(properties: JsonObject | undefined): boolean {
    if (!this.sessionId || !properties) return false;
    if (properties.sessionID === this.sessionId || properties.sessionId === this.sessionId) return true;
    const info = this.readObject(properties, "info");
    return info?.sessionID === this.sessionId || info?.sessionId === this.sessionId;
  }

  /** Renders a placeholder when no session id is bound to this view. */
  private renderEmpty(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ text: "No OpenCode session selected.", cls: "opencode-session-view__state-title" });
  }

  /** Renders a lightweight loading state while messages are fetched. */
  private renderLoading(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ cls: "opencode-session-view__spinner" });
    state.createDiv({ text: "Loading OpenCode session…", cls: "opencode-session-view__state-text" });
  }

  /** Renders connection or payload errors with a retry button. */
  private renderError(error: unknown): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ text: "Unable to load OpenCode session.", cls: "opencode-session-view__state-title" });
    state.createDiv({ text: error instanceof Error ? error.message : "Unknown error", cls: "opencode-session-view__state-text" });
    const retry = state.createEl("button", { text: "Retry", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.refresh());
  }

  /** Renders session chrome and all text message parts using Obsidian's MarkdownRenderer. */
  private async renderSession(session: JsonObject, messages: OpenCodeMessageBundle[]): Promise<void> {
    this.contentEl.empty();
    this.sessionTitle = this.sessionTitleFromSession(session);
    this.sessionDirectory = this.readString(session, ["directory", "cwd"]);
    this.refreshLeafTitle();
    const shell = this.contentEl.createDiv({ cls: "opencode-session-view__shell" });
    this.renderHeader(shell, session);

    const timeline = shell.createDiv({ cls: "opencode-session-view__timeline" });
    const sorted = [...messages].sort((a, b) => this.messageTime(a) - this.messageTime(b));
    let previousKind: MessageRenderKind = "none";
    for (const message of sorted) {
      const kind = this.messageRenderKind(message);
      if (kind === "none") continue;
      if (this.shouldInsertMessageBoundaryGap(previousKind, kind)) timeline.createDiv({ cls: "opencode-session-view__part-gap" });
      await this.renderMessage(timeline, message);
      previousKind = kind;
    }

    if (sorted.length === 0) timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
  }

  /** Classifies visible message content so compact assistant API calls can be separated without padding every part row. */
  private messageRenderKind(bundle: OpenCodeMessageBundle): MessageRenderKind {
    const role = this.readString(bundle.info, ["role"]) ?? "assistant";
    if (role !== "assistant") return this.textFromParts(bundle.parts).trim() ? "user" : "none";

    const hasText = bundle.parts.some((part) => {
      if (this.readString(part, ["type"]) !== "text") return false;
      if (part.synthetic === true || part.ignored === true) return false;
      return !!this.readString(part, ["text"]);
    });
    const hasCompact = bundle.parts.some((part) => this.isCompactAssistantPart(part));
    if (hasText && hasCompact) return "assistant-mixed";
    if (hasText) return "assistant-text";
    if (hasCompact) return "assistant-compact";
    return "none";
  }

  /** Returns true for visible non-prose assistant parts such as reasoning and tool calls. */
  private isCompactAssistantPart(part: JsonObject): boolean {
    const type = this.readString(part, ["type"]);
    if (type === "tool") return true;
    if (type === "reasoning") return this.plugin.settings.showReasoningBlocks && !!this.readString(part, ["text"]);
    return false;
  }

  /** Inserts spacing only between compact assistant message groups, preserving dense rows inside one model/API step. */
  private shouldInsertMessageBoundaryGap(previous: MessageRenderKind, next: MessageRenderKind): boolean {
    const compact = new Set<MessageRenderKind>(["assistant-compact", "assistant-mixed"]);
    return compact.has(previous) && compact.has(next);
  }

  /** Renders the fixed session header with refresh and copy-id actions. */
  private renderHeader(container: HTMLElement, session: JsonObject): void {
    const header = container.createDiv({ cls: "opencode-session-view__header" });
    const titleWrap = header.createDiv({ cls: "opencode-session-view__title-wrap" });
    titleWrap.createDiv({ text: this.sessionTitleFromSession(session), cls: "opencode-session-view__title" });
    titleWrap.createDiv({ text: this.sessionId ?? "", cls: "opencode-session-view__subtitle" });

    const actions = header.createDiv({ cls: "opencode-session-view__actions" });
    const copy = actions.createEl("button", { attr: { "aria-label": "Copy session ID" }, cls: "clickable-icon" });
    setIcon(copy, "copy");
    copy.addEventListener("click", () => void this.copySessionId());
    const refresh = actions.createEl("button", { attr: { "aria-label": "Refresh session" }, cls: "clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  /** Extracts the user-facing session title used by the Obsidian tab and in-view header. */
  private sessionTitleFromSession(session: JsonObject): string {
    return this.readString(session, ["title", "name", "slug"]) ?? this.sessionId ?? "OpenCode session";
  }

  /** Requests Obsidian to re-read getDisplayText after the async session title loads. */
  private refreshLeafTitle(): void {
    const title = this.getDisplayText();
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    const parent = this.leaf.parent as unknown as { updateHeader?: () => void };
    leaf.updateHeader?.();
    parent.updateHeader?.();
    this.containerEl.closest(".workspace-leaf")?.querySelector(".view-header-title")?.replaceChildren(title);
    this.app.workspace.trigger("layout-change");
  }

  /** Renders one user/assistant message block. */
  private async renderMessage(container: HTMLElement, bundle: OpenCodeMessageBundle): Promise<void> {
    const role = this.readString(bundle.info, ["role"]) ?? "assistant";

    if (role === "assistant") {
      await this.renderAssistantParts(container, bundle.parts);
      return;
    }

    const text = this.textFromParts(bundle.parts);
    if (!text.trim()) return;

    const article = container.createDiv({ cls: `opencode-session-view__message opencode-session-view__message--${role}` });
    const body = article.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Renders assistant parts in server order so text, reasoning, and tool calls appear at their original turn positions. */
  private async renderAssistantParts(container: HTMLElement, parts: JsonObject[]): Promise<void> {
    let textBuffer: string[] = [];
    let contextBuffer: JsonObject[] = [];
    let reasoningBuffer: JsonObject[] = [];
    let hasRenderedPart = false;
    let pendingStepGap = false;

    const markRendered = () => {
      hasRenderedPart = true;
    };

    const insertPendingStepGap = () => {
      if (!pendingStepGap) return;
      container.createDiv({ cls: "opencode-session-view__part-gap" });
      pendingStepGap = false;
    };

    const flushText = async () => {
      const text = textBuffer.join("\n\n").trim();
      textBuffer = [];
      if (!text) return;
      pendingStepGap = false;
      const body = container.createDiv({ cls: "opencode-session-view__markdown opencode-session-view__assistant-markdown markdown-preview-view markdown-rendered" });
      await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
      markRendered();
    };

    const flushContext = async () => {
      const group = contextBuffer;
      contextBuffer = [];
      if (group.length === 0) return;
      insertPendingStepGap();
      if (group.length === 1) {
        await this.renderToolCall(container, group[0]);
        markRendered();
        return;
      }
      await this.renderContextToolGroup(container, group);
      markRendered();
    };

    const flushReasoning = async () => {
      const group = reasoningBuffer;
      reasoningBuffer = [];
      if (group.length === 0 || !this.plugin.settings.showReasoningBlocks) return;
      insertPendingStepGap();
      if (await this.renderReasoningBlock(container, group)) markRendered();
    };

    for (const part of parts) {
      const type = this.readString(part, ["type"]);
      if (type === "text") {
        const text = part.synthetic === true || part.ignored === true ? undefined : this.readString(part, ["text"]);
        if (!text) continue;
        await flushContext();
        await flushReasoning();
        if (text) textBuffer.push(text);
        continue;
      }

      if (type === "step-start") {
        await flushText();
        await flushContext();
        await flushReasoning();
        pendingStepGap = hasRenderedPart;
        continue;
      }

      if (type === "step-finish") {
        await flushText();
        await flushContext();
        await flushReasoning();
        continue;
      }

      if (type === "reasoning") {
        await flushText();
        await flushContext();
        reasoningBuffer.push(part);
        continue;
      }

      if (type !== "tool") continue;
      await flushText();
      await flushReasoning();
      const tool = this.normalizedToolName(part);
      if (this.plugin.settings.groupContextTools && CONTEXT_TOOLS.has(tool)) {
        contextBuffer.push(part);
        continue;
      }
      await flushContext();
      insertPendingStepGap();
      await this.renderToolCall(container, part);
      markRendered();
    }

    await flushText();
    await flushReasoning();
    await flushContext();
  }

  /** Renders consecutive assistant reasoning parts as one collapsed Thinking/Thought block; referenced by renderAssistantParts. */
  private async renderReasoningBlock(container: HTMLElement, parts: JsonObject[]): Promise<boolean> {
    const text = this.reasoningText(parts);
    if (!text) return false;

    const complete = this.reasoningComplete(parts);
    const details = container.createEl("details", { cls: `opencode-session-view__reasoning opencode-session-view__reasoning--${complete ? "complete" : "streaming"}` });
    const summary = details.createEl("summary", { cls: "opencode-session-view__reasoning-summary" });
    const icon = summary.createSpan({ cls: "opencode-session-view__reasoning-icon" });
    setIcon(icon, complete ? "sparkles" : "brain");
    summary.createSpan({ text: complete ? "Thought" : "Thinking", cls: "opencode-session-view__reasoning-title" });
    if (!complete) summary.createSpan({ cls: "opencode-session-view__reasoning-spinner" });

    const body = details.createDiv({ cls: "opencode-session-view__reasoning-body opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
    return true;
  }

  /** Joins visible reasoning summaries without introducing separate collapsed rows for each provider summary fragment. */
  private reasoningText(parts: JsonObject[]): string {
    return parts.map((part) => this.readString(part, ["text"]) ?? "").filter((text) => text.trim().length > 0).join("\n\n");
  }

  /** Returns whether all reasoning fragments have finished streaming based on their time.end markers. */
  private reasoningComplete(parts: JsonObject[]): boolean {
    return parts.every((part) => {
      const time = this.readObject(part, "time");
      return typeof time?.end === "number";
    });
  }

  /** Renders consecutive read/search/list tools under one collapsed context-gathering container. */
  private async renderContextToolGroup(container: HTMLElement, parts: JsonObject[]): Promise<void> {
    const details = container.createEl("details", { cls: "opencode-session-view__tool-group opencode-session-view__tool" });
    const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
    const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
    setIcon(icon, "search");
    summary.createSpan({ text: "Gathered context", cls: "opencode-session-view__tool-title" });
    summary.createSpan({ text: this.contextSummary(parts), cls: "opencode-session-view__tool-subtitle" });

    const list = details.createDiv({ cls: "opencode-session-view__tool-group-list" });
    for (const part of parts) await this.renderToolCall(list, part);
  }

  /** Renders one collapsed-by-default tool call with specialized expanded states for common opencode tools. */
  private async renderToolCall(container: HTMLElement, part: JsonObject): Promise<void> {
    const tool = this.normalizedToolName(part);
    const state = this.readObject(part, "state") ?? {};
    const input = this.readObject(state, "input") ?? {};
    const output = this.readString(state, ["output", "error"]);
    const status = this.readString(state, ["status"]) ?? "unknown";
    const info = this.toolInfo(tool, input, state);

    const details = container.createEl("details", { cls: `opencode-session-view__tool opencode-session-view__tool--${status}` });
    const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
    if (this.hasToolIcon(tool)) {
      const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
      setIcon(icon, this.toolIcon(tool));
    }
    if (this.isPathTool(tool)) this.renderPathToolSummary(summary, tool, input, state);
    else if (this.isContextLocationTool(tool)) this.renderContextLocationSummary(summary, tool, input);
    else if (tool === "bash" || tool === "shell") this.renderBashToolSummary(summary, input, state);
    else {
      summary.createSpan({ text: info.title, cls: "opencode-session-view__tool-title" });
      if (info.subtitle) summary.createSpan({ text: info.subtitle, cls: "opencode-session-view__tool-subtitle" });
    }
    if (status !== "completed" && status !== "error") summary.createSpan({ text: status, cls: "opencode-session-view__tool-status" });

    const body = details.createDiv({ cls: "opencode-session-view__tool-body" });
    if (tool === "read" || tool === "read_file") await this.renderReadTool(body, input, output, state);
    else if (tool === "bash" || tool === "shell") await this.renderBashTool(body, input, output);
    else if (tool === "edit" || tool === "write" || tool === "apply_patch") await this.renderEditTool(body, tool, input, output, state);
    else if (tool === "task") await this.renderTaskTool(body, input, output, state);
    else if (tool.startsWith("todo")) await this.renderTodoTool(body, input, state);
    else await this.renderGenericTool(body, input, output, info.tags);
  }

  /** Renders read/read_file output as a syntax-highlighted Obsidian code block using the file extension. */
  private async renderReadTool(container: HTMLElement, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const filePath = this.toolPath(input);
    if (output) await this.renderReadOutput(container, output, this.languageFromPath(filePath));

    const loaded = this.readStringArray(this.readObject(state, "metadata") ?? {}, "loaded");
    for (const path of loaded) container.createDiv({ text: `Loaded ${this.displayPath(path)}`, cls: "opencode-session-view__tool-path" });
    if (!output && loaded.length === 0) container.createDiv({ text: "No output yet.", cls: "opencode-session-view__tool-empty" });
  }

  /** Renders read output with parsed line numbers in a dedicated gutter; referenced by renderReadTool. */
  private async renderReadOutput(container: HTMLElement, output: string, language: string): Promise<void> {
    const rows = this.parseReadOutputRows(output);
    if (rows.length === 0) {
      await this.renderCodeBlock(container, output, language);
      return;
    }

    const table = container.createDiv({ cls: "opencode-session-view__read-table" });
    for (const row of rows) {
      const line = table.createDiv({ cls: "opencode-session-view__read-line" });
      line.createSpan({ text: String(row.line), cls: "opencode-session-view__read-line-number" });
      const code = line.createSpan({ cls: "opencode-session-view__read-code" });
      await this.renderHighlightedCodeLine(code, row.text || " ", language);
    }
  }

  /** Extracts OpenCode read tool `<content>` rows like `123: code` while omitting path/type wrappers. */
  private parseReadOutputRows(output: string): Array<{ line: number; text: string }> {
    const content = output.match(/<content>\s*([\s\S]*?)\s*<\/content>/)?.[1] ?? output;
    return content.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
      const match = line.match(/^(\d+):\s?(.*)$/);
      if (!match) return [];
      return [{ line: Number(match[1]), text: match[2] ?? "" }];
    });
  }

  /** Renders shell tool output in a terminal-styled block with a copy action. */
  private async renderBashTool(container: HTMLElement, input: JsonObject, output: string | undefined): Promise<void> {
    const command = this.readString(input, ["command", "cmd"]) ?? "";
    const shell = container.createDiv({ cls: "opencode-session-view__terminal" });
    const copy = shell.createEl("button", { attr: { "aria-label": "Copy shell output" }, cls: "opencode-session-view__copy clickable-icon" });
    setIcon(copy, "copy");
    const terminalText = [`$ ${command}`, this.stripAnsi(output ?? "")].join("\n\n");
    copy.addEventListener("click", () => void this.copyText(terminalText, "Copied shell output"));
    shell.createEl("pre", { text: terminalText });
  }

  /** Renders edit/write tools with available diff metadata followed by the post-state or output code block. */
  private async renderEditTool(container: HTMLElement, tool: string, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const filePath = this.toolPath(input) ?? this.patchToolPath(input, state);
    const diffs = this.diffsFromEditTool(tool, input, state);
    for (const diff of diffs) await this.renderDiffSection(container, diff);
    const content = this.postStateFromTool(tool, input, state);
    if (content) {
      container.createDiv({ text: "Post-state", cls: "opencode-session-view__tool-section-title" });
      await this.renderCodeBlock(container, content, this.languageFromPath(filePath));
    }
    this.renderDiagnostics(container, filePath, state);
    if (output && diffs.length === 0 && !content) await this.renderMarkdownSection(container, "Result", output);
  }

  /** Renders one unified diff block with an optional affected-file label. */
  private async renderDiffSection(container: HTMLElement, diff: { file?: string; patch: string; additions?: number; deletions?: number }): Promise<void> {
    const table = container.createDiv({ cls: "opencode-session-view__diff-table" });
    const language = this.languageFromPath(diff.file);
    for (const row of this.parseUnifiedDiffRows(diff.patch)) {
      const line = table.createDiv({ cls: `opencode-session-view__diff-line opencode-session-view__diff-line--${row.kind}` });
      line.createSpan({ text: row.oldLine === undefined ? "" : String(row.oldLine), cls: "opencode-session-view__diff-line-number" });
      line.createSpan({ text: row.newLine === undefined ? "" : String(row.newLine), cls: "opencode-session-view__diff-line-number" });
      const code = line.createSpan({ cls: "opencode-session-view__diff-code" });
      if (row.kind === "meta") code.setText(row.text || " ");
      else await this.renderHighlightedCodeLine(code, row.text || " ", language);
    }
  }

  /** Renders one code line through Obsidian's fenced-code highlighter, then embeds the highlighted tokens in the diff table. */
  private async renderHighlightedCodeLine(container: HTMLElement, code: string, language: string): Promise<void> {
    const scratch = document.createElement("div");
    scratch.addClass("markdown-rendered");
    await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${this.escapeFence(code)}\n\`\`\``, scratch, `opencode-session/${this.sessionId ?? "session"}.md`, this);
    const highlighted = scratch.querySelector("code");
    if (!highlighted) {
      container.setText(code);
      return;
    }
    while (highlighted.firstChild) container.appendChild(highlighted.firstChild);
  }

  /** Renders LSP diagnostic errors reported in edit/write/apply_patch metadata. */
  private renderDiagnostics(container: HTMLElement, filePath: string | undefined, state: JsonObject): void {
    const diagnostics = this.diagnosticsFromTool(filePath, state);
    if (diagnostics.length === 0) return;

    const section = container.createDiv({ cls: "opencode-session-view__diagnostics" });
    section.createDiv({ text: "LSP errors", cls: "opencode-session-view__tool-section-title" });
    for (const diagnostic of diagnostics) {
      const row = section.createDiv({ cls: "opencode-session-view__diagnostic" });
      row.createSpan({ text: "ERROR", cls: "opencode-session-view__diagnostic-label" });
      if (diagnostic.location) row.createSpan({ text: diagnostic.location, cls: "opencode-session-view__diagnostic-location" });
      row.createSpan({ text: diagnostic.message, cls: "opencode-session-view__diagnostic-message" });
    }
  }

  /** Renders task/subagent spawns without inlining the child conversation. */
  private async renderTaskTool(container: HTMLElement, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const childId = this.readString(this.readObject(state, "metadata") ?? {}, ["sessionId", "sessionID"]);
    await this.renderJsonSection(container, "Input", input);
    if (output) await this.renderMarkdownSection(container, "Result", output);
    if (childId) container.createDiv({ text: `Child session: ${childId}`, cls: "opencode-session-view__tool-path" });
  }

  /** Renders todo* tool calls as an inert checklist, matching opencode's dedicated todo renderer intent. */
  private async renderTodoTool(container: HTMLElement, input: JsonObject, state: JsonObject): Promise<void> {
    const todos = this.todosFromTool(input, state);
    if (todos.length === 0) {
      await this.renderJsonSection(container, "Input", input);
      return;
    }

    const list = container.createDiv({ cls: "opencode-session-view__todos" });
    for (const todo of todos) {
      const row = list.createDiv({ cls: "opencode-session-view__todo" });
      const checkbox = row.createEl("input", { type: "checkbox", cls: "opencode-session-view__todo-checkbox" });
      checkbox.checked = this.readString(todo, ["status"]) === "completed";
      checkbox.disabled = true;
      row.createSpan({ text: this.readString(todo, ["content"]) ?? "Untitled todo", cls: "opencode-session-view__todo-content" });
      const priority = this.readString(todo, ["priority"]);
      if (priority) row.createSpan({ text: priority, cls: "opencode-session-view__tool-tag" });
    }
  }

  /** Extracts todo arrays from OpenCode input/metadata records. */
  private todosFromTool(input: JsonObject, state: JsonObject): JsonObject[] {
    const metadata = this.readObject(state, "metadata") ?? {};
    const metadataTodos = this.readObjectArray(metadata, "todos");
    return metadataTodos.length > 0 ? metadataTodos : this.readObjectArray(input, "todos");
  }

  /** Renders unknown tools as readable input/output sections plus up to three argument tags. */
  private async renderGenericTool(container: HTMLElement, input: JsonObject, output: string | undefined, tags: string[]): Promise<void> {
    if (tags.length > 0) {
      const tagWrap = container.createDiv({ cls: "opencode-session-view__tool-tags" });
      for (const tag of tags) tagWrap.createSpan({ text: tag, cls: "opencode-session-view__tool-tag" });
    }
    await this.renderJsonSection(container, "Input", input);
    if (output) await this.renderMarkdownSection(container, "Output", output);
  }

  /** Renders a labeled JSON section through Obsidian's code block highlighter. */
  private async renderJsonSection(container: HTMLElement, label: string, value: JsonObject): Promise<void> {
    container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
    await this.renderCodeBlock(container, JSON.stringify(value, null, 2), "json");
  }

  /** Renders a labeled markdown output section. */
  private async renderMarkdownSection(container: HTMLElement, label: string, markdown: string): Promise<void> {
    container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
    const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(markdown, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Uses MarkdownRenderer fenced code blocks so Obsidian supplies native syntax highlighting. */
  private async renderCodeBlock(container: HTMLElement, code: string, language: string): Promise<void> {
    const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${this.escapeFence(code)}\n\`\`\``, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Normalizes OpenCode tool names so aliases share one renderer path. */
  private normalizedToolName(part: JsonObject): string {
    return (this.readString(part, ["tool", "name"]) ?? "tool").toLowerCase();
  }

  /** Builds fallback tool title/subtitle/tags using the getToolInfo-style primary argument extraction from the spec. */
  private toolInfo(tool: string, input: JsonObject, state: JsonObject): { title: string; subtitle?: string; tags: string[] } {
    const title = this.readString(state, ["title"]) ?? this.toolTitle(tool, input);
    const subtitle = tool.startsWith("todo") ? this.todoSubtitle(this.todosFromTool(input, state)) : this.primaryArg(input);
    const tags = Object.entries(input)
      .filter(([key]) => !PRIMARY_ARG_KEYS.includes(key))
      .slice(0, 3)
      .map(([key, value]) => `${key}=${this.inlineValue(value)}`);
    return { title, subtitle, tags };
  }

  /** Returns true for tools whose collapsed row should prioritize a filesystem path over the tool title. */
  private isPathTool(tool: string): boolean {
    return tool === "read" || tool === "read_file" || tool === "edit" || tool === "write" || tool === "apply_patch";
  }

  /** Returns true for context tools that carry a directory plus optional search pattern. */
  private isContextLocationTool(tool: string): boolean {
    return tool === "list" || tool === "glob" || tool === "grep";
  }

  /** Renders path-tool summaries as muted path text with the final segment emphasized. */
  private renderPathToolSummary(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
    const rawPath = this.toolPath(input) ?? this.patchToolPath(input, state);
    if (!rawPath) {
      summary.createSpan({ text: this.toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
      return;
    }

    this.renderDisplayPath(summary, rawPath);
    this.renderDiffStats(summary, tool, input, state);
  }

  /** Appends edit/write/apply_patch additions/deletions to the collapsed row. */
  private renderDiffStats(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
    if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") return;
    const totals = this.diffsFromEditTool(tool, input, state).reduce(
      (acc, diff) => ({ additions: acc.additions + (diff.additions ?? 0), deletions: acc.deletions + (diff.deletions ?? 0) }),
      { additions: 0, deletions: 0 },
    );
    if (totals.additions === 0 && totals.deletions === 0) return;
    const stats = summary.createSpan({ cls: "opencode-session-view__diff-stats" });
    stats.createSpan({ text: `+${totals.additions}`, cls: "opencode-session-view__diff-stat-add" });
    stats.createSpan({ text: `−${totals.deletions}`, cls: "opencode-session-view__diff-stat-del" });
  }

  /** Renders list/glob/grep rows with the same path normalization used by standalone path tools. */
  private renderContextLocationSummary(summary: HTMLElement, tool: string, input: JsonObject): void {
    const rawPath = this.readString(input, ["path"]);
    const pattern = this.readString(input, ["pattern"]);
    const include = this.readString(input, ["include"]);

    if (tool === "list") summary.createSpan({ text: this.toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
    if (rawPath) this.renderDisplayPath(summary, rawPath);
    if (pattern) summary.createSpan({ text: `pattern=${pattern}`, cls: "opencode-session-view__tool-tag" });
    if (include) summary.createSpan({ text: `include=${include}`, cls: "opencode-session-view__tool-tag" });
  }

  /** Renders bash collapsed rows with only the command as muted text, avoiding duplicate title/subtitle. */
  private renderBashToolSummary(summary: HTMLElement, input: JsonObject, state: JsonObject): void {
    const command = this.readString(input, ["command", "cmd"]) ?? this.readString(state, ["title"]) ?? "Shell";
    summary.createSpan({ text: command, cls: "opencode-session-view__tool-subtitle" });
  }

  /** Appends a muted-prefix/emphasized-basename path span using the global tool path policy. */
  private renderDisplayPath(container: HTMLElement, rawPath: string): void {
    const display = this.displayPath(rawPath);
    const split = this.splitPath(display);
    const path = container.createSpan({ cls: "opencode-session-view__tool-display-path" });
    if (split.prefix) path.createSpan({ text: split.prefix, cls: "opencode-session-view__tool-path-prefix" });
    path.createSpan({ text: split.basename, cls: "opencode-session-view__tool-path-basename" });
  }

  /** Reads the preferred path-like input key from read/edit/write tool arguments. */
  private toolPath(input: JsonObject): string | undefined {
    return this.readString(input, ["filePath", "filepath", "path"]);
  }

  /** Extracts the first affected file from apply_patch-style inputs or metadata. */
  private patchToolPath(input: JsonObject, state: JsonObject): string | undefined {
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    const diffFile = filediff ? this.readString(filediff, ["file", "filePath", "path"]) : undefined;
    if (diffFile) return diffFile;

    const metadataFiles = this.readObjectArray(metadata, "files");
    const inputFiles = this.readObjectArray(input, "files");
    const first = [...metadataFiles, ...inputFiles][0];
    return first ? this.readString(first, ["filePath", "relativePath", "path", "file"]) : undefined;
  }

  /** Displays internal paths relative to the session directory and external paths from filesystem root. */
  private displayPath(rawPath: string): string {
    const absolute = this.toAbsolutePath(rawPath);
    const root = this.sessionDirectory ? this.normalizePath(this.sessionDirectory) : undefined;
    if (root && this.isInsidePath(absolute, root)) return this.relativePath(root, absolute) || this.basename(absolute);
    return this.compactHomePath(absolute);
  }

  /** Resolves relative paths against the OpenCode session directory before normalizing dot segments. */
  private toAbsolutePath(rawPath: string): string {
    if (rawPath === "~" || rawPath.startsWith("~/")) {
      const home = this.homeDirectory();
      if (home) return this.normalizePath(rawPath === "~" ? home : `${home}/${rawPath.slice(2)}`);
    }
    if (rawPath.startsWith("/")) return this.normalizePath(rawPath);
    if (!this.sessionDirectory) return this.normalizePath(rawPath);
    return this.normalizePath(`${this.sessionDirectory}/${rawPath}`);
  }

  /** Replaces the current user's home directory with ~ for shorter external absolute paths. */
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

  /** Chooses concise collapsed-state labels for common tools. */
  private toolTitle(tool: string, input: JsonObject): string {
    if (tool === "read" || tool === "read_file") return "Read";
    if (tool === "glob" || tool === "grep") return "Search";
    if (tool === "list") return "List";
    if (tool === "bash" || tool === "shell") return "Shell";
    if (tool === "edit") return "Edit";
    if (tool === "write") return "Write";
    if (tool === "task") return this.readString(input, ["description"]) ?? "Task";
    if (tool.startsWith("todo")) return "Todos";
    return tool;
  }

  /** Returns the best single-line descriptor from a tool input object. */
  private primaryArg(input: JsonObject): string | undefined {
    for (const key of PRIMARY_ARG_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }

  /** Returns true when a tool has a representative icon; generic tools intentionally do not. */
  private hasToolIcon(tool: string): boolean {
    return this.isPathTool(tool) || this.isContextLocationTool(tool) || tool === "bash" || tool === "shell" || tool === "task" || tool.startsWith("todo");
  }

  /** Chooses muted Lucide icons for non-generic collapsed tool rows. */
  private toolIcon(tool: string): string {
    if (tool === "read" || tool === "read_file") return "eye";
    if (tool === "grep" || tool === "glob") return "search";
    if (tool === "list") return "list";
    if (tool === "bash" || tool === "shell") return "terminal";
    if (tool === "edit" || tool === "write" || tool === "apply_patch") return "pencil";
    if (tool === "task") return "brain";
    if (tool.startsWith("todo")) return "list-checks";
    return "wrench";
  }

  /** Builds a compact completed/total subtitle for todo tool calls. */
  private todoSubtitle(todos: JsonObject[]): string | undefined {
    if (todos.length === 0) return undefined;
    const completed = todos.filter((todo) => this.readString(todo, ["status"]) === "completed").length;
    return `${completed}/${todos.length}`;
  }

  /** Summarizes grouped context tools as read/search/list counts. */
  private contextSummary(parts: JsonObject[]): string {
    const counts = new Map<string, number>();
    for (const part of parts) {
      const tool = this.normalizedToolName(part);
      const label = tool === "read" || tool === "read_file" ? "read" : tool === "grep" || tool === "glob" ? "search" : "list";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(", ");
  }

  /** Infers Obsidian code-block language from a file path extension. */
  private languageFromPath(filePath: string | undefined): string {
    const ext = filePath?.split(".").pop()?.toLowerCase();
    const languageByExtension: Record<string, string> = {
      js: "javascript",
      jsx: "jsx",
      ts: "typescript",
      tsx: "tsx",
      json: "json",
      jsonc: "jsonc",
      md: "markdown",
      css: "css",
      scss: "scss",
      html: "html",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
    };
    return ext ? languageByExtension[ext] ?? ext : "text";
  }

  /** Extracts unified diffs from edit/write/apply_patch metadata, falling back to old/new strings. */
  private diffsFromEditTool(tool: string, input: JsonObject, state: JsonObject): Array<{ file?: string; patch: string; additions?: number; deletions?: number }> {
    const metadata = this.readObject(state, "metadata") ?? {};
    const files = this.patchFilesFromMetadata(metadata);
    if (files.length > 0) return files;

    const single = this.diffFromTool(input, state);
    if (single) return [single];
    if (tool === "write") {
      const content = this.readString(input, ["content"]);
      const file = this.toolPath(input);
      if (content) return [{ file, patch: [`--- /dev/null`, `+++ ${file ?? "after"}`, ...content.split("\n").map((line) => `+${line}`)].join("\n") }];
    }
    return [];
  }

  /** Converts apply_patch metadata files into renderable unified diff blocks. */
  private patchFilesFromMetadata(metadata: JsonObject): Array<{ file?: string; patch: string; additions?: number; deletions?: number }> {
    return this.readObjectArray(metadata, "files").flatMap((file) => {
      const path = this.readString(file, ["relativePath", "filePath", "path", "file"]);
      const patch = this.readString(file, ["patch", "diff"]);
      const additions = this.readNumber(file, ["additions"]);
      const deletions = this.readNumber(file, ["deletions"]);
      if (patch) return [{ file: path, patch, additions, deletions }];

      const before = this.readString(file, ["before"]);
      const after = this.readString(file, ["after"]);
      if (before === undefined && after === undefined) return [];
      return [{ file: path, patch: this.beforeAfterDiff(before ?? "", after ?? "", path), additions, deletions }];
    });
  }

  /** Creates a single unified diff from edit metadata or old/new strings. */
  private diffFromTool(input: JsonObject, state: JsonObject): { file?: string; patch: string; additions?: number; deletions?: number } | undefined {
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    if (filediff) {
      const patch = this.readString(filediff, ["patch"]);
      const file = this.readString(filediff, ["file", "filePath", "path"]) ?? this.toolPath(input);
      const additions = this.readNumber(filediff, ["additions"]);
      const deletions = this.readNumber(filediff, ["deletions"]);
      if (patch) return { file, patch, additions, deletions };
      const before = this.readString(filediff, ["before"]) ?? "";
      const after = this.readString(filediff, ["after"]) ?? "";
      return { file, patch: this.beforeAfterDiff(before, after, file), additions, deletions };
    }
    const oldString = this.readString(input, ["oldString", "old"]);
    const newString = this.readString(input, ["newString", "new"]);
    if (!oldString && !newString) return undefined;
    const file = this.toolPath(input);
    return { file, patch: this.beforeAfterDiff(oldString ?? "", newString ?? "", file) };
  }

  /** Produces a simple diff block from complete before/after strings when no patch is supplied. */
  private beforeAfterDiff(before: string, after: string, file?: string): string {
    return [`--- ${file ?? "before"}`, `+++ ${file ?? "after"}`, ...before.split("\n").map((line) => `-${line}`), ...after.split("\n").map((line) => `+${line}`)].join("\n");
  }

  /** Parses unified diff text into display rows with old/new line numbers and no +/- glyph prefix. */
  private parseUnifiedDiffRows(patch: string): Array<{ kind: "context" | "add" | "del" | "meta"; oldLine?: number; newLine?: number; text: string }> {
    const rows: Array<{ kind: "context" | "add" | "del" | "meta"; oldLine?: number; newLine?: number; text: string }> = [];
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
      if (!raw) continue;
      if (raw.startsWith("Index: ") || raw.startsWith("====") || raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;

      const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: "meta", text: hunk[3] || `Lines ${oldLine}-${newLine}` });
        continue;
      }

      if (raw.startsWith("-")) {
        rows.push({ kind: "del", oldLine, text: raw.slice(1) });
        oldLine += 1;
        continue;
      }

      if (raw.startsWith("+")) {
        rows.push({ kind: "add", newLine, text: raw.slice(1) });
        newLine += 1;
        continue;
      }

      if (raw.startsWith(" ")) {
        rows.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
        oldLine += 1;
        newLine += 1;
        continue;
      }

      if (!raw.startsWith("\\")) rows.push({ kind: "meta", text: raw });
    }

    return rows;
  }

  /** Extracts severity-1 diagnostics from OpenCode edit/write metadata. */
  private diagnosticsFromTool(filePath: string | undefined, state: JsonObject): Array<{ location?: string; message: string }> {
    const metadata = this.readObject(state, "metadata") ?? {};
    const diagnosticsByFile = this.readObject(metadata, "diagnostics");
    if (!diagnosticsByFile) return [];
    const key = filePath && diagnosticsByFile[filePath] ? filePath : Object.keys(diagnosticsByFile)[0];
    const raw = key ? diagnosticsByFile[key] : undefined;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const diagnostic = item as JsonObject;
      if (this.readNumber(diagnostic, ["severity"]) !== 1) return [];
      const range = this.readObject(diagnostic, "range");
      const start = range ? this.readObject(range, "start") : undefined;
      const line = start ? this.readNumber(start, ["line"]) : undefined;
      const character = start ? this.readNumber(start, ["character"]) : undefined;
      return [{ location: line !== undefined && character !== undefined ? `[${line + 1}:${character + 1}]` : undefined, message: this.readString(diagnostic, ["message"]) ?? "Unknown diagnostic" }];
    }).slice(0, 3);
  }

  /** Returns best available post-edit/write contents for the expanded code block. */
  private postStateFromTool(tool: string, input: JsonObject, state: JsonObject): string | undefined {
    if (tool === "write") return this.readString(input, ["content"]);
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    return (filediff ? this.readString(filediff, ["after"]) : undefined) ?? this.readString(input, ["newString", "new"]);
  }

  /** Prevents nested triple-backtick content from breaking generated fenced code blocks. */
  private escapeFence(code: string): string {
    return code.replace(/```/g, "``\\`");
  }

  /** Strips ANSI control codes from terminal output before display/copy. */
  private stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
  }

  /** Formats arbitrary values for compact key=value tags. */
  private inlineValue(value: unknown): string {
    if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}…` : value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return String(value);
    return JSON.stringify(value).slice(0, 40);
  }

  /** Copies arbitrary rendered tool text to the clipboard. */
  private async copyText(text: string, notice: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    new Notice(notice);
  }

  /** Joins visible text parts for non-assistant messages, skipping synthetic/ignored and non-text parts. */
  private textFromParts(parts: JsonObject[]): string {
    return parts
      .flatMap((part) => {
        if (this.readString(part, ["type"]) !== "text") return [];
        if (part.synthetic === true || part.ignored === true) return [];
        return [this.readString(part, ["text"]) ?? ""];
      })
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
  }

  /** Returns message creation time for stable chronological rendering. */
  private messageTime(bundle: OpenCodeMessageBundle): number {
    const time = this.readObject(bundle.info, "time");
    const created = time?.created;
    return typeof created === "number" ? created : 0;
  }

  /** Copies the active session id to clipboard for debugging and API testing. */
  private async copySessionId(): Promise<void> {
    if (!this.sessionId) return;
    await navigator.clipboard.writeText(this.sessionId);
    new Notice(`Copied session ID: ${this.sessionId}`);
  }

  /** Reads a nested object field from a loosely typed OpenCode object. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    return undefined;
  }

  /** Reads an array of objects from a loosely typed OpenCode object. */
  private readObjectArray(source: JsonObject, key: string): JsonObject[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item));
  }

  /** Reads an array of strings from a loosely typed OpenCode object. */
  private readStringArray(source: JsonObject, key: string): string[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  /** Reads the first numeric value from a loosely typed OpenCode object. */
  private readNumber(source: JsonObject, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
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
