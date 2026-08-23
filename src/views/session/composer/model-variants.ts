import { Menu, Notice, setIcon } from "obsidian";
import type OpenCodePlugin from "../../../../main";
import { ModelSelectionMenu, type FavoriteModelRef, type ModelEntry } from "../../ModelSelectionMenu";
import type { JsonObject, OpenCodeMessageBundle, OpenCodeModelRef } from "../../../services/opencode-types";
import { setProviderIcon } from "../../../utils/provider-icons";
import type { SessionViewModel } from "../session-view-model";
import { latestUserAgent } from "../message-helpers";
import { readObject, readString } from "../json-helpers";

// ---- pure helpers (exported for unit testing)

/** Detects variant names that OpenCode models use for disabled/off reasoning. */
export function isOffReasoningVariant(variant: string): boolean {
  const normalized = variant.toLowerCase().replace(/[_-]+/g, " ").trim();
  return normalized === "none" || normalized === "off" || normalized === "disabled" || normalized === "no reasoning";
}

/** Returns true when two model refs point at the same provider/model pair. */
export function sameModel(left: OpenCodeModelRef | undefined, right: OpenCodeModelRef | undefined): boolean {
  return !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID;
}

/** Reads a model reference from a loose OpenCode model object. */
export function modelRefFromInfo(info: JsonObject): OpenCodeModelRef | undefined {
  const providerID = readString(info, ["providerID", "providerId"]);
  const modelID = readString(info, ["modelID", "modelId", "id"]);
  return providerID && modelID ? { providerID, modelID } : undefined;
}

