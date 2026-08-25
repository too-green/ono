import { describe, expect, it } from "vitest";

import { SessionViewModel, type DescendantSessionInfo } from "./session-view-model";

describe("SessionViewModel descendant reconciliation", () => {
  it("preserves streamed additions and deletions received during a canonical fetch", () => {
    const model = new SessionViewModel();
    const baseline = model.captureDescendantSessionRevision();
    model.descendantSessions.set("added", { title: "Added live" });
    model.recordDescendantSessionMutation("added");
    model.descendantSessions.delete("deleted");
    model.recordDescendantSessionMutation("deleted");

    const canonical = new Map<string, DescendantSessionInfo>([
      ["existing", { title: "Existing" }],
      ["deleted", { title: "Stale deleted child" }],
    ]);
    model.reconcileDescendantSessions(canonical, baseline);

    expect([...model.descendantSessions]).toEqual([
      ["existing", { title: "Existing" }],
      ["added", { title: "Added live" }],
    ]);
  });
});
