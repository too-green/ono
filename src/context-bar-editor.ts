import { setIcon } from "obsidian";
import {
  CONTEXT_BAR_MAX_THRESHOLDS,
  CONTEXT_SEGMENT_COLOR_VARS,
  CONTEXT_THRESHOLD_UNIT_LABELS,
  formatContextThresholdValue,
  hardStopGradient,
  isValidContextSegmentHex,
  parseContextThresholdValue,
  resolveContextSegmentColor,
  normalizeContextBarSettings,
  type ContextBarSettings,
  type ContextThreshold,
  type ContextThresholdSet,
  type ContextThresholdUnit,
} from "./settings";

/**
 * Visual editor for the context progress bar policy, mounted inside the plugin
 * settings tab by `OpenCodeSettingTab.display`.
 *
 * Renders a live preview bar with a 0→1 ruler. Threshold pills sit above the
 * bar and drag horizontally between their neighbors to set split positions;
 * double-clicking a pill opens a value editor (with removal), and clicking a
 * segment opens a color picker (palette names or hex). Each unit's threshold
 * set is persisted independently, so switching units preserves both.
 *
 * Pure helpers (`clampThresholdFraction`, `clampThresholdValue`,
 * `computeInsertSlot`) are exported for unit tests. Lifecycle:
 * `mount(container)` → `render()` on every commit → `dispose()`.
 */

/** Distance a pill must keep from the bar's 0/1 ends. */
export const CONTEXT_BAR_EDGE_MARGIN = 0.02;
/** Minimum distance between two neighboring pills. */
export const CONTEXT_BAR_MIN_GAP = 0.04;
/** Keyboard nudge step for a focused pill. */
export const CONTEXT_BAR_POSITION_STEP = 0.01;

/** Insertion plan for a new threshold: target index plus seeded fraction/value. */
export interface ContextThresholdInsertSlot {
  index: number;
  fraction: number;
  value: number;
}

/** Clamps a dragged fraction between the pill's neighbors and the bar's 0/1 ends. */
export function clampThresholdFraction(fraction: number, thresholds: ContextThreshold[], index: number): number {
  const lowerRaw = index > 0 ? thresholds[index - 1].fraction + CONTEXT_BAR_MIN_GAP : CONTEXT_BAR_EDGE_MARGIN;
  const upperRaw = index < thresholds.length - 1 ? thresholds[index + 1].fraction - CONTEXT_BAR_MIN_GAP : 1 - CONTEXT_BAR_EDGE_MARGIN;
  const lower = Math.ceil(lowerRaw / CONTEXT_BAR_POSITION_STEP) * CONTEXT_BAR_POSITION_STEP;
  const upper = Math.floor(upperRaw / CONTEXT_BAR_POSITION_STEP) * CONTEXT_BAR_POSITION_STEP;
  if (lower > upper) return thresholds[index].fraction;
  const snapped = Math.round(fraction / CONTEXT_BAR_POSITION_STEP) * CONTEXT_BAR_POSITION_STEP;
  return Math.round(Math.min(Math.max(snapped, lower), upper) * 100) / 100;
}

/** Clamps an edited value strictly between neighbor values and unit bounds; returns undefined when no valid value exists. */
export function clampThresholdValue(value: number, thresholds: ContextThreshold[], index: number, unit: ContextThresholdUnit): number | undefined {
  const granularity = unit === "percent" ? 0.1 : 1;
  const unitMin = unit === "percent" ? 0.1 : 1;
  const unitMax = unit === "percent" ? 100 : Number.POSITIVE_INFINITY;
  const prevValue = thresholds[index - 1]?.value ?? unitMin - granularity;
  const nextValue = thresholds[index + 1]?.value ?? unitMax + granularity;
  const rounded = unit === "percent" ? Math.round(value * 10) / 10 : Math.round(value);
  const clamped = Math.min(Math.max(rounded, prevValue + granularity), nextValue - granularity);
  if (!Number.isFinite(clamped) || clamped <= prevValue || clamped >= nextValue || clamped < unitMin || clamped > unitMax) return undefined;
  return clamped;
}

