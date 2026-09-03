import { describe, expect, it } from "vitest";
import { defaultContextBarSettings, type ContextBarSettings, type ContextThresholdSet } from "../../../settings";
import {
  computeProgressSections,
  contextToBarFraction,
  sectionsToGradient,
} from "./context-progress-bar";

const ACCENT = "var(--interactive-accent)";
const YELLOW = "var(--color-yellow)";
const RED = "var(--color-red)";

/** Builds a policy around one unit's set, leaving the other unit at defaults. */
const configWithSet = (unit: "percent" | "tokens", set: ContextThresholdSet): ContextBarSettings => ({
  ...defaultContextBarSettings(),
  unit,
  [unit]: set,
});

/** Classic absolute-budget preset: 100k and 250k splits at 50%/75%. */
const TOKENS_SET: ContextThresholdSet = {
  thresholds: [
    { fraction: 0.5, value: 100_000 },
    { fraction: 0.75, value: 250_000 },
  ],
  segmentColors: ["accent", "yellow", "red"],
};

describe("computeProgressSections", () => {
  it("renders the shipped default (percent 60/85 at 50%/75%) against the model limit", () => {
    const sections = computeProgressSections(500_000, configWithSet("percent", {
      thresholds: [{ fraction: 0.5, value: 60 }, { fraction: 0.75, value: 85 }],
      segmentColors: ["accent", "yellow", "red"],
    }));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 300_000, color: ACCENT },
      { startFraction: 0.5, endFraction: 0.75, startContext: 300_000, endContext: 425_000, color: YELLOW },
      { startFraction: 0.75, endFraction: 1, startContext: 425_000, endContext: 500_000, color: RED },
    ]);
  });

  it("renders absolute thresholds (100k/250k) at their configured bar positions", () => {
    const sections = computeProgressSections(500_000, configWithSet("tokens", TOKENS_SET));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 100_000, color: ACCENT },
      { startFraction: 0.5, endFraction: 0.75, startContext: 100_000, endContext: 250_000, color: YELLOW },
      { startFraction: 0.75, endFraction: 1, startContext: 250_000, endContext: 500_000, color: RED },
    ]);
  });

  it("returns a single accent section when the active set has no thresholds", () => {
    const sections = computeProgressSections(500_000, configWithSet("tokens", { thresholds: [], segmentColors: ["blue"] }));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 1, startContext: 0, endContext: 500_000, color: "var(--color-blue)" },
    ]);
  });

  it("returns a single accent section ending at context 0 when the limit is unknown", () => {
    const sections = computeProgressSections(0, configWithSet("tokens", TOKENS_SET));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 1, startContext: 0, endContext: 0, color: ACCENT },
    ]);
  });

  it("extends the overflowing section to the bar's end and drops later thresholds", () => {
    // Limit 150k sits between the 100k and 250k thresholds: the yellow section
    // (ending at 250k) stretches to fraction 1.0 at the limit; red never renders.
    const sections = computeProgressSections(150_000, configWithSet("tokens", TOKENS_SET));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 100_000, color: ACCENT },
      { startFraction: 0.5, endFraction: 1, startContext: 100_000, endContext: 150_000, color: YELLOW },
    ]);
  });

  it("truncates immediately when the limit is below the first threshold", () => {
    const sections = computeProgressSections(50_000, configWithSet("tokens", TOKENS_SET));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 1, startContext: 0, endContext: 50_000, color: ACCENT },
    ]);
  });

  it("keeps a threshold equal to the limit and collapses the final section", () => {
    // 100k == limit: not an overflow, so the accent section ends at its position
    // and the following yellow section spans [100k, limit] stretched to the end.
    const sections = computeProgressSections(100_000, configWithSet("tokens", TOKENS_SET));
    expect(sections).toEqual([
      { startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 100_000, color: ACCENT },
      { startFraction: 0.5, endFraction: 1, startContext: 100_000, endContext: 100_000, color: YELLOW },
    ]);
  });

  it("resolves palette names and hex colors per segment", () => {
    const sections = computeProgressSections(500_000, configWithSet("percent", {
      thresholds: [{ fraction: 0.4, value: 50 }],
      segmentColors: ["#00ff88", "cyan"],
    }));
    expect(sections.map((section) => section.color)).toEqual(["#00ff88", "var(--color-cyan)"]);
  });

  it("resolves the inactive unit's thresholds only when selected", () => {
    const config = defaultContextBarSettings();
    const sections = computeProgressSections(500_000, config);
    // Default active unit is percent: 60% of 500k = 300k, 85% = 425k.
    expect(sections.map((section) => section.endContext)).toEqual([300_000, 425_000, 500_000]);
  });

  it("never mutates the passed-in config", () => {
    const config = configWithSet("tokens", TOKENS_SET);
    const before = JSON.stringify(config);
    computeProgressSections(123_456, config);
    expect(JSON.stringify(config)).toBe(before);
  });
});

