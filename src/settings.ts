import { AbstractInputSuggest, PluginSettingTab, Setting, getIconIds, setIcon, type App } from "obsidian";
import type OpenCodePlugin from "../main";
import type { OpenCodeServerConfig } from "./services/opencode-service";
import {
  DEFAULT_WORKING_ANIMATION,
  WORKING_ANIMATION_LABELS,
  normalizeWorkingAnimation,
  type WorkingAnimation,
} from "./session-state";
import {
  DEFAULT_OPEN_IDE_ID,
  detectInstalledIdes,
  getIdeById,
  getIdeOrDefault,
  type IdeDescriptor,
} from "./utils/ide-launcher";

export type SessionIslandContextLabel = "percentage" | "tokens";

export const SESSION_ISLAND_CONTEXT_LABELS: Record<SessionIslandContextLabel, string> = {
  tokens: "Token count",
  percentage: "Percentage",
};

export const DEFAULT_SESSION_ISLAND_CONTEXT_LABEL: SessionIslandContextLabel = "tokens";

export const FOLDER_COLLAPSE_DISPLAY_LABELS = {
  inset: "Inset icon",
  size: "Smaller icon",
  chevron: "Trailing chevron",
} as const;

export type FolderCollapseDisplay = keyof typeof FOLDER_COLLAPSE_DISPLAY_LABELS;

export const DEFAULT_FOLDER_COLLAPSE_DISPLAY: FolderCollapseDisplay = "inset";

export const AGENT_PANEL_SESSION_SORT_LABELS = {
  "created-desc": "Created: newest first",
  "created-asc": "Created: oldest first",
  "modified-desc": "Modified: newest first",
  "modified-asc": "Modified: oldest first",
  "title-asc": "Title: A to Z",
  "title-desc": "Title: Z to A",
} as const;

export type AgentPanelSessionSort = keyof typeof AGENT_PANEL_SESSION_SORT_LABELS;

export const DEFAULT_AGENT_PANEL_SESSION_SORT: AgentPanelSessionSort = "created-desc";

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
  showContextBarThresholdLabels: boolean;
  sessionIslandContextLabel: SessionIslandContextLabel;
  todoInProgressStatusCharacter: string;
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
  folderCollapseDisplay: FolderCollapseDisplay;
  agentPanelSessionSort: AgentPanelSessionSort;
  favoriteModels: Array<{ providerID: string; modelID: string; variant?: string }>;
  customToolDisplays: ToolDisplaySetting[];
  /** Configured IDE/editor id for the "Open project in IDE" command and menu item. */
  openIde: string;
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
  sessionIslandContextLabel: DEFAULT_SESSION_ISLAND_CONTEXT_LABEL,
  todoInProgressStatusCharacter: "",
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
  folderCollapseDisplay: DEFAULT_FOLDER_COLLAPSE_DISPLAY,
  agentPanelSessionSort: DEFAULT_AGENT_PANEL_SESSION_SORT,
  favoriteModels: [],
  customToolDisplays: [],
  openIde: DEFAULT_OPEN_IDE_ID,
};

/** Returns a supported Prompt-tab context label for persisted settings and live rendering. */
export function normalizeSessionIslandContextLabel(value: unknown): SessionIslandContextLabel {
  if (typeof value === "string" && value in SESSION_ISLAND_CONTEXT_LABELS) return value as SessionIslandContextLabel;
  return DEFAULT_SESSION_ISLAND_CONTEXT_LABEL;
}

/** Returns a supported agents-panel folder collapse treatment for persisted settings. */
export function normalizeFolderCollapseDisplay(value: unknown): FolderCollapseDisplay {
  if (typeof value === "string" && value in FOLDER_COLLAPSE_DISPLAY_LABELS) return value as FolderCollapseDisplay;
  return DEFAULT_FOLDER_COLLAPSE_DISPLAY;
}

/** Returns a supported agents-panel session ordering for persisted settings. */
export function normalizeAgentPanelSessionSort(value: unknown): AgentPanelSessionSort {
  if (typeof value === "string" && value in AGENT_PANEL_SESSION_SORT_LABELS) return value as AgentPanelSessionSort;
  return DEFAULT_AGENT_PANEL_SESSION_SORT;
}

/** Normalizes the optional theme-defined in-progress task marker; empty means highlighted unchecked. */
export function normalizeTodoStatusCharacter(value: unknown): string {
  if (typeof value !== "string") return "";
  const character = Array.from(value.trim())[0];
  return character && !"[]xX-".includes(character) ? character : "";
}

