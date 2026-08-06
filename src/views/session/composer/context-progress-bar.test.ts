import { describe, expect, it } from "vitest";
import {
  PROGRESS_CHECKPOINTS,
  computeProgressSections,
  contextToBarFraction,
  sectionsToGradient,
} from "./context-progress-bar";

describe("PROGRESS_CHECKPOINTS", () => {
  it("has 3 checkpoints in ascending fractions ending at 1.0", () => {
    expect(PROGRESS_CHECKPOINTS).toHaveLength(3);
    expect(PROGRESS_CHECKPOINTS.map((c) => c.fraction)).toEqual([0.5, 0.75, 1.0]);
  });

  it("marks the last checkpoint without an explicit context (defaults to model limit)", () => {
    expect(PROGRESS_CHECKPOINTS[PROGRESS_CHECKPOINTS.length - 1].context).toBeUndefined();
  });

  it("assigns accent color by default and overrides on warning/danger checkpoints", () => {
    expect(PROGRESS_CHECKPOINTS[0].color).toBeUndefined();
    expect(PROGRESS_CHECKPOINTS[1].color).toBe("var(--color-yellow)");
    expect(PROGRESS_CHECKPOINTS[2].color).toBe("var(--color-red)");
  });
});

describe("computeProgressSections", () => {
  it("returns 3 sections with default accent color when no checkpoint overrides color", () => {
    const sections = computeProgressSections(500_000);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 100_000, color: "var(--interactive-accent)" });
    expect(sections[1]).toEqual({ startFraction: 0.5, endFraction: 0.75, startContext: 100_000, endContext: 250_000, color: "var(--color-yellow)" });
    expect(sections[2]).toEqual({ startFraction: 0.75, endFraction: 1.0, startContext: 250_000, endContext: 500_000, color: "var(--color-red)" });
  });

  it("forces the last section's endFraction to 1.0 and endContext to the model limit", () => {
    const sections = computeProgressSections(400_000);
    const last = sections[sections.length - 1];
    expect(last.endFraction).toBe(1.0);
    expect(last.endContext).toBe(400_000);
  });

  it("truncates when a non-last checkpoint exceeds the limit", () => {
    // Limit 150_000 sits between the 100k and 250k checkpoints, so the 250k checkpoint
    // exceeds the limit and the second section is extended to fraction 1.0.
    const sections = computeProgressSections(150_000);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toEqual({ startFraction: 0, endFraction: 0.5, startContext: 0, endContext: 100_000, color: "var(--interactive-accent)" });
    expect(sections[1]).toEqual({ startFraction: 0.5, endFraction: 1.0, startContext: 100_000, endContext: 150_000, color: "var(--color-yellow)" });
  });

  it("truncates immediately when limit is below the first checkpoint context", () => {
    const sections = computeProgressSections(50_000);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({ startFraction: 0, endFraction: 1.0, startContext: 0, endContext: 50_000, color: "var(--interactive-accent)" });
  });

  it("returns 3 sections without forcing last to 1.0 when limit is 0", () => {
    const sections = computeProgressSections(0);
    expect(sections).toHaveLength(3);
    // Last-section override is skipped when limit === 0, so fractions come straight from checkpoints.
    // cp.context ?? 0 → undefined becomes 0; non-last checkpoints retain their explicit context values.
    expect(sections[0].endContext).toBe(100_000);
    expect(sections[1].endContext).toBe(250_000);
    expect(sections[2].endContext).toBe(0); // last checkpoint has no explicit context; resolves to limit 0
    expect(sections[2].endFraction).toBe(1.0); // checkpoint fraction, not the override
  });

  it("never mutates the PROGRESS_CHECKPOINTS constant", () => {
    const before = PROGRESS_CHECKPOINTS.map((c) => ({ ...c }));
    computeProgressSections(123_456);
    expect(PROGRESS_CHECKPOINTS.map((c) => ({ ...c }))).toEqual(before);
  });
});

describe("contextToBarFraction", () => {
  const sections = computeProgressSections(500_000);

  it("returns 0 for non-positive used", () => {
    expect(contextToBarFraction(0, sections)).toBe(0);
    expect(contextToBarFraction(-10, sections)).toBe(0);
  });

  it("returns 0 in the empty state (no assistant messages yet)", () => {
    // used=0 maps to fraction 0
    expect(contextToBarFraction(0, sections)).toBe(0);
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
    // Synthetic degenerate sections: zero-width on context axis.
    const degenerate = [
      { startFraction: 0.5, endFraction: 0.5, startContext: 100, endContext: 100, color: "var(--interactive-accent)" },
    ];
    expect(contextToBarFraction(100, degenerate)).toBe(0.5);
  });

  it("respects truncation: a low limit yields fewer sections and the piecewise curve still monotonic", () => {
    const truncated = computeProgressSections(150_000);
    // Section 0: context [0, 100_000] → fraction [0, 0.5]
    expect(contextToBarFraction(50_000, truncated)).toBeCloseTo(0.25, 5);
    // Section 1 (truncated): context [100_000, 150_000] → fraction [0.5, 1.0]
    expect(contextToBarFraction(125_000, truncated)).toBeCloseTo(0.75, 5);
    expect(contextToBarFraction(150_000, truncated)).toBeCloseTo(1.0, 5);
  });
});

describe("sectionsToGradient", () => {
  it("emits a linear-gradient with two hard stops per section", () => {
    const sections = computeProgressSections(500_000);
    const gradient = sectionsToGradient(sections);
    expect(gradient.startsWith("linear-gradient(to right, ")).toBe(true);
    // 3 sections × 2 stops = 6 comma-separated stops (the join uses ", ")
    const stops = gradient.slice("linear-gradient(to right, ".length, -1).split(", ");
    expect(stops).toHaveLength(6);
  });

  it("preserves section colors at both endpoints of each stop", () => {
    const sections = computeProgressSections(500_000);
    const gradient = sectionsToGradient(sections);
    // Section 1 (yellow) spans 50%–75%, so its two stops should both carry the yellow color.
    expect(gradient).toContain("var(--color-yellow) 50.00%");
    expect(gradient).toContain("var(--color-yellow) 75.00%");
  });

  it("rounds to two decimals on fraction→percent conversion", () => {
    const sections = [
      { startFraction: 1 / 3, endFraction: 2 / 3, color: "red" },
    ];
    const gradient = sectionsToGradient(sections);
    expect(gradient).toContain("red 33.33%");
    expect(gradient).toContain("red 66.67%");
  });
});
