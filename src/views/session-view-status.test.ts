import { describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";
import { SessionViewModel } from "./session/session-view-model";

interface StatusHarness {
  model: SessionViewModel;
  timeline: { renderStreaming: ReturnType<typeof vi.fn> };
  composer: { onSessionStatusChanged: ReturnType<typeof vi.fn> };
  stream: { scheduleCanonicalSync: ReturnType<typeof vi.fn> };
  scroll: { releaseFollowLatestAfterIdle: ReturnType<typeof vi.fn> };
  plugin: { settings: { sessionUnread: Record<string, boolean> }; notifySessionStatusChanged: ReturnType<typeof vi.fn>; maybeShowRetryAction: ReturnType<typeof vi.fn> };
  refreshSessionStateChrome: ReturnType<typeof vi.fn>;
  setSessionUnread: ReturnType<typeof vi.fn>;
  applySessionStatus(status: Record<string, unknown> | undefined, fromEvent?: boolean): void;
  applySessionStatusSnapshot(snapshot: Record<string, unknown>, baselineRevision: number): void;
  applySessionError(error: unknown): void;
  hydrateCanonicalSessionError(): void;
  sessionVisualStatus(): string;
}

/** Builds a prototype-backed SessionView harness for isolated status reconciliation tests. */
function setup(): StatusHarness {
  const model = new SessionViewModel();
  model.sessionId = "session-1";
  model.sessionStatusType = "busy";
  model.sessionBusy = true;
  const view = Object.create(SessionView.prototype) as StatusHarness;
  Object.assign(view, {
    model,
    timeline: { renderStreaming: vi.fn(async () => undefined) },
    composer: { onSessionStatusChanged: vi.fn() },
    stream: { scheduleCanonicalSync: vi.fn() },
    scroll: { releaseFollowLatestAfterIdle: vi.fn() },
    plugin: { settings: { sessionUnread: {} }, notifySessionStatusChanged: vi.fn(), maybeShowRetryAction: vi.fn(async () => undefined) },
    refreshSessionStateChrome: vi.fn(),
    setSessionUnread: vi.fn(),
  });
  return view;
}

describe("SessionView retry status", () => {
  it("renders busy-to-retry payload changes and removes the card on resumed work", () => {
    const view = setup();
    const retry = { type: "retry", attempt: 1, message: "Provider unavailable", next: 20_000 };
    view.model.sessionError = { error: { name: "APIError" }, message: "stale error" };

    view.applySessionStatus(retry, true);
    expect(view.model.sessionRetry).toEqual({ attempt: 1, message: "Provider unavailable", next: 20_000, action: undefined });
    expect(view.model.sessionError).toBeUndefined();
    expect(view.timeline.renderStreaming).toHaveBeenCalledOnce();
    expect(view.composer.onSessionStatusChanged).not.toHaveBeenCalled();

    view.applySessionStatus(retry, true);
    expect(view.timeline.renderStreaming).toHaveBeenCalledOnce();

    view.applySessionStatus({ type: "busy" }, true);
    expect(view.model.sessionRetry).toBeUndefined();
    expect(view.timeline.renderStreaming).toHaveBeenCalledTimes(2);
  });

  it("clears retry state and settles the turn on idle", () => {
    const view = setup();
    view.model.sessionStatusType = "retry";
    view.model.sessionRetry = { attempt: 2, message: "Rate limited", next: 20_000 };

    view.applySessionStatus({ type: "idle" }, true);

    expect(view.model.sessionRetry).toBeUndefined();
    expect(view.model.sessionBusy).toBe(false);
    expect(view.timeline.renderStreaming).toHaveBeenCalledOnce();
    expect(view.composer.onSessionStatusChanged).toHaveBeenCalledOnce();
    expect(view.stream.scheduleCanonicalSync).toHaveBeenCalledWith(120);
    expect(view.scroll.releaseFollowLatestAfterIdle).toHaveBeenCalledOnce();
    expect(view.setSessionUnread).toHaveBeenCalledWith(true);
  });

  it("uses an empty canonical snapshot as idle without overwriting newer status events", () => {
    const settled = setup();
    settled.model.sessionStatusType = "retry";
    settled.model.sessionRetry = { attempt: 2, message: "Rate limited", next: 20_000 };
    settled.model.sessionStatusRevision = 4;
    settled.applySessionStatusSnapshot({}, 4);
    expect(settled.model.sessionStatusType).toBe("idle");
    expect(settled.model.sessionRetry).toBeUndefined();

    const stale = setup();
    stale.model.sessionStatusType = "retry";
    stale.model.sessionRetry = { attempt: 3, message: "Still retrying", next: 30_000 };
    stale.model.sessionStatusRevision = 5;
    stale.applySessionStatusSnapshot({}, 4);
    expect(stale.model.sessionStatusType).toBe("retry");
    expect(stale.model.sessionRetry?.attempt).toBe(3);
  });

  it("retains non-abort error chrome through idle and clears it on the next active attempt", () => {
    const view = setup();
    const error = { name: "APIError", data: { message: "Provider unavailable" } };
    view.applySessionError(error);
    expect(view.model.sessionError).toEqual({ error, message: "Provider unavailable" });
    expect(view.sessionVisualStatus()).toBe("error");
    expect(view.plugin.notifySessionStatusChanged).toHaveBeenLastCalledWith("session-1", "error");

    view.applySessionStatus({ type: "idle" }, true);
    expect(view.model.sessionError).not.toBeUndefined();
    expect(view.sessionVisualStatus()).toBe("error");

    view.applySessionStatus({ type: "busy" }, true);
    expect(view.model.sessionError).toBeUndefined();
    expect(view.sessionVisualStatus()).toBe("working");
  });

  it("ignores user-requested abort errors", () => {
    const view = setup();
    view.applySessionError({ name: "MessageAbortedError", data: { message: "Stopped" } });
    expect(view.model.sessionError).toBeUndefined();
    expect(view.plugin.notifySessionStatusChanged).not.toHaveBeenCalledWith("session-1", "error");
  });

  it("restores error chrome from the latest durable assistant error", () => {
    const view = setup();
    view.model.sessionBusy = false;
    view.model.loadedMessages = [{
      info: { id: "assistant-1", role: "assistant", error: { name: "APIError", data: { message: "Persisted failure" } } },
      parts: [],
    }];
    view.hydrateCanonicalSessionError();
    expect(view.model.sessionError?.message).toBe("Persisted failure");
    expect(view.sessionVisualStatus()).toBe("error");
  });
});