/** Converts an agent ID to Title Case for display (e.g. "code-review" → "Code Review"). Referenced by renderAgentLabel(). */
export function titleCaseAgent(name: string): string {
  return name.split(/[\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Reads the display/ID field used by OpenCode agent objects across protocol versions. */
export function agentName(agent: JsonObject): string | undefined {
  return readString(agent, ["name", "id"]);
}

/** Filters agents exactly like OpenCode desktop: no subagents and no hidden internal agents. */
export function visibleAgents(agents: JsonObject[]): JsonObject[] {
  return agents.filter((item) => readString(item, ["mode"]) !== "subagent" && item.hidden !== true);
}

/** Resolves a CSS color for the agent label without leaking color to other UI surfaces. */
export function agentColor(agent: JsonObject | undefined): string | undefined {
  const color = agent ? readString(agent, ["color"]) : undefined;
  if (!color) return undefined;
  const named: Record<string, string> = {
    primary: "var(--interactive-accent)",
    secondary: "var(--text-muted)",
    accent: "var(--interactive-accent)",
    success: "var(--color-green)",
    warning: "var(--color-orange)",
    error: "var(--color-red)",
    info: "var(--color-blue)",
  };
  return named[color] ?? color;
}

/** Lists enabled model references from OpenCode's directory-scoped `model.list`. */
export function availableModelRefs(models: JsonObject[]): OpenCodeModelRef[] {
  return models.flatMap((item) => {
    if (item.enabled === false) return [];
    const providerID = readString(item, ["providerID", "providerId"]);
    const modelID = readString(item, ["modelID", "modelId", "id"]);
    if (!providerID || !modelID) return [];
    return [{ providerID, modelID }];
  });
}

/** Reads variant IDs from model metadata, supporting both array and object encodings. */
export function modelVariants(models: JsonObject[], ref: OpenCodeModelRef | undefined): string[] {
  if (!ref) return [];
  const info = models.find((item) => sameModel(modelRefFromInfo(item), ref));
  const raw = info?.variants;
  if (Array.isArray(raw)) return raw.flatMap((item) => (item && typeof item === "object" ? [readString(item as JsonObject, ["id", "name"])] : typeof item === "string" ? [item] : [])).filter((item): item is string => !!item);
  if (raw && typeof raw === "object") return Object.keys(raw);
  return [];
}

/** Produces a concise provider/model label for menus and the composer pill. */
export function modelLabelForRef(models: JsonObject[], ref: OpenCodeModelRef): string {
  const info = models.find((item) => sameModel(modelRefFromInfo(item), ref));
  const name = info ? readString(info, ["name", "id", "modelID", "modelId"]) : undefined;
  const base = name ?? ref.modelID;
  return ref.variant ? `${base} · ${ref.providerID} · ${ref.variant}` : `${base} · ${ref.providerID}`;
}

/** Produces the compact model pill label, keeping provider details in the tooltip/menu. */
export function modelShortLabelForRef(models: JsonObject[], ref: OpenCodeModelRef): string {
  const info = models.find((item) => sameModel(modelRefFromInfo(item), ref));
  return (info ? readString(info, ["name", "id", "modelID", "modelId"]) : undefined) ?? ref.modelID;
}

/** Resolves an agent-configured model and variant for session creation and prompt submission. */
export function modelForAgent(agents: JsonObject[], agentNameValue: string | undefined): OpenCodeModelRef | undefined {
  const agent = visibleAgents(agents).find((item) => agentName(item) === agentNameValue);
  const model = agent ? readObject(agent, "model") : undefined;
  const providerID = model ? readString(model, ["providerID", "providerId"]) : undefined;
  const modelID = model ? readString(model, ["modelID", "modelId", "id"]) : undefined;
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID, variant: agent ? readString(agent, ["variant"]) : undefined };
}

/** Builds `ModelEntry[]` from raw model info objects for the selection menu. */
export function buildModelEntries(models: JsonObject[]): ModelEntry[] {
  return models
    .filter((item) => item.enabled !== false)
    .map((item): ModelEntry | null => {
      const ref = modelRefFromInfo(item);
      if (!ref) return null;
      const name = readString(item, ["name", "id", "modelID", "modelId"]) ?? ref.modelID;
      return { providerID: ref.providerID, modelID: ref.modelID, name, variants: modelVariants(models, ref) };
    })
    .filter((e): e is ModelEntry => e !== null);
}

/** Compares two variant strings, treating every off-style reasoning preset as equivalent. */
function sameVariant(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  return !!left && !!right && isOffReasoningVariant(left) && isOffReasoningVariant(right);
}

/**
 * Picks the next favorite after the current selection: an exact model+variant
 * match first, then any favorite of the same model, wrapping to the first
 * favorite; referenced by `cycleFavoriteModel`.
 */
export function nextFavoriteRef(favorites: FavoriteModelRef[], current: OpenCodeModelRef | undefined): FavoriteModelRef | undefined {
  if (favorites.length === 0) return undefined;
  if (!current) return favorites[0];
  const exact = favorites.findIndex((fav) => fav.providerID === current.providerID && fav.modelID === current.modelID && sameVariant(fav.variant, current.variant));
  if (exact >= 0) return favorites[(exact + 1) % favorites.length];
  const partial = favorites.findIndex((fav) => fav.providerID === current.providerID && fav.modelID === current.modelID);
  if (partial >= 0) return favorites[(partial + 1) % favorites.length];
  return favorites[0];
}

/** Returns the agent after the current one in list order, wrapping; the first agent when the current one is unknown. */
export function nextAgentName(names: string[], current: string | undefined): string | undefined {
  if (names.length === 0) return undefined;
  const index = current ? names.indexOf(current) : -1;
  if (index < 0) return names[0];
  return names[(index + 1) % names.length];
}

/** Determines the composer agent from persisted choice, session state, or the latest user message. */
export function composerAgentFromState(
  agents: JsonObject[],
  session: JsonObject,
  keyChoice: string | undefined,
  messages: OpenCodeMessageBundle[],
): string | undefined {
  const requested = keyChoice ?? readString(session, ["agent"]) ?? latestUserAgent(messages);
  const visible = visibleAgents(agents);
  if (requested && visible.some((item) => agentName(item) === requested)) return requested;
  return agentName(visible[0] ?? {});
}

/** Determines the composer model from persisted choice, session state, agent default, or first available model. */
export function composerModelFromState(
  models: JsonObject[],
  agents: JsonObject[],
  session: JsonObject,
  keyChoice: OpenCodeModelRef | undefined,
  selectedAgent?: string,
): OpenCodeModelRef | undefined {
  if (keyChoice?.providerID && keyChoice.modelID) return keyChoice;
  const sessionModel = readObject(session, "model");
  const sessionProvider = sessionModel ? readString(sessionModel, ["providerID", "providerId"]) : undefined;
  const sessionModelID = sessionModel ? readString(sessionModel, ["modelID", "modelId", "id"]) : undefined;
  if (sessionProvider && sessionModelID) return { providerID: sessionProvider, modelID: sessionModelID, variant: sessionModel ? readString(sessionModel, ["variant"]) : undefined };
  const agent = selectedAgent ?? readString(session, ["agent"]);
  return modelForAgent(agents, agent) ?? availableModelRefs(models)[0];
}

// ---- stateful controller

/**
 * Deps injected by `SessionView` when constructing a `ModelVariantsController`.
 *
 * `requestRefresh` asks the shell to re-render the composer after the
 * agent/model selection changes.
 */
export interface ModelVariantsDeps {
  plugin: OpenCodePlugin;
  model: SessionViewModel;
  requestRefresh: () => Promise<void>;
}

/**
 * Owns the agent/model/thinking pills in the composer, the model selection
 * popover, and the agent/model/variant resolution rules used at session load
 * and prompt submission.
 *
 * Controller-private state (`modelMenuInstance`) lives here. Shared domain
 * state (`model.availableAgents`, `model.availableModels`, `model.selectedAgent`,
 * `model.selectedModel`) is read/written through `SessionViewModel`.
 *
 * Reference: Phase 4a of `docs/tmp/SessionView Decomposition Plan.md`.
 */
export class ModelVariantsController {
  private modelMenuInstance: ModelSelectionMenu | null = null;

  constructor(private readonly deps: ModelVariantsDeps) {}

  // ---- resolution helpers used by the shell when hydrating a session

  /** Determines the current composer agent from persisted choice, session state, or latest user message. */
  resolveAgentForSession(session: JsonObject): string | undefined {
    const key = this.deps.model.composerStorageKey;
    const keyChoice = key ? this.deps.plugin.settings.sessionAgentChoices[key] : undefined;
    return composerAgentFromState(this.deps.model.availableAgents, session, keyChoice, this.deps.model.loadedMessages);
  }

  /** Determines the composer model from persisted choice, session state, agent default, or first available model. */
  resolveModelForSession(session: JsonObject, agentNameValue: string | undefined): OpenCodeModelRef | undefined {
    const key = this.deps.model.composerStorageKey;
    const keyChoice = key ? this.deps.plugin.settings.sessionModelChoices[key] : undefined;
    return composerModelFromState(this.deps.model.availableModels, this.deps.model.availableAgents, session, keyChoice, agentNameValue);
  }

  // ---- rendering (called by renderComposer)

  /** Renders the active-agent selector; the chosen agent is sent with the next prompt. */
  renderAgentLabel(container: HTMLElement, session: JsonObject): void {
    const agent = this.deps.model.selectedAgent ?? readString(session, ["agent"]) ?? "default";
    const el = container.createSpan({ cls: "opencode-session-view__agent-label", attr: { role: "button", tabindex: "0", "aria-label": "Switch agent" } });
    const info = visibleAgents(this.deps.model.availableAgents).find((item) => agentName(item) === agent);
    const color = agentColor(info);
    if (color) el.style.setProperty("--opencode-agent-label-color", color);
    const icon = el.createSpan({ cls: "opencode-session-view__agent-label-icon" });
    setIcon(icon, "bot");
    el.createSpan({ text: titleCaseAgent(agent), cls: "opencode-session-view__agent-label-text" });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const menu = new Menu();
      const agents = visibleAgents(this.deps.model.availableAgents);
      for (const item of agents) {
        const name = agentName(item);
        if (!name) continue;
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(titleCaseAgent(name))
            .setIcon(name === agent ? "check" : "bot")
            .onClick(() => void this.chooseComposerAgent(name)),
        );
      }
      if (agents.length === 0) menu.addItem((item) => item.setTitle("No visible primary agents").setDisabled(true));
      menu.showAtMouseEvent(event as MouseEvent);
    });
  }

  /** Renders the selected model pill and its dropdown from `model.list`. */
  renderModelPill(container: HTMLElement): void {
    const selected = this.deps.model.selectedModel;
    const label = selected ? modelShortLabelForRef(this.deps.model.availableModels, selected) : "No model";
    const el = container.createSpan({ cls: "opencode-session-view__model-pill", attr: { role: "button", tabindex: "0" } });
    if (selected) {
      const icon = el.createSpan({ cls: "opencode-session-view__model-pill-icon" });
      setProviderIcon(icon, selected.providerID, 14);
    }
    el.createSpan({ text: label });
    el.setAttr("aria-label", selected ? `Switch model · ${modelLabelForRef(this.deps.model.availableModels, selected)}` : "Switch model");
    el.addEventListener("click", (event) => {
      event.preventDefault();
      void this.showModelMenu(event as MouseEvent);
    });
  }

  /** Renders the model-variant/thinking control; variants are OpenCode's reasoning/model-effort presets. */
  renderThinkingPill(container: HTMLElement): void {
    const selected = this.deps.model.selectedModel;
    const variants = modelVariants(this.deps.model.availableModels, selected);
    const label = selected?.variant ?? "off";
    const el = container.createSpan({ cls: "opencode-session-view__thinking-pill", attr: { role: "button", tabindex: "0" } });
    const icon = el.createSpan({ cls: "opencode-session-view__thinking-pill-icon" });
    setIcon(icon, "brain");
    el.createSpan({ text: label });
    el.setAttr("aria-label", variants.length > 0 ? "Cycle reasoning mode" : "This model exposes no reasoning variants");
    el.toggleClass("is-disabled", !selected);
    el.toggleClass("is-empty", variants.length === 0);
    el.addEventListener("click", () => void this.cycleThinkingVariant());
  }

  // ---- catalog fetch + selection mutations

  /** Refreshes the directory-scoped model catalog used by the model and reasoning pills. */
  async loadAvailableModels(): Promise<void> {
    try {
      this.deps.model.availableModels = await this.deps.plugin.requireOpenCodeService().listModels(this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory);
    } catch (error) {
      console.warn("[opencode-plugin:composer] model catalog failed", error);
      this.deps.model.availableModels = [];
    }
  }

  /** Updates the composer agent choice and persists it for this session; the next send carries it via the per-prompt `agent` field. */
  async chooseComposerAgent(agent: string): Promise<void> {
    const composerKey = this.deps.model.composerStorageKey;
    if (!composerKey) return;
    this.deps.model.selectedAgent = agent;
    this.deps.model.selectedModel = modelForAgent(this.deps.model.availableAgents, agent) ?? this.deps.model.selectedModel;
    await this.deps.plugin.rememberSessionAgentChoice(composerKey, agent);
    if (this.deps.model.currentSession) this.deps.model.currentSession = { ...this.deps.model.currentSession, agent };
    await this.deps.requestRefresh();
  }

  /** Updates the composer model/variant; the next send carries it via the per-prompt `model` field. */
  async chooseComposerModel(model: OpenCodeModelRef): Promise<void> {
    const composerKey = this.deps.model.composerStorageKey;
    if (!composerKey) return;
    this.deps.model.selectedModel = model;
    await this.deps.plugin.rememberSessionModelChoice(composerKey, model);
    if (this.deps.model.currentSession) this.deps.model.currentSession = { ...this.deps.model.currentSession, model: { providerID: model.providerID, id: model.modelID, variant: model.variant } };
    await this.deps.requestRefresh();
  }

  /** Cycles the current model's configured variants, treating no variant as thinking off/default. */
  async cycleThinkingVariant(): Promise<void> {
    const selected = this.deps.model.selectedModel;
    if (!selected) return;
    if (this.deps.model.availableModels.length === 0) await this.loadAvailableModels();
    const variants = modelVariants(this.deps.model.availableModels, selected);
    if (variants.length === 0) {
      new Notice("This model does not expose reasoning variants.");
      return;
    }
    const current = selected.variant;
    const index = current ? variants.indexOf(current) : -1;
    const firstEnabled = variants.find((variant) => !isOffReasoningVariant(variant)) ?? variants[0];
    const offVariant = variants.find((variant) => isOffReasoningVariant(variant));
    const next = index < 0 ? firstEnabled : index === variants.length - 1 ? offVariant : variants[index + 1];
    await this.chooseComposerModel({ ...selected, variant: next });
  }

  /** Cycles to the next starred model-variant pair, skipping favorites missing from the catalog; referenced by the plugin's cycle-favorites command. */
  async cycleFavoriteModel(): Promise<void> {
    const favorites = this.deps.plugin.settings.favoriteModels;
    if (favorites.length === 0) {
      new Notice("No favorite models yet. Star a model in the model menu to add one.");
      return;
    }
    if (this.deps.model.availableModels.length === 0) await this.loadAvailableModels();
    const catalog = this.deps.model.availableModels;
    const usable = catalog.length > 0 ? favorites.filter((fav) => catalog.some((item) => sameModel(modelRefFromInfo(item), fav))) : favorites;
    if (usable.length === 0) {
      new Notice("None of your favorite models are currently available.");
      return;
    }
    const next = nextFavoriteRef(usable, this.deps.model.selectedModel);
    if (!next) return;
    await this.chooseComposerModel({ providerID: next.providerID, modelID: next.modelID, variant: next.variant });
  }

  /** Cycles to the next visible agent mode; an agent-configured model overrides a manual choice; referenced by the plugin's cycle-agent-mode command. */
  async cycleAgentMode(): Promise<void> {
    const names = visibleAgents(this.deps.model.availableAgents)
      .map((item) => agentName(item))
      .filter((name): name is string => !!name);
    if (names.length === 0) {
      new Notice("No agent modes are available.");
      return;
    }
    const next = nextAgentName(names, this.deps.model.selectedAgent);
    if (!next || next === this.deps.model.selectedAgent) return;
    await this.chooseComposerAgent(next);
  }

  /** Drops the model-selection popover so a closed view cannot leak it; called by `SessionView.onClose`. */
  dispose(): void {
    this.hideModelMenu();
  }

  /** Closes an open model-selection popover; called by the shell on tab switch so the menu does not float across views. */
  hideModelMenu(): void {
    this.modelMenuInstance?.close();
    this.modelMenuInstance = null;
  }

  // ---- private

  /** Loads models if needed and opens the custom model selection popover. */
  private async showModelMenu(event: MouseEvent): Promise<void> {
    if (availableModelRefs(this.deps.model.availableModels).length === 0) await this.loadAvailableModels();
    const entries = buildModelEntries(this.deps.model.availableModels);
    if (entries.length === 0) {
      new Notice("No OpenCode models are available from the server yet.");
      return;
    }
    this.modelMenuInstance?.close();
    this.modelMenuInstance = new ModelSelectionMenu({
      entries,
      selectedModel: this.deps.model.selectedModel,
      favorites: this.deps.plugin.settings.favoriteModels,
      anchorEl: event.currentTarget as HTMLElement,
      onSelect: (ref) => void this.chooseComposerModel(ref),
      onToggleFavorite: (ref) => { void this.deps.plugin.toggleFavoriteModel(ref); },
    });
  }
}
