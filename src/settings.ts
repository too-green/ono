import { AbstractInputSuggest, PluginSettingTab, SecretComponent, Setting, getIconIds, setIcon, type App } from "obsidian";
import type OpenCodePlugin from "../main";
import type { SessionNotificationTestKind } from "./services/session-notifications";
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

export const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:4096";

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

export const NOTIFICATION_MODE_LABELS = {
  system: "System notifications",
  "obsidian-notice": "Obsidian notices",
  none: "None",
} as const;

export type NotificationMode = keyof typeof NOTIFICATION_MODE_LABELS;
export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "none";

/** Persisted data-backed image attached to an unsent session composer draft. */
export interface ComposerImageAttachment {
  filename: string;
  mime: string;
  url: string;
}

/** Filesystem paths and data-backed images accepted by the session composer. */
export type ComposerAttachment = string | ComposerImageAttachment;

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
  sessionIslandContextLabel: SessionIslandContextLabel;
  todoInProgressStatusCharacter: string;
  interruptConfirmSeconds: number;
  archiveConfirmation: boolean;
  sessionScroll: Record<string, { top: number; atBottom: boolean }>;
  sessionDrafts: Record<string, string>;
  sessionAgentChoices: Record<string, string>;
  sessionModelChoices: Record<string, { providerID: string; modelID: string; variant?: string }>;
  defaultSessionAutoApprove: boolean;
  sessionAutoApprove: Record<string, boolean>;
  sessionAutoApproveDefaultApplied: Record<string, true>;
  sessionMute: Record<string, boolean>;
  sessionAttachedFiles: Record<string, ComposerAttachment[]>;
  sessionUnread: Record<string, boolean>;
  notificationMode: NotificationMode;
  notifyOnAttention: boolean;
  notifyOnSessionError: boolean;
  notifyOnTurnComplete: boolean;
  retryActionLastShown: Record<string, number>;
  retryActionSuppressed: Record<string, true>;
  workingAnimation: WorkingAnimation;
  folderCollapseDisplay: FolderCollapseDisplay;
  agentPanelSessionSort: AgentPanelSessionSort;
  favoriteModels: Array<{ providerID: string; modelID: string; variant?: string }>;
  customToolDisplays: ToolDisplaySetting[];
  debugLogging: boolean;
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
    baseUrl: DEFAULT_SERVER_BASE_URL,
  },
  openedDirectories: [],
  groupContextTools: false,
  showReasoningBlocks: true,
  sessionIslandContextLabel: DEFAULT_SESSION_ISLAND_CONTEXT_LABEL,
  todoInProgressStatusCharacter: "",
  interruptConfirmSeconds: 3,
  archiveConfirmation: true,
  sessionScroll: {},
  sessionDrafts: {},
  sessionAgentChoices: {},
  sessionModelChoices: {},
  defaultSessionAutoApprove: false,
  sessionAutoApprove: {},
  sessionAutoApproveDefaultApplied: {},
  sessionMute: {},
  sessionAttachedFiles: {},
  sessionUnread: {},
  notificationMode: DEFAULT_NOTIFICATION_MODE,
  notifyOnAttention: true,
  notifyOnSessionError: true,
  notifyOnTurnComplete: true,
  retryActionLastShown: {},
  retryActionSuppressed: {},
  workingAnimation: DEFAULT_WORKING_ANIMATION,
  folderCollapseDisplay: DEFAULT_FOLDER_COLLAPSE_DISPLAY,
  agentPanelSessionSort: DEFAULT_AGENT_PANEL_SESSION_SORT,
  favoriteModels: [],
  customToolDisplays: [],
  debugLogging: false,
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

/** Returns a supported notification delivery mode for persisted settings. */
export function normalizeNotificationMode(value: unknown): NotificationMode {
  return typeof value === "string" && value in NOTIFICATION_MODE_LABELS ? value as NotificationMode : DEFAULT_NOTIFICATION_MODE;
}

/** Enables persisted debug logging only for the explicit boolean value used by the settings toggle. */
export function normalizeDebugLogging(value: unknown): boolean {
  return value === true;
}

/** Normalizes persisted retry-action cooldown timestamps. */
export function normalizeRetryActionLastShown(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
}

/** Normalizes sparse permanent suppression flags for retry-action prompts. */
export function normalizeRetryActionSuppressed(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, true] => entry[1] === true));
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

/** Returns a parseable http(s) server base URL for persisted settings and the settings tab. */
export function normalizeServerBaseUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SERVER_BASE_URL;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_SERVER_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_SERVER_BASE_URL;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return DEFAULT_SERVER_BASE_URL;
  }
}

