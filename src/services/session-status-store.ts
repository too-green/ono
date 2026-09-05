import { isAssistantAbortError } from "./assistant-error";
import { logger } from "../logger";
import { isActiveSessionStatus } from "../session-state";
import type { JsonObject, OpenCodeEvent } from "./opencode-types";

/** Canonical runtime status; `payload` retains the full v1 status (including retry info). */
export interface SessionRuntimeStatus {
  payload: JsonObject;
  type: string;
  revision: number;
  /** Directory scope the status was last reported under; raw caller-provided string. */
  directory?: string;
}

/** Callbacks required by `SessionStatusStore`; referenced by OpenCodePlugin wiring. */
export interface SessionStatusStoreDeps {
  /** Invoked once per active→settled transition so completion bookkeeping stays centralized. */
  onTurnSettled?(sessionId: string, directory: string | undefined): void;
}

/** Distinguishes SSE-driven changes from snapshot-driven changes for consumers with origin-sensitive side effects. */
export type SessionStatusOrigin = "event" | "snapshot";

/** Receives canonical status/error-overlay changes; the store stays the only writer of runtime truth. */
export type SessionStatusListener = (sessionId: string, directory: string | undefined, origin: SessionStatusOrigin) => void;

/** Normalizes directory spellings for scope comparison while preserving path case. */
export function sessionStatusDirectoryKey(directory: string | undefined): string {
  if (!directory) return "";
  return directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory;
}

/** Reads the first status-type string from a loosely typed v1 status payload. */
function statusType(status: JsonObject | undefined): string {
  for (const key of ["type", "status", "state"]) {
    const value = status?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "idle";
}

/** Returns whether a status type is one of the terminal run outcomes. */
function isSettledStatus(type: string): boolean {
  return type === "idle" || type === "done" || type === "complete" || type === "completed";
}

/** Compares the retry-relevant payload fields that can change without changing the status type. */
function sameRetryPayload(left: JsonObject | undefined, right: JsonObject | undefined): boolean {
  for (const key of ["attempt", "next", "message"]) {
    if (left?.[key] !== right?.[key]) return false;
  }
  return sameRetryAction(left?.action, right?.action);
}

/** Compares the first-party retry action fields; absent actions only match other absent actions. */
function sameRetryAction(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null) return right === undefined || right === null;
  if (right === undefined || right === null) return false;
  if (typeof left !== "object" || Array.isArray(left) || typeof right !== "object" || Array.isArray(right)) return left === right;
  const leftAction = left as JsonObject;
  const rightAction = right as JsonObject;
  for (const key of ["reason", "provider", "title", "message", "label", "link"]) {
    if (leftAction[key] !== rightAction[key]) return false;
  }
  return true;
}

/** Bounds retained tombstones so forgotten-session guards cannot grow across a long plugin lifetime. */
const TOMBSTONE_LIMIT = 1_000;

/**
 * Single plugin-lifetime owner of canonical session runtime status.
 *
 * OpenCode session IDs are globally unique, so exactly one status entry exists per
 * session ID; `directoryIndex` records each session's current reporting scope so a
 * directory snapshot settles absence to idle only for sessions still reported under
 * that scope. OpenCodePlugin routes its per-directory notification subscriptions into
 * `handleEvent`, and per-view stream fallbacks ingest through `handleStatus`, so every
 * UI surface reads one truth via `statusFor` instead of running independent reconcilers.
 * Successful directory-scoped `GET /session/status` snapshots are applied through
 * `applySnapshot`; callers must skip that call when the GET fails so the cache survives
 * sync failures, and must compare `generation()` afterwards so responses from a replaced
 * server or removed directory are dropped. Forgotten (deleted/archived/moved) sessions
 * keep a tombstone revision so pending in-flight snapshots cannot resurrect them.
 *
 * Session errors are deliberately kept out of runtime status: `markSessionError` and
 * `hasSessionError` expose a small shared overlay (cleared by the next active status)
 * so error badges stay consistent across tabs, panels, and reopens.
 */
export class SessionStatusStore {
  private readonly entries = new Map<string, SessionRuntimeStatus>();
  private readonly directoryIndex = new Map<string, Set<string>>();
  private readonly tombstones = new Map<string, number>();
  private readonly errorSessions = new Set<string>();
  private readonly listeners = new Set<SessionStatusListener>();
  private revisionCounter = 0;
  private generationCounter = 0;

  constructor(private readonly deps: SessionStatusStoreDeps = {}) {}

