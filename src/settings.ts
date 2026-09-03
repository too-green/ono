import { AbstractInputSuggest, PluginSettingTab, SecretComponent, Setting, getIconIds, setIcon, type App } from "obsidian";
import { ContextBarEditor } from "./context-bar-editor";
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

/** Unit for context-bar thresholds: share of the model limit or absolute token counts. */
export type ContextThresholdUnit = "percent" | "tokens";

export const CONTEXT_THRESHOLD_UNIT_LABELS: Record<ContextThresholdUnit, string> = {
  percent: "Percent of context",
  tokens: "Absolute tokens",
};

/** Canonical segment color names mapped to Obsidian CSS variables so themes apply. */
export const CONTEXT_SEGMENT_COLOR_VARS = {
  accent: "var(--interactive-accent)",
  red: "var(--color-red)",
  orange: "var(--color-orange)",
  yellow: "var(--color-yellow)",
  green: "var(--color-green)",
  cyan: "var(--color-cyan)",
  blue: "var(--color-blue)",
  purple: "var(--color-purple)",
  pink: "var(--color-pink)",
} as const;

export type ContextSegmentColorName = keyof typeof CONTEXT_SEGMENT_COLOR_VARS;

/** One threshold pill: bar position (0–1 fraction) plus its value in the owning set's unit. */
export interface ContextThreshold {
  fraction: number;
  value: number;
}

/** One unit's independently persisted threshold configuration. */
export interface ContextThresholdSet {
  thresholds: ContextThreshold[];
  /** Segment colors; segment i ends at threshold i. Always thresholds.length + 1 entries. */
  segmentColors: string[];
}

/** Composer context progress bar policy: active unit plus one persisted threshold set per unit. */
export interface ContextBarSettings {
  unit: ContextThresholdUnit;
  percent: ContextThresholdSet;
  tokens: ContextThresholdSet;
}

export const CONTEXT_BAR_MAX_THRESHOLDS = 4;

export const DEFAULT_CONTEXT_PERCENT_SET: ContextThresholdSet = {
  thresholds: [
    { fraction: 0.5, value: 60 },
    { fraction: 0.75, value: 85 },
  ],
  segmentColors: ["accent", "yellow", "red"],
};

export const DEFAULT_CONTEXT_TOKENS_SET: ContextThresholdSet = {
  thresholds: [
    { fraction: 0.5, value: 100_000 },
    { fraction: 0.75, value: 250_000 },
  ],
  segmentColors: ["accent", "yellow", "red"],
};

/** Returns a deep copy of a threshold set; referenced by defaults and normalization. */
function cloneContextThresholdSet(set: ContextThresholdSet): ContextThresholdSet {
  return { thresholds: set.thresholds.map((threshold) => ({ ...threshold })), segmentColors: [...set.segmentColors] };
}

/** Returns a fresh deep copy of the default context bar policy; referenced by plugin defaults and tests. */
export function defaultContextBarSettings(): ContextBarSettings {
  return {
    unit: "percent",
    percent: cloneContextThresholdSet(DEFAULT_CONTEXT_PERCENT_SET),
    tokens: cloneContextThresholdSet(DEFAULT_CONTEXT_TOKENS_SET),
  };
}

export const FOLDER_COLLAPSE_DISPLAY_LABELS = {
  inset: "Inset icon",
  size: "Smaller icon",
  chevron: "Trailing chevron",
} as const;

export type FolderCollapseDisplay = keyof typeof FOLDER_COLLAPSE_DISPLAY_LABELS;

export const DEFAULT_FOLDER_COLLAPSE_DISPLAY: FolderCollapseDisplay = "inset";

export const SESSIONS_PANEL_SESSION_SORT_LABELS = {
  "created-desc": "Created: newest first",
  "created-asc": "Created: oldest first",
  "modified-desc": "Modified: newest first",
  "modified-asc": "Modified: oldest first",
  "title-asc": "Title: A to Z",
  "title-desc": "Title: Z to A",
} as const;

export type SessionsPanelSessionSort = keyof typeof SESSIONS_PANEL_SESSION_SORT_LABELS;

