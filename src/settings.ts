import { AbstractInputSuggest, PluginSettingTab, Setting, getIconIds, setIcon, type App } from "obsidian";
import type OpenCodePlugin from "../main";
import type { OpenCodeServerConfig } from "./services/opencode-service";
import {
  DEFAULT_WORKING_ANIMATION,
  WORKING_ANIMATION_LABELS,
  normalizeWorkingAnimation,
  type WorkingAnimation,
} from "./session-state";

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
  showContextBarThresholdLabels: boolean;
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
  customToolDisplays: ToolDisplaySetting[];
}

export interface ToolDisplaySetting {
  tool: string;
  icon: string;
  displayArgument: string;
}

export const DEFAULT_OPENCODE_SETTINGS: OpenCodePluginSettings = {
  server: {
    baseUrl: "http://127.0.0.1:4096",
  },
  openedDirectories: [],
  groupContextTools: false,
  showReasoningBlocks: true,
  showContextBarThresholdLabels: true,
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
  customToolDisplays: [],
};

class IconSuggest extends AbstractInputSuggest<string> {
  private readonly icons = getIconIds();

  /** Returns matching Lucide icon IDs for the custom-tool icon search field. */
  protected getSuggestions(query: string): string[] {
    const normalized = query.trim().toLowerCase();
    return this.icons.filter((icon) => !normalized || icon.toLowerCase().includes(normalized)).slice(0, 50);
  }

  /** Renders one icon suggestion with its native Obsidian icon and ID. */
  renderSuggestion(icon: string, element: HTMLElement): void {
    const preview = element.createSpan({ cls: "opencode-settings__tool-icon-preview" });
    setIcon(preview, icon);
    element.createSpan({ text: icon });
  }
}

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

    new Setting(this.containerEl)
      .setName("Show context bar threshold labels")
      .setDesc("Show token thresholds beneath the checkpoint markers on the composer context bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showContextBarThresholdLabels).onChange(async (value) => {
          this.plugin.settings.showContextBarThresholdLabels = value;
          await this.plugin.saveSettings();
          await this.plugin.refreshSessionViews();
        }),
      );

    new Setting(this.containerEl)
      .setName("Working indicator animation")
      .setDesc("Choose a compact animation for session rows, tabs, and active-turn metadata.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(WORKING_ANIMATION_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue(this.plugin.settings.workingAnimation).onChange(async (value) => {
          this.plugin.settings.workingAnimation = normalizeWorkingAnimation(value);
          await this.plugin.saveSettings();
          await Promise.all([
            this.plugin.refreshAgentPanels({ showLoading: false }),
            this.plugin.refreshSessionViews(),
          ]);
        });
      });

    new Setting(this.containerEl)
      .setName("Custom tool displays")
      .setDesc("Choose the Lucide icon and input argument shown when a matching tool call is collapsed.")
      .setHeading();

    for (const display of this.plugin.settings.customToolDisplays) this.renderToolDisplaySetting(display);

    new Setting(this.containerEl).addButton((button) =>
      button.setButtonText("Add custom tool").onClick(() => {
        this.plugin.settings.customToolDisplays.push({ tool: "", icon: "wrench", displayArgument: "" });
        void this.plugin.saveSettings();
        this.display();
      }),
    );
  }

  /** Renders and persists one user-defined collapsed tool display mapping. */
  private renderToolDisplaySetting(display: ToolDisplaySetting): void {
    const setting = new Setting(this.containerEl).setClass("opencode-settings__tool-display");
    setting.addText((text) => {
      text.setPlaceholder("Tool name").setValue(display.tool).onChange((value) => {
        display.tool = value.trim().toLowerCase();
        void this.plugin.saveSettings();
      });
      text.inputEl.setAttr("aria-label", "Tool name");
      text.inputEl.addEventListener("change", () => void this.plugin.refreshSessionViews());
    });
    setting.addSearch((search) => {
      search.setPlaceholder("Lucide icon").setValue(display.icon).onChange((value) => {
        display.icon = value.trim();
        void this.plugin.saveSettings();
      });
      search.inputEl.setAttr("aria-label", "Lucide icon");
      search.inputEl.addEventListener("change", () => void this.plugin.refreshSessionViews());
      new IconSuggest(this.app, search.inputEl).onSelect((icon) => {
        display.icon = icon;
        void this.plugin.saveSettings();
        void this.plugin.refreshSessionViews();
      });
    });
    setting.addText((text) => {
      text.setPlaceholder("Input argument").setValue(display.displayArgument).onChange((value) => {
        display.displayArgument = value.trim();
        void this.plugin.saveSettings();
      });
      text.inputEl.setAttr("aria-label", "Displayed input argument");
      text.inputEl.addEventListener("change", () => void this.plugin.refreshSessionViews());
    });
    setting.addExtraButton((button) =>
      button.setIcon("trash-2").setTooltip("Remove custom tool display").onClick(() => {
        this.plugin.settings.customToolDisplays = this.plugin.settings.customToolDisplays.filter((item) => item !== display);
        void this.plugin.saveSettings();
        void this.plugin.refreshSessionViews();
        this.display();
      }),
    );
  }
}
