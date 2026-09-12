import { BenchmarkEventBroker, directoryScopeKey } from "./benchmark-event-broker";
import type { OpenCodeEventHandlers, OpenCodeEventSubscription } from "../opencode/events-helper";
import type { OpenCodeServerConfig } from "../opencode/opencode-service";
import type { OpenCodeServiceApi } from "../opencode/opencode-service-api";
import {
  DEFAULT_STEP_INTERVAL_MS,
  DEFAULT_TEXT_CHUNK_CODE_POINTS,
  buildReplayPlan,
  type BenchmarkPlaybackOptions,
  type ReplayPlan,
} from "./benchmark-replay-plan";
import type {
  JsonObject,
  OpenCodeCreateSessionInput,
  OpenCodeCreateWorktreeInput,
  OpenCodeHealth,
  OpenCodeListSessionsParams,
  OpenCodeMessageBundle,
  OpenCodeMessagePage,
  OpenCodePermissionRequest,
  OpenCodeProject,
  OpenCodeQuestionRequest,
  OpenCodeSession,
  OpenCodeTodo,
  OpenCodeUpdateSessionInput,
  OpenCodeVcsInfo,
  OpenCodeWorktree,
} from "../opencode/opencode-types";

/** Lifecycle phases reported to benchmark orchestration through status(). */
export type BenchmarkPlaybackPhase = "empty" | "preparing" | "ready" | "playing" | "complete" | "disposed";

/** Readiness and replay progress snapshot for orchestration. */
export interface BenchmarkPlaybackStatus {
  phase: BenchmarkPlaybackPhase;
  /** Unique configured session count (deduplicated fetch targets). */
  configuredSessions: number;
  /** Configured `opencode-session` leaf occurrence count (duplicates included) for layout validation. */
  configuredLeaves: number;
  preparedSessions: number;
  totalEvents: number;
  emittedEvents: number;
  /** Per-session replay state aligned with the configured workspace sessions. */
  sessions: BenchmarkSessionPlaybackStatus[];
}

/** Current replay progress for one configured session. */
export interface BenchmarkSessionPlaybackStatus {
  sessionId: string;
  status: "busy" | "idle";
  totalEvents: number;
  emittedEvents: number;
}

/** Narrow orchestration surface; obtained from a service instance via isBenchmarkOpenCodeService. */
export interface BenchmarkOpenCodeControl {
  /** Sets the configured session IDs replayed by this service and resets prepared state. */
  configure(sessionIds: readonly string[]): void;
  /** Fetches each configured session's metadata and complete message bundles from the benchmark server. */
  prepare(): Promise<void>;
  /** Returns readiness and replay progress for orchestration. */
  status(): BenchmarkPlaybackStatus;
  /** Starts deterministic replay; resolves once every configured timeline finishes. */
  start(): Promise<void>;
  /** Stops replay and releases subscribers and retained data. */
  dispose(): void;
}

/** Subset of the production client the preparation path is allowed to call. */
export type BenchmarkSourceClient = Pick<OpenCodeServiceApi, "getSession" | "listMessages" | "dispose">;

export interface BenchmarkOpenCodeServiceOptions extends BenchmarkPlaybackOptions {
  /** Dedicated benchmark server that serves the fixed session snapshot during preparation. */
  server?: OpenCodeServerConfig;
  /** Builds the production client used internally by preparation; wired by the service factory. */
  createSourceClient?: (config: OpenCodeServerConfig) => BenchmarkSourceClient;
}

const BENCHMARK_HEALTH: OpenCodeHealth = { healthy: true, version: "benchmark" };
const EMPTY_BUNDLE: OpenCodeMessageBundle = { info: {}, parts: [] };
const COMPLETE_PAGE: OpenCodeMessagePage = { messages: [], complete: true };

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-plugin OpenCode service used only in benchmark mode. Preparation pulls each configured
 * session's metadata and complete message bundles from the dedicated benchmark server through
 * the real production client and retains them privately; the normal session-view API returns
 * captured metadata with empty timelines and never exposes the retained messages. Replay is a
 * deterministic precomputed event sequence driven by a catch-up clock, started only by start().
 */
export class BenchmarkOpenCodeService implements OpenCodeServiceApi {
  private readonly broker = new BenchmarkEventBroker();
  private readonly capturedSessions = new Map<string, OpenCodeSession>();
  private readonly stepIntervalMs: number;
  private readonly textChunkCodePoints: number;
  private readonly server: OpenCodeServerConfig;
  private readonly createSourceClient?: (config: OpenCodeServerConfig) => BenchmarkSourceClient;
  private readonly abort = new AbortController();
  private configuredIds: string[] = [];
  private configuredLeafCount = 0;
  private plan?: ReplayPlan;
  private phase: BenchmarkPlaybackPhase = "empty";
  private preparePromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private emittedEvents = 0;
  /** Live round-robin pointers so status snapshots can report sessions that are still replaying. */
  private replayPointers: number[] = [];

