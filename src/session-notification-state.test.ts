import { describe, expect, it } from "vitest";

import { muteOverrideForState, resolveSessionNotificationState } from "./session-notification-state";

describe("session notification state", () => {
  it("enables roots and mutes subagents by default", () => {
    expect(resolveSessionNotificationState({}, { id: "root" }).muted).toBe(false);
    expect(resolveSessionNotificationState({}, { id: "child", parentID: "root" }).muted).toBe(true);
  });

  it("supports explicit mute and enable overrides", () => {
    expect(resolveSessionNotificationState({ root: true }, { id: "root" }).muted).toBe(true);
    expect(resolveSessionNotificationState({ child: false }, { id: "child", parentID: "root" }).muted).toBe(false);
  });

  it("stores only values that differ from each session type's default", () => {
    expect(muteOverrideForState(false, false)).toBeUndefined();
    expect(muteOverrideForState(true, false)).toBe(true);
    expect(muteOverrideForState(true, true)).toBeUndefined();
    expect(muteOverrideForState(false, true)).toBe(false);
  });
});