/** Rounds a value to the unit's granularity (one decimal for percent, integers for tokens). */
function roundThresholdValue(value: number, unit: ContextThresholdUnit): number {
  return unit === "percent" ? Math.round(value * 10) / 10 : Math.round(value);
}

/**
 * Finds the widest fraction gap with room for a new pill and seeds its value
 * between the neighboring thresholds' values. Returns undefined at the cap or
 * when no gap (or no valid in-between value) exists.
 */
export function computeInsertSlot(thresholds: ContextThreshold[], unit: ContextThresholdUnit): ContextThresholdInsertSlot | undefined {
  if (thresholds.length >= CONTEXT_BAR_MAX_THRESHOLDS) return undefined;
  const bounds: Array<{ start: number; end: number; lowerIndex: number; upperIndex: number }> = [];
  let previous = 0;
  for (let i = 0; i < thresholds.length; i++) {
    bounds.push({ start: previous, end: thresholds[i].fraction, lowerIndex: i - 1, upperIndex: i });
    previous = thresholds[i].fraction;
  }
  bounds.push({ start: previous, end: 1, lowerIndex: thresholds.length - 1, upperIndex: thresholds.length });

  let best: { fraction: number; width: number; lowerIndex: number; upperIndex: number } | undefined;
  for (const bound of bounds) {
    const lowerLimit = bound.lowerIndex >= 0 ? thresholds[bound.lowerIndex].fraction + CONTEXT_BAR_MIN_GAP : CONTEXT_BAR_EDGE_MARGIN;
    const upperLimit = bound.upperIndex < thresholds.length ? thresholds[bound.upperIndex].fraction - CONTEXT_BAR_MIN_GAP : 1 - CONTEXT_BAR_EDGE_MARGIN;
    if (lowerLimit > upperLimit) continue;
    const width = upperLimit - lowerLimit;
    if (!best || width > best.width) {
      const midpoint = Math.round(((lowerLimit + upperLimit) / 2) / CONTEXT_BAR_POSITION_STEP) * CONTEXT_BAR_POSITION_STEP;
      best = { fraction: midpoint, width, lowerIndex: bound.lowerIndex, upperIndex: bound.upperIndex };
    }
  }
  if (!best) return undefined;

  // ---- Value seeding: midpoint between neighbors, or half/double at the open ends ----
  const lowerValue = best.lowerIndex >= 0 ? thresholds[best.lowerIndex].value : undefined;
  const upperValue = best.upperIndex < thresholds.length ? thresholds[best.upperIndex].value : undefined;
  let value: number;
  if (lowerValue !== undefined && upperValue !== undefined) value = roundThresholdValue((lowerValue + upperValue) / 2, unit);
  else if (lowerValue !== undefined) value = roundThresholdValue(unit === "percent" ? (lowerValue + 100) / 2 : lowerValue * 2, unit);
  else if (upperValue !== undefined) value = roundThresholdValue(upperValue / 2, unit);
  else value = unit === "percent" ? 50 : 100_000;

  const scratch = [...thresholds];
  scratch.splice(best.upperIndex, 0, { fraction: best.fraction, value });
  const validated = clampThresholdValue(value, scratch, best.upperIndex, unit);
  if (validated === undefined) return undefined;
  return { index: best.upperIndex, fraction: best.fraction, value: validated };
}

export interface ContextBarEditorDeps {
  /** Reads the current context bar policy from plugin settings. */
  getConfig: () => ContextBarSettings;
  /** Writes a mutated policy back into plugin settings. */
  setConfig: (config: ContextBarSettings) => void;
  /** Persists plugin settings. */
  save: () => Promise<void>;
  /** Refreshes open session views after a committed change. */
  onApplied: () => void | Promise<void>;
}

