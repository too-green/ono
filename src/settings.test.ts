import { describe, expect, it } from "vitest";

import {
  CONTEXT_BAR_MAX_THRESHOLDS,
  DEFAULT_CONTEXT_PERCENT_SET,
  DEFAULT_CONTEXT_TOKENS_SET,
  DEFAULT_OPENCODE_SETTINGS,
  DEFAULT_SERVER_BASE_URL,
  defaultContextBarSettings,
  formatContextThresholdValue,
  hardStopGradient,
  isValidContextSegmentHex,
  normalizeSessionsPanelSessionSort,
  normalizeContextBarSettings,
  normalizeContextSegmentColor,
  normalizeContextThresholdSet,
  normalizeDebugLogging,
  normalizeFolderCollapseDisplay,
  normalizeNotificationMode,
  normalizePersistedSessionStates,
  normalizeRetryActionLastShown,
  normalizeRetryActionSuppressed,
  normalizeServerBaseUrl,
  normalizeServerUsername,
  normalizeSessionIslandContextLabel,
  parseContextThresholdValue,
  resolveContextSegmentColor,
} from "./settings";

describe("normalizePersistedSessionStates", () => {
  it("keeps only compact supported session-owned state", () => {
    expect(normalizePersistedSessionStates({
      session: {
        composer: {
          text: "unsent",
          attachments: ["/tmp/context.md", { filename: "image.png", mime: "image/png", url: "data:image/png;base64,AQID" }, { invalid: true }],
        },
        autoApprove: "inherit",
        muted: false,
        unread: true,
        scroll: { top: 100 },
        model: { providerID: "unused", modelID: "unused" },
      },
      empty: { composer: { text: "  ", attachments: [] }, unread: false },
    })).toEqual({
      session: {
        composer: {
          text: "unsent",
          attachments: ["/tmp/context.md", { filename: "image.png", mime: "image/png", url: "data:image/png;base64,AQID" }],
        },
        autoApprove: "inherit",
        muted: false,
        unread: true,
      },
    });
  });
});

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
  it("preserves each supported sessions-panel folder treatment", () => {
    expect(normalizeFolderCollapseDisplay("inset")).toBe("inset");
    expect(normalizeFolderCollapseDisplay("size")).toBe("size");
    expect(normalizeFolderCollapseDisplay("chevron")).toBe("chevron");
  });

  it("falls back to the inset treatment for missing or invalid values", () => {
    expect(normalizeFolderCollapseDisplay("disclosure")).toBe("inset");
    expect(normalizeFolderCollapseDisplay(undefined)).toBe("inset");
  });
});

