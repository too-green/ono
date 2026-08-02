import { PluginSettingTab, Setting, type App } from "obsidian";
import type OpenCodePlugin from "../main";
import type { OpenCodeServerConfig } from "./services/opencode-service";
import { DEFAULT_WORKING_ANIMATION, type WorkingAnimation } from "./session-state";

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
  interruptConfirmSeconds: number;
  archiveConfirmation: boolean;
  sessionScroll: Record<string, { top: number; atBottom: boolean }>;
  sessionDrafts: Record<string, string>;
  sessionPromptHistory: Record<string, string[]>;
  sessionAgentChoices: Record<string, string>;
  sessionModelChoices: Record<string, { providerID: string; modelID: string; variant?: string }>;
  sessionAutoApprove: Record<string, boolean>;
  sessionMute: Record<string, boolean>;
  sessionAttachedFiles: Record<string, string[]>;
  sessionUnread: Record<string, boolean>;
  workingAnimation: WorkingAnimation;
  favoriteModels: Array<{ providerID: string; modelID: string; variant?: string }>;
}

export const DEFAULT_OPENCODE_SETTINGS: OpenCodePluginSettings = {
  server: {
    baseUrl: "http://127.0.0.1:4096",
  },
  openedDirectories: [],
  groupContextTools: false,
  showReasoningBlocks: true,
  interruptConfirmSeconds: 3,
  archiveConfirmation: true,
  sessionScroll: {},
  sessionDrafts: {},
  sessionPromptHistory: {},
  sessionAgentChoices: {},
  sessionModelChoices: {},
  sessionAutoApprove: {},
  sessionMute: {},
  sessionAttachedFiles: {},
  sessionUnread: {},
  workingAnimation: DEFAULT_WORKING_ANIMATION,
  favoriteModels: [],
};

export class OpenCodeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(app, plugin);
  }

  /** Renders the plugin settings currently exposed by the product specification. */
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Confirm session archival")
      .setDesc("Show the affected session and all descendants before archiving them.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.archiveConfirmation).onChange(async (value) => {
          this.plugin.settings.archiveConfirmation = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