/** Interactive settings-tab editor for the context progress bar. */
export class ContextBarEditor {
  private rootEl?: HTMLElement;
  private trackEl?: HTMLElement;
  private stripEl?: HTMLElement;
  private positionEl?: HTMLElement;
  private readonly pillEls: HTMLElement[] = [];
  private readonly segmentEls: HTMLElement[] = [];
  private popoverEl?: HTMLElement;
  private dragState?: {
    index: number;
    thresholds: ContextThreshold[];
    originalFraction: number;
    pointerId?: number;
    pill: HTMLElement;
    view: Window;
  };
  private readonly deps: ContextBarEditorDeps;

  constructor(deps: ContextBarEditorDeps) {
    this.deps = deps;
  }

  /** Builds the editor DOM inside the given settings container; called by `OpenCodeSettingTab.display`. */
  mount(container: HTMLElement): void {
    this.dispose();
    const root = container.createDiv({ cls: "opencode-context-bar-editor" });
    this.rootEl = root;
    this.render();
  }

  /** Drops DOM refs and live listeners so a re-displayed or closed tab cannot leak; referenced by `mount` and the settings tab. */
  dispose(): void {
    this.endDrag();
    this.closePopover();
    this.pillEls.length = 0;
    this.segmentEls.length = 0;
    this.trackEl = undefined;
    this.stripEl = undefined;
    this.positionEl = undefined;
    this.rootEl = undefined;
  }

  // ---- Model access ----

  /** Returns the threshold set for the given unit; referenced by render and popover builders. */
  private setFor(config: ContextBarSettings, unit: ContextThresholdUnit): ContextThresholdSet {
    return unit === "tokens" ? config.tokens : config.percent;
  }

  /** Returns the currently active unit's set; referenced by render, drag, and popover flows. */
  private activeSet(): ContextThresholdSet {
    const config = normalizeContextBarSettings(this.deps.getConfig());
    return this.setFor(config, config.unit);
  }

  /**
   * Applies a mutation to a cloned policy, sanitizes it through the settings
   * normalizer, persists, refreshes session views, and re-renders. Referenced
   * by every committing interaction (drag end, value/color/unit/add/remove).
   */
  private commit(mutate: (config: ContextBarSettings) => void): void {
    const config = normalizeContextBarSettings(this.deps.getConfig());
    mutate(config);
    this.deps.setConfig(normalizeContextBarSettings(config));
    void this.saveAndApply();
    this.render();
  }

  /** Persists one committed policy before refreshing every session view. */
  private async saveAndApply(): Promise<void> {
    await this.deps.save();
    this.deps.onApplied();
  }

  // ---- Rendering ----

  /** Rebuilds the whole editor from current settings; called by `mount` and after every commit. */
  private render(): void {
    const root = this.rootEl;
    if (!root) return;
    this.closePopover();
    this.endDrag();
    root.empty();
    this.pillEls.length = 0;
    this.segmentEls.length = 0;
    this.stripEl = undefined;
    this.positionEl = undefined;

    const config = normalizeContextBarSettings(this.deps.getConfig());
    const set = this.setFor(config, config.unit);

    // ---- Controls: unit toggle + add-threshold ----
    const controls = root.createDiv({ cls: "opencode-context-bar-editor__controls" });
    const toggle = controls.createDiv({
      cls: "opencode-context-bar-editor__unit-toggle",
      attr: { role: "group", "aria-label": "Cutoff unit" },
    });
    for (const unit of ["percent", "tokens"] as const) {
      const button = toggle.createEl("button", {
        cls: `opencode-context-bar-editor__unit-button${config.unit === unit ? " is-active" : ""}`,
        attr: { type: "button", "aria-pressed": String(config.unit === unit) },
      });
      button.setText(CONTEXT_THRESHOLD_UNIT_LABELS[unit]);
      button.addEventListener("click", () => {
        if (config.unit === unit) return;
        this.commit((next) => { next.unit = unit; });
      });
    }
    const slot = computeInsertSlot(set.thresholds, config.unit);
    const addButton = controls.createEl("button", {
      cls: "opencode-context-bar-editor__add-button",
      attr: { type: "button", "aria-label": "Add cutoff" },
    });
    const addIcon = addButton.createSpan({ cls: "opencode-context-bar-editor__add-icon" });
    setIcon(addIcon, "plus");
    addButton.createSpan().setText("Add cutoff");
    if (!slot) addButton.disabled = true;
    addButton.addEventListener("click", () => this.addThreshold());

    // ---- Preview bar: pills above, gradient track with segment hit areas, ruler below ----
    const barArea = root.createDiv({ cls: "opencode-context-bar-editor__bar-area" });
    const pillsLayer = barArea.createDiv({ cls: "opencode-context-bar-editor__pills" });
    for (let i = 0; i < set.thresholds.length; i++) {
      pillsLayer.appendChild(this.buildPill(set.thresholds[i], config.unit, i));
    }
    const track = barArea.createDiv({ cls: "opencode-context-bar-editor__track" });
    this.trackEl = track;
    this.stripEl = track.createDiv({ cls: "opencode-context-bar-editor__strip" });
    for (let i = 0; i <= set.thresholds.length; i++) {
      track.appendChild(this.buildSegment(i));
    }
    this.buildRuler(barArea);
    this.layoutBar(set);

    // ---- Unit hint ----
    const hint = root.createDiv({ cls: "opencode-context-bar-editor__hint" });
    hint.setText(config.unit === "tokens"
      ? "If a model's context limit is below a cutoff, that color section extends to the end of the bar."
      : "Percent cutoffs are relative to each model's context limit.");
  }

