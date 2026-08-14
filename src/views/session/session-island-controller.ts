import { MarkdownRenderer, setIcon, type Component } from "obsidian";

import {
  diffTotals,
  latestSummarizedTurnDiffs,
  messageId,
  messageRole,
  sessionDiffFiles,
  type DiffFileSummary,
  type SessionDiffFileSummary,
  type SummarizedTurnDiffs,
  type TurnFileDiff,
} from "../../diff-utils";
import type OpenCodePlugin from "../../../main";
import type { OpenCodeMessageBundle, OpenCodeTodo } from "../../services/opencode-types";
import { normalizeSessionIslandContextLabel, normalizeTodoStatusCharacter } from "../../settings";
import { isActiveSessionStatus } from "../../session-state";
import type { SessionViewModel } from "./session-view-model";
import { collapseExpandedDiffContext, DIFF_ACTIVE_ROW_EVENT, renderDiffSection } from "./blocks/edit-tool";
import { configuredToolIcon, toolIcon } from "./blocks/tool-renderer";
import { contextUsage } from "./composer/context-progress-bar";
import { formatCompactNumber } from "./format-helpers";
import { displayPath, splitPath } from "./path-utils";
import { sessionTodoMarkdown, todoTabTitle } from "./session-rollup-helpers";

export type SessionIslandTab = "prompt" | "todos" | "subagents" | "turn" | "session";

const ISLAND_TAB_ICONS: Record<SessionIslandTab, string> = {
  prompt: "message-circle",
  todos: toolIcon("todowrite"),
  subagents: "bot",
  turn: "message-square-diff",
  session: "diff",
};

interface SessionIslandDeps {
  plugin: OpenCodePlugin;
  component: Component;
  model: SessionViewModel;
  getRevertMessageId: () => string | undefined;
  isActive: () => boolean;
  isSessionMuted: () => boolean;
  shouldAutoApprove: () => boolean;
  isAutoApproveInherited: () => boolean;
  onPromptActivated: () => void;
}

const LARGE_DIFF_CHANGED_LINES = 500;

/** Owns the tabbed Prompt, todo, subagent, and diff panels in the sticky bottom dock. */
export class SessionIslandController {
  private readonly islandId = `opencode-session-island-${crypto.randomUUID()}`;
  private rootEl?: HTMLElement;
  private tabListEl?: HTMLElement;
  private promptPanelEl?: HTMLElement;
  private promptContentEl?: HTMLElement;
  private detailPanelEl?: HTMLElement;
  private detailContentEl?: HTMLElement;
  private activeTab?: SessionIslandTab = "prompt";
  private tabStop: SessionIslandTab = "prompt";
  private animationTab?: SessionIslandTab;
  private hydration?: Promise<void>;
  private needsRecovery = false;
  private bindingVersion = 0;
  private renderVersion = 0;
  private disposed = false;
  private sessionId?: string;
  private directory?: string;
  private todoRevision = 0;
  private todos: OpenCodeTodo[] = [];
  private todosLoaded = false;
  private todoError?: string;
  private gitState: "loading" | "git" | "non-git" | "error" = "loading";
  private messagesLoaded = false;
  private messageError?: string;
  private messages = new Map<string, OpenCodeMessageBundle>();
  private messageRevision = 0;
  private messageRevisions = new Map<string, number>();
  private removedMessageRevisions = new Map<string, number>();
  private removedMessageIds = new Set<string>();
  private openFiles = new Set<string>();
  private forcedLargeDiffs = new Set<string>();
  private selectedSubagentId?: string;
  private readonly selectedFileKeys = new Map<"turn" | "session", string>();
  private pendingDetailFocus?: "subagents" | "turn" | "session";

  constructor(private readonly deps: SessionIslandDeps) {}

  /** Invalidates server-backed roll-up state while the view is empty or bound to a client-only draft. */
  unbind(): void {
    this.bindingVersion += 1;
    this.hydration = undefined;
    this.sessionId = undefined;
    this.directory = undefined;
    this.activeTab = "prompt";
    this.tabStop = "prompt";
    this.animationTab = undefined;
    this.todos = [];
    this.todosLoaded = false;
    this.todoError = undefined;
    this.gitState = "loading";
    this.messagesLoaded = false;
    this.messageError = undefined;
    this.messageRevision = 0;
    this.messageRevisions.clear();
    this.removedMessageRevisions.clear();
    this.messages.clear();
    this.removedMessageIds.clear();
    this.openFiles.clear();
    this.forcedLargeDiffs.clear();
    this.clearDetailNavigationState();
    this.needsRecovery = false;
    this.detailContentEl?.empty();
    this.refreshDom();
  }

  /** Binds cached state to one server session and starts one background hydration for that identity. */
  bind(sessionId: string, directory: string | undefined, recentMessages: OpenCodeMessageBundle[]): void {
    const changed = this.sessionId !== sessionId || this.directory !== directory;
    if (changed) {
      this.bindingVersion += 1;
      this.hydration = undefined;
      this.sessionId = sessionId;
      this.directory = directory;
      this.todos = [];
      this.todosLoaded = false;
      this.todoError = undefined;
      this.todoRevision = 0;
      this.gitState = "loading";
      this.messagesLoaded = false;
      this.messageError = undefined;
      this.messageRevision = 0;
      this.messageRevisions.clear();
      this.removedMessageRevisions.clear();
      this.messages.clear();
      this.removedMessageIds.clear();
      this.openFiles.clear();
      this.forcedLargeDiffs.clear();
      this.clearDetailNavigationState();
      this.activeTab = "prompt";
      this.tabStop = "prompt";
      this.animationTab = undefined;
      this.needsRecovery = false;
    }
    this.reconcileMessages(recentMessages);
    this.refreshDom();
    if (changed) void this.revalidate(true);
  }

