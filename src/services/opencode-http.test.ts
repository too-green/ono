import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../logger";
import { OpenCodeHttpClient, OpenCodeHttpError } from "./opencode-http";

afterEach(() => {
  logger.setDebugEnabled(false);
  vi.restoreAllMocks();
});

describe("OpenCodeHttpClient diagnostics", () => {
  it("logs successful request metadata without query data", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    logger.setDebugEnabled(true);

    await client.get("/session/session-secret", { directory: "/Users/alice/PrivateVault" });

    expect(debug).toHaveBeenCalledWith(
      "[opencode-plugin:http] request completed",
      {
        durationMs: expect.any(Number),
        method: "GET",
        route: "/session/:id",
      },
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("PrivateVault");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("session-secret");
  });

  it("logs sanitized failure metadata without credentials or response bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response("private prompt token=server-secret", { status: 401 })) as unknown as typeof fetch;
    const client = new OpenCodeHttpClient({
      baseUrl: "http://user:url-password@127.0.0.1:4096",
      username: "api-user",
      password: "header-password",
      fetchImpl,
    });
    logger.setDebugEnabled(true);

    await expect(client.post(
      "/session/session-secret/prompt_async",
      { parts: [{ text: "private prompt" }] },
      { directory: "/Users/alice/PrivateVault" },
    )).rejects.toBeInstanceOf(OpenCodeHttpError);

    expect(warn).toHaveBeenCalledWith(
      "[opencode-plugin:http] request failed",
      {
        durationMs: expect.any(Number),
        errorName: "OpenCodeHttpError",
        method: "POST",
        route: "/session/:id/prompt_async",
        status: 401,
      },
    );
    const emitted = JSON.stringify(warn.mock.calls);
    expect(emitted).not.toContain("private prompt");
    expect(emitted).not.toContain("server-secret");
    expect(emitted).not.toContain("header-password");
    expect(emitted).not.toContain("url-password");
    expect(emitted).not.toContain("PrivateVault");
    expect(emitted).not.toContain("session-secret");
  });

  it("records aborts at debug level without warning", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const controller = new AbortController();
    controller.abort();
    logger.setDebugEnabled(true);

    await expect(client.get("/session/session-secret", undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(debug).toHaveBeenCalledWith(
      "[opencode-plugin:http] request aborted",
      {
        durationMs: expect.any(Number),
        method: "GET",
        route: "/session/:id",
        errorName: "AbortError",
      },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
