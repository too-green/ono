import { describe, expect, it } from "vitest";

import { RETRY_ACTION_COOLDOWN_MS, eligibleRetryActionKey, retryActionKey, safeRetryActionLink } from "./session-retry-action";

describe("session retry actions", () => {
  const freeTier = {
    reason: "free_tier_limit",
    provider: "opencode",
    title: "Usage limit reached",
    message: "Upgrade to continue",
    label: "View plans",
    link: "https://opencode.ai/go",
  };

  it("allowlists only first-party usage-limit reason/provider pairs", () => {
    expect(retryActionKey(freeTier)).toBe("free_tier_limit");
    expect(retryActionKey({ ...freeTier, provider: "opencode-go", reason: "account_rate_limit" })).toBe("account_rate_limit");
    expect(retryActionKey({ ...freeTier, provider: "custom" })).toBeUndefined();
    expect(retryActionKey({ ...freeTier, reason: "arbitrary" })).toBeUndefined();
    expect(RETRY_ACTION_COOLDOWN_MS).toBe(86_400_000);
  });

  it("accepts only valid HTTPS action links", () => {
    expect(safeRetryActionLink(freeTier)).toBe("https://opencode.ai/go");
    expect(safeRetryActionLink({ ...freeTier, link: "http://opencode.ai/go" })).toBeUndefined();
    expect(safeRetryActionLink({ ...freeTier, link: "https://attacker.example/go" })).toBeUndefined();
    expect(safeRetryActionLink({ ...freeTier, link: "https://opencode.ai/go?token=secret" })).toBeUndefined();
    expect(safeRetryActionLink({ ...freeTier, link: "not a URL" })).toBeUndefined();
  });

  it("applies the global cooldown and permanent suppression", () => {
    const now = 100_000_000;
    expect(eligibleRetryActionKey(freeTier, {}, {}, now)).toBe("free_tier_limit");
    expect(eligibleRetryActionKey(freeTier, { free_tier_limit: now - 1_000 }, {}, now)).toBeUndefined();
    expect(eligibleRetryActionKey(freeTier, { free_tier_limit: now - RETRY_ACTION_COOLDOWN_MS }, {}, now)).toBe("free_tier_limit");
    expect(eligibleRetryActionKey(freeTier, {}, { free_tier_limit: true }, now)).toBeUndefined();
  });
});
