import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../logger";
import { OpenCodeEventStream, type OpenCodeEventHandlers } from "./opencode-events";
import type { OpenCodeHttpClient } from "./opencode-http";

interface EventStreamHarness {
  connections: Map<string, { abort: AbortController; handlers: Set<OpenCodeEventHandlers>; directory?: string }>;
  emitChunk(key: string, chunk: string): void;
  readLoop(key: string, controller: AbortController): Promise<void>;
  readOnce: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
}

/** Creates a stream harness that exercises parsing and dispatch without opening a network connection. */
function setupStream(...handlers: OpenCodeEventHandlers[]): EventStreamHarness {
  const stream = new OpenCodeEventStream({} as OpenCodeHttpClient) as unknown as EventStreamHarness;
  stream.connections.set("", { abort: new AbortController(), handlers: new Set(handlers) });
  return stream;
}

afterEach(() => {
  logger.setDebugEnabled(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OpenCodeEventStream diagnostics", () => {
  it("contains malformed events without exposing their payload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onEvent = vi.fn();
    const stream = setupStream({ onEvent });

    stream.emitChunk("", "data: {private-prompt");

    expect(onEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[opencode-plugin:sse] event parse failed",
      { errorName: "SyntaxError" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-prompt");
  });

  it("isolates a throwing subscriber and continues dispatch", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secondHandler = vi.fn();
    const stream = setupStream(
      { onEvent: () => { throw new Error("private payload"); } },
      { onEvent: secondHandler },
    );

    stream.emitChunk("", 'data: {"type":"session.updated","properties":{}}');

    expect(secondHandler).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "[opencode-plugin:sse] subscriber failed",
      { errorName: "Error" },
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private payload");
  });

  it("logs only allowlisted event types without event properties", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const stream = setupStream({ onEvent: vi.fn() });
    logger.setDebugEnabled(true);

    stream.emitChunk("", 'data: {"type":"private-session-id","properties":{"text":"private prompt"}}');

    expect(debug).toHaveBeenCalledWith(
      "[opencode-plugin:sse] event received",
      { eventType: "unknown" },
    );
    const emitted = JSON.stringify(debug.mock.calls);
    expect(emitted).not.toContain("private-session-id");
    expect(emitted).not.toContain("private prompt");
  });

  it("bypasses disabled diagnostics and suppresses token-delta logs", () => {
    const debug = vi.spyOn(logger, "debug");
    const stream = setupStream({ onEvent: vi.fn() });

    stream.emitChunk("", 'data: {"type":"session.updated","properties":{}}');
    expect(debug).not.toHaveBeenCalled();

    logger.setDebugEnabled(true);
    stream.emitChunk("", 'data: {"type":"message.part.delta","properties":{"delta":"private token"}}');
    expect(debug).not.toHaveBeenCalled();
  });

  it("backs off after a clean EOF instead of reconnecting in a tight loop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onError = vi.fn();
    const onReconnect = vi.fn();
    const stream = setupStream({ onEvent: vi.fn(), onError, onReconnect });
    const controller = stream.connections.get("")!.abort;
    stream.readOnce = vi.fn(async () => undefined);
    stream.sleep = vi.fn(async () => {
      if (stream.sleep.mock.calls.length >= 3) controller.abort();
    });

    await stream.readLoop("", controller);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onReconnect.mock.calls.map((call) => call.slice(0, 2))).toEqual([[1, 1_000], [2, 2_000], [3, 5_000]]);
    expect(stream.sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 2_000, 5_000]);
  });

  it("removes the abort listener after a reconnect delay completes", async () => {
    vi.useFakeTimers();
    const stream = setupStream({ onEvent: vi.fn() });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const sleeping = stream.sleep(1_000, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await sleeping;

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