  /** Builds one draggable threshold pill; referenced by `render`. */
  private buildPill(threshold: ContextThreshold, unit: ContextThresholdUnit, index: number): HTMLElement {
    const pill = document.createElement("button");
    pill.className = "opencode-context-bar-editor__pill";
    pill.setAttribute("type", "button");
    pill.setAttribute("data-pill-index", String(index));
    pill.setAttribute("aria-label", `Cutoff ${formatContextThresholdValue(threshold.value, unit)} at bar position ${threshold.fraction.toFixed(2)}. Drag to move; double-click to edit.`);
    const label = pill.createSpan({ cls: "opencode-context-bar-editor__pill-label" });
    label.setText(formatContextThresholdValue(threshold.value, unit));
    pill.addEventListener("pointerdown", (event) => this.startDrag(event, index));
    pill.addEventListener("dblclick", () => this.openValuePopover(index));
    pill.addEventListener("keydown", (event) => this.handlePillKeydown(event, index));
    this.pillEls.push(pill);
    return pill;
  }

  /** Builds one clickable color segment overlay; referenced by `render`. */
  private buildSegment(index: number): HTMLElement {
    const segment = document.createElement("div");
    segment.className = "opencode-context-bar-editor__segment";
    segment.setAttribute("data-segment-index", String(index));
    segment.setAttribute("role", "button");
    segment.setAttribute("aria-label", `Segment ${index + 1} color`);
    segment.addEventListener("click", () => this.openColorPopover(index));
    this.segmentEls.push(segment);
    return segment;
  }

  /** Builds the 0→1 ruler beneath the track; referenced by `render`. */
  private buildRuler(barArea: HTMLElement): void {
    const ruler = barArea.createDiv({ cls: "opencode-context-bar-editor__ruler" });
    for (let tick = 0; tick <= 4; tick++) {
      ruler.createDiv({ cls: "opencode-context-bar-editor__ruler-tick", attr: { style: `left: ${tick * 25}%` } });
    }
    const start = ruler.createSpan({ cls: "opencode-context-bar-editor__ruler-label is-start" });
    start.setText("0");
    const end = ruler.createSpan({ cls: "opencode-context-bar-editor__ruler-label is-end" });
    end.setText("1");
    const position = ruler.createSpan({
      cls: "opencode-context-bar-editor__position",
      attr: { "aria-live": "polite", "aria-label": "Cutoff position" },
    });
    position.hidden = true;
    this.positionEl = position;
  }