export const DEFAULT_SESSIONS_PANEL_SESSION_SORT: SessionsPanelSessionSort = "created-desc";

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

export const OPENCODE_DATA_SCHEMA_VERSION = 1;

/** Composer content retained only until the next successful submission. */
export interface PersistedComposerState {
  text?: string;
  attachments?: ComposerAttachment[];
}

/** Session-owned UI policy and unsent composer state stored in plugin data. */
export interface PersistedSessionState {
  composer?: PersistedComposerState;
  autoApprove?: boolean | "inherit";
  muted?: boolean;
  unread?: true;
}

/** Versioned data.json boundary separating global preferences from keyed local state. */
export interface OpenCodePluginData {
  schemaVersion: typeof OPENCODE_DATA_SCHEMA_VERSION;
  preferences: OpenCodePluginSettings;
  sessions: Record<string, PersistedSessionState>;
  drafts: Record<string, PersistedSessionState>;
}

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
  sessionIslandContextLabel: SessionIslandContextLabel;
  todoInProgressStatusCharacter: string;
  interruptConfirmSeconds: number;
  archiveConfirmation: boolean;
  defaultSessionAutoApprove: boolean;
  notificationMode: NotificationMode;
  notifyOnAttention: boolean;
  notifyOnSessionError: boolean;
  notifyOnTurnComplete: boolean;
  retryActionLastShown: Record<string, number>;
  retryActionSuppressed: Record<string, true>;
  workingAnimation: WorkingAnimation;
  folderCollapseDisplay: FolderCollapseDisplay;
  sessionsPanelSessionSort: SessionsPanelSessionSort;
  favoriteModels: Array<{ providerID: string; modelID: string; variant?: string }>;
  customToolDisplays: ToolDisplaySetting[];
  debugLogging: boolean;
  /** Configured IDE/editor id for the "Open project in IDE" command and menu item. */
  openIde: string;
  contextBar: ContextBarSettings;
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
  defaultSessionAutoApprove: false,
  notificationMode: DEFAULT_NOTIFICATION_MODE,
  notifyOnAttention: true,
  notifyOnSessionError: true,
  notifyOnTurnComplete: true,
  retryActionLastShown: {},
  retryActionSuppressed: {},
  workingAnimation: DEFAULT_WORKING_ANIMATION,
  folderCollapseDisplay: DEFAULT_FOLDER_COLLAPSE_DISPLAY,
  sessionsPanelSessionSort: DEFAULT_SESSIONS_PANEL_SESSION_SORT,
  favoriteModels: [],
  customToolDisplays: [],
  debugLogging: false,
  openIde: DEFAULT_OPEN_IDE_ID,
  contextBar: defaultContextBarSettings(),
};

/** Returns a validated attachment from persisted composer data. */
function normalizeComposerAttachment(value: unknown): ComposerAttachment | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.filename === "string" && typeof attachment.mime === "string" && typeof attachment.url === "string"
    ? { filename: attachment.filename, mime: attachment.mime, url: attachment.url }
    : undefined;
}

/** Compacts and validates one session or draft state loaded from versioned plugin data. */
function normalizePersistedSessionState(value: unknown): PersistedSessionState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const state: PersistedSessionState = {};
  if (input.composer && typeof input.composer === "object" && !Array.isArray(input.composer)) {
    const inputComposer = input.composer as Record<string, unknown>;
    const composer: PersistedComposerState = {};
    if (typeof inputComposer.text === "string" && inputComposer.text.trim()) composer.text = inputComposer.text;
    if (Array.isArray(inputComposer.attachments)) {
      const attachments = inputComposer.attachments.flatMap((item) => {
        const attachment = normalizeComposerAttachment(item);
        return attachment === undefined ? [] : [attachment];
      });
      if (attachments.length > 0) composer.attachments = attachments;
    }
    if (Object.keys(composer).length > 0) state.composer = composer;
  }
  if (typeof input.autoApprove === "boolean" || input.autoApprove === "inherit") state.autoApprove = input.autoApprove;
  if (typeof input.muted === "boolean") state.muted = input.muted;
  if (input.unread === true) state.unread = true;
  return Object.keys(state).length > 0 ? state : undefined;
}

