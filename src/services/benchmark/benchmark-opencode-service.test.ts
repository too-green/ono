import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { setRequestUrlHandler } from "obsidian";

import { BenchmarkOpenCodeService, isBenchmarkOpenCodeService } from "./benchmark-opencode-service";
import { createOpenCodeService, OpenCodeService } from "../opencode/opencode-service";
import type { OpenCodeServiceApi } from "../opencode/opencode-service-api";
import type { JsonObject, OpenCodeEvent, OpenCodeMessageBundle, OpenCodeSession } from "../opencode/opencode-types";

interface SourceClientStub {
  getSession: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Builds a source client stub that fails any call made after disposal. */
function stubSourceClient(sessions: Record<string, { session: OpenCodeSession; bundles: OpenCodeMessageBundle[] }>): SourceClientStub {
  const stub: SourceClientStub = {
    getSession: vi.fn(async (sessionId: string) => {
      if (stub.dispose.mock.calls.length > 0) throw new Error("source client used after dispose");
      const entry = sessions[sessionId];
      if (!entry) throw new Error(`session ${sessionId} not found`);
      return entry.session;
    }),
    listMessages: vi.fn(async (sessionId: string) => {
      if (stub.dispose.mock.calls.length > 0) throw new Error("source client used after dispose");
      return sessions[sessionId]?.bundles ?? [];
    }),
    dispose: vi.fn(),
  };
  return stub;
}

function session(id: string, directory: string): OpenCodeSession {
  return { id, title: `Session ${id}`, directory, time: { created: 1 } };
}

function bundle(info: JsonObject, parts: JsonObject[]): OpenCodeMessageBundle {
  return { info, parts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BenchmarkOpenCodeService typing", () => {
  it("structurally implements the plugin service API", () => {
    expectTypeOf(new BenchmarkOpenCodeService()).toMatchTypeOf<OpenCodeServiceApi>();
  });

  it("is narrowable through the exported benchmark type guard", () => {
    const service: OpenCodeServiceApi = new BenchmarkOpenCodeService();
    expect(isBenchmarkOpenCodeService(service)).toBe(true);
    expect(isBenchmarkOpenCodeService(createOpenCodeService({ baseUrl: "https://remote.example" }))).toBe(false);
    if (isBenchmarkOpenCodeService(service)) {
      expectTypeOf(service.status()).toMatchTypeOf<{ phase: string }>();
      expectTypeOf(service.configure(["ses-1"])).toBeVoid();
      expectTypeOf(service.start).returns.toMatchTypeOf<Promise<void>>();
    }
    service.dispose();
  });
});

describe("createOpenCodeService factory path", () => {
  it("keeps production call sites on the live client by default", () => {
    const service = createOpenCodeService({ baseUrl: "https://remote.example" });
    expect(service instanceof OpenCodeService).toBe(true);
    service.dispose();
  });

  it("serves the benchmark service when the factory benchmark option is requested", () => {
    const service = createOpenCodeService({ baseUrl: "https://remote.example" }, { benchmark: { stepIntervalMs: 4 } });
    expect(isBenchmarkOpenCodeService(service)).toBe(true);
    if (isBenchmarkOpenCodeService(service)) expect(service.status().phase).toBe("empty");
    service.dispose();
  });

  it("wires benchmark preparation through a real OpenCodeService built against the configured server", async () => {
    const snapshotSession: OpenCodeSession = session("ses-live", "/repo");
    const requests: Array<{ method?: string; url: string }> = [];
    setRequestUrlHandler((init) => {
      requests.push({ method: init.method as string | undefined, url: String(init.url) });
      const url = String(init.url);
      if (url.endsWith("/session/ses-live")) {
        return { status: 200, text: "ok", json: snapshotSession, headers: {} };
      }
      if (url.endsWith("/session/ses-live/message")) {
        return { status: 200, text: "ok", json: [{ info: { id: "msg-1", sessionID: "ses-live", role: "assistant", time: { created: 1 } }, parts: [{ id: "part-1", type: "text", text: "hi" }] }], headers: {} };
      }
      return { status: 404, text: "missing", json: undefined, headers: {} };
    });
    try {
      const service = createOpenCodeService({ baseUrl: "http://127.0.0.1:4097" }, { benchmark: {} });
      expect(isBenchmarkOpenCodeService(service)).toBe(true);
      if (!isBenchmarkOpenCodeService(service)) return;
      service.configure(["ses-live"]);

      await service.prepare();

      expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/session/ses-live", "/session/ses-live/message"]);
      expect(service.status()).toMatchObject({ phase: "ready", preparedSessions: 1 });
      await expect(service.getSession("ses-live")).resolves.toEqual(snapshotSession);
      service.dispose();
    } finally {
      setRequestUrlHandler(undefined);
    }
  });
});

describe("BenchmarkOpenCodeService preparation", () => {
  it("fetches session metadata and message bundles once per configured ID and disposes the source client", async () => {
    const source = stubSourceClient({
      "ses-a": { session: session("ses-a", "/repo"), bundles: [] },
      "ses-b": { session: session("ses-b", "/repo"), bundles: [] },
    });
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a", "ses-b"]);

    await Promise.all([service.prepare(), service.prepare()]);

    expect(source.getSession).toHaveBeenCalledTimes(2);
    expect(source.listMessages).toHaveBeenCalledTimes(2);
    expect(source.dispose).toHaveBeenCalledOnce();
    expect(service.status()).toEqual({
      phase: "ready",
      configuredSessions: 2,
      configuredLeaves: 2,
      preparedSessions: 2,
      totalEvents: 6,
      emittedEvents: 0,
      sessions: [
        { sessionId: "ses-a", status: "idle", totalEvents: 3, emittedEvents: 0 },
        { sessionId: "ses-b", status: "idle", totalEvents: 3, emittedEvents: 0 },
      ],
    });
    service.dispose();
  });

  it("tracks leaf occurrence count separately from unique configured sessions", async () => {
    const source = stubSourceClient({ "ses-a": { session: session("ses-a", "/repo"), bundles: [] } });
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a", "ses-a", "ses-b"]);

    expect(service.status()).toMatchObject({ configuredSessions: 2, configuredLeaves: 3 });
    service.configure([]);
    expect(service.status()).toMatchObject({ configuredSessions: 0, configuredLeaves: 0 });
    service.dispose();
  });

  it("rejects preparation clearly before any sessions are configured", async () => {
    const source = stubSourceClient({});
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    // A hydration read without configuration fails instead of deadlocking on an empty layout.
    await expect(service.listSessions()).rejects.toThrow(/no configured sessions/);
    await expect(service.prepare()).rejects.toThrow(/no configured sessions/);
    expect(source.getSession).not.toHaveBeenCalled();
    expect(service.status().phase).toBe("empty");
    service.dispose();
  });

  it("returns captured session metadata with directory preserved and neutral fallbacks elsewhere", async () => {
    const source = stubSourceClient({ "ses-a": { session: session("ses-a", "/repo"), bundles: [] } });
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a"]);
    await service.prepare();

    await expect(service.getSession("ses-a")).resolves.toEqual(session("ses-a", "/repo"));
    await expect(service.getSession("ses-unknown", "/repo")).resolves.toEqual({ id: "ses-unknown", directory: "/repo" });
    await expect(service.listSessions({ directory: "/repo" })).resolves.toEqual([session("ses-a", "/repo")]);
    await expect(service.listSessions({ directory: "/other" })).resolves.toEqual([]);

    // Complete messages never surface through the session-view API.
    await expect(service.listMessagePage("ses-a")).resolves.toEqual({ messages: [], complete: true });
    await expect(service.listMessages("ses-a")).resolves.toEqual([]);
    await expect(service.getMessage("ses-a", "msg-1")).resolves.toEqual({ info: { id: "msg-1", sessionID: "ses-a" }, parts: [] });
    service.dispose();
  });

  it("makes no source-client calls for normal reads or mutations before or after preparation", async () => {
    const source = stubSourceClient({ "ses-a": { session: session("ses-a", "/repo"), bundles: [] } });
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a"]);

    // Hydration reads await preparation instead of returning placeholders; this read starts it.
    const pendingListSessions = service.listSessions();
    await expect(service.prepare()).resolves.toBeUndefined();
    await expect(pendingListSessions).resolves.toEqual([session("ses-a", "/repo")]);
    await expect(service.getSession("ses-a", "/repo")).resolves.toEqual(session("ses-a", "/repo"));
    await expect(service.health()).resolves.toEqual({ healthy: true, version: "benchmark" });
    await expect(service.getSessionStatus("/repo")).resolves.toEqual({});
    await service.prepare();

    await expect(service.listAgents("/repo")).resolves.toEqual([]);
    await expect(service.listModels("/repo")).resolves.toEqual([]);
    await expect(service.listCommands("/repo")).resolves.toEqual([]);
    await expect(service.getConfig("/repo")).resolves.toEqual({});
    await expect(service.listPermissionRequests("/repo")).resolves.toEqual([]);
    await expect(service.listQuestionRequests("/repo")).resolves.toEqual([]);
    await expect(service.listSessionChildren("ses-a")).resolves.toEqual([]);
    await expect(service.getSessionTodo("ses-a")).resolves.toEqual([]);
    await expect(service.getSessionDiff("ses-a")).resolves.toEqual([]);
    await expect(service.listWorktrees("/repo")).resolves.toEqual([]);
    await expect(service.getCurrentProject("/repo")).resolves.toEqual({ id: "bench-project", worktree: "/repo" });
    await expect(service.getVcs("/repo")).resolves.toEqual({});

    await expect(service.createSession({ title: "new" }, "/repo")).resolves.toMatchObject({ id: "bench-session", directory: "/repo" });
    await expect(service.updateSession("ses-a", { title: "renamed" }, "/repo")).resolves.toMatchObject({ id: "ses-a", title: "renamed" });
    await expect(service.archiveSession("ses-a", 123, "/repo")).resolves.toMatchObject({ time: { archived: 123 } });
    await expect(service.revertSession("ses-a", { messageID: "msg-1" }, "/repo")).resolves.toMatchObject({ id: "ses-a", directory: "/repo" });
    await expect(service.unrevertSession("ses-a", "/repo")).resolves.toMatchObject({ id: "ses-a", directory: "/repo" });
    await expect(service.forkSession("ses-a", "/repo")).resolves.toMatchObject({ id: "ses-a", directory: "/repo" });
    await expect(service.runCommand("ses-a", { command: "x", arguments: "" }, "/repo")).resolves.toEqual({ info: {}, parts: [] });
    await expect(service.sendPromptAsync("ses-a", { parts: [] }, "/repo")).resolves.toBeUndefined();
    await expect(service.abortSession("ses-a", "/repo")).resolves.toBe(false);
    await expect(service.replyPermission("req-1", "once", "/repo")).resolves.toBe(true);
    await expect(service.replyQuestion("req-1", [], "/repo")).resolves.toBe(true);
    await expect(service.rejectQuestion("req-1", "/repo")).resolves.toBe(true);
    await expect(service.shareSession("ses-a", "/repo")).resolves.toEqual({});
    await expect(service.unshareSession("ses-a", "/repo")).resolves.toEqual({});
    await expect(service.summarizeSession("ses-a", { providerID: "p", modelID: "m" }, "/repo")).resolves.toEqual({});
    await expect(service.moveSession({ sessionID: "ses-a", destination: { directory: "/repo" } })).resolves.toBeUndefined();
    await expect(service.findText({ pattern: "x" })).resolves.toEqual([]);
    await expect(service.findFiles({ query: "x" })).resolves.toEqual([]);
    await expect(service.findSymbols("x")).resolves.toEqual([]);
    await expect(service.listFiles("/repo")).resolves.toEqual([]);
    await expect(service.readFile("/repo/README.md")).resolves.toEqual({});
    await expect(service.getFileStatus()).resolves.toEqual([]);
    await expect(service.listToolIds()).resolves.toEqual({});
    await expect(service.listTools({ provider: "p" })).resolves.toEqual({});
    await expect(service.getLspStatus()).resolves.toEqual([]);
    await expect(service.getFormatterStatus()).resolves.toEqual([]);
    await expect(service.getMcpStatus()).resolves.toEqual({});
    await expect(service.listProviderAuth()).resolves.toEqual({});
    await expect(service.listProviders()).resolves.toEqual({});
    await expect(service.listConfigProviders()).resolves.toEqual({ providers: [] });

    expect(source.getSession).toHaveBeenCalledTimes(1);
    expect(source.listMessages).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("fails clearly when configured session data cannot be fetched", async () => {
    const source = stubSourceClient({ "ses-a": { session: session("ses-a", "/repo"), bundles: [] } });
    vi.mocked(source.getSession).mockImplementation(async (sessionId: string) => {
      if (sessionId === "ses-bad") throw new Error("snapshot missing");
      return session(sessionId, "/repo");
    });
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a", "ses-bad"]);

    await expect(service.prepare()).rejects.toThrow(/ses-bad.*snapshot missing/);
    expect(service.status().phase).toBe("empty");
    expect(source.dispose).toHaveBeenCalledOnce();
    service.dispose();
  });
});

describe("BenchmarkOpenCodeService replay", () => {
  /** Labels one event for deterministic ordering assertions. */
  function label(event: OpenCodeEvent): string {
    const sessionId = typeof event.properties?.sessionID === "string" ? event.properties.sessionID : "";
    if (event.type === "session.status") return `${event.type}:${sessionId}:${String(event.properties?.status?.type)}`;
    if (event.type === "message.part.delta") return `${event.type}:${sessionId}:${String(event.properties?.delta)}`;
    if (event.type === "message.part.updated") return `${event.type}:${sessionId}:${String(event.properties?.part?.id)}`;
    return `${event.type}:${sessionId}`;
  }

  function setupTwoSessions(): { service: BenchmarkOpenCodeService; events: string[] } {
    const source = stubSourceClient({
      "ses-a": {
        session: session("ses-a", "/repo"),
        bundles: [bundle({ id: "msg-1", sessionID: "ses-a", role: "assistant", time: { created: 2 } }, [{ id: "part-1", type: "text", text: "hi" }])],
      },
      "ses-b": { session: session("ses-b", "/repo"), bundles: [] },
    });
    const service = new BenchmarkOpenCodeService({ stepIntervalMs: 1, createSourceClient: () => source });
    service.configure(["ses-a", "ses-b"]);
    const events: string[] = [];
    service.subscribeToEvents({ onEvent: (event) => events.push(label(event)) }, "/repo");
    return { service, events };
  }

  it("keeps playback paused until start and then replays deterministic round-robin interleaving", async () => {
    const { service, events } = setupTwoSessions();
    await service.prepare();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);

    await service.start();

    expect(events).toEqual([
      "session.status:ses-a:busy",
      "session.status:ses-b:busy",
      "session.updated:ses-a",
      "session.updated:ses-b",
      "message.updated:ses-a",
      "session.status:ses-b:idle",
      "message.part.updated:ses-a:part-1",
      "message.part.delta:ses-a:hi",
      "message.part.updated:ses-a:part-1",
      "message.updated:ses-a",
      "session.status:ses-a:idle",
    ]);
    expect(service.status()).toMatchObject({ phase: "complete", emittedEvents: 11, totalEvents: 11 });
    await expect(service.getSessionStatus("/repo")).resolves.toEqual({});
    service.dispose();
  });

  it("rejects start before preparation and stays empty", async () => {
    const { service, events } = setupTwoSessions();
    await expect(service.start()).rejects.toThrow(/prepare/);
    expect(service.status().phase).toBe("empty");
    await service.prepare();
    expect(events).toEqual([]);
    service.dispose();
  });

  it("rejects start after completion instead of silently returning the finished run", async () => {
    const { service, events } = setupTwoSessions();
    await service.prepare();
    await service.start();
    expect(service.status().phase).toBe("complete");
    await expect(service.start()).rejects.toThrow(/phase "complete"/);
    expect(events).toHaveLength(11);
    service.dispose();
  });

  it("rejects start after dispose instead of silently returning the aborted promise", async () => {
    const { service, events } = setupTwoSessions();
    await service.prepare();
    void service.start();
    service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(service.start()).rejects.toThrow(/disposed/);
    expect(events.length).toBeLessThan(11);
  });

  it("rejects reconfiguration while preparation is in flight", async () => {
    let releaseSession: ((value: OpenCodeSession) => void) | undefined;
    const source = stubSourceClient({});
    vi.mocked(source.getSession).mockImplementation(() => new Promise((resolve) => { releaseSession = resolve; }));
    const service = new BenchmarkOpenCodeService({ createSourceClient: () => source });
    service.configure(["ses-a"]);
    const preparing = service.prepare();
    expect(() => service.configure(["ses-b"])).toThrow(/preparation or replay is running/);
    releaseSession?.(session("ses-a", "/repo"));
    await preparing;
    service.dispose();
  });

  it("reports derived busy statuses for timelines still replaying", async () => {
    const source = stubSourceClient({
      "ses-a": {
        session: session("ses-a", "/repo"),
        bundles: [bundle({ id: "msg-1", sessionID: "ses-a", role: "assistant", time: { created: 2 } }, [{ id: "part-1", type: "text", text: "hi" }])],
      },
      "ses-b": {
        session: session("ses-b", "/repo"),
        bundles: [bundle({ id: "msg-2", sessionID: "ses-b", role: "assistant", time: { created: 3 } }, [{ id: "part-2", type: "text", text: "hey" }])],
      },
    });
    const service = new BenchmarkOpenCodeService({ stepIntervalMs: 60, createSourceClient: () => source });
    service.configure(["ses-a", "ses-b"]);
    await service.prepare();

    const playback = service.start();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await expect(service.getSessionStatus("/repo")).resolves.toEqual({ "ses-a": { type: "busy" }, "ses-b": { type: "busy" } });
    expect(service.status().sessions).toEqual([
      expect.objectContaining({ sessionId: "ses-a", status: "busy" }),
      expect.objectContaining({ sessionId: "ses-b", status: "busy" }),
    ]);
    // Sessions outside the requested directory scope are never reported.
    await expect(service.getSessionStatus("/other")).resolves.toEqual({});

    await playback;
    await expect(service.getSessionStatus("/repo")).resolves.toEqual({});
    expect(service.status().sessions).toEqual([
      expect.objectContaining({ sessionId: "ses-a", status: "idle" }),
      expect.objectContaining({ sessionId: "ses-b", status: "idle" }),
    ]);
    service.dispose();
  });

  it("stops replay on dispose and releases subscribers and retained data", async () => {
    const { service, events } = setupTwoSessions();
    await service.prepare();
    void service.start();
    service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.length).toBeLessThan(11);
    expect(service.status().phase).toBe("disposed");
    await expect(service.prepare()).rejects.toThrow(/disposed/);
    await expect(service.getSession("ses-a")).resolves.toEqual({ id: "ses-a" });
  });
});
