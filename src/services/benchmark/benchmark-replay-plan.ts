import type { JsonObject, OpenCodeEvent, OpenCodeMessageBundle, OpenCodeSession } from "../opencode/opencode-types";

/** Deterministic pacing options for benchmark replay; every field is optional with a default. */
export interface BenchmarkPlaybackOptions {
  /** Fixed delay in milliseconds between replay rounds, where each round emits one event per active session. */
  stepIntervalMs?: number;
  /** Maximum code points streamed per `message.part.delta` text chunk. */
  textChunkCodePoints?: number;
}

export const DEFAULT_STEP_INTERVAL_MS = 20;
export const DEFAULT_TEXT_CHUNK_CODE_POINTS = 24;

/** One session's captured metadata plus its precomputed directory-scoped event list. */
export interface SessionReplayTimeline {
  session: OpenCodeSession;
  directory?: string;
  events: OpenCodeEvent[];
}

export interface ReplayPlan {
  timelines: SessionReplayTimeline[];
  totalEvents: number;
}

export interface ReplaySessionInput {
  session: OpenCodeSession;
  bundles: OpenCodeMessageBundle[];
}

/** Reads the first string value among loosely typed v1 payload keys. */
function readString(source: JsonObject | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Sorts bundles chronologically with stable id tie-breaking so replay order is deterministic. */
function compareBundles(left: OpenCodeMessageBundle, right: OpenCodeMessageBundle): number {
  const created = (bundle: OpenCodeMessageBundle): number => {
    const time = bundle.info?.time;
    if (!time || typeof time !== "object" || Array.isArray(time)) return 0;
    return typeof (time as JsonObject).created === "number" ? (time as JsonObject).created as number : 0;
  };
  const byTime = created(left) - created(right);
  if (byTime !== 0) return byTime;
  return (readString(left.info, ["id"]) ?? "").localeCompare(readString(right.info, ["id"]) ?? "");
}

/** Builds one session-status event with the payload shape consumed by session status reducers. */
function sessionStatusEvent(sessionId: string, type: string): OpenCodeEvent {
  return { type: "session.status", properties: { sessionID: sessionId, status: { type } } };
}

/** Builds one session-updated event carrying the captured session metadata. */
function sessionUpdatedEvent(session: OpenCodeSession): OpenCodeEvent {
  return { type: "session.updated", properties: { sessionID: session.id, info: clone(session) } };
}

/** Builds one authoritative message.part.updated event, filling missing ownership fields deterministically. */
function partUpdatedEvent(part: JsonObject, sessionId: string, messageId: string | undefined): OpenCodeEvent {
  const prepared = clone(part);
  if (messageId && !readString(prepared, ["messageID", "messageId"])) prepared.messageID = messageId;
  if (!readString(prepared, ["sessionID", "sessionId"])) prepared.sessionID = sessionId;
  return { type: "message.part.updated", properties: { sessionID: sessionId, part: prepared } };
}

/**
 * Returns the streamable `text` payload for one part, or undefined when the part must be
 * emitted as a single authoritative update (non-text, synthetic, ignored, or untargetable).
 */
function streamableTextField(part: JsonObject, sessionId: string, messageId: string | undefined): string | undefined {
  if (!messageId || !readString(part, ["id", "partID", "partId"])) return undefined;
  const type = readString(part, ["type"]);
  if (type !== "text" && type !== "reasoning") return undefined;
  if (part.synthetic === true || part.ignored === true) return undefined;
  const text = readString(part, ["text"]);
  return text ? text : undefined;
}

/**
 * Removes completion metadata (`time.end`) from one captured part so the initial streamed
 * skeleton stays patchable in `StreamController`, which treats a reasoning part with `time.end`
 * as already complete; the authoritative finish event restores the full captured part.
 */
function initialPartSkeleton(part: JsonObject): JsonObject {
  const time = part.time;
  if (!time || typeof time !== "object" || Array.isArray(time) || typeof (time as JsonObject).end !== "number") return part;
  const { end: _end, ...remaining } = time as JsonObject;
  return { ...part, time: remaining };
}

/** Builds the event sub-sequence for one part: empty start, text deltas, or a single full update. */
function partEvents(part: JsonObject, sessionId: string, messageId: string | undefined, chunkCodePoints: number): OpenCodeEvent[] {
  const text = streamableTextField(part, sessionId, messageId);
  if (text === undefined) return [partUpdatedEvent(part, sessionId, messageId)];
  const partId = readString(part, ["id", "partID", "partId"]);
  const events: OpenCodeEvent[] = [partUpdatedEvent({ ...initialPartSkeleton(part), text: "" }, sessionId, messageId)];
  for (const delta of chunkByCodePoints(text, chunkCodePoints)) {
    events.push({
      type: "message.part.delta",
      properties: { sessionID: sessionId, messageID: messageId, partID: partId, field: "text", delta },
    });
  }
  return events;
}

/** Precomputes one session's full deterministic replay timeline from captured bundles. */
function buildSessionTimeline(input: ReplaySessionInput, chunkCodePoints: number): SessionReplayTimeline {
  const sessionId = input.session.id;
  const events: OpenCodeEvent[] = [
    sessionStatusEvent(sessionId, "busy"),
    sessionUpdatedEvent(input.session),
  ];
  const bundles = [...input.bundles].sort(compareBundles);
  for (const bundle of bundles) {
    const messageId = readString(bundle.info, ["id", "messageID", "messageId"]);
    const info = clone(bundle.info);
    if (!readString(info, ["sessionID", "sessionId"])) info.sessionID = sessionId;
    const messageUpdated: OpenCodeEvent = { type: "message.updated", properties: { sessionID: sessionId, info } };
    events.push(messageUpdated);
    // OpenCode persists a submitted user message and each complete part once; only assistant
    // output is subsequently built through deltas and authoritative finish updates.
    if (readString(info, ["role"]) === "user") {
      for (const part of bundle.parts) events.push(partUpdatedEvent(part, sessionId, messageId));
      continue;
    }
    for (const part of bundle.parts) events.push(...partEvents(part, sessionId, messageId, chunkCodePoints));
    // Authoritative finish: full captured parts and message info restore every non-streamed field.
    for (const part of bundle.parts) events.push(partUpdatedEvent(part, sessionId, messageId));
    events.push(messageUpdated);
  }
  events.push(sessionStatusEvent(sessionId, "idle"));
  return { session: input.session, directory: readString(input.session, ["directory"]), events };
}

/**
 * Builds the precomputed replay plan for configured sessions; the replay loop later interleaves
 * these timelines with fixed deterministic round-robin so no event construction happens mid-play.
 */
export function buildReplayPlan(sessions: readonly ReplaySessionInput[], options: { textChunkCodePoints: number }): ReplayPlan {
  const timelines = sessions.map((input) => buildSessionTimeline(input, options.textChunkCodePoints));
  return { timelines, totalEvents: timelines.reduce((sum, timeline) => sum + timeline.events.length, 0) };
}

/** Splits text into fixed-size chunks without splitting Unicode code points. */
export function chunkByCodePoints(text: string, size: number): string[] {
  const limit = Math.max(1, size);
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  for (const codePoint of text) {
    if (count === limit) {
      chunks.push(current);
      current = "";
      count = 0;
    }
    current += codePoint;
    count += 1;
  }
  if (current) chunks.push(current);
  return chunks;
}
