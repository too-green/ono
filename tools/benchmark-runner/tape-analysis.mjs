import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadTape } from "../benchmark-proxy/tape-store.mjs";

/** Summarizes deterministic workload size and completion timing from one private tape. */
export async function analyzeTape(filePath) {
  const [source, tape] = await Promise.all([readFile(filePath), loadTape(filePath)]);
  const promptedSessionIds = new Set();
  for (const interaction of tape.interactions) {
    if (interaction.request.method !== "POST") continue;
    const sessionId = promptSessionId(interaction.request.target);
    if (sessionId) promptedSessionIds.add(sessionId);
  }

  const eventCounts = {};
  const busySessions = new Set();
  const completedAtBySession = new Map();
  let eventCount = 0;
  let deltaCount = 0;
  let deltaCharacters = 0;
  let lastWorkEventAtMs = 0;
  for (const interaction of tape.interactions) {
    if (!isEventTarget(interaction.request.target)) continue;
    for (const timedEvent of decodeTimedEvents(interaction.response.chunks)) {
      const event = timedEvent.event;
      eventCount += 1;
      eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      if (event.type !== "server.heartbeat") lastWorkEventAtMs = Math.max(lastWorkEventAtMs, timedEvent.atMs);
      if (event.type === "message.part.delta") {
        deltaCount += 1;
        if (typeof event.properties?.delta === "string") deltaCharacters += event.properties.delta.length;
      }
      const sessionId = eventSessionId(event);
      if (!sessionId || !promptedSessionIds.has(sessionId)) continue;
      const status = event.properties?.status;
      const statusType = typeof status === "object" && status !== null ? status.type : undefined;
      if (event.type === "session.status" && statusType === "busy") busySessions.add(sessionId);
      const completed = event.type === "session.idle" || (event.type === "session.status" && statusType === "idle");
      if (completed && busySessions.has(sessionId) && !completedAtBySession.has(sessionId)) {
        completedAtBySession.set(sessionId, timedEvent.atMs);
      }
    }
  }

  const completedTimes = [...completedAtBySession.values()];
  return {
    schemaVersion: 1,
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
    interactionCount: tape.interactions.length,
    promptedSessionCount: promptedSessionIds.size,
    promptedSessionIds: [...promptedSessionIds],
    completedSessionCount: completedAtBySession.size,
    eventCount,
    eventCounts,
    deltaCount,
    deltaCharacters,
    workloadDurationMs: completedTimes.length > 0 ? Math.max(...completedTimes) : lastWorkEventAtMs,
  };
}

/** Decodes raw timed SSE response chunks into complete OpenCode events. */
export function decodeTimedEvents(chunks) {
  const events = [];
  let buffer = "";
  for (const chunk of chunks ?? []) {
    buffer += Buffer.from(chunk.data, "base64").toString("utf8");
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        if (typeof event?.type === "string") events.push({ atMs: chunk.atMs, event });
      } catch {
        // The production client also drops malformed SSE data frames.
      }
    }
  }
  return events;
}

/** Extracts a prompted session id from an OpenCode async prompt or command route. */
function promptSessionId(target) {
  const pathname = new URL(target, "http://benchmark.invalid").pathname;
  const match = pathname.match(/^\/session\/([^/]+)\/(prompt_async|command)$/);
  return match?.[1];
}

/** Resolves common OpenCode event session-id locations. */
function eventSessionId(event) {
  const properties = event.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (typeof properties.sessionId === "string") return properties.sessionId;
  if (typeof properties.info?.sessionID === "string") return properties.info.sessionID;
  if (typeof properties.part?.sessionID === "string") return properties.part.sessionID;
  return undefined;
}

/** Detects one canonical OpenCode SSE request target. */
function isEventTarget(target) {
  return new URL(target, "http://benchmark.invalid").pathname === "/event";
}
