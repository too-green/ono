import { readNumber, readObject, readString } from "../json-helpers";
import { formatCompactNumber } from "../format-helpers";
import { modelRefFromInfo, sameModel } from "./model-variants";
import type { SessionViewModel } from "../session-view-model";
import { CONTEXT_BAR_MAX_THRESHOLDS, CONTEXT_SEGMENT_COLOR_VARS, hardStopGradient, resolveContextSegmentColor, type ContextBarSettings, type ContextThresholdSet } from "../../../settings";

/**
 * Progress bar pinned to the composer's bottom border.
 *
 * Owns the bar DOM (mask + gradient track + checkpoint markers) and reads token
 * usage from `model.loadedMessages` and the limit from `model.selectedModel`.
 * Scale and color thresholds come from `settings.contextBar`; pure math
 * (`computeProgressSections`, `contextToBarFraction`, `sectionsToGradient`) is
 * exported for unit testing.
 *
 * Lifecycle: `mount(container)` creates the DOM, `update()` re-pulls model
 * state, `dispose()` drops refs. The shell calls `update()` after each
 * streaming render frame and after canonical sync.
 */

/** Upper bound on sections (thresholds + final) and therefore on rendered markers. */
const MAX_MARKERS = CONTEXT_BAR_MAX_THRESHOLDS + 1;

export interface ProgressSection {
  startFraction: number;
  endFraction: number;
  startContext: number;
  endContext: number;
  color: string;
}

/**
 * Computes effective progress sections from the context bar policy and the model's context limit.
 *
 * Walks the active unit's thresholds in fraction order. Extend-to-end
 * truncation: the section ending at the first threshold whose resolved context
 * exceeds the limit stretches to the bar's end and later thresholds drop, so a
 * short-context model never renders unreachable segments. Percent thresholds
 * resolve against the limit, so they never overflow. An empty set (or unknown
 * limit) yields a single accent section.
 *
 * Pure: exported for unit tests in `context-progress-bar.test.ts`.
 * Referenced by `ContextProgressBarController.update`.
 */
export function computeProgressSections(limit: number, config: ContextBarSettings): ProgressSection[] {
  if (limit <= 0) {
    return [{ startFraction: 0, endFraction: 1, startContext: 0, endContext: 0, color: resolveContextSegmentColor("accent") }];
  }
  const set: ContextThresholdSet = config.unit === "tokens" ? config.tokens : config.percent;

  const sections: ProgressSection[] = [];
  let previousFraction = 0;
  let previousContext = 0;
  for (let i = 0; i < set.thresholds.length; i++) {
    const threshold = set.thresholds[i];
    const context = config.unit === "percent" ? (threshold.value / 100) * limit : threshold.value;
    const color = resolveContextSegmentColor(set.segmentColors[i] ?? "accent");
    if (context > limit) {
      // The section ending at this overflowing threshold extends to the bar's end.
      sections.push({ startFraction: previousFraction, endFraction: 1, startContext: previousContext, endContext: limit, color });
      return sections;
    }
    sections.push({ startFraction: previousFraction, endFraction: threshold.fraction, startContext: previousContext, endContext: context, color });
    previousFraction = threshold.fraction;
    previousContext = context;
  }
  sections.push({ startFraction: previousFraction, endFraction: 1, startContext: previousContext, endContext: limit, color: resolveContextSegmentColor(set.segmentColors[set.thresholds.length] ?? "accent") });
  return sections;
}

/**
 * Maps an absolute token count to a bar fraction via piecewise-linear interpolation across sections.
 *
 * Scans from the end so a value landing on a shared boundary (including a
 * zero-width clamped tail section) resolves to the latest section, keeping the
 * curve monotonic all the way to a full bar at the model limit.
 *
 * Pure: exported for unit tests in `context-progress-bar.test.ts`.
 * Referenced by `ContextProgressBarController.update`.
 */
export function contextToBarFraction(used: number, sections: ProgressSection[]): number {
  if (used <= 0 || sections.length === 0) return 0;
  const last = sections[sections.length - 1];
  if (used > last.endContext) return 1.0;
  if (used === last.endContext) return last.endFraction;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const section = sections[i];
    if (used < section.startContext || used > section.endContext) continue;
    const contextRange = section.endContext - section.startContext;
    if (contextRange <= 0) return section.endFraction;
    const t = (used - section.startContext) / contextRange;
    return section.startFraction + t * (section.endFraction - section.startFraction);
  }
  return 0;
}

/** Builds a CSS linear-gradient string with hard color stops at each section boundary; delegates to the shared settings helper. */
export function sectionsToGradient(sections: { startFraction: number; endFraction: number; color: string }[]): string {
  return hardStopGradient(sections.map((section) => ({ from: section.startFraction, to: section.endFraction, color: section.color })));
}

/** Returns total tokens from the latest assistant message, or 0; used by the bar and Session Island label. */
function currentContextLength(model: SessionViewModel): number {
  for (let i = model.loadedMessages.length - 1; i >= 0; i -= 1) {
    const bundle = model.loadedMessages[i];
    if (readString(bundle.info, ["role"]) !== "assistant") continue;
    const tokens = readObject(bundle.info, "tokens");
    if (!tokens) continue;
    const input = readNumber(tokens, ["input"]) ?? 0;
    const output = readNumber(tokens, ["output"]) ?? 0;
    const reasoning = readNumber(tokens, ["reasoning"]) ?? 0;
    const cache = readObject(tokens, "cache");
    const cacheRead = cache ? readNumber(cache, ["read"]) ?? 0 : 0;
    const cacheWrite = cache ? readNumber(cache, ["write"]) ?? 0 : 0;
    const total = input + output + reasoning + cacheRead + cacheWrite;
    if (total > 0) return total;
  }
  return 0;
}