describe("normalizeSessionsPanelSessionSort", () => {
  it("preserves all six supported session orderings", () => {
    expect(normalizeSessionsPanelSessionSort("created-desc")).toBe("created-desc");
    expect(normalizeSessionsPanelSessionSort("created-asc")).toBe("created-asc");
    expect(normalizeSessionsPanelSessionSort("modified-desc")).toBe("modified-desc");
    expect(normalizeSessionsPanelSessionSort("modified-asc")).toBe("modified-asc");
    expect(normalizeSessionsPanelSessionSort("title-asc")).toBe("title-asc");
    expect(normalizeSessionsPanelSessionSort("title-desc")).toBe("title-desc");
  });

  it("falls back to newest-created-first for missing or invalid values", () => {
    expect(normalizeSessionsPanelSessionSort("recent")).toBe("created-desc");
    expect(normalizeSessionsPanelSessionSort(undefined)).toBe("created-desc");
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

describe("context bar settings", () => {
  it("ships percent as the active unit with both default threshold sets seeded", () => {
    expect(DEFAULT_OPENCODE_SETTINGS.contextBar).toEqual(defaultContextBarSettings());
    expect(defaultContextBarSettings()).toEqual({
      unit: "percent",
      percent: DEFAULT_CONTEXT_PERCENT_SET,
      tokens: DEFAULT_CONTEXT_TOKENS_SET,
    });
    expect(DEFAULT_CONTEXT_PERCENT_SET).toEqual({
      thresholds: [{ fraction: 0.5, value: 60 }, { fraction: 0.75, value: 85 }],
      segmentColors: ["accent", "yellow", "red"],
    });
    expect(DEFAULT_CONTEXT_TOKENS_SET).toEqual({
      thresholds: [{ fraction: 0.5, value: 100_000 }, { fraction: 0.75, value: 250_000 }],
      segmentColors: ["accent", "yellow", "red"],
    });
  });

  it("returns fresh objects so saved settings never alias the defaults", () => {
    const first = defaultContextBarSettings();
    const second = defaultContextBarSettings();
    expect(first).not.toBe(second);
    expect(first.percent).not.toBe(second.percent);
    expect(first.percent.thresholds[0]).not.toBe(second.percent.thresholds[0]);
  });

  it("normalizes threshold sets: clamped bounds, strictly ascending, capped length, padded colors", () => {
    expect(normalizeContextThresholdSet({
      thresholds: [
        { fraction: -1, value: 0 },                          // clamps to 0.001 / 0.1
        { fraction: 0.4, value: 120 },                       // percent clamps to 100
        { fraction: 0.3, value: 95 },                        // non-ascending fraction → dropped
        { fraction: 0.8, value: 50 },                        // non-ascending value (vs clamped 100) → dropped
        { fraction: 0.9, value: 195.55, junk: true },        // clamps to 100... which equals the previous value → dropped
      ],
      segmentColors: ["red", "nope"],
    }, "percent")).toEqual({
      thresholds: [{ fraction: 0.001, value: 0.1 }, { fraction: 0.4, value: 100 }],
      segmentColors: ["red", "accent", "accent"],
    });
    expect(normalizeContextThresholdSet({
      thresholds: [
        { fraction: 0.4, value: 60.44 },                     // percent rounds to 60.4
        { fraction: 0.9, value: 95.55 },                     // rounds to 95.6, ascending → kept
      ],
      segmentColors: [],
    }, "percent")).toEqual({
      thresholds: [{ fraction: 0.4, value: 60.4 }, { fraction: 0.9, value: 95.6 }],
      segmentColors: ["accent", "accent", "accent"],
    });
  });

  it("caps normalized sets at the threshold maximum", () => {
    const crowded = { thresholds: Array.from({ length: 8 }, (_, i) => ({ fraction: (i + 1) / 9, value: (i + 1) * 10 })) };
    expect(normalizeContextThresholdSet(crowded, "percent").thresholds).toHaveLength(CONTEXT_BAR_MAX_THRESHOLDS);
  });

  it("preserves explicitly emptied sets but defaults missing ones", () => {
    expect(normalizeContextBarSettings("nope")).toEqual(defaultContextBarSettings());
    const emptied = normalizeContextBarSettings({ unit: "tokens", tokens: { thresholds: [], segmentColors: ["blue"] } });
    expect(emptied.tokens).toEqual({ thresholds: [], segmentColors: ["blue"] });
    expect(emptied.percent).toEqual(DEFAULT_CONTEXT_PERCENT_SET);
    expect(normalizeContextBarSettings({ unit: "lightyears" }).unit).toBe("percent");
  });

  it("validates, normalizes, and resolves segment colors", () => {
    expect(isValidContextSegmentHex("#f00")).toBe(true);
    expect(isValidContextSegmentHex("#rrggbb")).toBe(false);
    expect(normalizeContextSegmentColor("RED")).toBe("accent");
    expect(normalizeContextSegmentColor("red")).toBe("red");
    expect(normalizeContextSegmentColor(" #FF00AA ")).toBe("#ff00aa");
    expect(resolveContextSegmentColor("accent")).toBe("var(--interactive-accent)");
    expect(resolveContextSegmentColor("#ff00aa")).toBe("#ff00aa");
    expect(resolveContextSegmentColor("garbage")).toBe("var(--interactive-accent)");
  });

  it("parses unit-aware threshold values and rejects the wrong unit's syntax", () => {
    expect(parseContextThresholdValue("60%", "percent")).toBe(60);
    expect(parseContextThresholdValue(" 99.9", "percent")).toBe(99.9);
    expect(parseContextThresholdValue("100k", "tokens")).toBe(100_000);
    expect(parseContextThresholdValue("1M", "tokens")).toBe(1_000_000);
    expect(parseContextThresholdValue("250000", "tokens")).toBe(250_000);
    expect(parseContextThresholdValue("100k", "percent")).toBeUndefined();
    expect(parseContextThresholdValue("60%", "tokens")).toBeUndefined();
    expect(parseContextThresholdValue("", "percent")).toBeUndefined();
    expect(parseContextThresholdValue("lots", "tokens")).toBeUndefined();
  });

  it("formats threshold values with compact k/m suffixes for round token counts", () => {
    expect(formatContextThresholdValue(60, "percent")).toBe("60%");
    expect(formatContextThresholdValue(100_000, "tokens")).toBe("100k");
    expect(formatContextThresholdValue(1_000_000, "tokens")).toBe("1m");
    expect(formatContextThresholdValue(108_800, "tokens")).toBe("108800");
  });

  it("builds hard-stop gradients shared by the session bar and the settings editor", () => {
    expect(hardStopGradient([{ from: 0, to: 0.5, color: "var(--interactive-accent)" }, { from: 0.5, to: 1, color: "#ff0000" }])).toBe(
      "linear-gradient(to right, var(--interactive-accent) 0.00%, var(--interactive-accent) 50.00%, #ff0000 50.00%, #ff0000 100.00%)",
    );
  });
});
