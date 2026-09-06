import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKING_ANIMATION,
  SELECTABLE_WORKING_ANIMATIONS,
  normalizeSelectableWorkingAnimation,
  normalizeWorkingAnimation,
} from "./session-state";

describe("normalizeWorkingAnimation", () => {
  it.each(["bounce", "pulse", "orbit", "scanner", "puzzle"] as const)("preserves the %s animation", (animation) => {
    expect(normalizeWorkingAnimation(animation)).toBe(animation);
  });

  it("maps legacy persisted variants to their closest compact replacements", () => {
    expect(normalizeWorkingAnimation("W1")).toBe("pulse");
    expect(normalizeWorkingAnimation("W2")).toBe("orbit");
    expect(normalizeWorkingAnimation("W3")).toBe("bounce");
    expect(normalizeWorkingAnimation("W4")).toBe("scanner");
  });

  it("uses the default for unsupported values", () => {
    expect(normalizeWorkingAnimation("unknown")).toBe(DEFAULT_WORKING_ANIMATION);
    expect(normalizeWorkingAnimation(undefined)).toBe(DEFAULT_WORKING_ANIMATION);
  });
});

describe("selectable working animations", () => {
  it("exposes Braille orbit as the sole option and default", () => {
    expect(SELECTABLE_WORKING_ANIMATIONS).toEqual(["orbit"]);
    expect(DEFAULT_WORKING_ANIMATION).toBe("orbit");
  });

  it("migrates dormant animation choices to Braille orbit", () => {
    expect(normalizeSelectableWorkingAnimation("bounce")).toBe("orbit");
    expect(normalizeSelectableWorkingAnimation("pulse")).toBe("orbit");
    expect(normalizeSelectableWorkingAnimation("orbit")).toBe("orbit");
  });
});