  /** Mounts the stable tab list and panels, returning the persistent Prompt panel for the composer. */
  mount(container: HTMLElement): HTMLElement {
    this.rootEl?.remove();
    const root = container.createDiv({ cls: "opencode-session-view__island" });
    this.rootEl = root;
    const panels = root.createDiv({ cls: "opencode-session-view__island-panels" });
    this.promptPanelEl = panels.createDiv({ cls: "opencode-session-view__island-panel opencode-session-view__island-panel--prompt", attr: { role: "tabpanel" } });
    this.promptPanelEl.id = `${this.islandId}-panel-prompt`;
    this.promptPanelEl.setAttr("aria-labelledby", `${this.islandId}-tab-prompt`);
    this.promptContentEl = this.promptPanelEl.createDiv({ cls: "opencode-session-view__island-panel-content" });
    this.detailPanelEl = panels.createDiv({ cls: "opencode-session-view__island-panel opencode-session-view__island-panel--detail", attr: { role: "tabpanel" } });
    this.detailPanelEl.id = `${this.islandId}-panel-detail`;
    this.detailContentEl = this.detailPanelEl.createDiv({ cls: "opencode-session-view__island-panel-content" });
    const tabContainer = root.createDiv({ cls: "opencode-session-view__island-tabs" });
    this.tabListEl = tabContainer.createDiv({ cls: "opencode-session-view__island-tabs-inner", attr: { role: "tablist", "aria-label": "Session island" } });
    this.refreshDom();
    return this.promptContentEl;
  }

  /** Replaces todo state directly from the full-list `todo.updated` payload without another API call. */
  applyTodos(todos: OpenCodeTodo[]): void {
    this.todoRevision += 1;
    this.setTodos(todos);
  }

  /** Commits one authoritative todo list without changing its event-vs-fetch revision. */
  private setTodos(todos: OpenCodeTodo[]): void {
    this.todos = todos;
    this.todosLoaded = true;
    this.todoError = undefined;
    this.refreshDom();
  }

  /** Reconciles changed message summaries into the full-history cache without refetching during streaming. */
  reconcileMessages(messages: OpenCodeMessageBundle[]): void {
    let changed = false;
    for (const message of messages) {
      if (messageRole(message) !== "user") continue;
      const id = messageId(message);
      if (id) {
        const previous = this.messages.get(id);
        const previousSummary = previous?.info.summary ?? previous?.info.diffs;
        const nextSummary = message.info.summary ?? message.info.diffs;
        if (previous && JSON.stringify(previousSummary) === JSON.stringify(nextSummary)) continue;
        const revision = ++this.messageRevision;
        this.messageRevisions.set(id, revision);
        this.removedMessageIds.delete(id);
        this.removedMessageRevisions.delete(id);
        this.messages.set(id, message);
        changed = true;
      }
    }
    if (changed) this.refreshDom();
  }

  /** Removes one message from roll-up aggregation after a streamed message removal. */
  removeMessage(removedMessageId: string): void {
    const revision = ++this.messageRevision;
    this.removedMessageIds.add(removedMessageId);
    this.removedMessageRevisions.set(removedMessageId, revision);
    this.messageRevisions.delete(removedMessageId);
    if (!this.messages.delete(removedMessageId)) return;
    this.refreshDom();
  }

  /** Re-fetches non-durable todo state and full Git-session summaries after initial bind or SSE reconnect. */
  revalidate(refreshProject = false): Promise<void> {
    if (this.disposed || !this.sessionId) return Promise.resolve();
    if (this.hydration) return this.hydration;
    const version = this.bindingVersion;
    const sessionId = this.sessionId;
    const directory = this.directory;
    const todoRevision = this.todoRevision;
    const messageRevision = this.messageRevision;
    const shouldRefreshProject = refreshProject || this.gitState === "loading" || this.gitState === "error";
    const service = this.deps.plugin.requireOpenCodeService();
    const hydration = (async (): Promise<void> => {
      const [todoResult, projectResult] = await Promise.allSettled([
        service.getSessionTodo(sessionId, directory),
        shouldRefreshProject ? service.getCurrentProject(directory) : Promise.resolve(undefined),
      ]);
      if (!this.isCurrent(version, sessionId)) return;

      if (todoResult.status === "fulfilled") {
        if (todoRevision === this.todoRevision) this.setTodos(todoResult.value);
      } else {
        this.todoError = this.errorMessage(todoResult.reason);
        this.refreshDom();
      }

      if (projectResult.status === "fulfilled" && projectResult.value) {
        this.gitState = projectResult.value.vcs === "git" ? "git" : "non-git";
      } else if (projectResult.status === "rejected" && this.gitState === "loading") {
        this.gitState = "error";
      }
      this.refreshDom();
      if (this.gitState !== "git") return;

      try {
        const messages = await service.listMessages(sessionId, { directory });
        if (!this.isCurrent(version, sessionId)) return;
        const nextMessages = new Map<string, OpenCodeMessageBundle>();
        for (const message of messages) {
          const id = messageId(message);
          if (id && messageRole(message) === "user") nextMessages.set(id, message);
        }
        for (const [id, message] of this.messages) {
          if ((this.messageRevisions.get(id) ?? 0) > messageRevision) nextMessages.set(id, message);
        }
        for (const [id, revision] of this.removedMessageRevisions) {
          if (revision > messageRevision) nextMessages.delete(id);
        }
        this.messages = nextMessages;
        this.messagesLoaded = true;
        this.messageError = undefined;
        this.refreshDom();
      } catch (error) {
        if (!this.isCurrent(version, sessionId)) return;
        this.messageError = this.errorMessage(error);
        this.refreshDom();
      }
    })().finally(() => {
      if (this.hydration === hydration) this.hydration = undefined;
    });
    this.hydration = hydration;
    return hydration;
  }