  /** Subscribes one consumer to canonical status changes and returns its unsubscribe handle. */
  subscribe(listener: SessionStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns the monotonic revision consumers must capture before issuing a status snapshot request. */
  revision(): number {
    return this.revisionCounter;
  }

  /** Returns the lifecycle generation consumers must capture so stale responses can be dropped. */
  generation(): number {
    return this.generationCounter;
  }

  /** Returns the canonical runtime status for one globally unique session ID. */
  statusFor(sessionId: string): SessionRuntimeStatus | undefined {
    return this.entries.get(sessionId);
  }

  /** Returns whether the shared error overlay currently marks a session. */
  hasSessionError(sessionId: string): boolean {
    return this.errorSessions.has(sessionId);
  }

  /** Adds the shared error overlay for one session and notifies consumers once; abort errors never reach here. */
  markSessionError(sessionId: string): void {
    if (!sessionId || this.errorSessions.has(sessionId)) return;
    this.errorSessions.add(sessionId);
    const directory = this.entries.get(sessionId)?.directory;
    this.notify(sessionId, directory, "event");
  }

  /** Reduces one directory-scoped SSE event into the canonical cache; referenced by OpenCodePlugin event routing. */
  handleEvent(directory: string | undefined, event: OpenCodeEvent): void {
    if (!event.properties) return;
    if (event.type === "session.status") {
      const sessionId = this.eventSessionId(event.properties);
      if (sessionId) this.handleStatus(directory, sessionId, this.readObject(event.properties, "status"), "event");
      return;
    }
    if (event.type === "session.idle") {
      const sessionId = this.eventSessionId(event.properties);
      if (sessionId) this.handleStatus(directory, sessionId, undefined, "event");
      return;
    }
    if (event.type === "session.error") {
      const sessionId = this.eventSessionId(event.properties);
      if (sessionId && !isAssistantAbortError(event.properties.error)) this.markSessionError(sessionId);
      return;
    }
    if (event.type === "session.deleted" || event.type === "session.moved" || event.type === "session.next.moved") {
      const sessionId = this.eventSessionId(event.properties);
      if (sessionId) this.forgetSessions([sessionId]);
      return;
    }
    if (event.type === "session.updated") {
      const info = this.readObject(event.properties, "info");
      const sessionId = info ? this.readString(info, ["id", "sessionID", "sessionId"]) : this.eventSessionId(event.properties);
      const time = info?.time;
      if (sessionId && time && typeof time === "object" && !Array.isArray(time) && typeof (time as JsonObject).archived === "number") {
        this.forgetSessions([sessionId]);
      }
    }
  }

  /** Ingests one raw status payload (undefined means idle); shared by SSE routing and per-view stream fallbacks. */
  handleStatus(directory: string | undefined, sessionId: string, status: JsonObject | undefined, origin: SessionStatusOrigin): void {
    this.reduce(directory, sessionId, status, origin);
  }

  /**
   * Applies one successful directory-scoped `GET /session/status` snapshot:
   * sessions absent from the response become idle only when they are still
   * reported under this directory's scope, sessions changed by events newer
   * than `baselineRevision` are preserved, and forgotten sessions cannot be
   * resurrected by a pending response. Callers must skip this call when the
   * GET fails so the cache survives sync failures untouched.
   */
  applySnapshot(directory: string | undefined, statuses: JsonObject, baselineRevision: number): void {
    for (const [sessionId, value] of Object.entries(statuses)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (this.sessionRevision(sessionId) > baselineRevision) continue;
      this.reduce(directory, sessionId, value as JsonObject, "snapshot");
    }
    const key = sessionStatusDirectoryKey(directory);
    for (const sessionId of [...(this.directoryIndex.get(key) ?? [])]) {
      if (Object.prototype.hasOwnProperty.call(statuses, sessionId)) continue;
      if (this.sessionRevision(sessionId) > baselineRevision) continue;
      this.reduce(directory, sessionId, undefined, "snapshot");
    }
  }

  /** Drops canonical statuses and error overlays for deleted, archived, or moved sessions, leaving a tombstone. */
  forgetSessions(sessionIds: Iterable<string>): void {
    const ids = [...sessionIds];
    if (ids.length === 0) return;
    for (const sessionId of ids) {
      this.entries.delete(sessionId);
      this.errorSessions.delete(sessionId);
      if (this.tombstones.has(sessionId)) this.tombstones.delete(sessionId);
      this.tombstones.set(sessionId, ++this.revisionCounter);
      while (this.tombstones.size > TOMBSTONE_LIMIT) {
        const oldest = this.tombstones.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.tombstones.delete(oldest);
      }
    }
    this.pruneIndex(ids);
  }

  /** Drops one directory's scope and any statuses reported only under it; bumps the lifecycle generation. */
  forgetDirectory(directory: string | undefined): void {
    this.generationCounter += 1;
    const key = sessionStatusDirectoryKey(directory);
    const ids = this.directoryIndex.get(key);
    if (!ids) return;
    this.directoryIndex.delete(key);
    for (const sessionId of ids) {
      let indexedElsewhere = false;
      for (const [otherKey, otherIds] of this.directoryIndex) {
        if (otherKey !== key && otherIds.has(sessionId)) {
          indexedElsewhere = true;
          break;
        }
      }
      if (!indexedElsewhere) {
        this.entries.delete(sessionId);
        this.errorSessions.delete(sessionId);
      }
    }
  }

  /** Clears every cached status when the backing server changes or the plugin unloads; bumps the generation. */
  clear(): void {
    this.generationCounter += 1;
    this.entries.clear();
    this.directoryIndex.clear();
    this.tombstones.clear();
    this.errorSessions.clear();
  }

  /** Returns the newest known revision for a session, treating forgotten sessions as newer than any prior snapshot. */
  private sessionRevision(sessionId: string): number {
    return this.entries.get(sessionId)?.revision ?? this.tombstones.get(sessionId) ?? 0;
  }

  /** Removes one session's membership from every scope index, pruning empty index entries. */
  private pruneIndex(sessionIds: Iterable<string>): void {
    const ids = new Set(sessionIds);
    for (const [key, members] of this.directoryIndex) {
      for (const sessionId of ids) members.delete(sessionId);
      if (members.size === 0) this.directoryIndex.delete(key);
    }
  }

  /** Reduces one status into the canonical entry and fires settled/listener callbacks only on real changes. */
  private reduce(directory: string | undefined, sessionId: string, status: JsonObject | undefined, origin: SessionStatusOrigin): void {
    if (!sessionId) return;
    const type = statusType(status);
    const previous = this.entries.get(sessionId);
    const next: SessionRuntimeStatus = { payload: status ?? {}, type, revision: ++this.revisionCounter, directory };
    this.entries.set(sessionId, next);
    this.reindex(sessionId, previous?.directory, directory);
    const clearedError = isActiveSessionStatus(type) && this.errorSessions.delete(sessionId);
    if (previous && previous.type === type && !clearedError && sameRetryPayload(previous.payload, next.payload)) return;
    if (previous && isActiveSessionStatus(previous.type) && isSettledStatus(type)) {
      this.deps.onTurnSettled?.(sessionId, directory);
    }
    this.notify(sessionId, directory, origin);
  }

  /** Moves a session's scope-index membership when its latest reporting directory changes. */
  private reindex(sessionId: string, previousDirectory: string | undefined, directory: string | undefined): void {
    const previousKey = sessionStatusDirectoryKey(previousDirectory);
    const nextKey = sessionStatusDirectoryKey(directory);
    if (previousKey === nextKey) return;
    if (previousKey) {
      const previousScope = this.directoryIndex.get(previousKey);
      previousScope?.delete(sessionId);
      if (previousScope && previousScope.size === 0) this.directoryIndex.delete(previousKey);
    }
    const nextScope = this.directoryIndex.get(nextKey) ?? new Set<string>();
    nextScope.add(sessionId);
    this.directoryIndex.set(nextKey, nextScope);
  }

  /** Fans one change out to listeners, isolating consumer failures from the store. */
  private notify(sessionId: string, directory: string | undefined, origin: SessionStatusOrigin): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId, directory, origin);
      } catch (error) {
        logger.warn("session-status", "status listener failed", { error });
      }
    }
  }

  /** Extracts the owning session id from common v1 event payload locations. */
  private eventSessionId(properties: JsonObject): string | undefined {
    const direct = this.readString(properties, ["sessionID", "sessionId"]);
    if (direct) return direct;
    const info = this.readObject(properties, "info");
    return info ? this.readString(info, ["id", "sessionID", "sessionId"]) : undefined;
  }

  /** Reads a nested object from a loosely typed v1 event payload. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
  }

  /** Reads the first non-empty string from a loosely typed v1 event payload. */
  private readString(source: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  }
}