  /** Positions pills and segments, and paints the gradient, from the given (possibly in-drag) set; referenced by `render` and `handleDragMove`. */
  private layoutBar(set: ContextThresholdSet): void {
    const fractions = set.thresholds.map((threshold) => threshold.fraction);
    const stops: Array<{ from: number; to: number; color: string }> = [];
    for (let i = 0; i <= fractions.length; i++) {
      const from = i === 0 ? 0 : fractions[i - 1];
      const to = i === fractions.length ? 1 : fractions[i];
      stops.push({ from, to, color: resolveContextSegmentColor(set.segmentColors[i] ?? "accent") });
      const segment = this.segmentEls[i];
      if (segment) {
        segment.style.left = `${(from * 100).toFixed(2)}%`;
        segment.style.width = `${((to - from) * 100).toFixed(2)}%`;
      }
    }
    if (this.stripEl) this.stripEl.style.background = hardStopGradient(stops);
    for (let i = 0; i < this.pillEls.length; i++) {
      this.pillEls[i].style.left = `${(fractions[i] * 100).toFixed(2)}%`;
    }
  }

  // ---- Drag ----

  /** Starts a captured pill drag in the element's owning window; referenced by pill pointerdown. */
  private startDrag(event: PointerEvent, index: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.closePopover();
    const pill = event.currentTarget as HTMLElement;
    const view = pill.ownerDocument.defaultView;
    if (!view) return;
    const set = this.activeSet();
    const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : undefined;
    this.dragState = {
      index,
      thresholds: set.thresholds.map((threshold) => ({ ...threshold })),
      originalFraction: set.thresholds[index].fraction,
      pointerId,
      pill,
      view,
    };
    pill.classList.add("is-dragging");
    if (pointerId !== undefined) pill.setPointerCapture?.(pointerId);
    this.showDragPosition(set.thresholds[index].fraction);
    view.addEventListener("pointermove", this.handleDragMove, true);
    view.addEventListener("pointerup", this.handleDragEnd, true);
    view.addEventListener("pointercancel", this.handleDragEnd, true);
  }

  /** Moves the dragged pill in one-percent steps, clamped between neighbors; referenced by the owning-window listener. */
  private handleDragMove = (event: PointerEvent): void => {
    const drag = this.dragState;
    const rect = this.trackEl?.getBoundingClientRect();
    if (!drag || !rect || rect.width <= 0) return;
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    const raw = (event.clientX - rect.left) / rect.width;
    drag.thresholds[drag.index].fraction = clampThresholdFraction(raw, drag.thresholds, drag.index);
    this.layoutBar({ thresholds: drag.thresholds, segmentColors: this.activeSet().segmentColors });
    this.showDragPosition(drag.thresholds[drag.index].fraction);
  };

  /** Commits the dragged fraction on pointer release/cancel; referenced by the owning-window listeners. */
  private handleDragEnd = (event?: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag) return;
    if (drag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    const { index, thresholds, originalFraction } = drag;
    this.endDrag();
    if (thresholds[index].fraction === originalFraction) return;
    this.commit((config) => {
      this.setFor(config, config.unit).thresholds[index].fraction = thresholds[index].fraction;
    });
  };

  /** Releases pointer capture and owning-window listeners; referenced by drag end, `render`, and `dispose`. */
  private endDrag(): void {
    const drag = this.dragState;
    this.dragState = undefined;
    if (!drag) return;
    drag.view.removeEventListener("pointermove", this.handleDragMove, true);
    drag.view.removeEventListener("pointerup", this.handleDragEnd, true);
    drag.view.removeEventListener("pointercancel", this.handleDragEnd, true);
    drag.pill.classList.remove("is-dragging");
    if (drag.pointerId !== undefined && drag.pill.hasPointerCapture?.(drag.pointerId)) drag.pill.releasePointerCapture?.(drag.pointerId);
    if (this.positionEl) this.positionEl.hidden = true;
  }

  /** Shows the active threshold's 0–1 scale position beneath the bar while dragging. */
  private showDragPosition(fraction: number): void {
    if (!this.positionEl) return;
    this.positionEl.hidden = false;
    this.positionEl.style.left = `${(fraction * 100).toFixed(2)}%`;
    this.positionEl.setText(fraction.toFixed(2));
  }

