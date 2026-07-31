import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodePluginSettings } from "./src/settings";
import { OpenCodeService } from "./src/services/opencode-service";
import { AgentPanelView, VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./src/views/AgentPanelView";
import { DiffPanelView, VIEW_TYPE_OPENCODE_DIFF_PANEL, type DiffPanelContext } from "./src/views/DiffPanelView";
import { SessionView, VIEW_TYPE_OPENCODE_SESSION } from "./src/views/SessionView";
import { normalizeWorkingAnimation } from "./src/session-state";

export default class OpenCodePlugin extends Plugin {
  settings: OpenCodePluginSettings = DEFAULT_OPENCODE_SETTINGS;
  opencode?: OpenCodeService;
  private diffPanelContext: DiffPanelContext = {};

  /** Initializes plugin settings and the OpenCode API service used by future UI views. */
  async onload(): Promise<void> {
    await this.loadSettings();
    this.opencode = new OpenCodeService(this.settings.server);

    this.registerView(VIEW_TYPE_OPENCODE_AGENT_PANEL, (leaf) => new AgentPanelView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_SESSION, (leaf) => new SessionView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_DIFF_PANEL, (leaf) => new DiffPanelView(leaf, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        void this.syncDiffPanelToActiveSessionLeaf(leaf);
      }),
    );

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

  /** Releases service resources when Obsidian unloads the plugin. */
  onunload(): void {
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

  /** Returns the latest active session/turn context; referenced by DiffPanelView on open. */
  getDiffPanelContext(): DiffPanelContext {
    return { ...this.diffPanelContext };
  }

  /** Updates the right-sidebar diff panel context; referenced by SessionView render and turn selection. */
  async updateDiffPanelContext(context: DiffPanelContext, options?: { force?: boolean }): Promise<void> {
    const next = { ...this.diffPanelContext, ...context };
    if (!options?.force && JSON.stringify(this.diffPanelContext) === JSON.stringify(next)) return;
    this.diffPanelContext = next;
    await this.refreshDiffPanels();
  }

  /** Mirrors native Outline behavior by rebinding the diff panel to the focused OpenCode session tab. */
  private async syncDiffPanelToActiveSessionLeaf(leaf: WorkspaceLeaf | null): Promise<void> {
    if (!(leaf?.view instanceof SessionView)) return;
    await this.updateDiffPanelContext(leaf.view.diffPanelContext(), { force: true });
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
  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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

  /** Opens or focuses the OpenCode agents panel in the left Obsidian sidebar. */
  private async activateAgentPanel(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_OPENCODE_AGENT_PANEL, active: true });
    }

    if (leaf) this.app.workspace.revealLeaf(leaf);
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

  /** Refreshes every visible diff panel after active session or turn context changes. */
  private async refreshDiffPanels(): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_DIFF_PANEL).map(async (leaf) => {
        if (leaf.view instanceof DiffPanelView) await leaf.view.setContext(this.diffPanelContext);
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