/** Returns a compact validated map of persisted session-owned state. */
export function normalizePersistedSessionStates(value: unknown): Record<string, PersistedSessionState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
    const state = id.trim() ? normalizePersistedSessionState(raw) : undefined;
    return state ? [[id, state]] : [];
  }));
}

/** Returns a supported Prompt-tab context label for persisted settings and live rendering. */
export function normalizeSessionIslandContextLabel(value: unknown): SessionIslandContextLabel {
  if (typeof value === "string" && value in SESSION_ISLAND_CONTEXT_LABELS) return value as SessionIslandContextLabel;
  return DEFAULT_SESSION_ISLAND_CONTEXT_LABEL;
}

/** Returns a supported sessions-panel folder collapse treatment for persisted settings. */
export function normalizeFolderCollapseDisplay(value: unknown): FolderCollapseDisplay {
  if (typeof value === "string" && value in FOLDER_COLLAPSE_DISPLAY_LABELS) return value as FolderCollapseDisplay;
  return DEFAULT_FOLDER_COLLAPSE_DISPLAY;
}

/** Returns a supported sessions-panel session ordering for persisted settings. */
export function normalizeSessionsPanelSessionSort(value: unknown): SessionsPanelSessionSort {
  if (typeof value === "string" && value in SESSIONS_PANEL_SESSION_SORT_LABELS) return value as SessionsPanelSessionSort;
  return DEFAULT_SESSIONS_PANEL_SESSION_SORT;
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

/** Matches #rgb, #rgba, #rrggbb, and #rrggbbaa hex colors. */
const CONTEXT_SEGMENT_HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Returns true when the value is a valid hex color string for a context bar segment. */
export function isValidContextSegmentHex(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_SEGMENT_HEX_PATTERN.test(value.trim());
}

/** Normalizes one stored segment color: canonical palette name, valid hex, or accent fallback. */
export function normalizeContextSegmentColor(value: unknown): string {
  if (typeof value === "string" && value in CONTEXT_SEGMENT_COLOR_VARS) return value;
  if (isValidContextSegmentHex(value)) return value.trim().toLowerCase();
  return "accent";
}

/** Resolves a stored segment color (palette name or hex) to a CSS color value for gradients. */
export function resolveContextSegmentColor(color: string): string {
  if (color in CONTEXT_SEGMENT_COLOR_VARS) return CONTEXT_SEGMENT_COLOR_VARS[color as ContextSegmentColorName];
  return isValidContextSegmentHex(color) ? color : CONTEXT_SEGMENT_COLOR_VARS.accent;
}

/**
 * Normalizes one unit's threshold set: bounded values, strictly ascending fractions and
 * values (so the runtime piecewise mapping stays monotonic), matching color count, capped length.
 */
export function normalizeContextThresholdSet(value: unknown, unit: ContextThresholdUnit): ContextThresholdSet {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const thresholds: ContextThreshold[] = [];
  for (const raw of Array.isArray(input.thresholds) ? input.thresholds : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const fraction = Number(candidate.fraction);
    const rawValue = Number(candidate.value);
    if (!Number.isFinite(fraction) || !Number.isFinite(rawValue)) continue;
    const clampedFraction = Math.min(Math.max(fraction, 0.001), 0.999);
    const clampedValue = unit === "percent"
      ? Math.min(Math.max(Math.round(rawValue * 10) / 10, 0.1), 100)
      : Math.max(Math.round(rawValue), 1);
    const previous = thresholds[thresholds.length - 1];
    if (previous && (clampedFraction <= previous.fraction || clampedValue <= previous.value)) continue;
    thresholds.push({ fraction: clampedFraction, value: clampedValue });
    if (thresholds.length >= CONTEXT_BAR_MAX_THRESHOLDS) break;
  }
  const colors = (Array.isArray(input.segmentColors) ? input.segmentColors : [])
    .slice(0, thresholds.length + 1)
    .map((color) => normalizeContextSegmentColor(color));
  while (colors.length < thresholds.length + 1) colors.push("accent");
  return { thresholds, segmentColors: colors };
}

/**
 * Returns a validated context bar policy for persisted settings. A missing per-unit set
 * falls back to that unit's default; a present-but-emptied set is preserved as empty.
 */
export function normalizeContextBarSettings(value: unknown): ContextBarSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const hasPercent = input.percent && typeof input.percent === "object" && !Array.isArray(input.percent);
  const hasTokens = input.tokens && typeof input.tokens === "object" && !Array.isArray(input.tokens);
  return {
    unit: input.unit === "tokens" ? "tokens" : "percent",
    percent: hasPercent ? normalizeContextThresholdSet(input.percent, "percent") : cloneContextThresholdSet(DEFAULT_CONTEXT_PERCENT_SET),
    tokens: hasTokens ? normalizeContextThresholdSet(input.tokens, "tokens") : cloneContextThresholdSet(DEFAULT_CONTEXT_TOKENS_SET),
  };
}