  constructor(options: BenchmarkOpenCodeServiceOptions = {}) {
    this.server = options.server ?? { baseUrl: "" };
    this.stepIntervalMs = options.stepIntervalMs ?? DEFAULT_STEP_INTERVAL_MS;
    this.textChunkCodePoints = options.textChunkCodePoints ?? DEFAULT_TEXT_CHUNK_CODE_POINTS;
    this.createSourceClient = options.createSourceClient;
  }

  // ---- Orchestration control ----

  /** Sets the configured session ids (one entry per workspace leaf, duplicates kept); rejected while a run is active. */
  configure(sessionIds: readonly string[]): void {
    if (this.phase === "preparing" || this.phase === "playing") throw new Error("Benchmark sessions cannot be reconfigured while preparation or replay is running.");
    if (this.phase === "disposed") throw new Error("Benchmark service is disposed.");
    this.configuredLeafCount = sessionIds.length;
    this.configuredIds = [...new Set(sessionIds)];
    this.capturedSessions.clear();
    this.plan = undefined;
    this.emittedEvents = 0;
    this.replayPointers = [];
    this.phase = "empty";
  }

  /** Fetches and retains session data from the benchmark server; concurrent calls share one run. */
  prepare(): Promise<void> {
    if (this.phase === "disposed") return Promise.reject(new Error("Benchmark service is disposed."));
    if (this.preparePromise) return this.preparePromise;
    if (this.phase === "ready" || this.phase === "playing" || this.phase === "complete") return Promise.resolve();
    if (this.configuredIds.length === 0) {
      return Promise.reject(new Error("Benchmark service has no configured sessions; the benchmark layout must contain opencode-session leaves with session ids."));
    }
    const promise = this.runPreparation();
    this.preparePromise = promise;
    void promise.catch(() => undefined).finally(() => {
      if (this.preparePromise === promise) this.preparePromise = undefined;
    });
    return promise;
  }

  /** Returns readiness and replay progress for orchestration. */
  status(): BenchmarkPlaybackStatus {
    return {
      phase: this.phase,
      configuredSessions: this.configuredIds.length,
      configuredLeaves: this.configuredLeafCount,
      preparedSessions: this.capturedSessions.size,
      totalEvents: this.plan?.totalEvents ?? 0,
      emittedEvents: this.emittedEvents,
      sessions: this.configuredIds.map((sessionId, index) => {
        const totalEvents = this.plan?.timelines[index]?.events.length ?? 0;
        const emittedEvents = this.replayPointers[index] ?? 0;
        return {
          sessionId,
          status: this.phase === "playing" && emittedEvents < totalEvents ? "busy" : "idle",
          totalEvents,
          emittedEvents,
        };
      }),
    };
  }

  /** Starts deterministic replay; resolves when every configured timeline has finished. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.phase === "preparing") return Promise.reject(new Error("Benchmark replay is still preparing; await prepare() first."));
    if (this.phase !== "ready") return Promise.reject(new Error(`Benchmark replay cannot start from phase "${this.phase}"; configure and prepare first.`));
    this.phase = "playing";
    const promise = this.runReplay().then(() => {
      // Forget the finished promise so later starts report the terminal phase instead of
      // silently returning the completed replay.
      if (this.startPromise === promise) this.startPromise = undefined;
      if (this.phase === "playing") this.phase = "complete";
    });
    this.startPromise = promise;
    return promise;
  }

  /** Stops replay, closes subscribers, and releases retained benchmark data. */
  dispose(): void {
    this.abort.abort();
    this.broker.close();
    this.capturedSessions.clear();
    this.plan = undefined;
    this.preparePromise = undefined;
    this.startPromise = undefined;
    this.phase = "disposed";
  }

  // ---- Preparation ----

