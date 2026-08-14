import { describe, expect, it } from "vitest";

import { normalizeAgentPanelSessionSort, normalizeFolderCollapseDisplay, normalizeNotificationMode, normalizeSessionIslandContextLabel } from "./settings";

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

describe("normalizeFolderCollapseDisplay", () => {
  it("preserves each supported agents-panel folder treatment", () => {
    expect(normalizeFolderCollapseDisplay("inset")).toBe("inset");
    expect(normalizeFolderCollapseDisplay("size")).toBe("size");
    expect(normalizeFolderCollapseDisplay("chevron")).toBe("chevron");
  });

  it("falls back to the inset treatment for missing or invalid values", () => {
    expect(normalizeFolderCollapseDisplay("disclosure")).toBe("inset");
    expect(normalizeFolderCollapseDisplay(undefined)).toBe("inset");
  });
});

describe("normalizeAgentPanelSessionSort", () => {
  it("preserves all six supported session orderings", () => {
    expect(normalizeAgentPanelSessionSort("created-desc")).toBe("created-desc");
    expect(normalizeAgentPanelSessionSort("created-asc")).toBe("created-asc");
    expect(normalizeAgentPanelSessionSort("modified-desc")).toBe("modified-desc");
    expect(normalizeAgentPanelSessionSort("modified-asc")).toBe("modified-asc");
    expect(normalizeAgentPanelSessionSort("title-asc")).toBe("title-asc");
    expect(normalizeAgentPanelSessionSort("title-desc")).toBe("title-desc");
  });

  it("falls back to newest-created-first for missing or invalid values", () => {
    expect(normalizeAgentPanelSessionSort("recent")).toBe("created-desc");
    expect(normalizeAgentPanelSessionSort(undefined)).toBe("created-desc");
  });
});

describe("normalizeNotificationMode", () => {
  it("preserves supported modes and disables missing or invalid persisted values", () => {
    expect(normalizeNotificationMode("system")).toBe("system");
    expect(normalizeNotificationMode("obsidian-notice")).toBe("obsidian-notice");
    expect(normalizeNotificationMode("none")).toBe("none");
    expect(normalizeNotificationMode("push")).toBe("none");
    expect(normalizeNotificationMode(undefined)).toBe("none");
  });
});
