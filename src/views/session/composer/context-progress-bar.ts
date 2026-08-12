import { readNumber, readObject, readString } from "../json-helpers";
import { formatCompactNumber } from "../format-helpers";
import { modelRefFromInfo, sameModel } from "./model-variants";
import type { SessionViewModel } from "../session-view-model";

/**
 * Progress bar pinned to the composer's bottom border.
 *
 * Owns the bar DOM (mask + gradient track + checkpoint markers) and reads token
 * usage from `model.loadedMessages` and the limit from `model.selectedModel`.
 * Pure math (`computeProgressSections`, `contextToBarFraction`,
 * `sectionsToGradient`) is exported for unit testing.
 *
 * Lifecycle: `mount(container)` creates the DOM, `update()` re-pulls model
 * state, `dispose()` drops refs. The shell calls `update()` after each
 * streaming render frame and after canonical sync.
 *
 * Reference: `docs/product-spec/UI Elements/Context Progress Bar`.
 */

/** Checkpoint tuples: (bar-fraction, absolute-context, color?). Color defaults to accent. Context optional on last tuple (defaults to model limit). */
export const PROGRESS_CHECKPOINTS: readonly { fraction: number; context?: number; color?: string }[] = [
  { fraction: 0.5, context: 100_000 },
  { fraction: 0.75, context: 250_000, color: "var(--color-yellow)" },
  { fraction: 1.0, color: "var(--color-red)" },
];

const ACCENT_COLOR = "var(--interactive-accent)";

export interface ProgressSection {
  startFraction: number;
  endFraction: number;
  startContext: number;
  endContext: number;
  color: string;
}

/**
 * Computes effective progress sections from checkpoints, adjusting for the model's context limit.
 *
 * Pure: exported for unit tests in `context-progress-bar.test.ts`.
 * Referenced by `ContextProgressBarController.update`.
 */
export function computeProgressSections(limit: number): ProgressSection[] {
  const sections: ProgressSection[] = [];
  let prevFraction = 0;
  let prevContext = 0;

  for (let i = 0; i < PROGRESS_CHECKPOINTS.length; i++) {
    const cp = PROGRESS_CHECKPOINTS[i];
    const isLast = i === PROGRESS_CHECKPOINTS.length - 1;
    const context = cp.context ?? limit;
    const color = cp.color ?? ACCENT_COLOR;

    // Non-last checkpoint exceeds model limit: extend this section to the end and stop.
    if (!isLast && limit > 0 && context > limit) {
      sections.push({ startFraction: prevFraction, endFraction: 1.0, startContext: prevContext, endContext: limit, color });
      return sections;
    }

    sections.push({ startFraction: prevFraction, endFraction: cp.fraction, startContext: prevContext, endContext: context, color });
    prevFraction = cp.fraction;
    prevContext = context;
  }

  // Ensure the last section always reaches fraction 1.0 and the model limit.
  const last = sections[sections.length - 1];
  if (last && limit > 0) {
    last.endFraction = 1.0;
    last.endContext = limit;
  }

  return sections;
}

/**
 * Maps an absolute token count to a bar fraction via piecewise-linear interpolation across sections.
 *
 * Pure: exported for unit tests in `context-progress-bar.test.ts`.
 * Referenced by `ContextProgressBarController.update`.
 */
export function contextToBarFraction(used: number, sections: ProgressSection[]): number {
  if (used <= 0) return 0;
  for (const section of sections) {
    if (used <= section.endContext) {
      const contextRange = section.endContext - section.startContext;
      if (contextRange <= 0) return section.endFraction;
      const t = (used - section.startContext) / contextRange;
      return section.startFraction + t * (section.endFraction - section.startFraction);
    }
  }
  return 1.0;
}

/** Builds a CSS linear-gradient string with hard color stops at each section boundary. Pure helper. */
export function sectionsToGradient(sections: { startFraction: number; endFraction: number; color: string }[]): string {
  const stops: string[] = [];
  for (const section of sections) {
    stops.push(`${section.color} ${(section.startFraction * 100).toFixed(2)}%`);
    stops.push(`${section.color} ${(section.endFraction * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
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
  /** Returns whether checkpoint token labels should be visible. */
  showThresholdLabels: () => boolean;
}

/** Renders and updates the context-length progress bar pinned to the composer's bottom border. */
export class ContextProgressBarController {
  private barEl?: HTMLElement;
  private trackEl?: HTMLElement;
  private fillEl?: HTMLElement;
  private readonly markers: HTMLElement[] = [];
  private readonly model: SessionViewModel;
  private readonly showThresholdLabels: () => boolean;

  constructor(deps: ContextProgressBarDeps) {
    this.model = deps.model;
    this.showThresholdLabels = deps.showThresholdLabels;
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
    // One marker per checkpoint (section boundary, excluding the implicit 0-origin).
    for (let i = 0; i < PROGRESS_CHECKPOINTS.length; i++) {
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
    const showThresholdLabels = this.showThresholdLabels();

    // Compute piecewise-linear sections from checkpoints, adjusted for the model's limit.
    const sections = computeProgressSections(limit);

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

    // Markers sit at section end-points with absolute token labels.
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      const label = marker.querySelector(".opencode-session-view__composer-progress-marker-label") as HTMLElement | null;
      if (label) label.hidden = !showThresholdLabels;
      if (!isEmpty && i < sections.length) {
        marker.style.left = `${(sections[i].endFraction * 100).toFixed(2)}%`;
        marker.style.visibility = "visible";
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