  /** Fetches metadata and message bundles per configured ID through the production client. */
  private async runPreparation(): Promise<void> {
    this.phase = "preparing";
    try {
      const client = this.createSourceClient?.(this.server);
      if (!client) throw new Error("Benchmark service has no source client factory; use the createOpenCodeService benchmark path.");
      try {
        const results = await Promise.allSettled(this.configuredIds.map(async (sessionId) => ({
          sessionId,
          session: await client.getSession(sessionId),
          bundles: await client.listMessages(sessionId),
        })));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length > 0) {
          // Associate each failure with its configured id through the shared result index.
          const failedIds = results.flatMap((result, index) => {
            if (result.status !== "rejected") return [];
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return [`${this.configuredIds[index]}: ${reason}`];
          });
          throw new Error(`Benchmark preparation failed for configured session data: ${failedIds.join("; ")}`);
        }
        if (this.abort.signal.aborted) return;
        const prepared = results.map((result) => result as PromiseFulfilledResult<{ sessionId: string; session: OpenCodeSession; bundles: OpenCodeMessageBundle[] }>).map((result) => result.value);
        this.capturedSessions.clear();
        for (const item of prepared) this.capturedSessions.set(item.sessionId, item.session);
        this.plan = buildReplayPlan(prepared, { textChunkCodePoints: this.textChunkCodePoints });
        this.emittedEvents = 0;
        this.replayPointers = new Array(this.plan.timelines.length).fill(0);
        this.phase = "ready";
      } finally {
        client.dispose();
      }
    } catch (error) {
      this.phase = "empty";
      this.capturedSessions.clear();
      this.plan = undefined;
      this.emittedEvents = 0;
      this.replayPointers = [];
      throw error;
    }
  }

  // ---- Replay ----

  /** Interleaves precomputed timelines with fixed deterministic round-robin on a catch-up clock. */
  private async runReplay(): Promise<void> {
    const plan = this.plan!;
    const signal = this.abort.signal;
    const startedAt = Date.now();
    let round = 0;
    while (true) {
      // Target-timeline pacing: absolute schedule absorbs handler overrun instead of accumulating drift.
      const delayMs = startedAt + round * this.stepIntervalMs - Date.now();
      if (delayMs > 0) await this.waitFor(delayMs, signal);
      if (signal.aborted) return;
      let emitted = false;
      for (let index = 0; index < plan.timelines.length; index += 1) {
        const timeline = plan.timelines[index];
        const pointer = this.replayPointers[index] ?? 0;
        if (pointer >= timeline.events.length) continue;
        this.replayPointers[index] = pointer + 1;
        this.emittedEvents += 1;
        emitted = true;
        this.broker.publish(timeline.events[pointer], timeline.directory);
      }
      if (!emitted) return;
      round += 1;
    }
  }

  /** Resolves after the delay or as soon as dispose aborts the replay clock. */
  private waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        globalThis.clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = globalThis.setTimeout(finish, delayMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  // ---- Session/mutation responses ----

  /** Returns captured metadata for a session, or a neutral placeholder that still hydrates views. */
  private sessionResponse(sessionId: string, directory?: string): OpenCodeSession {
    const captured = this.capturedSessions.get(sessionId);
    if (captured) return clone(captured);
    return directory !== undefined ? { id: sessionId, directory } : { id: sessionId };
  }

  // ---- Preparation gating ----

  /**
   * Resolves once preparation is ready (or the service is disposed, where reads degrade to
   * neutral placeholders). Session hydration APIs await it so restored views never observe
   * placeholders while the snapshot fetch is still running.
   */
  private ensurePrepared(): Promise<void> {
    if (this.phase === "disposed") return Promise.resolve();
    return this.prepare();
  }

  // ---- Normal API surface (no network after/during preparation) ----

  /** Benchmark mode has no live server to re-point; configuration changes stay no-ops. */
  updateConfig(): void {}

  health(): Promise<OpenCodeHealth> {
    return Promise.resolve(clone(BENCHMARK_HEALTH));
  }

  subscribeToEvents(handlers: OpenCodeEventHandlers, directory?: string): OpenCodeEventSubscription {
    return this.broker.subscribe(handlers, directory);
  }

  subscribeToGlobalEvents(handlers: OpenCodeEventHandlers): OpenCodeEventSubscription {
    return this.broker.subscribeGlobal(handlers);
  }

  listProjects(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  getCurrentProject(directory?: string): Promise<OpenCodeProject> {
    return Promise.resolve({ id: "bench-project", worktree: directory ?? "" });
  }

  getPath(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  getVcs(): Promise<OpenCodeVcsInfo> {
    return Promise.resolve({});
  }

  listWorktrees(): Promise<string[]> {
    return Promise.resolve([]);
  }

  createWorktree(directory: string, input?: OpenCodeCreateWorktreeInput): Promise<OpenCodeWorktree> {
    return Promise.resolve({ name: input?.name ?? "bench-worktree", directory });
  }

  removeWorktree(): Promise<boolean> {
    return Promise.resolve(true);
  }

  resetWorktree(): Promise<boolean> {
    return Promise.resolve(true);
  }

  getConfig(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  listConfigProviders(): Promise<JsonObject> {
    return Promise.resolve({ providers: [] });
  }

  listProviders(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  listProviderAuth(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  /** Awaits preparation, then returns captured session metadata filtered by directory; hydration stays fully offline. */
  async listSessions(params?: OpenCodeListSessionsParams): Promise<OpenCodeSession[]> {
    await this.ensurePrepared();
    const sessions = [...this.capturedSessions.values()];
    const filtered = params?.directory !== undefined
      ? sessions.filter((session) => directoryScopeKey(typeof session.directory === "string" ? session.directory : undefined) === directoryScopeKey(params.directory))
      : sessions;
    filtered.sort((left, right) => {
      const created = (session: OpenCodeSession): number => typeof session.time?.created === "number" ? session.time.created : 0;
      const byTime = created(left) - created(right);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
    return filtered.map(clone);
  }

  /** Derives busy statuses for timelines still replaying so canonical snapshots never clobber live state. */
  getSessionStatus(directory?: string): Promise<JsonObject> {
    const statuses: JsonObject = {};
    if (this.phase !== "playing") return Promise.resolve(statuses);
    this.plan?.timelines.forEach((timeline, index) => {
      const pointer = this.replayPointers[index] ?? 0;
      if (pointer >= timeline.events.length) return;
      if (directory !== undefined && directoryScopeKey(timeline.directory) !== directoryScopeKey(directory)) return;
      statuses[timeline.session.id] = { type: "busy" };
    });
    return Promise.resolve(statuses);
  }

  /** Awaits preparation, then returns captured metadata without ever exposing retained messages. */
  async getSession(sessionId: string, directory?: string): Promise<OpenCodeSession> {
    await this.ensurePrepared();
    return this.sessionResponse(sessionId, directory);
  }

  createSession(input?: OpenCodeCreateSessionInput, directory?: string): Promise<OpenCodeSession> {
    const session: OpenCodeSession = { id: "bench-session", directory, time: { created: 0 } };
    if (input?.title !== undefined) session.title = input.title;
    return Promise.resolve(session);
  }

  /** Deterministic no-op mutation; merges the input so view chrome never regresses. */
  updateSession(sessionId: string, input: OpenCodeUpdateSessionInput, directory?: string): Promise<OpenCodeSession> {
    const session = this.sessionResponse(sessionId, directory);
    if (input.title !== undefined) session.title = input.title;
    if (typeof input.time?.archived === "number") session.time = { ...session.time, archived: input.time.archived };
    return Promise.resolve(session);
  }

  archiveSession(sessionId: string, archivedAt: number, directory?: string): Promise<OpenCodeSession> {
    return this.updateSession(sessionId, { time: { archived: archivedAt } }, directory);
  }

  moveSession(): Promise<void> {
    return Promise.resolve();
  }

  sendPromptAsync(): Promise<void> {
    return Promise.resolve();
  }

  abortSession(): Promise<boolean> {
    return Promise.resolve(false);
  }

  runCommand(): Promise<OpenCodeMessageBundle> {
    return Promise.resolve(clone(EMPTY_BUNDLE));
  }

  summarizeSession(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  revertSession(sessionId: string): Promise<OpenCodeSession> {
    return Promise.resolve(this.sessionResponse(sessionId));
  }

  unrevertSession(sessionId: string): Promise<OpenCodeSession> {
    return Promise.resolve(this.sessionResponse(sessionId));
  }

  shareSession(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  unshareSession(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  forkSession(sessionId: string): Promise<OpenCodeSession> {
    return Promise.resolve(this.sessionResponse(sessionId));
  }

  listPermissionRequests(): Promise<OpenCodePermissionRequest[]> {
    return Promise.resolve([]);
  }

  replyPermission(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listQuestionRequests(): Promise<OpenCodeQuestionRequest[]> {
    return Promise.resolve([]);
  }

  replyQuestion(): Promise<boolean> {
    return Promise.resolve(true);
  }

  rejectQuestion(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listSessionChildren(): Promise<OpenCodeSession[]> {
    return Promise.resolve([]);
  }

  getSessionTodo(): Promise<OpenCodeTodo[]> {
    return Promise.resolve([]);
  }

  getSessionDiff(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  listMessages(): Promise<OpenCodeMessageBundle[]> {
    return Promise.resolve([]);
  }

  listMessagePage(): Promise<OpenCodeMessagePage> {
    return Promise.resolve(clone(COMPLETE_PAGE));
  }

  getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessageBundle> {
    return Promise.resolve({ info: { id: messageId, sessionID: sessionId }, parts: [] });
  }

  listCommands(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  findText(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  findFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }

  findSymbols(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  listFiles(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  readFile(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  getFileStatus(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  listToolIds(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  listTools(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  getLspStatus(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  getFormatterStatus(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  getMcpStatus(): Promise<JsonObject> {
    return Promise.resolve({});
  }

  listAgents(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }

  listModels(): Promise<JsonObject[]> {
    return Promise.resolve([]);
  }
}

/** Narrows an unknown service to the benchmark implementation for orchestration wiring. */
export function isBenchmarkOpenCodeService(value: unknown): value is BenchmarkOpenCodeService {
  return value instanceof BenchmarkOpenCodeService;
}