  /** Defers reconnect recovery for hidden leaves and refreshes only when their session becomes active. */
  recoverAfterReconnect(): void {
    if (!this.deps.isActive() || this.hydration) {
      this.needsRecovery = true;
      if (this.hydration) void this.hydration.finally(() => this.activate());
      return;
    }
    this.needsRecovery = false;
    void this.revalidate();
  }

  /** Runs deferred reconnect recovery when Obsidian focuses this session leaf. */
  activate(): void {
    if (!this.needsRecovery || !this.deps.isActive()) return;
    this.needsRecovery = false;
    void this.revalidate();
  }

  /** Re-renders island labels and active detail content after display settings change, without fetching. */
  refreshDisplay(): void {
    this.refreshDom();
  }

  /** Refreshes tabs after context, descendant, notification, or auto-accept state changes. */
  refreshState(): void {
    this.refreshDom();
  }

  /** Repaints trigger labels/indicators without touching the mounted active panel. */
  refreshChrome(): void {
    if (!this.tabListEl) return;
    this.renderTabs(this.availableTabs());
  }

  /** Returns whether the mounted island can cycle through its tabs and collapsed state. */
  canCycleTabs(): boolean {
    return !!this.rootEl?.isConnected && this.availableTabs().length > 0;
  }

  /** Selects the next tab, then the collapsed state, and wraps; called by the Obsidian cycle command. */
  cycleTab(): void {
    const tabs = this.availableTabs();
    if (tabs.length === 0) return;
    if (!this.activeTab) {
      this.selectTab(tabs[0]);
      return;
    }
    const current = tabs.indexOf(this.activeTab);
    if (current === tabs.length - 1) {
      this.collapsePanels(this.activeTab);
      return;
    }
    this.selectTab(tabs[Math.max(0, current + 1)]);
  }

  /** Invalidates pending work and releases Session Island DOM references. */
  dispose(): void {
    this.disposed = true;
    this.bindingVersion += 1;
    this.renderVersion += 1;
    this.rootEl?.remove();
    this.rootEl = undefined;
    this.tabListEl = undefined;
    this.promptPanelEl = undefined;
    this.promptContentEl = undefined;
    this.detailPanelEl = undefined;
    this.detailContentEl = undefined;
  }

  /** Updates tab labels and the active panel while leaving the composer and timeline untouched. */
  private refreshDom(): void {
    if (!this.tabListEl || !this.promptPanelEl || !this.detailPanelEl || !this.detailContentEl) return;
    const tabs = this.availableTabs();
    if (this.activeTab && !tabs.includes(this.activeTab)) {
      this.activeTab = "prompt";
      this.tabStop = "prompt";
      this.animationTab = "prompt";
    }
    if (!tabs.includes(this.tabStop)) this.tabStop = "prompt";
    this.renderTabs(tabs);
    this.syncPanels();
    if (this.activeTab === "prompt" && this.animationTab === "prompt") {
      this.animatePanel(this.promptPanelEl);
      this.animationTab = undefined;
      this.deps.onPromptActivated();
    } else if (this.activeTab && this.activeTab !== "prompt") void this.renderActivePanel();
  }

  /** Returns Prompt plus conditional tabs backed by non-empty live session data. */
  private availableTabs(): SessionIslandTab[] {
    const tabs: SessionIslandTab[] = ["prompt"];
    if (this.todos.length > 0) tabs.push("todos");
    if (this.deps.model.descendantSessions.size > 0) tabs.push("subagents");
    if (this.gitState === "git" && this.turnDiffs().length > 0) tabs.push("turn");
    if (this.gitState === "git" && this.sessionFiles().length > 0) tabs.push("session");
    return tabs;
  }

  /** Renders native-variable tab controls and preserves keyboard focus across label changes. */
  private renderTabs(tabs: SessionIslandTab[]): void {
    const focusedTab = (document.activeElement as HTMLElement | null)?.dataset.islandTab as SessionIslandTab | undefined;
    this.tabListEl?.empty();
    for (const tab of tabs) {
      const selected = this.activeTab === tab;
      const button = this.tabListEl?.createEl("button", {
        cls: `opencode-session-view__island-tab${selected ? " is-active" : ""}`,
        attr: {
          type: "button",
          role: "tab",
          tabindex: selected || (!this.activeTab && this.tabStop === tab) ? "0" : "-1",
          "aria-selected": String(selected),
          "aria-controls": tab === "prompt" ? `${this.islandId}-panel-prompt` : `${this.islandId}-panel-detail`,
        },
      });
      if (!button) continue;
      button.dataset.islandTab = tab;
      button.id = `${this.islandId}-tab-${tab}`;
      this.renderTabLabel(button, tab);
      button.addEventListener("click", () => this.selectTab(tab));
      button.addEventListener("keydown", (event) => this.handleTabKeydown(event, tabs));
    }
    if (focusedTab && tabs.includes(focusedTab)) this.tabListEl?.querySelector<HTMLElement>(`[data-island-tab="${focusedTab}"]`)?.focus();
  }

