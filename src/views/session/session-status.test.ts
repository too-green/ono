import { describe, expect, it } from "vitest";

import { retryCountdownText, sessionRetryStatus, sessionRetryStatusEquals } from "./session-status";

describe("session retry status", () => {
  it("parses the full v1 retry payload defensively", () => {
    const action = { reason: "free_tier_limit", provider: "opencode", title: "Limit reached", message: "Upgrade to continue", label: "View plans", link: "https://opencode.ai/go" };
    expect(sessionRetryStatus({ type: "retry", attempt: 3, message: "Rate limited", next: 20_000, action })).toEqual({
      attempt: 3,
      message: "Rate limited",
      next: 20_000,
      action,
    });
    expect(sessionRetryStatus({ type: "busy" })).toBeUndefined();
  });

  it("compares visible retry fields and formats a clamped countdown", () => {
    const retry = { attempt: 2, message: "Unavailable", next: 15_000 };
    expect(sessionRetryStatusEquals(retry, { ...retry })).toBe(true);
    expect(sessionRetryStatusEquals(retry, { ...retry, attempt: 3 })).toBe(false);
    expect(retryCountdownText(retry, 5_000)).toBe("Retrying in 10s (attempt 2)");
    expect(retryCountdownText(retry, 16_000)).toBe("Retrying (attempt 2)");
  });
});