/** Returns a valid IDE id for persisted settings, falling back to the canonical default. */
export function normalizeOpenIde(value: unknown): string {
  return typeof value === "string" && getIdeById(value) ? value : DEFAULT_OPEN_IDE_ID;
}

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
      .setName("Open project in IDE")
      .setDesc("Editor launched by the \u201COpen current project in IDE\u201D command and the session menu item.")
      .addDropdown((dropdown) => {
        const configured = getIdeOrDefault(this.plugin.settings.openIde);
        for (const ide of this.openIdeOptions(configured)) dropdown.addOption(ide.id, ide.label);
        dropdown.setValue(configured.id).onChange(async (value) => {
          this.plugin.settings.openIde = normalizeOpenIde(value);
          await this.plugin.saveSettings();
        });
      });

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
      .setName("Folder collapse indicator")
      .setDesc("Choose how collapsed project and worktree rows are distinguished in the agents panel.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(FOLDER_COLLAPSE_DISPLAY_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue(normalizeFolderCollapseDisplay(this.plugin.settings.folderCollapseDisplay)).onChange(async (value) => {
          this.plugin.settings.folderCollapseDisplay = normalizeFolderCollapseDisplay(value);
          await this.plugin.saveSettings();
          await this.plugin.refreshAgentPanels({ showLoading: false });
        });
      });

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
      .setName("Show session context as percentage")
      .setDesc("Show a percentage in the Session Island Prompt tab instead of the default compact token count.")
      .addToggle((toggle) => {
        toggle.setValue(normalizeSessionIslandContextLabel(this.plugin.settings.sessionIslandContextLabel) === "percentage").onChange(async (value) => {
          this.plugin.settings.sessionIslandContextLabel = value ? "percentage" : "tokens";
          await this.plugin.saveSettings();
          this.plugin.refreshSessionIslands();
        });
      });

    const todoStatus = new Setting(this.containerEl)
      .setName("In-progress todo status")
      .setDesc("Highlight the current todo by default, or use a task character supported by your theme.");
    const currentTodoStatus = normalizeTodoStatusCharacter(this.plugin.settings.todoInProgressStatusCharacter);
    const commonStatuses = new Set(["", "/", ">", "!", "?"]);
    let customStatusInput: HTMLInputElement | undefined;
    todoStatus.addDropdown((dropdown) => {
      dropdown
        .addOption("", "Highlight (default)")
        .addOption("/", "/ task status")
        .addOption(">", "> task status")
        .addOption("!", "! task status")
        .addOption("?", "? task status")
        .addOption("__custom__", "Custom character")
        .setValue(commonStatuses.has(currentTodoStatus) ? currentTodoStatus : "__custom__")
        .onChange(async (value) => {
          if (value === "__custom__") {
            this.plugin.settings.todoInProgressStatusCharacter = "";
            if (customStatusInput) {
              customStatusInput.disabled = false;
              customStatusInput.value = "";
              customStatusInput.focus();
            }
            await this.plugin.saveSettings();
            this.plugin.refreshSessionIslands();
            return;
          }
          this.plugin.settings.todoInProgressStatusCharacter = value;
          if (customStatusInput) customStatusInput.disabled = true;
          await this.plugin.saveSettings();
          this.plugin.refreshSessionIslands();
        });
    });
    todoStatus.addText((text) => {
      customStatusInput = text.inputEl;
      text.setPlaceholder("Character").setValue(commonStatuses.has(currentTodoStatus) ? "" : currentTodoStatus).onChange(async (value) => {
        if (customStatusInput?.disabled) return;
        const character = normalizeTodoStatusCharacter(value);
        this.plugin.settings.todoInProgressStatusCharacter = character;
        if (customStatusInput && customStatusInput.value !== character) customStatusInput.value = character;
        await this.plugin.saveSettings();
        this.plugin.refreshSessionIslands();
      });
      text.inputEl.maxLength = 2;
      text.inputEl.disabled = commonStatuses.has(currentTodoStatus);
      text.inputEl.setAttr("aria-label", "Custom in-progress todo task character");
    });

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

  /** Detected IDEs for the dropdown, always including the configured value even if not detected. */
  private openIdeOptions(configured: IdeDescriptor): IdeDescriptor[] {
    const options = detectInstalledIdes();
    const ids = new Set(options.map((ide) => ide.id));
    if (!ids.has(configured.id)) options.unshift(configured);
    return options;
  }
}