  /** Renders one glanceable Prompt, todo, subagent, or diff tab label. */
  private renderTabLabel(button: HTMLButtonElement, tab: SessionIslandTab): void {
    const container = button.createSpan({ cls: "opencode-session-view__island-tab-inner" });
    const icon = container.createSpan({ cls: "opencode-session-view__island-tab-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, tab === "todos" ? configuredToolIcon("todowrite", this.deps.plugin.settings.customToolDisplays) : ISLAND_TAB_ICONS[tab]);
    const info = container.createSpan({ cls: "opencode-session-view__island-tab-info" });
    if (tab === "prompt") {
      this.renderPromptTabLabel(button, info);
      return;
    }
    if (tab === "todos") {
      const title = todoTabTitle(this.todos);
      button.title = `${title} todos completed`;
      button.setAttr("aria-label", `Todos: ${title} completed`);
      info.createSpan({ text: title, cls: "opencode-session-view__island-tab-title" });
      return;
    }
    if (tab === "subagents") {
      const working = [...this.deps.model.descendantSessions.values()].filter((item) => isActiveSessionStatus(item.statusType)).length;
      const title = working > 0 ? `${working} working...` : String(this.deps.model.descendantSessions.size);
      button.title = working > 0 ? `${working} subagents working` : `${this.deps.model.descendantSessions.size} subagents`;
      button.setAttr("aria-label", button.title);
      info.createSpan({ text: title, cls: "opencode-session-view__island-tab-title" });
      return;
    }
    const diffs = tab === "turn" ? this.turnDiffs() : this.sessionFiles();
    const label = tab === "turn" ? "Last turn" : "Session";
    button.setAttr("aria-label", `${label} diffs`);
    button.title = `${label} diffs`;
    const totals = diffTotals(diffs);
    const stats = info.createSpan({ cls: "opencode-session-view__island-tab-stats" });
    stats.createSpan({ text: `+${totals.additions}`, cls: "opencode-session-view__diff-stat-add" });
    stats.createSpan({ text: `−${totals.deletions}`, cls: "opencode-session-view__diff-stat-del" });
  }

  /** Renders the Prompt context summary followed by auto-accept and mute indicators. */
  private renderPromptTabLabel(button: HTMLButtonElement, container: HTMLElement): void {
    const usage = contextUsage(this.deps.model);
    const mode = normalizeSessionIslandContextLabel(this.deps.plugin.settings.sessionIslandContextLabel);
    const title = !usage
      ? "Prompt"
      : mode === "tokens"
        ? formatCompactNumber(usage.used)
        : `${usage.percentage}%`;
    const states: string[] = [];
    container.createSpan({ text: title, cls: "opencode-session-view__island-tab-title" });
    if (this.deps.shouldAutoApprove()) {
      const indicator = container.createSpan({ cls: "opencode-session-view__island-tab-indicator is-auto-accept", attr: { "aria-hidden": "true" } });
      setIcon(indicator, "shield-alert");
      states.push(this.deps.isAutoApproveInherited() ? "auto-accept inherited from an ancestor session" : "auto-accept enabled");
    }
    if (this.deps.isSessionMuted()) {
      const indicator = container.createSpan({ cls: "opencode-session-view__island-tab-indicator", attr: { "aria-hidden": "true" } });
      setIcon(indicator, "bell-off");
      states.push("notifications muted");
    }
    const accessible = states.length > 0 ? `${title}, ${states.join(", ")}` : title;
    button.title = accessible;
    button.setAttr("aria-label", accessible);
  }

  /** Selects one available tab, or collapses the island when its active trigger is selected again. */
  private selectTab(tab: SessionIslandTab): void {
    if (!this.availableTabs().includes(tab)) return;
    if (this.activeTab === "turn" || this.activeTab === "session") this.collapseOpenFiles();
    if (this.activeTab === tab) {
      this.collapsePanels(tab);
      return;
    }
    this.activeTab = tab;
    this.tabStop = tab;
    this.animationTab = tab;
    if (tab === "subagents" || tab === "turn" || tab === "session") this.pendingDetailFocus = tab;
    this.refreshDom();
    const selected = this.tabListEl?.querySelector<HTMLElement>(`[data-island-tab="${tab}"]`);
    selected?.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    selected?.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "nearest" });
  }

  /** Hides both panels while retaining the last active trigger as the keyboard tab stop. */
  private collapsePanels(tab: SessionIslandTab): void {
    this.collapseOpenFiles();
    this.activeTab = undefined;
    this.tabStop = tab;
    this.animationTab = undefined;
    this.pendingDetailFocus = undefined;
    this.refreshDom();
    this.tabListEl?.querySelector<HTMLElement>(`[data-island-tab="${tab}"]`)?.focus({ preventScroll: true });
  }