/** Builds a hard-stop linear-gradient string from positioned color stops; shared by the session bar and the settings editor. */
export function hardStopGradient(stops: Array<{ from: number; to: number; color: string }>): string {
  const parts = stops.flatMap((stop) => [
    `${stop.color} ${(stop.from * 100).toFixed(2)}%`,
    `${stop.color} ${(stop.to * 100).toFixed(2)}%`,
  ]);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Parses a threshold value for the given unit: percent accepts `60` or `60%`; tokens accepts `100k`, `1m`, or `250000`. Returns undefined for empty or unparseable input. */
export function parseContextThresholdValue(input: string, unit: ContextThresholdUnit): number | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(unit === "percent" ? /^(\d+(?:\.\d+)?)\s*%?$/ : /^(\d+(?:\.\d+)?)\s*(k|m)?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (unit === "percent") return Math.min(value, 100);
  const suffix = match[2]?.toLowerCase();
  const tokens = suffix === "k" ? value * 1_000 : suffix === "m" ? value * 1_000_000 : value;
  return Math.max(1, Math.round(tokens));
}

/** Formats a threshold value for pill labels and settings inputs; compact k/m suffixes for round token counts. */
export function formatContextThresholdValue(value: number, unit: ContextThresholdUnit): string {
  if (unit === "percent") return `${value}%`;
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
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
  private contextBarEditor?: ContextBarEditor;

  constructor(
    app: App,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(app, plugin);
  }

  /** Renders the plugin settings currently exposed by the product specification. */
  display(): void {
    this.contextBarEditor?.dispose();
    this.contextBarEditor = undefined;
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
      .setDesc("Choose how collapsed project and worktree rows are distinguished in the sessions panel.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(FOLDER_COLLAPSE_DISPLAY_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue(normalizeFolderCollapseDisplay(this.plugin.settings.folderCollapseDisplay)).onChange(async (value) => {
          this.plugin.settings.folderCollapseDisplay = normalizeFolderCollapseDisplay(value);
          await this.plugin.saveSettings();
          await this.plugin.refreshSessionsPanels({ showLoading: false });
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

    const contextBarSetting = new Setting(this.containerEl)
      .setName("Context progress bar")
      .setDesc("Customize where context colors change. Drag a cutoff to position it, double-click it to edit its value, or select a bar segment to change its color.");
    contextBarSetting.settingEl.classList.add("opencode-settings__context-bar");
    this.contextBarEditor = new ContextBarEditor({
      getConfig: () => this.plugin.settings.contextBar,
      setConfig: (config) => { this.plugin.settings.contextBar = config; },
      save: () => this.plugin.saveSettings(),
      onApplied: () => this.plugin.refreshSessionViews(),
    });
    this.contextBarEditor.mount(contextBarSetting.settingEl);

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
            this.plugin.refreshSessionsPanels({ showLoading: false }),
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
      .setDesc("Connection used by the sessions panel, sessions, and notifications.")
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
