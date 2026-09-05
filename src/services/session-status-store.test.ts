import { describe, expect, it, vi } from "vitest";

import { SessionStatusStore } from "./session-status-store";

describe("SessionStatusStore", () => {
  it("keeps one canonical entry per globally unique session ID regardless of reporting scope", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo/packages/app", "ses_1", { type: "retry" }, "event");

    expect(store.statusFor("ses_1")?.type).toBe("retry");
    expect(store.statusFor("ses_1")?.directory).toBe("/repo/packages/app");
  });

  it("settles snapshot absence to idle only inside the reported directory scope", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo-a", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo-b", "ses_2", { type: "busy" }, "event");

    const baseline = store.revision();
    store.applySnapshot("/repo-a", {}, baseline);

    expect(store.statusFor("ses_1")?.type).toBe("idle");
    expect(store.statusFor("ses_2")?.type).toBe("busy");
  });

  it("retains the full retry payload for reopened consumers", () => {
    const store = new SessionStatusStore();
    const retry = { type: "retry", attempt: 2, message: "Rate limited", next: 20_000, action: { reason: "usage", provider: "anthropic" } };
    store.handleStatus("/repo", "ses_1", retry, "event");

    expect(store.statusFor("ses_1")?.payload).toEqual(retry);
    expect(store.statusFor("ses_1")?.type).toBe("retry");
  });

  it("preserves a newer event status over an older in-flight snapshot", () => {
    const store = new SessionStatusStore();
    const baseline = store.revision();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");

    store.applySnapshot("/repo", { ses_1: { type: "idle" } }, baseline);

    expect(store.statusFor("ses_1")?.type).toBe("busy");
  });

  it("applies a newer snapshot over an older event", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    const baseline = store.revision();

    store.applySnapshot("/repo", { ses_1: { type: "idle" } }, baseline);

    expect(store.statusFor("ses_1")?.type).toBe("idle");
  });

  it("keeps a busy parent busy while a child-creation resync snapshot lands", () => {
    const store = new SessionStatusStore();
    const baseline = store.revision();
    store.handleStatus("/workspace", "parent", { type: "busy" }, "event");

    store.applySnapshot("/workspace", { child: { type: "busy" } }, baseline);

    expect(store.statusFor("parent")?.type).toBe("busy");
    expect(store.statusFor("child")?.type).toBe("busy");
  });

  it("marks a missed completion unread exactly once when a reconnect snapshot settles the run", () => {
    const onTurnSettled = vi.fn();
    const store = new SessionStatusStore({ onTurnSettled });
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    const baseline = store.revision();

    store.applySnapshot("/repo", {}, baseline);

    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(onTurnSettled).toHaveBeenCalledWith("ses_1", "/repo");

    store.applySnapshot("/repo", {}, store.revision());
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it("fires the settled callback for event-driven busy-to-idle transitions once per turn", () => {
    const onTurnSettled = vi.fn();
    const store = new SessionStatusStore({ onTurnSettled });
    const listener = vi.fn();
    store.subscribe(listener);

    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    expect(listener).toHaveBeenCalledTimes(1);

    // Duplicate delivery of the same SSE event (plugin routing + per-view stream fallback) reduces once.
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    expect(listener).toHaveBeenCalledTimes(1);

    store.handleStatus("/repo", "ses_1", { type: "idle" }, "event");
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);

    store.handleStatus("/repo", "ses_1", { type: "idle" }, "event");
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("forgets deleted, archived, and moved sessions from the canonical cache and scope index", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo-a", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo-b", "ses_1", { type: "busy" }, "event");

    store.handleEvent("/repo-a", { type: "session.deleted", properties: { sessionID: "ses_1" } } as never);
    expect(store.statusFor("ses_1")).toBeUndefined();

    store.handleStatus("/repo-a", "ses_2", { type: "busy" }, "event");
    store.handleEvent("/repo-a", { type: "session.updated", properties: { info: { id: "ses_2", time: { archived: 123 } } } } as never);
    expect(store.statusFor("ses_2")).toBeUndefined();

    store.handleStatus("/repo-a", "ses_3", { type: "busy" }, "event");
    store.handleEvent("/repo-a", { type: "session.moved", properties: { sessionID: "ses_3" } } as never);
    expect(store.statusFor("ses_3")).toBeUndefined();
  });

  it("never settles a moved session from its previous directory's snapshot", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo-a", "ses_1", { type: "busy" }, "event");
    store.forgetSessions(["ses_1"]);
    store.handleStatus("/repo-b", "ses_1", { type: "busy" }, "event");

    store.applySnapshot("/repo-a", {}, store.revision());

    expect(store.statusFor("ses_1")?.type).toBe("busy");
    expect(store.statusFor("ses_1")?.directory).toBe("/repo-b");
  });

  it("cannot resurrect a forgotten session from a pending snapshot response", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    const baseline = store.revision();
    store.forgetSessions(["ses_1"]);

    store.applySnapshot("/repo", { ses_1: { type: "busy" } }, baseline);

    expect(store.statusFor("ses_1")).toBeUndefined();
  });

  it("never settles an entry from a snapshot of a scope it no longer reports under", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo/packages/app", "ses_1", { type: "retry" }, "event");

    store.applySnapshot("/repo", {}, store.revision());

    expect(store.statusFor("ses_1")?.type).toBe("retry");
    expect(store.statusFor("ses_1")?.directory).toBe("/repo/packages/app");
  });

  it("preserves path case when comparing directory scopes", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/Repo", "ses_1", { type: "busy" }, "event");

    store.applySnapshot("/repo", {}, store.revision());

    expect(store.statusFor("ses_1")?.type).toBe("busy");
  });

  it("normalizes separators and trailing slashes while preserving case", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo/", "ses_1", { type: "busy" }, "event");

    store.applySnapshot("\\repo", {}, store.revision());

    expect(store.statusFor("ses_1")?.type).toBe("idle");
  });

  it("reduces a changed retry action without changing the status type", () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const action = { reason: "usage", provider: "anthropic", title: "Upgrade", message: "Limit reached", label: "Upgrade plan" };
    store.handleStatus("/repo", "ses_1", { type: "retry", attempt: 1, message: "m", next: 1_000, action }, "event");
    expect(listener).toHaveBeenCalledTimes(1);

    store.handleStatus("/repo", "ses_1", { type: "retry", attempt: 1, message: "m", next: 1_000, action: { ...action, link: "https://example.com" } }, "event");
    expect(listener).toHaveBeenCalledTimes(2);

    store.handleStatus("/repo", "ses_1", { type: "retry", attempt: 1, message: "m", next: 1_000, action: { ...action, link: "https://example.com" } }, "event");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reduces session.idle and directory-scoped session.status events routed from the plugin", () => {
    const store = new SessionStatusStore();
    store.handleEvent("/repo", { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never);
    expect(store.statusFor("ses_1")?.type).toBe("busy");

    store.handleEvent("/repo", { type: "session.idle", properties: { sessionID: "ses_1" } } as never);
    expect(store.statusFor("ses_1")?.type).toBe("idle");
  });

  it("shares a session error overlay across surfaces without folding it into runtime status", () => {
    const store = new SessionStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    store.handleEvent("/repo", { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "Failed" } } } } as never);
    expect(store.hasSessionError("ses_1")).toBe(true);
    expect(store.statusFor("ses_1")?.type).toBe("busy");

    // The next active status clears the overlay together with the status change.
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    expect(store.hasSessionError("ses_1")).toBe(false);

    store.handleEvent("/repo", { type: "session.error", properties: { sessionID: "ses_1", error: { name: "MessageAbortedError", data: { message: "Stopped" } } } } as never);
    expect(store.hasSessionError("ses_1")).toBe(false);

    store.handleEvent("/repo", { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError" } } } as never);
    expect(store.hasSessionError("ses_1")).toBe(true);
    store.forgetSessions(["ses_1"]);
    expect(store.hasSessionError("ses_1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("keeps the error overlay until the run goes active so reopened panels stay consistent", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    store.handleEvent("/repo", { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError" } } } as never);

    store.applySnapshot("/repo", { ses_1: { type: "idle" } }, store.revision());
    expect(store.hasSessionError("ses_1")).toBe(true);
    expect(store.statusFor("ses_1")?.type).toBe("idle");
  });

  it("settles equivalent directory spellings that differ only in separators or case of distinct scopes", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo/sub/", "ses_1", { type: "busy" }, "event");

    store.applySnapshot("/repo\\sub", {}, store.revision());

    expect(store.statusFor("ses_1")?.type).toBe("idle");
  });

  it("bumps the lifecycle generation on clear and per-directory removal", () => {
    const store = new SessionStatusStore();
    const before = store.generation();
    store.forgetDirectory("/repo");
    expect(store.generation()).toBeGreaterThan(before);

    const afterForget = store.generation();
    store.clear();
    expect(store.generation()).toBeGreaterThan(afterForget);
  });

  it("drops statuses reported only under a removed directory but keeps entries shared with other scopes", () => {
    const store = new SessionStatusStore();
    store.handleStatus("/repo", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo/packages/app", "ses_1", { type: "busy" }, "event");
    store.handleStatus("/repo", "ses_2", { type: "busy" }, "event");

    store.forgetDirectory("/repo");

    expect(store.statusFor("ses_1")?.type).toBe("busy");
    expect(store.statusFor("ses_2")).toBeUndefined();
  });
});