describe("contextToBarFraction", () => {
  const sections = computeProgressSections(500_000, configWithSet("tokens", TOKENS_SET));

  it("returns 0 for non-positive used", () => {
    expect(contextToBarFraction(0, sections)).toBe(0);
    expect(contextToBarFraction(-10, sections)).toBe(0);
  });

  it("interpolates linearly inside the first section", () => {
    // Section 0: context [0, 100_000] → fraction [0, 0.5]. Midpoint at 50_000 → 0.25.
    expect(contextToBarFraction(50_000, sections)).toBeCloseTo(0.25, 5);
    expect(contextToBarFraction(100_000, sections)).toBeCloseTo(0.5, 5);
  });

  it("interpolates linearly inside the second section", () => {
    // Section 1: context [100_000, 250_000] → fraction [0.5, 0.75]. Midpoint at 175_000 → 0.625.
    expect(contextToBarFraction(175_000, sections)).toBeCloseTo(0.625, 5);
    expect(contextToBarFraction(250_000, sections)).toBeCloseTo(0.75, 5);
  });

  it("interpolates linearly inside the last section", () => {
    // Section 2: context [250_000, 500_000] → fraction [0.75, 1.0]. Midpoint at 375_000 → 0.875.
    expect(contextToBarFraction(375_000, sections)).toBeCloseTo(0.875, 5);
    expect(contextToBarFraction(500_000, sections)).toBeCloseTo(1.0, 5);
  });

  it("clamps to 1.0 when used exceeds every section's endContext", () => {
    expect(contextToBarFraction(999_999, sections)).toBe(1.0);
  });

  it("returns section endFraction when contextRange is zero (avoid divide-by-zero)", () => {
    // Synthetic degenerate sections: zero-width on the context axis.
    const degenerate = [
      { startFraction: 0.5, endFraction: 0.5, startContext: 100, endContext: 100, color: ACCENT },
    ];
    expect(contextToBarFraction(100, degenerate)).toBe(0.5);
    expect(contextToBarFraction(101, degenerate)).toBe(1.0);
  });

  it("fills to the very end at the limit under extend-to-end truncation", () => {
    const truncated = computeProgressSections(150_000, configWithSet("tokens", TOKENS_SET));
    // Section 0: context [0, 100_000] → fraction [0, 0.5]
    expect(contextToBarFraction(50_000, truncated)).toBeCloseTo(0.25, 5);
    // Section 1 (extended): context [100_000, 150_000] → fraction [0.5, 1.0]
    expect(contextToBarFraction(125_000, truncated)).toBeCloseTo(0.75, 5);
    expect(contextToBarFraction(150_000, truncated)).toBeCloseTo(1.0, 5);
  });
});

describe("sectionsToGradient", () => {
  it("emits a linear-gradient with two hard stops per section", () => {
    const sections = computeProgressSections(500_000, configWithSet("tokens", TOKENS_SET));
    const gradient = sectionsToGradient(sections);
    expect(gradient.startsWith("linear-gradient(to right, ")).toBe(true);
    // 3 sections × 2 stops = 6 comma-separated stops (the join uses ", ")
    const stops = gradient.slice("linear-gradient(to right, ".length, -1).split(", ");
    expect(stops).toHaveLength(6);
  });

  it("preserves section colors at both endpoints of each stop", () => {
    const sections = computeProgressSections(500_000, configWithSet("tokens", TOKENS_SET));
    const gradient = sectionsToGradient(sections);
    // Section 1 (yellow) spans 50%–75%, so its two stops should both carry the yellow color.
    expect(gradient).toContain("var(--color-yellow) 50.00%");
    expect(gradient).toContain("var(--color-yellow) 75.00%");
  });
});
