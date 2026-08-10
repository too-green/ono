import type { OpenCodeEventHandlers } from "../../../services/opencode-events";
import type { JsonObject, OpenCodeEvent } from "../../../services/opencode-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionViewModel } from "../session-view-model";
import { eventReferencesSession, StreamController } from "./stream-controller";

describe("eventReferencesSession", () => {
  it("matches direct, info, and part session identifiers", () => {
    expect(eventReferencesSession({ sessionID: "s1" }, "s1")).toBe(true);
    expect(eventReferencesSession({ info: { sessionId: "s1" } }, "s1")).toBe(true);
    expect(eventReferencesSession({ info: { id: "s1" } }, "s1")).toBe(true);
    expect(eventReferencesSession({ part: { sessionID: "s1" } }, "s1")).toBe(true);
  });

  it("rejects missing and foreign session identifiers", () => {
    expect(eventReferencesSession(undefined, "s1")).toBe(false);
    expect(eventReferencesSession({ sessionID: "s2" }, "s1")).toBe(false);
    expect(eventReferencesSession({ sessionID: "s1" }, undefined)).toBe(false);
  });
});

describe("StreamController", () => {
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    frameId = 0;
    frames = new Map();
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames.delete(id);
    }));
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Builds a controller with captured SSE handlers and observable narrow callbacks. */
  function setup() {
    const model = new SessionViewModel();
    model.sessionId = "s1";
    model.renderedSessionId = "s1";
    model.currentSession = { id: "s1" };
    const handlers: OpenCodeEventHandlers[] = [];
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const deps = {
      model,
      subscribeToEvents: vi.fn((next: OpenCodeEventHandlers) => {
        handlers.push(next);
        const close = vi.fn();
        closes.push(close);
        return { close };
      }),
      findStreamingPartTarget: vi.fn<(messageId: string, partId: string, type: string) => HTMLElement | undefined>(() => undefined),
      queueStreamingMarkdownPatch: vi.fn(),
      extendFollowLatest: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionDiff: vi.fn(),
      onStatusChange: vi.fn(),
      onPermissionAsked: vi.fn(),
      onPermissionReplied: vi.fn(),
      onQuestionAsked: vi.fn(),
      onQuestionSettled: vi.fn(),
      requestTimelineRender: vi.fn<() => Promise<void>>(async () => undefined),
      requestDiffPanelRefresh: vi.fn<(force: boolean) => Promise<void>>(async () => undefined),
      requestComposerProgressRefresh: vi.fn(),
      requestCanonicalSync: vi.fn(),
    };
    const controller = new StreamController(deps);
    controller.subscribe("/workspace");
    return { model, handlers, closes, deps, controller };
  }

  /** Emits one event through the newest captured directory subscription. */
  function emit(handlers: OpenCodeEventHandlers[], type: string, properties: JsonObject): void {
    handlers[handlers.length - 1]?.onEvent({ type, properties } as OpenCodeEvent);
  }

  /** Runs the oldest queued animation frame, matching browser one-shot frame behavior. */
  function runNextFrame(): void {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) throw new Error("Expected a queued animation frame");
    frames.delete(next[0]);
    next[1](performance.now());
  }

  it("reuses a matching subscription and ignores handlers from a replaced directory", () => {
    const { model, handlers, closes, deps, controller } = setup();
    controller.subscribe("/workspace");
    expect(deps.subscribeToEvents).toHaveBeenCalledTimes(1);

    controller.subscribe("/other");
    expect(closes[0]).toHaveBeenCalledOnce();
    handlers[0]?.onEvent({ type: "message.updated", properties: { sessionID: "s1", info: { id: "old", role: "assistant" } } });
    expect(model.loadedMessages).toEqual([]);
    handlers[0]?.onOpen?.();
    vi.runAllTimers();
    expect(deps.requestCanonicalSync).not.toHaveBeenCalled();

    handlers[1]?.onEvent({ type: "message.updated", properties: { sessionID: "s1", info: { id: "new", role: "assistant" } } });
    expect(model.loadedMessages[0]?.info.id).toBe("new");
  });

  it("requests canonical sync when an active subscription opens and debounces later requests", () => {
    const { handlers, deps, controller } = setup();
    handlers[0]?.onOpen?.();
    vi.runOnlyPendingTimers();
    expect(deps.requestCanonicalSync).toHaveBeenCalledOnce();

    controller.scheduleCanonicalSync(100);
    controller.scheduleCanonicalSync(20);
    vi.advanceTimersByTime(19);
    expect(deps.requestCanonicalSync).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(deps.requestCanonicalSync).toHaveBeenCalledTimes(2);
  });

  it("upserts, sorts, acknowledges, and removes streamed messages", async () => {
    const { model, handlers, deps } = setup();
    model.pendingQueuedUserMessages = 1;
    emit(handlers, "message.updated", { sessionID: "s1", info: { id: "user", role: "user", time: { created: 2 } } });
    emit(handlers, "message.updated", { sessionID: "s1", info: { id: "assistant", role: "assistant", time: { created: 1 } } });
    expect(model.loadedMessages.map((bundle) => bundle.info.id)).toEqual(["assistant", "user"]);
    expect(model.pendingQueuedUserMessages).toBe(0);
    expect(model.queuedMessageIds.has("user")).toBe(true);
    expect(frames.size).toBe(1);

    runNextFrame();
    await vi.waitFor(() => expect(deps.requestComposerProgressRefresh).toHaveBeenCalledOnce());
    expect(deps.requestTimelineRender).toHaveBeenCalledOnce();
    expect(deps.requestDiffPanelRefresh).toHaveBeenCalledWith(false);

    emit(handlers, "message.removed", { sessionID: "s1", messageID: "user" });
    expect(model.loadedMessages.map((bundle) => bundle.info.id)).toEqual(["assistant"]);
    expect(model.queuedMessageIds.has("user")).toBe(false);
  });

  it("upserts and removes parts, including parts received before their message", () => {
    const { model, handlers } = setup();
    model.loadedMessages = [{ info: { id: "m1" }, parts: [{ id: "p1", messageID: "m1", text: "old" }] }];
    emit(handlers, "message.part.updated", { sessionID: "s1", part: { id: "p1", messageID: "m1", text: "new" } });
    expect(model.loadedMessages[0]?.parts[0]?.text).toBe("new");

    emit(handlers, "message.part.removed", { sessionID: "s1", messageID: "m1", partID: "p1" });
    expect(model.loadedMessages[0]?.parts).toEqual([]);

    emit(handlers, "message.part.updated", { sessionID: "s1", part: { id: "p2", messageID: "m2", type: "text" } });
    expect(model.loadedMessages.find((bundle) => bundle.info.id === "m2")?.parts[0]?.id).toBe("p2");
  });

  it("patches mounted text snapshots without scheduling timeline reconciliation", () => {
    const { model, handlers, deps } = setup();
    const target = document.createElement("div");
    target.dataset.partId = "p1";
    deps.findStreamingPartTarget.mockReturnValue(target);
    model.loadedMessages = [{ info: { id: "m1" }, parts: [{ id: "p1", messageID: "m1", type: "text", text: "old" }] }];

    emit(handlers, "message.part.updated", { sessionID: "s1", part: { id: "p1", messageID: "m1", type: "text", text: "snapshot" } });

    expect(deps.queueStreamingMarkdownPatch).toHaveBeenCalledWith("m1:p1:text", target, "snapshot");
    expect(frames.size).toBe(0);
  });

  it("patches mounted text deltas directly and falls back to a timeline render without a target", () => {
    const { model, handlers, deps } = setup();
    const target = document.createElement("div");
    deps.findStreamingPartTarget.mockReturnValue(target);
    model.followLatest = true;
    model.loadedMessages = [{ info: { id: "m1" }, parts: [{ id: "p1", messageID: "m1", type: "text", text: "a" }] }];

    emit(handlers, "message.part.delta", { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "b" });
    expect(model.loadedMessages[0]?.parts[0]?.text).toBe("ab");
    expect(deps.queueStreamingMarkdownPatch).toHaveBeenCalledWith("m1:p1:text", target, "ab");
    expect(deps.extendFollowLatest).toHaveBeenCalledWith(1600);
    expect(frames.size).toBe(0);

    deps.findStreamingPartTarget.mockReturnValue(undefined);
    emit(handlers, "message.part.delta", { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "c" });
    expect(model.loadedMessages[0]?.parts[0]?.text).toBe("abc");
    expect(frames.size).toBe(1);
  });

  it("routes session, status, permission, and question events through narrow callbacks", () => {
    const { model, handlers, deps } = setup();
    const session = { id: "s1", title: "Updated" };
    emit(handlers, "session.updated", { sessionID: "s1", info: session });
    expect(deps.onSessionUpdated).toHaveBeenCalledWith(session);

    model.rewindInFlight = true;
    emit(handlers, "session.updated", { sessionID: "s1", info: { id: "s1", title: "Ignored" } });
    expect(deps.onSessionUpdated).toHaveBeenCalledOnce();
    model.rewindInFlight = false;

    emit(handlers, "session.diff", { sessionID: "s1", diff: [{ file: "src/a.ts", additions: 2, deletions: 1 }] });
    expect(deps.onSessionDiff).toHaveBeenCalledWith([{ file: "src/a.ts", additions: 2, deletions: 1, patch: undefined, status: undefined }]);
    expect(deps.requestDiffPanelRefresh).toHaveBeenCalledWith(true);
    emit(handlers, "session.status", { sessionID: "s1", status: { type: "busy" } });
    expect(deps.onStatusChange).toHaveBeenCalledWith({ type: "busy" });

    emit(handlers, "permission.asked", { sessionID: "s1", id: "permission-1" });
    emit(handlers, "permission.replied", { sessionID: "s1", requestID: "permission-1" });
    emit(handlers, "question.asked", { sessionID: "s1", id: "question-1" });
    emit(handlers, "question.rejected", { sessionID: "s1", requestID: "question-1" });
    expect(deps.onPermissionAsked).toHaveBeenCalledWith(expect.objectContaining({ id: "permission-1" }));
    expect(deps.onPermissionReplied).toHaveBeenCalledWith("permission-1");
    expect(deps.onQuestionAsked).toHaveBeenCalledWith(expect.objectContaining({ id: "question-1" }));
    expect(deps.onQuestionSettled).toHaveBeenCalledWith("question-1");
  });

  it("routes directory request events while ignoring foreign timeline data and refreshing relevant descendants", () => {
    const { model, handlers, deps } = setup();
    emit(handlers, "permission.asked", { sessionID: "child", id: "permission-child" });
    emit(handlers, "question.asked", { sessionID: "foreign", id: "question-foreign" });
    expect(deps.onPermissionAsked).toHaveBeenCalledWith(expect.objectContaining({ id: "permission-child" }));
    expect(deps.onQuestionAsked).toHaveBeenCalledWith(expect.objectContaining({ id: "question-foreign" }));

    emit(handlers, "message.updated", { sessionID: "foreign", info: { id: "ignored", role: "assistant" } });
    expect(model.loadedMessages).toEqual([]);

    emit(handlers, "session.created", { info: { id: "child", parentID: "s1", title: "Research child", directory: "/workspace" } });
    expect(model.descendantSessions.get("child")).toEqual({ title: "Research child", directory: "/workspace" });
    expect(frames.size).toBe(1);
    vi.runOnlyPendingTimers();
    expect(deps.requestCanonicalSync).toHaveBeenCalledOnce();

    emit(handlers, "session.updated", { info: { id: "child", title: "Renamed child" } });
    expect(model.descendantSessions.get("child")).toEqual({ title: "Renamed child", directory: "/workspace" });
    vi.advanceTimersByTime(499);
    expect(deps.requestCanonicalSync).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(deps.requestCanonicalSync).toHaveBeenCalledTimes(2);
    expect(deps.onSessionUpdated).not.toHaveBeenCalled();
  });

  it("queues a follow-up render for a directly patched delta received during an in-flight render", async () => {
    const { model, handlers, deps } = setup();
    let releaseFirst: (() => void) | undefined;
    const firstRender = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    deps.requestTimelineRender.mockImplementationOnce(() => firstRender);
    deps.findStreamingPartTarget.mockReturnValue(document.createElement("div"));
    model.loadedMessages = [{ info: { id: "m1", role: "assistant" }, parts: [{ id: "p1", messageID: "m1", type: "text", text: "a" }] }];
    emit(handlers, "message.updated", { sessionID: "s1", info: { id: "m1", role: "assistant" } });
    runNextFrame();
    await vi.waitFor(() => expect(deps.requestTimelineRender).toHaveBeenCalledOnce());

    emit(handlers, "message.part.delta", { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "b" });
    expect(deps.queueStreamingMarkdownPatch).toHaveBeenCalledWith("m1:p1:text", expect.any(HTMLElement), "ab");
    expect(frames.size).toBe(0);
    releaseFirst?.();
    await vi.waitFor(() => expect(frames.size).toBe(1));
    runNextFrame();
    await vi.waitFor(() => expect(deps.requestTimelineRender).toHaveBeenCalledTimes(2));
  });

  it("does not run post-render callbacks after disposal during an in-flight render", async () => {
    const { handlers, deps, controller } = setup();
    let releaseRender: (() => void) | undefined;
    deps.requestTimelineRender.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseRender = resolve;
    }));
    emit(handlers, "message.updated", { sessionID: "s1", info: { id: "m1", role: "assistant" } });
    runNextFrame();
    await vi.waitFor(() => expect(deps.requestTimelineRender).toHaveBeenCalledOnce());

    controller.dispose();
    releaseRender?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.requestDiffPanelRefresh).not.toHaveBeenCalled();
    expect(deps.requestComposerProgressRefresh).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("contains rejected fire-and-forget canonical and diff refresh callbacks", async () => {
    const { handlers, deps, controller } = setup();
    deps.requestCanonicalSync.mockRejectedValueOnce(new Error("canonical failed"));
    controller.scheduleCanonicalSync(0);
    vi.runAllTimers();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith("[opencode-plugin:session-stream] canonical sync request failed", expect.any(Error)));

    deps.requestDiffPanelRefresh.mockRejectedValueOnce(new Error("diff failed"));
    emit(handlers, "session.diff", { sessionID: "s1", diff: [] });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith("[opencode-plugin:session-stream] diff panel refresh failed", expect.any(Error)));
  });

  it("cancels subscriptions, timers, frames, and stale handlers on disposal", () => {
    const { model, handlers, closes, deps, controller } = setup();
    controller.scheduleCanonicalSync(100);
    emit(handlers, "message.updated", { sessionID: "s1", info: { id: "queued", role: "assistant" } });
    expect(frames.size).toBe(1);

    controller.dispose();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    vi.runAllTimers();
    expect(deps.requestCanonicalSync).not.toHaveBeenCalled();
    handlers[0]?.onEvent({ type: "message.updated", properties: { sessionID: "s1", info: { id: "stale", role: "assistant" } } });
    expect(model.loadedMessages.map((bundle) => bundle.info.id)).toEqual(["queued"]);
  });
});
