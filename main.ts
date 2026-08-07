import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_OPENCODE_SETTINGS, OpenCodeSettingTab, type OpenCodePluginSettings } from "./src/settings";
import { OpenCodeService } from "./src/services/opencode-service";
import type { OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from "./src/services/opencode-types";
import { confirmSessionArchive, requestSessionTitle, type SessionArchiveNode } from "./src/session-actions";
import { AgentPanelView, VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./src/views/AgentPanelView";
import { DiffPanelView, VIEW_TYPE_OPENCODE_DIFF_PANEL, type DiffPanelContext } from "./src/views/DiffPanelView";
import { SessionView, VIEW_TYPE_OPENCODE_SESSION } from "./src/views/SessionView";
import { normalizeWorkingAnimation } from "./src/session-state";

export default class OpenCodePlugin extends Plugin {
  settings: OpenCodePluginSettings = DEFAULT_OPENCODE_SETTINGS;
  opencode?: OpenCodeService;
  private diffPanelContext: DiffPanelContext = {};
  private diffPanelSourceLeaf?: WorkspaceLeaf;
  private archivingSessionIds = new Set<string>();
  private respondingSessionRequestIds = new Set<string>();

  /** Initializes plugin settings and the OpenCode API service used by future UI views. */
  async onload(): Promise<void> {
    await this.loadSettings();
    this.opencode = new OpenCodeService(this.settings.server);

    this.registerView(VIEW_TYPE_OPENCODE_AGENT_PANEL, (leaf) => new AgentPanelView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_SESSION, (leaf) => new SessionView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_DIFF_PANEL, (leaf) => new DiffPanelView(leaf, this));
    this.addSettingTab(new OpenCodeSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        void this.syncDiffPanelToActiveSessionLeaf(leaf);
        this.syncAgentPanelToActiveSessionLeaf(leaf);
      }),
    );
    void this.syncDiffPanelToActiveSessionLeaf(this.app.workspace.activeLeaf);

    this.addRibbonIcon("bot", "OpenCode agents", () => {
      void this.activateAgentPanel();
    });

    this.addCommand({
      id: "opencode-open-agent-panel",
      name: "Open agents panel",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "A" }],
      callback: () => void this.activateAgentPanel(),
    });

    this.addCommand({
      id: "opencode-open-directory",
      name: "Open directory in OpenCode agents panel",
      callback: () => void this.openDirectoryWithPicker(),
    });

    this.addCommand({
      id: "opencode-check-connection",
      name: "Check OpenCode server connection",
      callback: () => this.checkConnection(),
    });

    this.addCommand({
      id: "opencode-open-diff-panel",
      name: "Open diffs panel",
      callback: () => void this.activateDiffPanel(),
    });

    this.addCommand({
      id: "opencode-toggle-context-tool-grouping",
      name: "Toggle context tool grouping",
      callback: () => void this.toggleContextToolGrouping(),
    });

    this.addCommand({
      id: "opencode-toggle-reasoning-blocks",
      name: "Toggle reasoning blocks",
      callback: () => void this.toggleReasoningBlocks(),
    });
  }

  /** Detaches plugin-owned views before releasing service resources during unload or reload. */
  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_SESSION);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL);
    this.opencode?.dispose();
  }

  /** Returns the initialized OpenCode API service for registered plugin views. */
  requireOpenCodeService(): OpenCodeService {
    if (!this.opencode) throw new Error("OpenCode service has not been initialized.");
    return this.opencode;
  }

  /** Returns user-opened absolute directories; referenced by the agents panel refresh loop. */
  getOpenedDirectories(): string[] {
    return [...this.settings.openedDirectories];
  }

  /** Opens a native desktop directory chooser, then persists and displays the selected directory. */
  async openDirectoryWithPicker(): Promise<void> {
    const directory = await this.pickDirectory();
    if (!directory) return;
    await this.addOpenedDirectory(directory);
  }

  /** Opens an OpenCode session in a main Obsidian tab; referenced by AgentPanelView. */
  async openSessionTab(sessionId: string, sessionTitle?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).find((leaf) => {
      const view = leaf.view;
      return view instanceof SessionView && view.getState().sessionId === sessionId;
    });
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { sessionId, sessionTitle }, active: true });
    this.app.workspace.revealLeaf(leaf);
    await this.activateDiffPanel();
  }

  /** Opens a client-only draft tab; the server session is created only on its first send. */
  async openNewSessionTab(directory: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    const draftId = crypto.randomUUID();
    await leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { draftId, draftDirectory: directory }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Returns server session ids retained by loaded or deferred OpenCode tabs. */
  getOpenSessionIds(excludedLeaf?: WorkspaceLeaf): Set<string> {
    const sessionIds = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf === excludedLeaf) continue;
      const sessionId = leaf.getViewState().state?.sessionId;
      if (typeof sessionId === "string") sessionIds.add(sessionId);
    }
    return sessionIds;
  }

  /** Evicts closed-session state after the last workspace tab for that session closes. */
  notifySessionViewClosed(leaf: WorkspaceLeaf, sessionId: string | undefined): void {
    if (this.diffPanelSourceLeaf === leaf) this.diffPanelSourceLeaf = undefined;
    if (!sessionId || this.getOpenSessionIds(leaf).has(sessionId)) return;
    if (this.diffPanelContext.sessionId === sessionId) this.diffPanelContext = {};
    for (const diffLeaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL)) {
      if (diffLeaf.view instanceof DiffPanelView) diffLeaf.view.evictSnapshot(sessionId);
    }
  }

  /** Marks cached summaries stale when a session emits new diff state. */
  markDiffPanelSessionDirty(sessionId: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL)) {
      if (leaf.view instanceof DiffPanelView) leaf.view.markSessionDirty(sessionId);
    }
  }

  /** Prompts for a title and applies the v1 session rename; referenced by menu-based rename entry points. */
  async requestSessionRename(sessionId: string, currentTitle: string, directory?: string): Promise<void> {
    const title = await requestSessionTitle(this.app, currentTitle);
    if (!title || title === currentTitle.trim()) return;
    try {
      await this.renameSession(sessionId, title, directory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to rename OpenCode session.");
    }
  }

  /** Renames one session through v1 PATCH and synchronizes all open session handles. */
  async renameSession(sessionId: string, title: string, directory?: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Session name cannot be empty.");
    const updated = await this.requireOpenCodeService().updateSession(sessionId, { title: trimmed }, directory);
    const resolvedTitle = updated.title?.trim() || trimmed;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView && leaf.view.getState().sessionId === sessionId) leaf.view.applySessionTitle(resolvedTitle);
    }
    await this.refreshAgentPanels({ showLoading: false });
  }

  /** Confirms and archives a target plus every descendant through v1 PATCH calls. */
  async requestSessionArchive(sessionId: string, directory?: string): Promise<void> {
    if (this.archivingSessionIds.has(sessionId)) return;
    this.archivingSessionIds.add(sessionId);
    let archivedCount = 0;
    try {
      const tree = await this.loadSessionArchiveTree(sessionId, directory);
      const targets = this.flattenArchiveTargets(tree);
      if (targets.length === 0) return;
      if (this.settings.archiveConfirmation && !(await confirmSessionArchive(this.app, tree))) return;

      const archivedAt = Date.now();
      for (const target of targets) {
        await this.requireOpenCodeService().archiveSession(target.id, archivedAt, target.directory);
        archivedCount += 1;
      }
      await this.refreshAgentPanels({ showLoading: false });
      new Notice(targets.length === 1 ? `Archived ${tree.title}.` : `Archived ${tree.title} and ${targets.length - 1} descendant sessions.`);
    } catch (error) {
      if (archivedCount > 0) await this.refreshAgentPanels({ showLoading: false });
      const message = error instanceof Error ? error.message : "Unable to archive OpenCode session.";
      new Notice(archivedCount > 0 ? `Archived ${archivedCount} descendant sessions before archival stopped: ${message}` : message);
    } finally {
      this.archivingSessionIds.delete(sessionId);
    }
  }

  /** Returns the latest active session/turn context; referenced by DiffPanelView on open. */
  getDiffPanelContext(): DiffPanelContext {
    return { ...this.diffPanelContext };
  }

  /** Updates diffs only when the requesting session leaf still owns the panel context. */
  async updateDiffPanelContext(context: DiffPanelContext, options?: { force?: boolean; sourceLeaf?: WorkspaceLeaf }): Promise<void> {
    if (options?.sourceLeaf) {
      if (this.diffPanelSourceLeaf && this.diffPanelSourceLeaf !== options.sourceLeaf) return;
      if (!this.diffPanelSourceLeaf && this.app.workspace.activeLeaf !== options.sourceLeaf) return;
      this.diffPanelSourceLeaf = options.sourceLeaf;
    }
    const next = { ...this.diffPanelContext, ...context };
    if (!options?.force && JSON.stringify(this.diffPanelContext) === JSON.stringify(next)) return;
    this.diffPanelContext = next;
    await this.refreshDiffPanels(options?.force === true);
  }

  /** Mirrors native Outline behavior by rebinding the diff panel to the focused OpenCode session tab. */
  private async syncDiffPanelToActiveSessionLeaf(leaf: WorkspaceLeaf | null): Promise<void> {
    if (!leaf) return;
    const state = leaf.getViewState();
    if (state.type !== VIEW_TYPE_OPENCODE_SESSION) return;
    this.diffPanelSourceLeaf = leaf;
    const sessionView = leaf.view instanceof SessionView ? leaf.view : undefined;
    const context = sessionView
      ? sessionView.diffPanelContext()
      : {
          sessionId: typeof state.state?.sessionId === "string" ? state.state.sessionId : undefined,
          sessionTitle: typeof state.state?.sessionTitle === "string" ? state.state.sessionTitle : undefined,
          sessionDirectory: undefined,
        };
    await this.updateDiffPanelContext(context, { force: !sessionView, sourceLeaf: leaf });
  }

  /** Pushes the focused session tab into every open agents panel so its row is revealed. */
  private syncAgentPanelToActiveSessionLeaf(leaf: WorkspaceLeaf | null): void {
    const sessionId = this.sessionIdFromLeaf(leaf);
    if (!sessionId) return;
    for (const panelLeaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL)) {
      if (panelLeaf.view instanceof AgentPanelView) panelLeaf.view.setActiveSession(sessionId);
    }
  }

  /** Returns the session id of the currently focused session tab, if any; referenced by AgentPanelView.onOpen. */
  getActiveSessionId(): string | undefined {
    return this.sessionIdFromLeaf(this.app.workspace.activeLeaf);
  }

  /** Extracts the session id from a leaf when it is an OpenCode session view. */
  private sessionIdFromLeaf(leaf: WorkspaceLeaf | null | undefined): string | undefined {
    if (!leaf) return undefined;
    const state = leaf.getViewState();
    if (state.type !== VIEW_TYPE_OPENCODE_SESSION) return undefined;
    const sessionId = state.state?.sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  }

  /** Persists a directory exactly like OpenCode's UI-local opened-project list. */
  async addOpenedDirectory(directory: string): Promise<void> {
    const normalized = this.normalizeDirectory(directory);
    const existing = this.settings.openedDirectories.filter((item) => this.pathKey(item) !== this.pathKey(normalized));
    this.settings.openedDirectories = [normalized, ...existing];
    await this.saveSettings();
    new Notice(`Opened ${normalized} in OpenCode agents panel.`);
    await this.refreshAgentPanels();
  }

  /** Removes a previously opened directory from the panel's local workspace list. */
  async removeOpenedDirectory(directory: string): Promise<void> {
    const key = this.pathKey(directory);
    this.settings.openedDirectories = this.settings.openedDirectories.filter((item) => this.pathKey(item) !== key);
    await this.saveSettings();
    await this.refreshAgentPanels();
  }

  /** Loads persisted settings, falling back to localhost:4096 for external OpenCode servers. */
  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_OPENCODE_SETTINGS, await this.loadData());
    this.settings.openedDirectories = Array.isArray(this.settings.openedDirectories) ? this.settings.openedDirectories : [];
    this.settings.groupContextTools = this.settings.groupContextTools === true;
    this.settings.showReasoningBlocks = this.settings.showReasoningBlocks !== false;
    this.settings.archiveConfirmation = this.settings.archiveConfirmation !== false;
    this.settings.sessionScroll = this.settings.sessionScroll && typeof this.settings.sessionScroll === "object" ? this.settings.sessionScroll : {};
    this.settings.sessionDrafts = this.settings.sessionDrafts && typeof this.settings.sessionDrafts === "object" ? this.settings.sessionDrafts : {};
    this.settings.sessionPromptHistory =
      this.settings.sessionPromptHistory && typeof this.settings.sessionPromptHistory === "object" ? this.settings.sessionPromptHistory : {};
    this.settings.sessionAgentChoices =
      this.settings.sessionAgentChoices && typeof this.settings.sessionAgentChoices === "object" ? this.settings.sessionAgentChoices : {};
    this.settings.sessionModelChoices =
      this.settings.sessionModelChoices && typeof this.settings.sessionModelChoices === "object" ? this.settings.sessionModelChoices : {};
    this.settings.sessionAutoApprove =
      this.settings.sessionAutoApprove && typeof this.settings.sessionAutoApprove === "object" ? this.settings.sessionAutoApprove : {};
    this.settings.sessionMute = this.settings.sessionMute && typeof this.settings.sessionMute === "object" ? this.settings.sessionMute : {};
    this.settings.sessionAttachedFiles =
      this.settings.sessionAttachedFiles && typeof this.settings.sessionAttachedFiles === "object" ? this.settings.sessionAttachedFiles : {};
    this.settings.sessionUnread = this.settings.sessionUnread && typeof this.settings.sessionUnread === "object" ? this.settings.sessionUnread : {};
    this.settings.workingAnimation = normalizeWorkingAnimation(this.settings.workingAnimation);
  }

  /** Writes plugin settings to Obsidian's plugin data file; referenced by opened-directory mutations. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Loads the target and all descendants because v1 archival only updates one session per PATCH. */
  private async loadSessionArchiveTree(sessionId: string, directory?: string): Promise<SessionArchiveNode> {
    const session = await this.requireOpenCodeService().getSession(sessionId, directory);
    return this.loadSessionArchiveNode(session, directory, new Set());
  }

  /** Recursively builds the archive confirmation tree while guarding against malformed cycles. */
  private async loadSessionArchiveNode(session: OpenCodeSession, fallbackDirectory: string | undefined, visited: Set<string>): Promise<SessionArchiveNode> {
    if (visited.has(session.id)) throw new Error(`OpenCode returned a cyclic session tree at ${session.id}.`);
    visited.add(session.id);
    const directory = session.directory ?? fallbackDirectory;
    const children = await this.requireOpenCodeService().listSessionChildren(session.id, directory);
    return {
      id: session.id,
      title: session.title?.trim() || session.id,
      directory,
      archived: typeof session.time?.archived === "number",
      children: await Promise.all(children.map((child) => this.loadSessionArchiveNode(child, directory, visited))),
    };
  }

  /** Flattens descendants before their parent so a partial failure never hides reachable children. */
  private flattenArchiveTargets(tree: SessionArchiveNode): SessionArchiveNode[] {
    return [...tree.children.flatMap((child) => this.flattenArchiveTargets(child)), ...(tree.archived ? [] : [tree])];
  }

  /** Persists lightweight per-session scroll state; referenced by SessionView scroll listeners. */
  async rememberSessionScroll(sessionId: string, state: { top: number; atBottom: boolean }): Promise<void> {
    this.settings.sessionScroll[sessionId] = state;
    await this.saveSettings();
  }

  /** Persists the unsent composer text for a session; referenced by SessionView input events. */
  async rememberSessionDraft(sessionId: string, draft: string): Promise<void> {
    if (draft.trim()) this.settings.sessionDrafts[sessionId] = draft;
    else delete this.settings.sessionDrafts[sessionId];
    await this.saveSettings();
  }

  /** Records a sent prompt for per-session history navigation; referenced by SessionView sends. */
  async rememberPromptHistory(sessionId: string, prompt: string): Promise<void> {
    const existing = this.settings.sessionPromptHistory[sessionId] ?? [];
    const next = [prompt, ...existing.filter((item) => item !== prompt)].slice(0, 100);
    this.settings.sessionPromptHistory[sessionId] = next;
    await this.saveSettings();
  }

  /** Persists the selected composer agent for a session; referenced by SessionView agent menu. */
  async rememberSessionAgentChoice(sessionId: string, agent: string): Promise<void> {
    if (agent) this.settings.sessionAgentChoices[sessionId] = agent;
    else delete this.settings.sessionAgentChoices[sessionId];
    await this.saveSettings();
  }

  /** Persists the selected composer model for a session; referenced by SessionView model and variant pills. */
  async rememberSessionModelChoice(sessionId: string, model: { providerID: string; modelID: string; variant?: string } | undefined): Promise<void> {
    if (model) this.settings.sessionModelChoices[sessionId] = model;
    else delete this.settings.sessionModelChoices[sessionId];
    await this.saveSettings();
  }

  /** Persists whether the session should automatically allow permission prompts once. */
  async rememberSessionAutoApprove(sessionId: string, enabled: boolean): Promise<void> {
    if (enabled) this.settings.sessionAutoApprove[sessionId] = true;
    else delete this.settings.sessionAutoApprove[sessionId];
    await this.saveSettings();
  }

  /** Persists the local muted-notification state for a session composer. */
  async rememberSessionMute(sessionId: string, muted: boolean): Promise<void> {
    if (muted) this.settings.sessionMute[sessionId] = true;
    else delete this.settings.sessionMute[sessionId];
    await this.saveSettings();
  }

  /** Persists whether a session has completed activity the user has not read yet. */
  async rememberSessionUnread(sessionId: string, unread: boolean): Promise<void> {
    if (unread) this.settings.sessionUnread[sessionId] = true;
    else delete this.settings.sessionUnread[sessionId];
    await this.saveSettings();
  }

  /** Persists selected absolute file attachments for an unsent composer draft. */
  async rememberSessionAttachedFiles(sessionId: string, files: string[]): Promise<void> {
    if (files.length > 0) this.settings.sessionAttachedFiles[sessionId] = [...files];
    else delete this.settings.sessionAttachedFiles[sessionId];
    await this.saveSettings();
  }

  /** Toggles a model (+optional variant) in the global favorites list; referenced by ModelSelectionMenu. */
  async toggleFavoriteModel(ref: { providerID: string; modelID: string; variant?: string }): Promise<void> {
    const key = (r: { providerID: string; modelID: string; variant?: string }) => `${r.providerID}/${r.modelID}/${r.variant ?? ""}`;
    const idx = this.settings.favoriteModels.findIndex((f) => key(f) === key(ref));
    if (idx >= 0) this.settings.favoriteModels.splice(idx, 1);
    else this.settings.favoriteModels.push(ref);
    await this.saveSettings();
  }

  /** Moves local composer state from a draft key to its newly created server session. */
  async promoteSessionDraft(draftKey: string, sessionId: string): Promise<void> {
    const draft = this.settings.sessionDrafts[draftKey];
    const history = this.settings.sessionPromptHistory[draftKey];
    const agent = this.settings.sessionAgentChoices[draftKey];
    const model = this.settings.sessionModelChoices[draftKey];
    const autoApprove = this.settings.sessionAutoApprove[draftKey];
    const muted = this.settings.sessionMute[draftKey];
    const files = this.settings.sessionAttachedFiles[draftKey];
    if (draft) this.settings.sessionDrafts[sessionId] = draft;
    if (history) this.settings.sessionPromptHistory[sessionId] = history;
    if (agent) this.settings.sessionAgentChoices[sessionId] = agent;
    if (model) this.settings.sessionModelChoices[sessionId] = model;
    if (autoApprove) this.settings.sessionAutoApprove[sessionId] = autoApprove;
    if (muted) this.settings.sessionMute[sessionId] = muted;
    if (files) this.settings.sessionAttachedFiles[sessionId] = files;
    delete this.settings.sessionDrafts[draftKey];
    delete this.settings.sessionPromptHistory[draftKey];
    delete this.settings.sessionAgentChoices[draftKey];
    delete this.settings.sessionModelChoices[draftKey];
    delete this.settings.sessionAutoApprove[draftKey];
    delete this.settings.sessionMute[draftKey];
    delete this.settings.sessionAttachedFiles[draftKey];
    await this.saveSettings();
  }

  /** Opens or focuses the OpenCode agents panel and reveals the focused session's row. */
  private async activateAgentPanel(): Promise<void> {
    // Capture the focused session before revealing the panel can change the active leaf.
    const activeSessionId = this.getActiveSessionId();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_OPENCODE_AGENT_PANEL, active: true });
    }

    if (leaf) this.app.workspace.revealLeaf(leaf);

    if (leaf?.view instanceof AgentPanelView) {
      if (activeSessionId) leaf.view.setActiveSession(activeSessionId);
      // Focus the panel container so arrow-key navigation works immediately, mirroring
      // Obsidian's "Reveal current file in navigation" rather than "Show file explorer".
      leaf.view.focusContent();
    }
  }

  /** Opens or focuses the OpenCode diffs panel in the right Obsidian sidebar. */
  private async activateDiffPanel(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_OPENCODE_DIFF_PANEL, active: true });
    }

    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  /** Refreshes every visible agents panel after local or server-side session changes. */
  async refreshAgentPanels(options?: { showLoading?: boolean }): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL).map(async (leaf) => {
        if (leaf.view instanceof AgentPanelView) await leaf.view.refresh(options);
      }),
    );
  }

  /** Pushes one live session status into visible agent panels without waiting for their full refresh. */
  notifySessionStatusChanged(sessionId: string, statusType: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL)) {
      if (leaf.view instanceof AgentPanelView) leaf.view.applyLiveSessionStatus(sessionId, statusType);
    }
  }

  /** Routes one permission request to every open session view that contains its owning session. */
  routePermissionRequest(request: OpenCodePermissionRequest): void {
    // TODO(notification-routing): emit at most one notification per permission request ID. Decide whether clicking it opens the surfaced parent or the owning child session.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.ingestPermissionRequest(request);
    }
  }

  /** Routes one question request to every open session view that contains its owning session. */
  routeQuestionRequest(request: OpenCodeQuestionRequest): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.ingestQuestionRequest(request);
    }
  }

  /** Claims one request response globally so parent and child controls cannot submit concurrently. */
  beginSessionRequestResponse(requestId: string): boolean {
    if (this.respondingSessionRequestIds.has(requestId)) return false;
    this.respondingSessionRequestIds.add(requestId);
    this.refreshSessionRequestDocks();
    return true;
  }

  /** Releases a failed request response and re-enables every visible copy of its controls. */
  finishSessionRequestResponse(requestId: string): void {
    this.respondingSessionRequestIds.delete(requestId);
    this.refreshSessionRequestDocks();
  }

  /** Returns whether either a parent or child view is currently responding to one request. */
  isSessionRequestResponding(requestId: string): boolean {
    return this.respondingSessionRequestIds.has(requestId);
  }

  /** Removes a settled request from every visible parent and child view. */
  settleSessionRequest(requestId: string | undefined): void {
    if (!requestId) return;
    this.respondingSessionRequestIds.delete(requestId);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.settleSessionRequest(requestId);
    }
  }

  /** Re-renders request controls across all open session views after shared response state changes. */
  private refreshSessionRequestDocks(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.refreshSessionRequestDocks();
    }
  }

  /** Refreshes every visible diff panel after active session or turn context changes. */
  private async refreshDiffPanels(force = false): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL).map(async (leaf) => {
        if (leaf.view instanceof DiffPanelView) await leaf.view.setContext(this.diffPanelContext, { force });
      }),
    );
  }

  /** Toggles collapsed Gathered context grouping for read/search/list tool calls. */
  private async toggleContextToolGrouping(): Promise<void> {
    this.settings.groupContextTools = !this.settings.groupContextTools;
    await this.saveSettings();
    new Notice(`OpenCode context tool grouping ${this.settings.groupContextTools ? "enabled" : "disabled"}.`);
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).map(async (leaf) => {
        if (leaf.view instanceof SessionView) await leaf.view.refresh();
      }),
    );
  }

  /** Toggles visibility for assistant reasoning/thinking blocks in session tabs. */
  private async toggleReasoningBlocks(): Promise<void> {
    this.settings.showReasoningBlocks = !this.settings.showReasoningBlocks;
    await this.saveSettings();
    new Notice(`OpenCode reasoning blocks ${this.settings.showReasoningBlocks ? "enabled" : "disabled"}.`);
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).map(async (leaf) => {
        if (leaf.view instanceof SessionView) await leaf.view.refresh();
      }),
    );
  }

  /** Shows Electron's native open-directory dialog; referenced by the open-directory command and panel button. */
  private async pickDirectory(): Promise<string | undefined> {
    try {
      const electron = require("electron") as {
        remote?: { dialog?: { showOpenDialog: (options: object) => Promise<{ canceled: boolean; filePaths: string[] }> } };
      };
      const dialog = electron.remote?.dialog;
      if (!dialog) throw new Error("Electron remote dialog is unavailable.");
      const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      return result.canceled ? undefined : result.filePaths[0];
    } catch (error) {
      new Notice(`Unable to open directory picker: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  }

  /** Normalizes user-selected directory strings for stable persistence and comparison. */
  private normalizeDirectory(directory: string): string {
    return directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory;
  }

  /** Mirrors OpenCode's pathKey behavior for opened-directory deduplication. */
  private pathKey(directory: string): string {
    return this.normalizeDirectory(directory).toLowerCase();
  }

  /** Performs a read-only health check command for early manual testing. */
  private async checkConnection(): Promise<void> {
    if (!this.opencode) return;
    try {
      const health = await this.opencode.health();
      new Notice(`OpenCode server ${health.healthy ? "healthy" : "unhealthy"}: ${health.version}`);
    } catch (error) {
      new Notice(`OpenCode server connection failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
