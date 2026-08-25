import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginLogger, type LogContext } from "./logger";

/** Creates an isolated logger and console-compatible spy sink for privacy assertions. */
function setupLogger() {
  const sink = {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  return { logger: new PluginLogger(sink), sink };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginLogger", () => {
  it("suppresses debug entries by default while preserving warnings", () => {
    const { logger, sink } = setupLogger();

    logger.debug("http", "request completed", { method: "GET", route: "/session/private-id" });
    logger.warn("http", "request failed", { error: new TypeError("failed") });

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith(
      "[opencode-plugin:http] request failed",
      { errorName: "TypeError" },
    );
  });

  it("emits allowlisted diagnostics when explicitly enabled", () => {
    const { logger, sink } = setupLogger();
    logger.setDebugEnabled(true);

    logger.debug("sse", "event received", {
      eventType: "message.part.updated",
      count: 4,
      reconnected: true,
    });

    expect(logger.isDebugEnabled()).toBe(true);
    expect(sink.debug).toHaveBeenCalledWith(
      "[opencode-plugin:sse] event received",
      { count: 4, eventType: "message.part.updated", reconnected: true },
    );
  });

  it("excludes routes IDs, arbitrary error text, and unsupported context from failures", () => {
    const { logger, sink } = setupLogger();
    logger.setDebugEnabled(true);
    const error = Object.assign(
      new Error("Request to https://user:password@localhost:4096 failed in /Users/alice/PrivateVault password=hunter2"),
      { name: "OpenCodeHttpError", status: 401, responseText: "private prompt and token=server-secret" },
    );
    const context = {
      method: "POST",
      route: "/session/session-secret/message/message-secret?directory=/Users/alice/PrivateVault",
      error,
      payload: { prompt: "private prompt" },
      authorization: "Basic private-credentials",
    } as unknown as LogContext;

    logger.warn("http", "request failed", context);

    expect(sink.warn).toHaveBeenCalledWith(
      "[opencode-plugin:http] request failed",
      {
        method: "POST",
        route: "/session/:id/message/:messageId",
        status: 401,
        errorName: "OpenCodeHttpError",
      },
    );
    const emitted = JSON.stringify(sink.warn.mock.calls);
    expect(emitted).not.toContain("session-secret");
    expect(emitted).not.toContain("message-secret");
    expect(emitted).not.toContain("PrivateVault");
    expect(emitted).not.toContain("private prompt");
    expect(emitted).not.toContain("private-credentials");
    expect(emitted).not.toContain("server-secret");
    expect(emitted).not.toContain("hunter2");
  });

  it("replaces server-controlled event types and error names outside known v1 values", () => {
    const { logger, sink } = setupLogger();
    logger.setDebugEnabled(true);
    const error = Object.assign(new Error("private payload"), { name: "session-secret" });

    logger.debug("sse", "event received", { eventType: "private-id", error });

    expect(sink.debug).toHaveBeenCalledWith(
      "[opencode-plugin:sse] event received",
      { eventType: "unknown", errorName: "Error" },
    );
  });

  it("keeps allowlisted network codes while excluding their error message", () => {
    const { logger, sink } = setupLogger();
    logger.setDebugEnabled(true);
    const error = Object.assign(new TypeError("connect ECONNREFUSED /Users/alice/private"), { code: "ECONNREFUSED" });

    logger.warn("http", "request failed", { error });

    expect(sink.warn).toHaveBeenCalledWith(
      "[opencode-plugin:http] request failed",
      { errorName: "TypeError", errorCode: "ECONNREFUSED" },
    );
    expect(JSON.stringify(sink.warn.mock.calls)).not.toContain("/Users/alice/private");
  });

  it("does not stringify non-Error thrown values", () => {
    const { logger, sink } = setupLogger();
    logger.setDebugEnabled(true);

    logger.error("sse", "subscriber failed", { error: "private payload" });

    expect(sink.error).toHaveBeenCalledWith(
      "[opencode-plugin:sse] subscriber failed",
      { errorName: "ThrownString" },
    );
  });
});
