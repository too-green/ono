import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";

import { logger } from "../logger";
import { OpenCodeHttpClient, OpenCodeHttpError } from "./opencode-http";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return {
    ...actual,
    requestUrl: vi.fn(async () => ({ status: 200, json: { healthy: true, version: "test" }, headers: {}, text: "" })),
  };
});

afterEach(() => {
  logger.setDebugEnabled(false);
  vi.restoreAllMocks();
});

describe("OpenCodeHttpClient basic authentication", () => {
  it("sends the default-username basic authorization header on fetch requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", password: "a-strong-secret", fetchImpl });

    await client.get("/global/health");

    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("opencode:a-strong-secret")}`);
  });

  it("sends the configured username through Obsidian requestUrl when a password is set", async () => {
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", username: "ahmed", password: "a-strong-secret" });

    await client.get("/global/health");

    expect(vi.mocked(requestUrl).mock.calls[0][0]).toMatchObject({
      url: "http://127.0.0.1:4096/global/health",
      method: "GET",
      headers: { authorization: `Basic ${btoa("ahmed:a-strong-secret")}` },
    });
  });

  it("omits the authorization header when no password is configured", async () => {
    const client = new OpenCodeHttpClient({ baseUrl: "http://127.0.0.1:4096", username: "ahmed" });

    await client.get("/global/health");

    const { headers } = vi.mocked(requestUrl).mock.calls[0][0] as { headers: Record<string, string> };
    expect(headers.authorization).toBeUndefined();
  });
});

describe("OpenCodeHttpClient DELETE bodies", () => {
  it("sends JSON payloads through Obsidian requestUrl", async () => {
    const client = new OpenCodeHttpClient({ baseUrl: "https://remote.example/api" });

    await client.delete("/experimental/worktree", { directory: "/repo" }, { directory: "/repo/feature" });

    expect(vi.mocked(requestUrl).mock.calls[0][0]).toMatchObject({
      url: "https://remote.example/experimental/worktree?directory=%2Frepo",
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/repo/feature" }),
    });
  });

  it("sends JSON payloads through injected fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("true", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = new OpenCodeHttpClient({ baseUrl: "https://remote.example", fetchImpl });

    await client.delete("/experimental/worktree", { directory: "/repo" }, { directory: "/repo/feature" });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("https://remote.example/experimental/worktree?directory=%2Frepo");
    expect(init).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ directory: "/repo/feature" }),
    });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });
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