/** Returns the selected model's configured context-window limit, or 0 if unavailable. */
function currentModelContextLimit(model: SessionViewModel): number {
  if (!model.selectedModel) return 0;
  const info = model.availableModels.find((item) => sameModel(modelRefFromInfo(item), model.selectedModel));
  const limit = info ? readObject(info, "limit") : undefined;
  return limit ? readNumber(limit, ["context"]) ?? 0 : 0;
}

export interface ContextUsage {
  used: number;
  limit: number;
  percentage: number;
}

/** Returns usable context data shared by the progress bar and Session Island Prompt trigger. */
export function contextUsage(model: SessionViewModel): ContextUsage | undefined {
  const used = currentContextLength(model);
  const limit = currentModelContextLimit(model);
  if (used <= 0 || limit <= 0) return undefined;
  return { used, limit, percentage: Math.min(100, Math.round((used / limit) * 100)) };
}

export interface ContextProgressBarDeps {
  /** Shared domain state; the bar reads `loadedMessages`, `selectedModel`, `availableModels`. */
  model: SessionViewModel;
  /** Reads the current context bar policy from plugin settings on every update. */
  getConfig: () => ContextBarSettings;
}

/** Renders and updates the context-length progress bar pinned to the composer's bottom border. */
export class ContextProgressBarController {
  private barEl?: HTMLElement;
  private trackEl?: HTMLElement;
  private fillEl?: HTMLElement;
  private readonly markers: HTMLElement[] = [];
  private readonly model: SessionViewModel;
  private readonly getConfig: () => ContextBarSettings;

  constructor(deps: ContextProgressBarDeps) {
    this.model = deps.model;
    this.getConfig = deps.getConfig;
  }

  /** Creates the progress bar DOM inside the given container; called by `ComposerController.mount`. */
  mount(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "opencode-session-view__composer-progress" });
    const track = bar.createDiv({ cls: "opencode-session-view__composer-progress-track" });
    // Fill acts as a mask: it covers the unfilled portion of the gradient track with the border color.
    this.fillEl = track.createDiv({ cls: "opencode-session-view__composer-progress-fill" });
    this.trackEl = track;
    this.barEl = bar;
    this.markers.length = 0;
    // One marker per section boundary (excluding the implicit 0-origin); extras stay hidden.
    for (let i = 0; i < MAX_MARKERS; i++) {
      const marker = track.createDiv({ cls: "opencode-session-view__composer-progress-marker" });
      marker.createSpan({ cls: "opencode-session-view__composer-progress-marker-label" });
      this.markers.push(marker);
    }
    this.update();
  }

  /** Recomputes fractions and updates styles; called after each streaming render frame and on canonical sync. */
  update(): void {
    const bar = this.barEl;
    const track = this.trackEl;
    const fill = this.fillEl;
    if (!bar?.isConnected) return;
    const usage = contextUsage(this.model);
    const limit = usage?.limit ?? currentModelContextLimit(this.model);
    const used = usage?.used ?? 0;
    const hasAssistant = this.model.loadedMessages.some((bundle) => readString(bundle.info, ["role"]) === "assistant");
    const isEmpty = !hasAssistant || limit === 0 || used === 0;

    // Compute piecewise-linear sections from the configured policy, adjusted for the model's limit.
    const sections = computeProgressSections(limit, this.getConfig());

    // Set the multi-color gradient on the track.
    if (track) track.style.background = sectionsToGradient(sections);

    // Piecewise-linear interpolation: map used tokens to bar fraction.
    const visualFrac = !isEmpty && limit > 0 ? contextToBarFraction(used, sections) : 0;

    // Position the mask to hide the unfilled portion.
    if (fill) fill.style.left = `${(visualFrac * 100).toFixed(2)}%`;

    bar.toggleClass("is-empty", isEmpty);

    // Tooltip shows true linear percentage.
    const actualPct = !isEmpty && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    bar.title = limit > 0 && !isEmpty ? `${formatCompactNumber(used)}/${formatCompactNumber(limit)} tokens (${Math.round(actualPct)}%)` : "";

    // Markers sit at section end-points; hover reveals their token count as inline beads.
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      const label = marker.querySelector(".opencode-session-view__composer-progress-marker-label") as HTMLElement | null;
      if (!isEmpty && i < sections.length) {
        marker.style.left = `${(sections[i].endFraction * 100).toFixed(2)}%`;
        marker.style.visibility = "visible";
        marker.style.setProperty("--checkpoint-color", sections[i].color);
        marker.toggleClass("is-passed", visualFrac >= sections[i].endFraction - 1e-9);
        marker.toggleClass("is-warn", sections[i].color === CONTEXT_SEGMENT_COLOR_VARS.yellow);
        if (label) label.setText(formatCompactNumber(sections[i].endContext));
      } else {
        marker.style.visibility = "hidden";
        if (label) label.setText("");
      }
    }
  }

  /** Drops DOM refs so a closed view cannot leak the bar; called by `SessionView.onClose`. */
  dispose(): void {
    this.barEl = undefined;
    this.trackEl = undefined;
    this.fillEl = undefined;
    this.markers.length = 0;
  }
}