  /** Synchronizes panel ARIA and inert state without unmounting the hidden composer. */
  private syncPanels(): void {
    if (!this.promptPanelEl || !this.detailPanelEl) return;
    const promptActive = this.activeTab === "prompt";
    const detailActive = this.activeTab !== undefined && !promptActive;
    this.promptPanelEl.inert = !promptActive;
    this.promptPanelEl.setAttr("aria-hidden", String(!promptActive));
    this.detailPanelEl.inert = !detailActive;
    this.detailPanelEl.setAttr("aria-hidden", String(!detailActive));
    if (promptActive) {
      this.renderVersion += 1;
      this.detailContentEl?.empty();
      delete this.detailPanelEl.dataset.islandPanel;
      this.detailPanelEl.removeAttribute("aria-labelledby");
    } else if (detailActive) {
      this.detailPanelEl.dataset.islandPanel = this.activeTab;
      this.detailPanelEl.setAttr("aria-labelledby", `${this.islandId}-tab-${this.activeTab}`);
    } else {
      this.renderVersion += 1;
      this.detailContentEl?.empty();
      delete this.detailPanelEl.dataset.islandPanel;
      this.detailPanelEl.removeAttribute("aria-labelledby");
    }
  }

  /** Implements native tab-strip arrow, Home, End, Enter, and Space keyboard behavior. */
  private handleTabKeydown(event: KeyboardEvent, tabs: SessionIslandTab[]): void {
    const current = (event.currentTarget as HTMLElement).dataset.islandTab as SessionIslandTab | undefined;
    const index = current ? tabs.indexOf(current) : -1;
    let target: SessionIslandTab | undefined;
    if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
    else if (event.key === "Home") target = tabs[0];
    else if (event.key === "End") target = tabs.at(-1);
    else if ((event.key === "Enter" || event.key === " ") && current) {
      event.preventDefault();
      this.selectTab(current);
      return;
    }
    if (!target) return;
    event.preventDefault();
    this.tabListEl?.querySelector<HTMLElement>(`[data-island-tab="${target}"]`)?.focus();
  }

  /** Renders the currently selected panel and guards asynchronous Markdown from stale replacement. */
  private async renderActivePanel(): Promise<void> {
    const panel = this.detailContentEl;
    const tab = this.activeTab;
    if (!panel || !tab || tab === "prompt") return;
    const version = ++this.renderVersion;
    const staging = document.createElement("div");
    if (tab === "todos") await this.renderTodos(staging);
    else if (tab === "subagents") this.renderSubagents(staging);
    else if (tab === "turn") {
      const turn = this.latestTurn();
      this.renderDiffFiles(staging, (turn?.diffs ?? []).map((diff) => ({ ...diff, turns: [{ messageId: turn?.messageId ?? "turn", created: turn?.created ?? 0, diff }] })), "turn");
    }
    else this.renderSessionDiffs(staging);
    if (version !== this.renderVersion || panel !== this.detailContentEl || tab !== this.activeTab) return;
    const restoreNavigationFocus = panel.contains(document.activeElement);
    panel.replaceChildren(...Array.from(staging.childNodes));
    if (this.animationTab === tab && this.detailPanelEl) {
      this.animatePanel(this.detailPanelEl);
      this.animationTab = undefined;
    }
    if (this.pendingDetailFocus === tab || restoreNavigationFocus) {
      this.pendingDetailFocus = undefined;
      window.setTimeout(() => {
        if (this.activeTab === tab) this.focusDetailNavigation(tab);
      }, 0);
    }
  }

  /** Restarts the native-variable roll-up animation for the newly selected panel. */
  private animatePanel(panel: HTMLElement): void {
    panel.removeClass("is-rolling-up");
    void panel.offsetWidth;
    panel.addClass("is-rolling-up");
  }

