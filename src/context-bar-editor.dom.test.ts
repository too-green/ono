import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_BAR_MIN_GAP,
  CONTEXT_BAR_POSITION_STEP,
  ContextBarEditor,
  clampThresholdFraction,
  clampThresholdValue,
  computeInsertSlot,
} from "./context-bar-editor";
import { CONTEXT_BAR_MAX_THRESHOLDS, defaultContextBarSettings, type ContextBarSettings, type ContextThreshold } from "./settings";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the editor. */
function installObsidianDomMethods(): void {
  const create = function (this: HTMLElement, tag: string, options: DomOptions = {}): HTMLElement {
    const element = document.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.appendChild(element);
    return element;
  };
  Object.defineProperties(HTMLElement.prototype, {
    createDiv: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "div", options); } },
    createSpan: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "span", options); } },
    createEl: { configurable: true, value: function (this: HTMLElement, tag: string, options?: DomOptions) { return create.call(this, tag, options); } },
    setAttr: { configurable: true, value: function (this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); } },
    setText: { configurable: true, value: function (this: HTMLElement, text: string) { this.textContent = text; } },
    toggleClass: { configurable: true, value: function (this: HTMLElement, cls: string, force?: boolean) { this.classList.toggle(cls, force); } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

/** Fires a mouse-based pointer event that bubbles to window listeners. */
function pointerEvent(type: string, clientX = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
}

const PILL = ".opencode-context-bar-editor__pill";
const SEGMENT = ".opencode-context-bar-editor__segment";
const POPOVER = ".opencode-context-bar-editor__popover";
const TRACK = ".opencode-context-bar-editor__track";
const STRIP = ".opencode-context-bar-editor__strip";
const POSITION = ".opencode-context-bar-editor__position";

/** Mounts an editor against an in-memory config with spied persistence callbacks. */
function setup(initial: ContextBarSettings = defaultContextBarSettings()) {
  let config = initial;
  const save = vi.fn(async () => undefined);
  const onApplied = vi.fn(() => undefined);
  const editor = new ContextBarEditor({
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    save,
    onApplied,
  });
  const container = document.body.createDiv();
  editor.mount(container);
  return { editor, container, getConfig: () => config, save, onApplied };
}

/** Stubs the track's bounding rect to a 100px-wide bar for fraction math. */
function stubTrackRect(container: HTMLElement): void {
  const track = container.querySelector(TRACK) as HTMLElement | null;
  if (track) vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100, right: 100, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
}

beforeEach(() => {
  installObsidianDomMethods();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("clampThresholdFraction", () => {
  const thresholds: ContextThreshold[] = [
    { fraction: 0.3, value: 10 },
    { fraction: 0.6, value: 50 },
    { fraction: 0.8, value: 90 },
  ];

  it("keeps a pill between its neighbors by the minimum gap", () => {
    expect(clampThresholdFraction(0.9, thresholds, 1)).toBeCloseTo(0.8 - CONTEXT_BAR_MIN_GAP, 5);
    expect(clampThresholdFraction(0.1, thresholds, 1)).toBeCloseTo(0.3 + CONTEXT_BAR_MIN_GAP, 5);
  });

  it("snaps positions to one-percent steps", () => {
    expect(CONTEXT_BAR_POSITION_STEP).toBe(0.01);
    expect(clampThresholdFraction(0.556, thresholds, 1)).toBe(0.56);
    expect(clampThresholdFraction(0.554, thresholds, 1)).toBe(0.55);
  });

  it("keeps the first and last pills off the 0/1 ends", () => {
    expect(clampThresholdFraction(-1, thresholds, 0)).toBeCloseTo(0.02, 5);
    expect(clampThresholdFraction(2, thresholds, 2)).toBeCloseTo(0.98, 5);
  });

  it("returns the current fraction when no valid range exists", () => {
    const crowded: ContextThreshold[] = [{ fraction: 0.5, value: 10 }, { fraction: 0.53, value: 20 }, { fraction: 0.55, value: 30 }];
    // Index 1 is boxed in: lower bound 0.54 exceeds upper bound 0.51.
    expect(clampThresholdFraction(0.2, crowded, 1)).toBe(0.53);
  });
});

describe("clampThresholdValue", () => {
  it("clamps between neighbor values with unit granularity", () => {
    const thresholds: ContextThreshold[] = [{ fraction: 0.3, value: 60 }, { fraction: 0.7, value: 85 }];
    expect(clampThresholdValue(200, thresholds, 0, "percent")).toBe(84.9);
    expect(clampThresholdValue(10, thresholds, 1, "percent")).toBe(60.1);
    expect(clampThresholdValue(50_000, [{ fraction: 0.5, value: 100_000 }], 1, "tokens")).toBe(100_001);
  });

  it("keeps unit bounds at the open ends", () => {
    const single: ContextThreshold[] = [{ fraction: 0.5, value: 50 }];
    expect(clampThresholdValue(0, single, 0, "percent")).toBe(0.1);
    expect(clampThresholdValue(9999, single, 1, "percent")).toBe(100);
    expect(clampThresholdValue(0, single, 0, "tokens")).toBe(1);
  });

  it("returns undefined when no discrete value fits between adjacent neighbors", () => {
    const adjacent: ContextThreshold[] = [
      { fraction: 0.3, value: 100_000 },
      { fraction: 0.5, value: 150_000 },
      { fraction: 0.7, value: 100_001 },
    ];
    expect(clampThresholdValue(150_000, adjacent, 1, "tokens")).toBeUndefined();
  });
});

describe("computeInsertSlot", () => {
  it("picks the widest gap and seeds the value between neighbors", () => {
    const thresholds: ContextThreshold[] = [{ fraction: 0.5, value: 60 }, { fraction: 0.75, value: 85 }];
    // Widest gap is [0, 0.5]; seeded value halves the first threshold.
    const slot = computeInsertSlot(thresholds, "percent");
    expect(slot?.index).toBe(0);
    expect(slot?.fraction).toBeCloseTo(0.24, 5);
    expect(slot?.value).toBe(30);
  });

  it("seeds midpoints and open-end doublings", () => {
    const between = computeInsertSlot([{ fraction: 0.3, value: 100_000 }, { fraction: 0.7, value: 300_000 }], "tokens");
    expect(between?.index).toBe(1);
    expect(between?.fraction).toBeCloseTo(0.5, 5);
    expect(between?.value).toBe(200_000);
    const appended = computeInsertSlot([{ fraction: 0.2, value: 100_000 }], "tokens");
    expect(appended?.index).toBe(1);
    expect(appended?.fraction).toBeCloseTo(0.61, 5);
    expect(appended?.value).toBe(200_000);
  });

  it("seeds a first threshold for an empty set", () => {
    expect(computeInsertSlot([], "percent")).toEqual({ index: 0, fraction: 0.5, value: 50 });
    expect(computeInsertSlot([], "tokens")).toEqual({ index: 0, fraction: 0.5, value: 100_000 });
  });

  it("returns undefined at the threshold cap", () => {
    const full = Array.from({ length: CONTEXT_BAR_MAX_THRESHOLDS }, (_, i): ContextThreshold => ({ fraction: (i + 1) / 5, value: (i + 1) * 10 }));
    expect(computeInsertSlot(full, "percent")).toBeUndefined();
  });
});

describe("ContextBarEditor", () => {
  it("renders the active unit's pills, segments, and gradient from defaults", () => {
    const { container } = setup();
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    expect(pills.map((pill) => pill.textContent)).toEqual(["60%", "85%"]);
    expect(pills[0].getAttribute("aria-label")).toContain("Cutoff 60%");
    expect(container.querySelector(".opencode-context-bar-editor__add-button")?.textContent).toContain("Add cutoff");
    expect(pills[0].style.left).toBe("50%");
    expect(container.querySelectorAll(SEGMENT)).toHaveLength(3);
    const strip = container.querySelector(STRIP) as HTMLElement;
    expect(strip.style.background).toContain("var(--interactive-accent) 0.00%");
    expect(strip.style.background).toContain("var(--color-red) 75.00%");
  });

  it("switches units while preserving each unit's thresholds independently", () => {
    const { container, getConfig } = setup();
    const tokensButton = [...container.querySelectorAll<HTMLButtonElement>(".opencode-context-bar-editor__unit-button")][1];
    tokensButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getConfig().unit).toBe("tokens");
    expect([...container.querySelectorAll(PILL)].map((pill) => pill.textContent)).toEqual(["100k", "250k"]);
    // Re-query: the switch re-rendered the controls.
    const percentButton = [...container.querySelectorAll<HTMLButtonElement>(".opencode-context-bar-editor__unit-button")][0];
    percentButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getConfig().unit).toBe("percent");
    expect([...container.querySelectorAll(PILL)].map((pill) => pill.textContent)).toEqual(["60%", "85%"]);
  });

  it("adds a threshold at the widest gap, inherits the lower segment color, and opens the value editor", () => {
    const { container, getConfig } = setup();
    (container.querySelector(".opencode-context-bar-editor__add-button") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const config = getConfig();
    expect(config.percent.thresholds).toHaveLength(3);
    expect(config.percent.thresholds[0].fraction).toBeCloseTo(0.24, 5);
    expect(config.percent.thresholds[0].value).toBe(30);
    expect(config.percent.segmentColors).toEqual(["accent", "accent", "yellow", "red"]);
    const popover = container.querySelector(POPOVER) as HTMLElement;
    expect(popover?.dataset.kind).toBe("value");
    expect((popover.querySelector("input") as HTMLInputElement).value).toBe("30%");
  });

  it("edits a pill value through the popover and clamps it between neighbors", () => {
    const { container, getConfig } = setup();
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = container.querySelector<HTMLInputElement>(".opencode-context-bar-editor__value-input");
    expect(input).not.toBeNull();
    expect(container.querySelector(".opencode-context-bar-editor__popover-title")?.textContent).toBe("Cutoff value");
    input!.value = "200";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getConfig().percent.thresholds[0].value).toBe(84.9);
  });

  it("reverts invalid pill values instead of saving them", () => {
    const { container, getConfig } = setup();
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = container.querySelector<HTMLInputElement>(".opencode-context-bar-editor__value-input");
    input!.value = "lots";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getConfig().percent.thresholds[0].value).toBe(60);
    expect(input!.value).toBe("60%");
  });

  it("removes a threshold through the popover and merges segment colors", () => {
    const { container, getConfig } = setup();
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    (container.querySelector(".opencode-context-bar-editor__remove-button") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const set = getConfig().percent;
    expect(set.thresholds).toHaveLength(1);
    expect(set.thresholds[0].value).toBe(85);
    expect(set.segmentColors).toEqual(["accent", "red"]);
  });

  it("recolors a segment from the palette swatches", () => {
    const { container, getConfig } = setup();
    const segments = [...container.querySelectorAll<HTMLElement>(SEGMENT)];
    segments[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const swatches = [...container.querySelectorAll<HTMLButtonElement>(".opencode-context-bar-editor__swatch")];
    swatches.find((swatch) => swatch.textContent === "blue")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getConfig().percent.segmentColors[1]).toBe("blue");
    expect((container.querySelector(STRIP) as HTMLElement).style.background).toContain("var(--color-blue) 50.00%");
  });

  it("recolors a segment with a hex value and rejects invalid hex", () => {
    const { container, getConfig } = setup();
    const segments = [...container.querySelectorAll<HTMLElement>(SEGMENT)];
    segments[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const hex = container.querySelector<HTMLInputElement>(".opencode-context-bar-editor__hex-input");
    hex!.value = "#0f0";
    hex!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getConfig().percent.segmentColors[0]).toBe("#0f0");
    segments[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const hexAgain = container.querySelector<HTMLInputElement>(".opencode-context-bar-editor__hex-input");
    hexAgain!.value = "nope";
    hexAgain!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getConfig().percent.segmentColors[0]).toBe("#0f0");
  });

  it("drags a pill with the pointer and commits the clamped fraction", () => {
    const { container, getConfig } = setup();
    stubTrackRect(container);
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(pointerEvent("pointerdown", 50));
    document.body.dispatchEvent(pointerEvent("pointermove", 55.6));
    const position = container.querySelector<HTMLElement>(POSITION)!;
    expect(position.hidden).toBe(false);
    expect(position.textContent).toBe("0.56");
    expect(position.style.left).toBe("56%");
    document.body.dispatchEvent(pointerEvent("pointerup", 55.6));
    expect(getConfig().percent.thresholds[0].fraction).toBe(0.56);
    expect(container.querySelector<HTMLElement>(POSITION)!.hidden).toBe(true);
  });

  it("keeps a no-move drag from committing", () => {
    const { container, save } = setup();
    stubTrackRect(container);
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(pointerEvent("pointerdown", 50));
    document.body.dispatchEvent(pointerEvent("pointerup", 50));
    expect(save).not.toHaveBeenCalled();
  });

  it("nudges a focused pill with arrow keys", () => {
    const { container, getConfig } = setup();
    const pills = [...container.querySelectorAll<HTMLElement>(PILL)];
    pills[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(getConfig().percent.thresholds[0].fraction).toBeCloseTo(0.51, 5);
  });

  it("disables the add button at the threshold cap", () => {
    const crowded = defaultContextBarSettings();
    crowded.percent.thresholds = [
      { fraction: 0.2, value: 20 },
      { fraction: 0.4, value: 40 },
      { fraction: 0.6, value: 60 },
      { fraction: 0.8, value: 80 },
    ];
    crowded.percent.segmentColors = ["accent", "yellow", "red", "red", "red"];
    const { container } = setup(crowded);
    expect((container.querySelector(".opencode-context-bar-editor__add-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders an empty state with one recolorable segment", () => {
    const emptied = defaultContextBarSettings();
    emptied.percent = { thresholds: [], segmentColors: ["blue"] };
    const { container } = setup(emptied);
    expect(container.querySelectorAll(PILL)).toHaveLength(0);
    expect(container.querySelectorAll(SEGMENT)).toHaveLength(1);
    expect((container.querySelector(STRIP) as HTMLElement).style.background).toContain("var(--color-blue) 0.00%");
  });
});
