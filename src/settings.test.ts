import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENCODE_SETTINGS,
  DEFAULT_SERVER_BASE_URL,
  normalizeAgentPanelSessionSort,
  normalizeDebugLogging,
  normalizeFolderCollapseDisplay,
  normalizeNotificationMode,
  normalizeRetryActionLastShown,
  normalizeRetryActionSuppressed,
  normalizeServerBaseUrl,
  normalizeServerUsername,
  normalizeSessionIslandContextLabel,
} from "./settings";

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

describe("normalizeDebugLogging", () => {
  it("keeps diagnostics opt-in for missing and malformed persisted values", () => {
    expect(DEFAULT_OPENCODE_SETTINGS.debugLogging).toBe(false);
    expect(normalizeDebugLogging(true)).toBe(true);
    expect(normalizeDebugLogging(false)).toBe(false);
    expect(normalizeDebugLogging("true")).toBe(false);
    expect(normalizeDebugLogging(undefined)).toBe(false);
  });
});

describe("normalizeServerBaseUrl", () => {
  it("keeps valid http and https URLs while trimming whitespace and trailing slashes", () => {
    expect(normalizeServerBaseUrl("http://10.0.0.5:4096")).toBe("http://10.0.0.5:4096");
    expect(normalizeServerBaseUrl("  https://opencode.example.com/api/  ")).toBe("https://opencode.example.com/api");
  });

  it("falls back to the local default for missing, malformed, or non-http values", () => {
    expect(DEFAULT_OPENCODE_SETTINGS.server.baseUrl).toBe(DEFAULT_SERVER_BASE_URL);
    expect(normalizeServerBaseUrl("")).toBe(DEFAULT_SERVER_BASE_URL);
    expect(normalizeServerBaseUrl("not a url")).toBe(DEFAULT_SERVER_BASE_URL);
    expect(normalizeServerBaseUrl("ftp://127.0.0.1:4096")).toBe(DEFAULT_SERVER_BASE_URL);
    expect(normalizeServerBaseUrl(undefined)).toBe(DEFAULT_SERVER_BASE_URL);
  });
});

describe("normalizeServerUsername", () => {
  it("trims usernames and drops empty values", () => {
    expect(normalizeServerUsername("  admin ")).toBe("admin");
    expect(normalizeServerUsername("   ")).toBeUndefined();
    expect(normalizeServerUsername(undefined)).toBeUndefined();
  });
});

describe("retry action prompt settings", () => {
  it("keeps only valid cooldown timestamps and sparse suppression flags", () => {
    expect(normalizeRetryActionLastShown({ valid: 123, negative: -1, text: "4" })).toEqual({ valid: 123 });
    expect(normalizeRetryActionSuppressed({ hidden: true, false: false, text: "true" })).toEqual({ hidden: true });
    expect(normalizeRetryActionLastShown(undefined)).toEqual({});
    expect(normalizeRetryActionSuppressed([])).toEqual({});
  });
});