  /** Nudges a focused pill with the arrow keys and opens the value editor on Enter; referenced by the pill keydown listener. */
  private handlePillKeydown(event: KeyboardEvent, index: number): void {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const set = this.activeSet();
      const next = clampThresholdFraction(set.thresholds[index].fraction + (event.key === "ArrowLeft" ? -CONTEXT_BAR_POSITION_STEP : CONTEXT_BAR_POSITION_STEP), set.thresholds, index);
      if (next === set.thresholds[index].fraction) return;
      this.commit((config) => {
        this.setFor(config, config.unit).thresholds[index].fraction = next;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.openValuePopover(index);
    }
  }

  // ---- Mutations ----

  /** Inserts a threshold at the widest gap and immediately opens its value editor; referenced by the add button. */
  private addThreshold(): void {
    const config = normalizeContextBarSettings(this.deps.getConfig());
    const set = this.setFor(config, config.unit);
    const slot = computeInsertSlot(set.thresholds, config.unit);
    if (!slot) return;
    this.commit((next) => {
      const target = this.setFor(next, next.unit);
      target.thresholds.splice(slot.index, 0, { fraction: slot.fraction, value: slot.value });
      // The split segment inherits the lower segment's color until recolored.
      target.segmentColors.splice(slot.index, 0, target.segmentColors[slot.index] ?? "accent");
    });
    this.openValuePopover(slot.index);
  }

  // ---- Popovers ----

  /** Closes any open popover and removes its outside-click listener; referenced by render, commit flows, and `dispose`. */
  private closePopover(): void {
    this.popoverEl?.remove();
    this.popoverEl = undefined;
    document.removeEventListener("pointerdown", this.handlePopoverOutside, true);
  }

  /** Commits and closes an open value popover when the user clicks elsewhere; referenced by the document capture listener. */
  private handlePopoverOutside = (event: PointerEvent): void => {
    if (!this.popoverEl?.isConnected) return;
    if (this.popoverEl.contains(event.target as Node)) return;
    const input = this.popoverEl.querySelector("input");
    if (input && this.popoverEl.dataset.kind === "value") this.commitValueInput();
    this.closePopover();
  };

  /** Opens the threshold value editor (with removal) anchored under a pill; referenced by pill dblclick/Enter and `addThreshold`. */
  private openValuePopover(index: number): void {
    this.closePopover();
    const root = this.rootEl;
    if (!root) return;
    const config = normalizeContextBarSettings(this.deps.getConfig());
    const set = this.setFor(config, config.unit);
    const threshold = set.thresholds[index];
    if (!threshold) return;

    const popover = root.createDiv({ cls: "opencode-context-bar-editor__popover", attr: { "data-kind": "value", "data-index": String(index) } });
    popover.createSpan({ cls: "opencode-context-bar-editor__popover-title" }).setText("Cutoff value");
    const input = popover.createEl("input", {
      cls: "opencode-context-bar-editor__value-input",
      attr: { type: "text", "aria-label": `Cutoff ${index + 1} value` },
    }) as HTMLInputElement;
    input.value = formatContextThresholdValue(threshold.value, config.unit);

    // Range hint: neighbors if present, otherwise unit bounds.
    const lower = set.thresholds[index - 1]?.value;
    const upper = set.thresholds[index + 1]?.value;
    const lowerText = lower !== undefined ? formatContextThresholdValue(lower, config.unit) : config.unit === "percent" ? "0.1" : "1";
    const upperText = upper !== undefined ? formatContextThresholdValue(upper, config.unit) : config.unit === "percent" ? "100" : "∞";
    popover.createSpan({ cls: "opencode-context-bar-editor__popover-hint" }).setText(`Between ${lowerText} and ${upperText}. Enter to apply.`);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (this.commitValueInput()) this.closePopover();
      } else if (event.key === "Escape") {
        this.closePopover();
      }
    });
    input.addEventListener("change", () => {
      if (this.commitValueInput()) this.closePopover();
    });

    const remove = popover.createEl("button", {
      cls: "opencode-context-bar-editor__remove-button",
      attr: { type: "button", "aria-label": `Remove cutoff ${index + 1}` },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => {
      this.closePopover();
      this.commit((next) => {
        const target = this.setFor(next, next.unit);
        target.thresholds.splice(index, 1);
        // Merging segments keeps the lower segment's color.
        target.segmentColors.splice(index + 1, 1);
      });
    });

    this.popoverEl = popover;
    document.addEventListener("pointerdown", this.handlePopoverOutside, true);
    window.setTimeout(() => input.focus(), 0);
  }

  /** Parses, clamps, and persists the popover's value input; reverts the field when invalid. Returns true on success. */
  private commitValueInput(): boolean {
    const popover = this.popoverEl;
    if (!popover) return false;
    const config = normalizeContextBarSettings(this.deps.getConfig());
    const set = this.setFor(config, config.unit);
    const index = Number(popover.dataset.index);
    const input = popover.querySelector<HTMLInputElement>("input.opencode-context-bar-editor__value-input");
    if (!input || !set.thresholds[index]) return false;
    const parsed = parseContextThresholdValue(input.value, config.unit);
    const clamped = parsed === undefined ? undefined : clampThresholdValue(parsed, set.thresholds, index, config.unit);
    if (clamped === undefined) {
      input.value = formatContextThresholdValue(set.thresholds[index].value, config.unit);
      return false;
    }
    this.commit((next) => {
      this.setFor(next, next.unit).thresholds[index].value = clamped;
    });
    return true;
  }

  /** Opens the segment color picker (palette swatches + hex) anchored under a segment; referenced by segment clicks. */
  private openColorPopover(segmentIndex: number): void {
    this.closePopover();
    const root = this.rootEl;
    if (!root) return;
    const config = normalizeContextBarSettings(this.deps.getConfig());
    const set = this.setFor(config, config.unit);
    const current = set.segmentColors[segmentIndex] ?? "accent";

    const popover = root.createDiv({ cls: "opencode-context-bar-editor__popover", attr: { "data-kind": "color", "data-index": String(segmentIndex) } });
    popover.createSpan({ cls: "opencode-context-bar-editor__popover-title" }).setText("Segment color");
    const swatches = popover.createDiv({ cls: "opencode-context-bar-editor__swatches" });
    for (const [name, cssVar] of Object.entries(CONTEXT_SEGMENT_COLOR_VARS)) {
      const swatch = swatches.createEl("button", {
        cls: `opencode-context-bar-editor__swatch${current === name ? " is-active" : ""}`,
        attr: { type: "button", "aria-pressed": String(current === name), style: `color: ${cssVar}` },
      });
      swatch.setText(name);
      swatch.addEventListener("click", () => {
        this.commit((next) => {
          this.setFor(next, next.unit).segmentColors[segmentIndex] = name;
        });
        this.closePopover();
      });
    }
    const hex = popover.createEl("input", {
      cls: "opencode-context-bar-editor__hex-input",
      attr: { type: "text", placeholder: "#rrggbb", "aria-label": `Segment ${segmentIndex + 1} hex color` },
    }) as HTMLInputElement;
    if (isValidContextSegmentHex(current)) hex.value = current;
    hex.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.commitHexInput()) this.closePopover();
    });
    hex.addEventListener("change", () => {
      if (this.commitHexInput()) this.closePopover();
    });

    this.popoverEl = popover;
    document.addEventListener("pointerdown", this.handlePopoverOutside, true);
  }

  /** Validates and persists the hex input; reverts when invalid. Returns true on success. */
  private commitHexInput(): boolean {
    const popover = this.popoverEl;
    if (!popover) return false;
    const segmentIndex = Number(popover.dataset.index);
    const input = popover.querySelector<HTMLInputElement>("input.opencode-context-bar-editor__hex-input");
    if (!input) return false;
    const value = input.value.trim().toLowerCase();
    if (!isValidContextSegmentHex(value)) {
      input.value = "";
      return false;
    }
    this.commit((next) => {
      this.setFor(next, next.unit).segmentColors[segmentIndex] = value;
    });
    return true;
  }
}
