import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodePluginSettings } from "./src/settings";
import { OpenCodeService } from "./src/services/opencode-service";
import { AgentPanelView, VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./src/views/AgentPanelView";
import { SessionView, VIEW_TYPE_OPENCODE_SESSION } from "./src/views/SessionView";

export default class OpenCodePlugin extends Plugin {
  settings: OpenCodePluginSettings = DEFAULT_OPENCODE_SETTINGS;
  opencode?: OpenCodeService;

  /** Initializes plugin settings and the OpenCode API service used by future UI views. */
  async onload(): Promise<void> {
    await this.loadSettings();
    this.opencode = new OpenCodeService(this.settings.server);

    this.registerView(VIEW_TYPE_OPENCODE_AGENT_PANEL, (leaf) => new AgentPanelView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_SESSION, (leaf) => new SessionView(leaf, this));

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
  }

  /** Writes plugin settings to Obsidian's plugin data file; referenced by opened-directory mutations. */
  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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

  /** Refreshes every visible agents panel after local opened-directory state changes. */
  private async refreshAgentPanels(): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_AGENT_PANEL).map(async (leaf) => {
        if (leaf.view instanceof AgentPanelView) await leaf.view.refresh();
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