/** Returns an optional trimmed basic-auth username for persisted settings. */
export function normalizeServerUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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

    this.renderServerSettings();

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
      .setName("Default auto-accept")
      .setDesc("Enable auto-accept when a session is first opened or a new session is created using this plugin.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.defaultSessionAutoApprove).onChange(async (value) => {
          this.plugin.settings.defaultSessionAutoApprove = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(this.containerEl)
      .setName("Notifications")
      .setDesc("Choose how OpenCode reports sessions that need attention, fail, or finish a turn.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(NOTIFICATION_MODE_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue(normalizeNotificationMode(this.plugin.settings.notificationMode)).onChange(async (value) => {
          this.plugin.settings.notificationMode = normalizeNotificationMode(value);
          if (this.plugin.settings.notificationMode === "system") await this.plugin.requestSystemNotificationPermission();
          await this.plugin.saveSettings();
        });
      });

    new Setting(this.containerEl)
      .setName("Notify when attention is needed")
      .setDesc("Notify for permission and question requests that require a response.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.notifyOnAttention).onChange(async (value) => {
          this.plugin.settings.notifyOnAttention = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(this.containerEl)
      .setName("Notify when a session errors")
      .setDesc("Notify when an active agent turn stops because of an error.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.notifyOnSessionError).onChange(async (value) => {
          this.plugin.settings.notifyOnSessionError = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(this.containerEl)
      .setName("Notify when a turn finishes")
      .setDesc("Notify when an active agent session completes its turn.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.notifyOnTurnComplete).onChange(async (value) => {
          this.plugin.settings.notifyOnTurnComplete = value;
          await this.plugin.saveSettings();
        }),
      );

    let notificationTestKind: SessionNotificationTestKind = "permission";
    new Setting(this.containerEl)
      .setName("Test notifications")
      .setDesc("Send a dummy notification using the selected event type and delivery mode.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("permission", "Permission request")
          .addOption("question", "Question request")
          .addOption("turn-complete", "Turn finished")
          .addOption("error", "Session error")
          .setValue(notificationTestKind)
          .onChange((value) => {
            notificationTestKind = value as SessionNotificationTestKind;
          }),
      )
      .addButton((button) =>
        button.setButtonText("Send test").onClick(() => void this.plugin.sendTestNotification(notificationTestKind)),
      );

    new Setting(this.containerEl)
      .setName("Reset usage-limit prompts")
      .setDesc("Show OpenCode usage-limit action prompts again after choosing Don’t show again.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(() => void this.plugin.resetRetryActionPrompts()),
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
      .setName("Debug logging")
      .setDesc("Log endpoint templates, timings, statuses, event types, counts, retries, and error classes to the developer console. Prompts, paths, IDs, payloads, headers, credentials, and error messages are excluded.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          await this.plugin.setDebugLogging(value);
        }),
      );

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

  /** Renders the OpenCode server URL, username, and secret-storage password fields; referenced by display. */
  private renderServerSettings(): void {
    new Setting(this.containerEl)
      .setName("OpenCode server")
      .setDesc("Connection used by the agents panel, sessions, and notifications.")
      .setHeading();

    const server = { ...this.plugin.settings.server };
    const commit = (): void => {
      void this.plugin.applyServerConfig(server.baseUrl, server.username, server.passwordSecretName);
    };

    new Setting(this.containerEl)
      .setName("Server URL")
      .setDesc(`Base URL of the OpenCode server API. Defaults to ${DEFAULT_SERVER_BASE_URL}. Applied when the field loses focus.`)
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SERVER_BASE_URL).setValue(server.baseUrl);
        text.inputEl.addEventListener("change", () => {
          server.baseUrl = normalizeServerBaseUrl(text.inputEl.value);
          text.inputEl.value = server.baseUrl;
          commit();
        });
      });

    new Setting(this.containerEl)
      .setName("Server username")
      .setDesc("Optional username for the server's basic authentication. Defaults to \"opencode\" when a password is set.")
      .addText((text) => {
        text.setPlaceholder("opencode").setValue(server.username ?? "");
        text.inputEl.addEventListener("change", () => {
          server.username = normalizeServerUsername(text.inputEl.value);
          commit();
        });
      });

    // Canonical secret pattern per the Obsidian "Store secrets" guide: SecretComponent
    // picks or creates a named Keychain secret; settings persist the name and the
    // plugin resolves the value through SecretStorage at request time.
    const passwordSetting = new Setting(this.containerEl)
      .setName("Server password")
      .setDesc("Named secret in Obsidian's secret storage holding the server's basic-auth password. Pick an existing secret or create a new one.");
    if (this.app.secretStorage) {
      passwordSetting.addComponent((el) => new SecretComponent(this.app, el)
        .setValue(server.passwordSecretName ?? "")
        .onChange((name) => {
          server.passwordSecretName = name || undefined;
          commit();
        }));
    } else {
      passwordSetting.setDesc("Named-secret password storage requires Obsidian 1.11.4 or newer.");
    }

    const connectionSetting = new Setting(this.containerEl)
      .setName("Test connection")
      .setDesc("Check the health of the OpenCode server using the values entered above.");
    const connectionResult = connectionSetting.controlEl.createSpan({ cls: "opencode-settings__connection-result" });
    connectionSetting.addButton((button) =>
      button.setButtonText("Test connection").onClick(() => void this.runServerConnectionTest(server, connectionResult)),
    );
  }

  /** Probes the drafted server values and renders an inline verdict beside the test button. */
  private async runServerConnectionTest(server: OpenCodeServerConfig, resultEl: HTMLElement): Promise<void> {
    resultEl.removeClass("is-ok", "is-error");
    resultEl.textContent = "Testing…";
    try {
      const health = await this.plugin.testServerConnection(server.baseUrl, server.username, server.passwordSecretName);
      await this.plugin.applyServerConfig(server.baseUrl, server.username, server.passwordSecretName);
      resultEl.addClass(health.healthy ? "is-ok" : "is-error");
      resultEl.textContent = health.healthy
        ? `Connected — OpenCode ${health.version}`
        : `Server responded but reports unhealthy (version ${health.version}).`;
    } catch (error) {
      resultEl.addClass("is-error");
      resultEl.textContent = error instanceof Error ? error.message : "Connection failed.";
    }
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