  /** Renders descendant sessions as a roving list whose rows open their owning session. */
  private renderSubagents(panel: HTMLElement): void {
    const list = panel.createDiv({ cls: "opencode-session-view__island-subagents" });
    const descendants = [...this.deps.model.descendantSessions];
    if (!descendants.some(([sessionId]) => sessionId === this.selectedSubagentId)) this.selectedSubagentId = descendants[0]?.[0];
    list.addEventListener("keydown", (event) => this.handleSubagentKeydown(event, list));
    for (const [sessionId, info] of this.deps.model.descendantSessions) {
      const working = isActiveSessionStatus(info.statusType);
      const row = list.createEl("button", {
        cls: "opencode-session-view__island-subagent",
        attr: {
          type: "button",
          tabindex: this.selectedSubagentId === sessionId ? "0" : "-1",
          "aria-label": `Open subagent ${info.title}${working ? ", working" : ""}`,
          "aria-busy": String(working),
        },
      });
      row.dataset.subagentId = sessionId;
      const icon = row.createSpan({ cls: "opencode-session-view__island-subagent-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "bot");
      row.createSpan({ text: info.title, cls: "opencode-session-view__island-subagent-title" });
      if (working) {
        row.createSpan({
          cls: "opencode-session-view__island-subagent-status opencode-session-view__message-working-indicator",
          attr: { "aria-hidden": "true" },
        });
      } else {
        row.createSpan({ text: "Idle", cls: "opencode-session-view__island-subagent-status" });
      }
      row.toggleClass("is-working", working);
      row.addEventListener("focus", () => this.selectSubagentRow(list, row, sessionId, false));
      row.addEventListener("click", () => void this.deps.plugin.openSessionTab(sessionId, info.title));
    }
  }

  /** Handles row movement and open-in-workspace actions for the Subagents panel. */
  private handleSubagentKeydown(event: KeyboardEvent, list: HTMLElement): void {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>(".opencode-session-view__island-subagent");
    if (!row) return;
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(".opencode-session-view__island-subagent"));
    const sessionId = row.dataset.subagentId;
    const index = rows.indexOf(row);
    if (!sessionId || index < 0) return;
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const info = this.deps.model.descendantSessions.get(sessionId);
      if (info) void this.deps.plugin.openSessionTab(sessionId, info.title);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const target = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    this.selectSubagentRow(list, target, target.dataset.subagentId!, true);
  }

  /** Selects one subagent row and keeps the native tab order on that row alone. */
  private selectSubagentRow(list: HTMLElement, row: HTMLButtonElement, sessionId: string, focus: boolean): void {
    this.selectedSubagentId = sessionId;
    for (const item of Array.from(list.querySelectorAll<HTMLButtonElement>(".opencode-session-view__island-subagent"))) {
      item.tabIndex = item === row ? 0 : -1;
    }
    if (focus) row.focus({ preventScroll: true });
  }

  /** Renders the complete endpoint todo list through Obsidian's MarkdownRenderer. */
  private async renderTodos(panel: HTMLElement): Promise<void> {
    if (!this.todosLoaded) {
      this.renderLoadState(panel, this.todoError ? "Unable to load todos." : "Loading todos…", this.todoError);
      return;
    }
    if (this.todos.length === 0) {
      panel.createDiv({ text: "No session todos.", cls: "opencode-session-view__rollup-empty" });
      return;
    }
    const character = normalizeTodoStatusCharacter(this.deps.plugin.settings.todoInProgressStatusCharacter);
    const body = panel.createDiv({ cls: "opencode-session-view__rollup-todos markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(
      sessionTodoMarkdown(this.todos, character),
      body,
      `opencode-session/${this.sessionId ?? "session"}.md`,
      this.deps.component,
    );
    const rows = Array.from(body.querySelectorAll<HTMLElement>("li.task-list-item, li[data-task]"));
    for (const [index, row] of rows.entries()) {
      const todo = this.todos[index];
      if (todo?.status === "in_progress" && !character) row.addClass("is-in-progress");
    }
    for (const checkbox of Array.from(body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) checkbox.disabled = true;
  }

  /** Renders session-level files or the authoritative loading/error state for their full-history request. */
  private renderSessionDiffs(panel: HTMLElement): void {
    if (!this.messagesLoaded) {
      this.renderLoadState(panel, this.messageError ? "Unable to load session diffs." : "Loading session diffs…", this.messageError);
      return;
    }
    this.renderDiffFiles(panel, this.sessionFiles(), "session");
  }

  /** Renders one expandable row per affected file while deferring syntax highlighting until disclosure. */
  private renderDiffFiles(panel: HTMLElement, files: SessionDiffFileSummary[], scope: "turn" | "session"): void {
    if (files.length === 0) {
      panel.createDiv({ text: scope === "turn" ? "No changes in the latest summarized turn." : "No summarized changes in this session.", cls: "opencode-session-view__rollup-empty" });
      return;
    }
    const list = panel.createDiv({ cls: "opencode-session-view__rollup-files" });
    const fileKeys = new Set(files.map((file) => `${scope}:${file.file}`));
    if (!fileKeys.has(this.selectedFileKeys.get(scope) ?? "")) this.selectedFileKeys.set(scope, `${scope}:${files[0]?.file ?? ""}`);
    list.addEventListener("keydown", (event) => this.handleDiffKeydown(event, list, scope));
    for (const file of files) {
      const key = `${scope}:${file.file}`;
      const details = list.createEl("details", { cls: "opencode-session-view__rollup-file" });
      details.open = this.openFiles.has(key);
      const summary = details.createEl("summary", {
        cls: "opencode-session-view__rollup-file-summary",
        attr: { title: file.file, tabindex: this.selectedFileKeys.get(scope) === key ? "0" : "-1" },
      });
      summary.dataset.fileKey = key;
      const chevron = summary.createSpan({ cls: "opencode-session-view__rollup-file-chevron" });
      setIcon(chevron, "chevron-right");
      this.renderDisplayPath(summary.createSpan({ cls: "opencode-session-view__rollup-file-path" }), file.file);
      const stats = summary.createSpan({ cls: "opencode-session-view__diff-stats" });
      stats.createSpan({ text: `+${file.additions}`, cls: "opencode-session-view__diff-stat-add" });
      stats.createSpan({ text: `−${file.deletions}`, cls: "opencode-session-view__diff-stat-del" });
      let hydrated = false;
      const hydrate = (): void => {
        if (!details.open || hydrated) return;
        hydrated = true;
        const body = details.createDiv({
          cls: "opencode-session-view__rollup-file-body",
          attr: { role: "grid", tabindex: "0", "aria-label": `Diff for ${file.file}` },
        });
        body.addEventListener("focus", () => this.ensureActiveDiffRow(body));
        body.addEventListener("click", (event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-diff-row]");
          if (row && body.contains(row)) this.selectActiveDiffRow(body, row, true);
        });
        body.addEventListener("keydown", (event) => this.handleDiffLineKeydown(event, body, summary));
        body.addEventListener(DIFF_ACTIVE_ROW_EVENT, (event) => {
          const row = (event as CustomEvent<{ row?: HTMLElement }>).detail.row;
          if (row && body.contains(row)) this.selectActiveDiffRow(body, row, true);
        });
        const renderVersion = this.renderVersion;
        void this.renderTurnPatches(body, file.turns, key, () => renderVersion === this.renderVersion);
      };
      details.addEventListener("toggle", () => {
        if (details.open) this.openExclusiveFile(list, details, key, scope);
        else this.openFiles.delete(key);
        hydrate();
      });
      summary.addEventListener("focus", () => this.selectDiffRow(list, summary, scope, key, false));
      hydrate();
    }
  }

  /** Implements disclosure-row movement and entry into an expanded file's line cursor. */
  private handleDiffKeydown(event: KeyboardEvent, list: HTMLElement, scope: "turn" | "session"): void {
    const summary = (event.target as HTMLElement).closest<HTMLElement>(".opencode-session-view__rollup-file-summary");
    if (!summary) return;
    const details = summary.parentElement as HTMLDetailsElement | null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".opencode-session-view__rollup-file-summary"));
    const index = rows.indexOf(summary);
    if (!details || index < 0) return;
    if (event.key === "ArrowLeft" && details.open) {
      event.preventDefault();
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
      return;
    }
    if ((event.key === "ArrowRight" || event.key === " " || event.key === "Spacebar") && !details.open) {
      event.preventDefault();
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? rows[0] : rows.at(-1);
      if (target) this.selectDiffRow(list, target, scope, target.dataset.fileKey!, true);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (details.open) {
      const body = details.querySelector<HTMLElement>(".opencode-session-view__rollup-file-body");
      if (!body) return;
      event.preventDefault();
      const rows = Array.from(body.querySelectorAll<HTMLElement>("[data-diff-row]"));
      const target = event.key === "ArrowDown" ? rows[0] : rows.at(-1);
      if (target) this.selectActiveDiffRow(body, target, true);
      return;
    }
    event.preventDefault();
    const target = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    this.selectDiffRow(list, target, scope, target.dataset.fileKey!, true);
  }

  /** Moves the active line cursor and expands or restores folded context without creating extra tab stops. */
  private handleDiffLineKeydown(event: KeyboardEvent, body: HTMLElement, summary: HTMLElement): void {
    const rows = Array.from(body.querySelectorAll<HTMLElement>("[data-diff-row]"));
    const current = this.activeDiffRow(body) ?? rows[0];
    if (!current) return;
    const index = rows.indexOf(current);
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home"
        ? rows[0]
        : event.key === "End"
          ? rows.at(-1)
          : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (target) this.selectActiveDiffRow(body, target, false);
      return;
    }
    if ((event.key === "ArrowRight" || event.key === " " || event.key === "Spacebar") && current.hasAttribute("data-diff-folded")) {
      event.preventDefault();
      current.click();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (collapseExpandedDiffContext(current)) return;
      const details = summary.parentElement as HTMLDetailsElement | null;
      if (details?.open) {
        details.open = false;
        details.dispatchEvent(new Event("toggle"));
        summary.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      summary.focus({ preventScroll: true });
    }
  }

  /** Ensures one rendered row is exposed as the grid's active descendant when keyboard focus enters. */
  private ensureActiveDiffRow(body: HTMLElement): void {
    if (this.activeDiffRow(body)) return;
    const first = body.querySelector<HTMLElement>("[data-diff-row]");
    if (first) this.selectActiveDiffRow(body, first, false);
  }

  /** Updates active-descendant semantics and keeps the current line inside the scroll viewport. */
  private selectActiveDiffRow(body: HTMLElement, row: HTMLElement, focus: boolean): void {
    for (const item of Array.from(body.querySelectorAll<HTMLElement>("[data-diff-row]"))) {
      item.toggleClass("is-active", item === row);
    }
    body.setAttr("aria-activedescendant", row.id);
    if (focus) body.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  /** Returns the visible row currently owned by one diff grid's active-descendant cursor. */
  private activeDiffRow(body: HTMLElement): HTMLElement | undefined {
    const id = body.getAttribute("aria-activedescendant");
    const row = id ? document.getElementById(id) : null;
    return row && body.contains(row) ? row : undefined;
  }

  /** Selects one diff row and retains it as the only normal tab stop in its panel. */
  private selectDiffRow(list: HTMLElement, summary: HTMLElement, scope: "turn" | "session", key: string, focus: boolean): void {
    this.selectedFileKeys.set(scope, key);
    for (const item of Array.from(list.querySelectorAll<HTMLElement>(".opencode-session-view__rollup-file-summary"))) {
      item.tabIndex = item === summary ? 0 : -1;
    }
    if (focus) summary.focus({ preventScroll: true });
  }

  /** Focuses the selected first row after a keyboard-navigable detail panel becomes visible. */
  private focusDetailNavigation(tab: SessionIslandTab): void {
    if (!this.detailContentEl) return;
    if (tab === "subagents") {
      const selected = this.detailContentEl.querySelector<HTMLButtonElement>(`[data-subagent-id="${this.selectedSubagentId}"]`)
        ?? this.detailContentEl.querySelector<HTMLButtonElement>(".opencode-session-view__island-subagent");
      selected?.focus({ preventScroll: true });
      return;
    }
    if (tab === "turn" || tab === "session") {
      const selected = this.detailContentEl.querySelector<HTMLElement>(`[data-file-key="${this.selectedFileKeys.get(tab)}"]`)
        ?? this.detailContentEl.querySelector<HTMLElement>(".opencode-session-view__rollup-file-summary");
      selected?.focus({ preventScroll: true });
    }
  }

  /** Keeps one expanded file in the visible diff panel. */
  private openExclusiveFile(list: HTMLElement, active: HTMLDetailsElement, key: string, scope: "turn" | "session"): void {
    for (const details of Array.from(list.querySelectorAll<HTMLDetailsElement>(".opencode-session-view__rollup-file"))) {
      if (details !== active && details.open) details.open = false;
    }
    for (const openKey of this.openFiles) {
      if (openKey.startsWith(`${scope}:`)) this.openFiles.delete(openKey);
    }
    this.openFiles.add(key);
  }

  /** Collapses every remembered file when panel focus moves to another Session Island tab. */
  private collapseOpenFiles(): void {
    this.openFiles.clear();
    for (const details of Array.from(this.detailContentEl?.querySelectorAll<HTMLDetailsElement>(".opencode-session-view__rollup-file[open]") ?? [])) {
      details.open = false;
    }
  }

  /** Renders chronological per-turn patches for one expanded session file. */
  private async renderTurnPatches(container: HTMLElement, turns: TurnFileDiff[], fileKey: string, shouldCommit: () => boolean): Promise<void> {
    for (const [index, turn] of turns.entries()) {
      if (turns.length > 1) container.createDiv({ text: `Turn ${index + 1}`, cls: "opencode-session-view__rollup-turn-heading" });
      const patch = turn.diff.patch;
      if (!patch) {
        container.createDiv({ text: "Patch unavailable.", cls: "opencode-session-view__rollup-empty" });
        continue;
      }
      const largeKey = `${fileKey}:${turn.messageId}`;
      if (turn.diff.additions + turn.diff.deletions > LARGE_DIFF_CHANGED_LINES && !this.forcedLargeDiffs.has(largeKey)) {
        const gate = container.createDiv({ cls: "opencode-session-view__rollup-large-diff" });
        gate.createSpan({ text: `${turn.diff.additions + turn.diff.deletions} changed lines` });
        const render = gate.createEl("button", { text: "Render anyway", cls: "mod-muted" });
        render.addEventListener("click", () => {
          this.forcedLargeDiffs.add(largeKey);
          container.empty();
          void this.renderTurnPatches(container, turns, fileKey, shouldCommit);
        });
        continue;
      }
      await renderDiffSection(container, { file: turn.diff.file, patch, additions: turn.diff.additions, deletions: turn.diff.deletions }, {
        component: this.deps.component,
        sessionId: this.sessionId,
        sessionDirectory: this.directory,
      }, { foldContext: true, shouldCommit });
    }
  }

  /** Renders an error/loading message and an explicit retry action for failed authoritative loads. */
  private renderLoadState(panel: HTMLElement, message: string, error?: string): void {
    const state = panel.createDiv({ cls: "opencode-session-view__rollup-state" });
    state.createDiv({ text: message, cls: "opencode-session-view__rollup-empty" });
    if (!error) return;
    state.createDiv({ text: error, cls: "opencode-session-view__rollup-error" });
    const retry = state.createEl("button", { text: "Retry" });
    retry.addEventListener("click", () => void this.revalidate());
  }

  /** Renders a muted directory prefix and normal basename for one diff file. */
  private renderDisplayPath(container: HTMLElement, rawPath: string): void {
    const path = splitPath(displayPath(rawPath, this.directory));
    if (path.prefix) container.createSpan({ text: path.prefix, cls: "opencode-session-view__rollup-path-prefix" });
    container.createSpan({ text: path.basename, cls: "opencode-session-view__rollup-path-basename" });
  }

  /** Returns the latest completed turn summary before the active rewind boundary. */
  private latestTurn(): SummarizedTurnDiffs | undefined {
    return latestSummarizedTurnDiffs([...this.messages.values()], this.deps.getRevertMessageId());
  }

  /** Returns file diffs for the latest completed turn. */
  private turnDiffs(): DiffFileSummary[] {
    return this.latestTurn()?.diffs ?? [];
  }

  /** Returns all active session turn summaries grouped by file. */
  private sessionFiles(): SessionDiffFileSummary[] {
    return sessionDiffFiles([...this.messages.values()], this.deps.getRevertMessageId());
  }

  /** Checks that asynchronous hydration still belongs to the mounted session binding. */
  private isCurrent(version: number, sessionId: string): boolean {
    return !this.disposed && version === this.bindingVersion && sessionId === this.sessionId;
  }

  /** Clears row/disclosure state that belongs to the previous server session binding. */
  private clearDetailNavigationState(): void {
    this.selectedSubagentId = undefined;
    this.selectedFileKeys.clear();
    this.pendingDetailFocus = undefined;
  }

  /** Converts unknown request failures into compact user-visible text. */
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }
}
