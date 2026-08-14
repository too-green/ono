import { describe, expect, it } from "vitest";

import { DEFAULT_WORKING_ANIMATION, normalizeWorkingAnimation } from "./session-state";

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
