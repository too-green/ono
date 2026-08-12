import { describe, expect, it } from "vitest";

import { normalizeSessionIslandContextLabel } from "./settings";

describe("normalizeSessionIslandContextLabel", () => {
  it("preserves each supported context label", () => {
    expect(normalizeSessionIslandContextLabel("percentage")).toBe("percentage");
    expect(normalizeSessionIslandContextLabel("tokens")).toBe("tokens");
  });

  it("falls back to token count for missing or invalid values", () => {
    expect(normalizeSessionIslandContextLabel("remaining")).toBe("tokens");
    expect(normalizeSessionIslandContextLabel(undefined)).toBe("tokens");
  });
});
