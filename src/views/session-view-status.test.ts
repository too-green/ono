import { describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";
import { SessionViewModel } from "./session/session-view-model";
import { SessionStatusStore } from "../services/session-status-store";
import type { JsonObject, OpenCodeSession } from "../services/opencode-types";

interface StatusHarness {
  model: SessionViewModel;
  timeline: { renderStreaming: ReturnType<typeof vi.fn> };
  composer: { onSessionStatusChanged: ReturnType<typeof vi.fn>; updateProgressBar: ReturnType<typeof vi.fn> };
  island: { refreshState: ReturnType<typeof vi.fn>; refreshChrome: ReturnType<typeof vi.fn> };
  stream: { scheduleCanonicalSync: ReturnType<typeof vi.fn> };
  scroll: { releaseFollowLatestAfterIdle: ReturnType<typeof vi.fn> };
  sessionStatuses: { statusFor: ReturnType<typeof vi.fn>; handleStatus: ReturnType<typeof vi.fn>; markSessionError: ReturnType<typeof vi.fn>; hasSessionError: ReturnType<typeof vi.fn> };
  plugin: { sessionStatuses: StatusHarness["sessionStatuses"]; isSessionUnread: ReturnType<typeof vi.fn>; maybeShowRetryAction: ReturnType<typeof vi.fn> };
  refreshSessionStateChrome: ReturnType<typeof vi.fn>;
  setSessionUnread: ReturnType<typeof vi.fn>;
  applySessionStatus(status: Record<string, unknown> | undefined, fromEvent?: boolean): void;
  applyCachedSessionStatus(): void;
  ingestLiveSessionStatus(sessionId: string | undefined, status: Record<string, unknown>): void;
  applyStoreStatusChange(sessionId: string, origin: "event" | "snapshot"): void;
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
  const sessionStatuses = { statusFor: vi.fn(() => undefined), handleStatus: vi.fn(), markSessionError: vi.fn(), hasSessionError: vi.fn(() => false) };
  const view = Object.create(SessionView.prototype) as StatusHarness;
  Object.assign(view, {
    model,
    timeline: { renderStreaming: vi.fn(async () => undefined) },
    composer: { onSessionStatusChanged: vi.fn(), updateProgressBar: vi.fn() },
    island: { refreshState: vi.fn(), refreshChrome: vi.fn() },
    stream: { scheduleCanonicalSync: vi.fn() },
    scroll: { releaseFollowLatestAfterIdle: vi.fn() },
    sessionStatuses,
    plugin: { sessionStatuses, isSessionUnread: vi.fn(() => false), maybeShowRetryAction: vi.fn(async () => undefined) },
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

  it("clears retry state on idle and leaves unread bookkeeping to the shared store", () => {
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
    expect(view.setSessionUnread).not.toHaveBeenCalled();
  });

  it("seeds a reopened tab from the shared status cache without event side effects", () => {
    const view = setup();
    view.model.sessionStatusType = "idle";
    view.model.sessionBusy = false;
    const retry = { type: "retry", attempt: 3, message: "Still retrying", next: 30_000 };
    view.plugin.sessionStatuses.statusFor.mockReturnValue({ payload: retry, type: "retry", revision: 9 });

    view.applyCachedSessionStatus();

    expect(view.plugin.sessionStatuses.statusFor).toHaveBeenCalledWith("session-1");
    expect(view.model.sessionStatusType).toBe("retry");
    expect(view.model.sessionBusy).toBe(true);
    expect(view.model.sessionRetry?.attempt).toBe(3);
    expect(view.plugin.maybeShowRetryAction).not.toHaveBeenCalled();
    expect(view.stream.scheduleCanonicalSync).not.toHaveBeenCalled();
  });

  it("keeps a failed status sync from wiping cached busy state", () => {
    const view = setup();
    view.model.sessionStatusType = "retry";
    view.model.sessionBusy = true;
    // fetchCanonicalSession applies undefined only when the store has no cached entry.
    view.applySessionStatus(undefined, false);
    expect(view.model.sessionStatusType).toBe("idle");
    expect(view.model.sessionBusy).toBe(false);

    const cached = setup();
    cached.model.sessionStatusType = "busy";
    cached.model.sessionBusy = true;
    cached.plugin.sessionStatuses.statusFor.mockReturnValue({ payload: { type: "busy" }, type: "busy", revision: 2 });
    cached.applyCachedSessionStatus();
    expect(cached.model.sessionBusy).toBe(true);
  });

  it("routes live SSE status events into the shared store", () => {
    const view = setup();
    view.model.sessionDirectory = "/workspace";
    const status = { type: "busy" };

    view.ingestLiveSessionStatus("session-1", status);

    expect(view.plugin.sessionStatuses.handleStatus).toHaveBeenCalledWith("/workspace", "session-1", status, "event");

    const fallback = setup();
    fallback.plugin.sessionStatuses = undefined as unknown as StatusHarness["sessionStatuses"];
    fallback.ingestLiveSessionStatus("session-1", status);
    expect(fallback.model.sessionStatusType).toBe("busy");
    fallback.ingestLiveSessionStatus("other", status);
    expect(fallback.model.sessionId).toBe("session-1");
  });

  it("applies store changes to the bound session and mounted descendants", () => {
    const view = setup();
    view.plugin.sessionStatuses.statusFor.mockImplementation((sessionId: string) =>
      sessionId === "session-1" ? { payload: { type: "idle" }, type: "idle", revision: 4 } : { payload: { type: "busy" }, type: "busy", revision: 5 });
    view.model.descendantSessions.set("child-1", { title: "Research", statusType: "idle" });

    view.applyStoreStatusChange("session-1", "event");
    expect(view.model.sessionStatusType).toBe("idle");
    expect(view.model.sessionBusy).toBe(false);

    view.applyStoreStatusChange("child-1", "event");
    expect(view.model.descendantSessions.get("child-1")?.statusType).toBe("busy");
    expect(view.island.refreshState).toHaveBeenCalledOnce();
    expect(view.island.refreshChrome).toHaveBeenCalledOnce();
    expect(view.composer.updateProgressBar).toHaveBeenCalledOnce();
    expect(view.timeline.renderStreaming).toHaveBeenCalled();

    view.applyStoreStatusChange("foreign", "snapshot");
    expect(view.island.refreshState).toHaveBeenCalledOnce();
  });

  it("shows the shared error overlay for errors cached while this tab was closed", () => {
    const view = setup();
    view.model.sessionError = undefined;
    view.model.sessionStatusType = "idle";
    view.plugin.sessionStatuses.hasSessionError.mockReturnValue(true);

    expect(view.sessionVisualStatus()).toBe("error");
    expect(view.plugin.sessionStatuses.hasSessionError).toHaveBeenCalledWith("session-1");
  });

  it("reconciles each distinct descendant directory before deriving descendant statuses", async () => {
    const store = new SessionStatusStore();
    const baseline = store.revision();
    const getSessionStatus = vi.fn(async (directory: string) => {
      if (directory === "/descendant-work") return { child: { type: "busy" } } as JsonObject;
      throw new Error("unrelated scope");
    });
    const service = { getSessionStatus };
    const view = Object.create(SessionView.prototype) as unknown as {
      plugin: { sessionStatuses: SessionStatusStore; requireOpenCodeService: () => typeof service };
      sessionDirectoryFromSession(session: JsonObject): string | undefined;
      syncDescendantStatusScopes(descendants: OpenCodeSession[], rootDirectory: string | undefined, baseline: number, generation: number): Promise<void>;
    };
    Object.assign(view, { plugin: { sessionStatuses: store, requireOpenCodeService: () => service } });
    const descendants = [
      { id: "in-root", directory: "/opened" },
      { id: "child", directory: "/descendant-work" },
      { id: "sibling", directory: "/descendant-work" },
    ] as OpenCodeSession[];

    await view.syncDescendantStatusScopes(descendants, "/opened", baseline, store.generation());

    // The root scope is reused and duplicate descendant directories are fetched once.
    expect(getSessionStatus).toHaveBeenCalledTimes(1);
    expect(getSessionStatus).toHaveBeenCalledWith("/descendant-work");
    expect(store.statusFor("child")?.type).toBe("busy");
    expect(store.statusFor("child")?.directory).toBe("/descendant-work");
  });

  it("skips descendant scopes that fail or belong to a replaced server generation", async () => {
    const store = new SessionStatusStore();
    const baseline = store.revision();
    const generation = store.generation();
    const getSessionStatus = vi.fn(async (directory: string) => {
      if (directory === "/descendant-work") return { child: { type: "busy" } } as JsonObject;
      throw new Error("offline");
    });
    const service = { getSessionStatus };
    const view = Object.create(SessionView.prototype) as unknown as {
      plugin: { sessionStatuses: SessionStatusStore; requireOpenCodeService: () => typeof service };
      sessionDirectoryFromSession(session: JsonObject): string | undefined;
      syncDescendantStatusScopes(descendants: OpenCodeSession[], rootDirectory: string | undefined, baseline: number, generation: number): Promise<void>;
    };
    Object.assign(view, { plugin: { sessionStatuses: store, requireOpenCodeService: () => service } });

    // Failed descendant scope is skipped without touching the cache.
    await view.syncDescendantStatusScopes([{ id: "child", directory: "/descendant-work" }, { id: "other", directory: "/offline-dir" }] as OpenCodeSession[], "/opened", baseline, generation);
    expect(store.statusFor("child")?.type).toBe("busy");
    expect(store.statusFor("other")).toBeUndefined();

    // A replaced server generation drops the whole reconciliation without fetching.
    store.clear();
    const fetchCount = getSessionStatus.mock.calls.length;
    await view.syncDescendantStatusScopes([{ id: "child", directory: "/descendant-work" }] as OpenCodeSession[], "/opened", baseline, generation);
    expect(store.statusFor("child")).toBeUndefined();
    expect(getSessionStatus).toHaveBeenCalledTimes(fetchCount);
  });

  it("retains non-abort error chrome through idle and clears it on the next active attempt", () => {
    const view = setup();
    const error = { name: "APIError", data: { message: "Provider unavailable" } };
    view.applySessionError(error);
    expect(view.model.sessionError).toEqual({ error, message: "Provider unavailable" });
    expect(view.sessionVisualStatus()).toBe("error");
    expect(view.plugin.sessionStatuses.markSessionError).toHaveBeenCalledWith("session-1");

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
