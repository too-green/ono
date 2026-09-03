import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

import { createTape, finalizePendingSseResponses, loadTape, TapeWriter } from "./tape-store.mjs";

const CONTROL_PREFIX = "/__opencode_benchmark";
const DEFAULT_HOST = "127.0.0.1";
const MAX_REPLAY_REQUEST_BYTES = 128 * 1024 * 1024;
const SENSITIVE_QUERY_KEYS = new Set(["auth_token"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Starts a loopback proxy that forwards OpenCode traffic and records a private tape. */
export async function startRecordProxy(options) {
  const host = validateHost(options.host ?? DEFAULT_HOST);
  const upstream = validateUpstream(options.upstream);
  const filePath = requireText(options.tapePath, "A tape path is required.");
  await refuseExistingTape(filePath, options.overwrite === true);

  const tape = createTape();
  const writer = new TapeWriter(filePath, tape);
  const controlToken = randomBytes(24).toString("hex");
  const activeRequests = new Set();
  const recordingState = { captureStarted: false, captureStartedAt: undefined };
  let stopping = false;

  await writer.persist();

  const server = http.createServer((request, response) => {
    void handleRecordRequest({
      request,
      response,
      upstream,
      tape,
      writer,
      controlToken,
      activeRequests,
      recordingState,
      isStopping: () => stopping,
    }).catch(() => sendProxyError(response, 500, "Benchmark proxy request failed."));
  });
  await listen(server, options.port ?? 4097, host);

  return {
    mode: "record",
    url: serverUrl(server, host),
    controlToken,
    tape,
    /** Stops forwarding, preserves open SSE state, and flushes the tape. */
    async close() {
      if (stopping) return;
      stopping = true;
      for (const context of activeRequests) {
        context.finalizeBody();
        context.interaction.response.terminal = isEventTarget(context.interaction.request.target) && context.interaction.response.statusCode !== null
          ? "open"
          : "aborted";
        context.interaction.response.endedAtMs = elapsedMs(context.timingStartedAt);
        context.upstreamResponse?.destroy();
        context.upstreamRequest.destroy();
        context.downstream.destroy();
      }
      activeRequests.clear();
      finalizePendingSseResponses(tape);
      await closeServer(server);
      await writer.close();
    },
  };
}

/** Starts a loopback server that replays one recorded OpenCode tape. */
export async function startReplayProxy(options) {
  const host = validateHost(options.host ?? DEFAULT_HOST);
  const filePath = requireText(options.tapePath, "A tape path is required.");
  const speed = validateSpeed(options.speed ?? 1);
  const tape = await loadTape(filePath);
  const catalog = new ReplayCatalog(tape);
  const gate = new ReplayGate(options.paused === true);
  const controlToken = randomBytes(24).toString("hex");
  const activeReplays = new Set();
  let stopping = false;

  const server = http.createServer((request, response) => {
    void handleReplayRequest({
      request,
      response,
      speed,
      catalog,
      gate,
      controlToken,
      activeReplays,
    }).catch(() => sendProxyError(response, 500, "Benchmark replay failed."));
  });
  await listen(server, options.port ?? 4097, host);

  return {
    mode: "replay",
    url: serverUrl(server, host),
    controlToken,
    tape,
    /** Starts paused SSE responses after profiler setup. */
    start() {
      gate.start();
    },
    /** Rewinds request cursors, pauses configured playback, and closes active responses. */
    reset() {
      resetReplayState(catalog, gate, activeReplays);
    },
    /** Stops all scheduled playback and closes the replay server. */
    async close() {
      if (stopping) return;
      stopping = true;
      for (const controller of activeReplays) controller.abort();
      activeReplays.clear();
      await closeServer(server);
    },
  };
}

/** Canonicalizes query ordering so equivalent plugin requests match one tape key. */
export function canonicalRequestTarget(rawTarget = "/") {
  const parsed = new URL(rawTarget, "http://benchmark.invalid");
  const entries = [...parsed.searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value) || left.index - right.index);
  const search = new URLSearchParams();
  for (const entry of entries) {
    search.append(entry.key, SENSITIVE_QUERY_KEYS.has(entry.key.toLowerCase()) ? "[redacted]" : entry.value);
  }
  const query = search.toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

/** Forwards and records one request without retaining its potentially sensitive body. */
async function handleRecordRequest(context) {
  const { request, response, writer, controlToken } = context;
  const controlHandled = await handleRecordControl(
    request,
    response,
    writer,
    context.tape,
    controlToken,
    context.activeRequests,
    context.recordingState,
  );
  if (controlHandled) return;

  if (!context.recordingState.captureStarted && isPromptStartRequest(request)) {
    beginSseCapture(context.activeRequests, context.tape, writer, context.recordingState, "first-prompt");
  }

  const startedAt = performance.now();
  const interaction = createInteraction(request);
  interaction.sequence = context.tape.interactions.length;
  context.tape.interactions.push(interaction);
  writer.schedulePersist();

  const target = upstreamTarget(context.upstream, request.url ?? "/");
  const transport = target.protocol === "https:" ? https : http;
  const upstreamRequest = transport.request(target, {
    method: request.method,
    headers: forwardedRequestHeaders(request.headers, target),
  });
  const active = {
    interaction,
    upstreamRequest,
    upstreamResponse: undefined,
    downstream: response,
    timingStartedAt: isEventTarget(interaction.request.target) && context.recordingState.captureStartedAt !== undefined
      ? context.recordingState.captureStartedAt
      : startedAt,
    finalizeBody: () => undefined,
  };
  context.activeRequests.add(active);

  const bodyHash = createHash("sha256");
  let bodyBytes = 0;
  let bodyFinalized = false;
  active.finalizeBody = () => {
    if (bodyFinalized) return;
    bodyFinalized = true;
    interaction.request.bodySha256 = bodyHash.digest("hex");
    interaction.request.bodyBytes = bodyBytes;
    writer.schedulePersist();
  };

  request.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyHash.update(bytes);
    bodyBytes += bytes.length;
    if (!upstreamRequest.write(bytes)) {
      request.pause();
      upstreamRequest.once("drain", () => request.resume());
    }
  });
  request.on("end", () => {
    active.finalizeBody();
    upstreamRequest.end();
  });
  request.on("aborted", () => upstreamRequest.destroy());
  request.on("error", () => upstreamRequest.destroy());

  upstreamRequest.on("response", (upstreamResponse) => {
    active.upstreamResponse = upstreamResponse;
    recordUpstreamResponse({ ...context, response, interaction, upstreamResponse, active });
  });
  upstreamRequest.on("error", () => {
    if (active.upstreamResponse || active.interaction.response.terminal !== "pending") return;
    active.finalizeBody();
    recordGeneratedError(interaction, response, active.timingStartedAt);
    context.activeRequests.delete(active);
    writer.schedulePersist();
  });
  response.on("close", () => {
    if (response.writableEnded || context.isStopping() || interaction.response.terminal !== "pending") return;
    interaction.response.terminal = "aborted";
    interaction.response.endedAtMs = elapsedMs(active.timingStartedAt);
    active.finalizeBody();
    upstreamResponseDestroy(active);
    context.activeRequests.delete(active);
    writer.schedulePersist();
  });
}

/** Streams one upstream response downstream while capturing exact bytes and arrival times. */
function recordUpstreamResponse(context) {
  const { response, interaction, upstreamResponse, writer, active } = context;
  interaction.response.statusCode = upstreamResponse.statusCode ?? 502;
  interaction.response.statusMessage = upstreamResponse.statusMessage ?? "";
  interaction.response.headers = filteredRawHeaders(upstreamResponse.rawHeaders);
  interaction.response.startedAtMs = elapsedMs(active.timingStartedAt);
  response.writeHead(
    interaction.response.statusCode,
    interaction.response.statusMessage,
    headersForNode(interaction.response.headers),
  );
  writer.schedulePersist();

  upstreamResponse.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    interaction.response.chunks.push({ atMs: elapsedMs(active.timingStartedAt), data: bytes.toString("base64") });
    interaction.response.bodyBytes += bytes.length;
    if (!response.write(bytes)) {
      upstreamResponse.pause();
      response.once("drain", () => upstreamResponse.resume());
    }
    writer.schedulePersist();
  });
  upstreamResponse.on("end", () => {
    interaction.response.terminal = "end";
    interaction.response.endedAtMs = elapsedMs(active.timingStartedAt);
    response.end();
    context.activeRequests.delete(active);
    writer.schedulePersist();
  });
  upstreamResponse.on("aborted", () => finishRecordedFailure(context, "aborted"));
  upstreamResponse.on("error", () => finishRecordedFailure(context, "error"));
}

/** Finalizes a response whose upstream stream terminated before a normal end. */
function finishRecordedFailure(context, terminal) {
  const { interaction, response, active, writer } = context;
  if (interaction.response.terminal !== "pending") return;
  interaction.response.terminal = terminal;
  interaction.response.endedAtMs = elapsedMs(active.timingStartedAt);
  response.destroy();
  context.activeRequests.delete(active);
  writer.schedulePersist();
}

/** Records the proxy's generic 502 when no upstream response was established. */
function recordGeneratedError(interaction, response, startedAt) {
  const body = Buffer.from('{"error":"Benchmark proxy could not reach the upstream server."}\n');
  const atMs = elapsedMs(startedAt);
  interaction.response.statusCode = 502;
  interaction.response.generated = true;
  interaction.response.statusMessage = "Bad Gateway";
  interaction.response.headers = [["content-type", "application/json; charset=utf-8"]];
  interaction.response.startedAtMs = atMs;
  interaction.response.chunks.push({ atMs, data: body.toString("base64") });
  interaction.response.bodyBytes = body.length;
  interaction.response.terminal = "end";
  interaction.response.endedAtMs = atMs;
  if (!response.headersSent) response.writeHead(502, headersForNode(interaction.response.headers));
  response.end(body);
}

/** Matches and replays one request or handles replay control endpoints. */
async function handleReplayRequest(context) {
  const { request, response, catalog, controlToken, activeReplays, gate } = context;
  if (await handleReplayControl(request, response, catalog, gate, controlToken, activeReplays)) return;

  let fingerprint;
  try {
    fingerprint = await fingerprintRequest(request, MAX_REPLAY_REQUEST_BYTES);
  } catch {
    sendProxyError(response, 413, "Benchmark replay request was too large.");
    return;
  }
  const descriptor = {
    method: (request.method ?? "GET").toUpperCase(),
    target: canonicalRequestTarget(request.url),
    bodySha256: fingerprint.sha256,
    bodyBytes: fingerprint.bytes,
  };
  const interaction = catalog.take(descriptor);
  if (!interaction) {
    sendProxyError(response, 409, `No recorded response remains for ${redactedRequestLabel(descriptor)}.`);
    return;
  }
  if (interaction.response.statusCode === null || interaction.response.startedAtMs === null) {
    sendProxyError(response, 409, "The recorded response is incomplete and cannot be replayed.");
    return;
  }

  const controller = new AbortController();
  activeReplays.add(controller);
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    if (isEventTarget(descriptor.target)) await gate.wait(controller.signal);
    await replayInteraction(interaction, response, context.speed, controller.signal);
  } finally {
    activeReplays.delete(controller);
  }
}

/** Reproduces response headers, chunks, timing, and terminal behavior from one interaction. */
async function replayInteraction(interaction, response, speed, signal) {
  const replayStartedAt = performance.now();
  const recorded = interaction.response;
  await waitUntil(replayStartedAt, recorded.startedAtMs / speed, signal);
  if (signal.aborted) return;
  response.writeHead(recorded.statusCode, recorded.statusMessage || undefined, headersForNode(recorded.headers));

  for (const chunk of recorded.chunks) {
    await waitUntil(replayStartedAt, chunk.atMs / speed, signal);
    if (signal.aborted) return;
    await writeWithBackpressure(response, Buffer.from(chunk.data, "base64"), signal);
  }

  const terminalAtMs = (recorded.endedAtMs ?? recorded.chunks.at(-1)?.atMs ?? recorded.startedAtMs) / speed;
  if (recorded.terminal === "end") {
    await waitUntil(replayStartedAt, terminalAtMs, signal);
    if (!signal.aborted) response.end();
    return;
  }
  if (recorded.terminal === "error" || recorded.terminal === "aborted") {
    await waitUntil(replayStartedAt, terminalAtMs, signal);
    if (!signal.aborted) response.destroy();
    return;
  }
  await waitForAbort(signal);
  response.destroy();
}

/** Serves record-mode status and authenticated flush operations. */
async function handleRecordControl(request, response, writer, tape, controlToken, activeRequests, recordingState) {
  const pathname = new URL(request.url ?? "/", "http://benchmark.invalid").pathname;
  if (!pathname.startsWith(CONTROL_PREFIX)) return false;
  request.resume();
  if (request.method === "GET" && pathname === `${CONTROL_PREFIX}/status`) {
    sendJson(response, 200, { mode: "record", interactions: tape.interactions.length, captureStarted: recordingState.captureStarted });
    return true;
  }
  if (request.method === "POST" && pathname === `${CONTROL_PREFIX}/flush`) {
    if (!hasControlToken(request, controlToken)) {
      sendProxyError(response, 403, "Invalid benchmark control token.");
      return true;
    }
    await writer.persist();
    sendJson(response, 200, { flushed: true });
    return true;
  }
  if (request.method === "POST" && pathname === `${CONTROL_PREFIX}/capture`) {
    if (!hasControlToken(request, controlToken)) {
      sendProxyError(response, 403, "Invalid benchmark control token.");
      return true;
    }
    beginSseCapture(activeRequests, tape, writer, recordingState, "manual");
    sendJson(response, 200, { captureStarted: true });
    return true;
  }
  sendProxyError(response, 404, "Unknown benchmark control route.");
  return true;
}

/** Serves replay-mode status and authenticated cursor reset operations. */
async function handleReplayControl(request, response, catalog, gate, controlToken, activeReplays) {
  const pathname = new URL(request.url ?? "/", "http://benchmark.invalid").pathname;
  if (!pathname.startsWith(CONTROL_PREFIX)) return false;
  request.resume();
  if (request.method === "GET" && pathname === `${CONTROL_PREFIX}/status`) {
    sendJson(response, 200, { mode: "replay", playbackStarted: gate.started, ...catalog.status() });
    return true;
  }
  if (request.method === "POST" && pathname === `${CONTROL_PREFIX}/reset`) {
    if (!hasControlToken(request, controlToken)) {
      sendProxyError(response, 403, "Invalid benchmark control token.");
      return true;
    }
    resetReplayState(catalog, gate, activeReplays);
    sendJson(response, 200, { reset: true });
    return true;
  }
  if (request.method === "POST" && pathname === `${CONTROL_PREFIX}/start`) {
    if (!hasControlToken(request, controlToken)) {
      sendProxyError(response, 403, "Invalid benchmark control token.");
      return true;
    }
    gate.start();
    sendJson(response, 200, { playbackStarted: true });
    return true;
  }
  sendProxyError(response, 404, "Unknown benchmark control route.");
  return true;
}

/** Owns the optional start barrier used by automated benchmark profiling. */
class ReplayGate {
  constructor(paused) {
    this.pausedByDefault = paused;
    this.started = !paused;
    this.waiters = new Set();
  }

  /** Releases every event response waiting for the measured workload boundary. */
  start() {
    this.started = true;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  /** Restores the configured initial state between benchmark iterations. */
  reset() {
    this.started = !this.pausedByDefault;
    if (this.started) this.start();
  }

  /** Waits for playback start while respecting response cancellation. */
  wait(signal) {
    if (this.started) return Promise.resolve();
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const release = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        this.waiters.delete(release);
        reject(abortError());
      };
      this.waiters.add(release);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

/** Rewinds deterministic responses and cancels work from the prior replay iteration. */
function resetReplayState(catalog, gate, activeReplays) {
  catalog.reset();
  gate.reset();
  for (const controller of activeReplays) controller.abort();
  activeReplays.clear();
}

/** Indexes recorded responses by deterministic request identity and tracks replay cursors. */
class ReplayCatalog {
  constructor(tape) {
    this.buckets = new Map();
    for (const interaction of tape.interactions) {
      if (typeof interaction.request.bodySha256 !== "string" || interaction.response.generated === true) continue;
      const key = requestKey(interaction.request);
      const bucket = this.buckets.get(key) ?? { interactions: [], cursor: 0 };
      bucket.interactions.push(interaction);
      this.buckets.set(key, bucket);
    }
  }

  /** Returns the next matching response, retaining the final REST GET as a stable snapshot. */
  take(descriptor) {
    const bucket = this.buckets.get(requestKey(descriptor));
    if (!bucket || bucket.interactions.length === 0) return undefined;
    if (descriptor.method === "GET" && isSessionMessageListTarget(descriptor.target)) {
      const initial = bucket.interactions.find((interaction) => interaction.response.terminal === "end");
      if (initial) bucket.cursor = Math.max(bucket.cursor, 1);
      return initial;
    }
    if (bucket.cursor < bucket.interactions.length) {
      const interaction = bucket.interactions[bucket.cursor];
      bucket.cursor += 1;
      return interaction;
    }
    if (descriptor.method === "GET" && !isEventTarget(descriptor.target)) {
      return [...bucket.interactions].reverse().find((interaction) => interaction.response.terminal === "end");
    }
    return undefined;
  }

  /** Rewinds all request buckets for another benchmark run. */
  reset() {
    for (const bucket of this.buckets.values()) bucket.cursor = 0;
  }

  /** Reports aggregate replay progress without exposing recorded paths or payloads. */
  status() {
    let consumed = 0;
    let total = 0;
    for (const bucket of this.buckets.values()) {
      consumed += Math.min(bucket.cursor, bucket.interactions.length);
      total += bucket.interactions.length;
    }
    return { consumed, total };
  }
}

/** Creates one mutable tape interaction before the upstream response arrives. */
function createInteraction(request) {
  return {
    sequence: -1,
    request: {
      method: (request.method ?? "GET").toUpperCase(),
      target: canonicalRequestTarget(request.url),
      bodySha256: null,
      bodyBytes: 0,
    },
    response: {
      statusCode: null,
      statusMessage: "",
      headers: [],
      startedAtMs: null,
      chunks: [],
      bodyBytes: 0,
      terminal: "pending",
      endedAtMs: null,
      generated: false,
    },
  };
}

/** Hashes a replay request body without retaining private prompt content. */
function fingerprintRequest(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    request.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maximumBytes) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
      hash.update(data);
    });
    request.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
    request.on("aborted", () => reject(new Error("request aborted")));
    request.on("error", reject);
  });
}

/** Builds the exact request identity shared by recording and replay lookup. */
function requestKey(request) {
  return JSON.stringify([request.method, request.target, request.bodySha256, request.bodyBytes]);
}

/** Removes credentials and connection-specific headers before forwarding upstream. */
function forwardedRequestHeaders(headers, target) {
  const forwarded = {};
  const excluded = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaderTokens(headers.connection)]);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || excluded.has(name.toLowerCase()) || name.toLowerCase() === "host") continue;
    forwarded[name] = value;
  }
  forwarded.host = target.host;
  return forwarded;
}

/** Filters raw upstream headers while preserving duplicate end-to-end values. */
function filteredRawHeaders(rawHeaders) {
  const headers = [];
  const connectionValues = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "connection" && rawHeaders[index + 1] !== undefined) connectionValues.push(rawHeaders[index + 1]);
  }
  const excluded = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaderTokens(connectionValues)]);
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!name || value === undefined || excluded.has(name.toLowerCase())) continue;
    headers.push([name, value]);
  }
  return headers;
}

/** Converts stored header pairs into Node's duplicate-aware response header shape. */
function headersForNode(pairs) {
  const headers = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    const current = headers[key];
    if (current === undefined) headers[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else headers[key] = [current, value];
  }
  return headers;
}

/** Resolves an incoming proxy path against the configured upstream origin. */
function upstreamTarget(upstream, rawTarget) {
  const incoming = new URL(rawTarget, "http://benchmark.invalid");
  const target = new URL(upstream.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

/** Returns a redacted route label suitable for local mismatch diagnostics. */
function redactedRequestLabel(descriptor) {
  const pathname = new URL(descriptor.target, "http://benchmark.invalid").pathname;
  const segments = pathname.split("/").map((segment, index, all) => {
    if (index === 0 || !segment) return segment;
    const parent = all[index - 1];
    if (parent === "session" || parent === "permission" || parent === "question" || parent === "message") return ":id";
    return segment;
  });
  return `${descriptor.method} ${segments.join("/")}`;
}

/** Drops pre-benchmark SSE bytes and rebases active event timing to the capture trigger. */
function beginSseCapture(activeRequests, tape, writer, recordingState, trigger) {
  const startedAt = performance.now();
  recordingState.captureStarted = true;
  recordingState.captureStartedAt = startedAt;
  tape.capture = { trigger };
  const retainedEventInteractions = new Set(
    [...activeRequests]
      .filter((active) => isEventTarget(active.interaction.request.target))
      .map((active) => active.interaction),
  );
  tape.interactions = tape.interactions.filter((interaction) => {
    return !isEventTarget(interaction.request.target) || retainedEventInteractions.has(interaction);
  });
  tape.interactions.forEach((interaction, sequence) => {
    interaction.sequence = sequence;
  });
  for (const active of activeRequests) {
    if (!isEventTarget(active.interaction.request.target)) continue;
    active.timingStartedAt = startedAt;
    active.interaction.response.startedAtMs = active.interaction.response.statusCode === null ? null : 0;
    active.interaction.response.chunks = [];
    active.interaction.response.bodyBytes = 0;
    active.interaction.response.endedAtMs = null;
    active.interaction.response.terminal = "pending";
  }
  writer.schedulePersist();
}

/** Detects the first prompt submission used to start automatic SSE capture timing. */
function isPromptStartRequest(request) {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url ?? "/", "http://benchmark.invalid").pathname;
  return /^\/session\/[^/]+\/(prompt_async|command)$/.test(pathname);
}

/** Extracts extension header names nominated by one HTTP Connection header. */
function connectionHeaderTokens(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => typeof item === "string")
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Waits until one absolute replay offset or rejects when playback is cancelled. */
function waitUntil(startedAt, offsetMs, signal) {
  return delay(Math.max(0, startedAt + offsetMs - performance.now()), signal);
}

/** Provides an abort-aware timeout used by deterministic playback. */
function delay(durationMs, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, durationMs);
    signal.addEventListener("abort", cancel, { once: true });
    function finish() {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timeout);
      reject(abortError());
    }
  });
}

/** Waits for cancellation while an originally open SSE recording remains connected. */
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

/** Writes one replay chunk and honors downstream backpressure. */
function writeWithBackpressure(response, chunk, signal) {
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    response.once("drain", finish);
    signal.addEventListener("abort", cancel, { once: true });
    function finish() {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      response.removeListener("drain", finish);
      reject(abortError());
    }
  });
}

/** Produces the standard cancellation error used by replay timing helpers. */
function abortError() {
  return new DOMException("Replay aborted", "AbortError");
}

/** Reads and compares the random token protecting state-changing control routes. */
function hasControlToken(request, controlToken) {
  return request.headers["x-opencode-benchmark-token"] === controlToken;
}

/** Sends a small JSON control response. */
function sendJson(response, statusCode, payload) {
  if (response.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Sends a body-free-of-private-data proxy error if the response is still writable. */
function sendProxyError(response, statusCode, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, statusCode, { error: message });
}

/** Detects the long-lived OpenCode SSE route from a canonical target. */
function isEventTarget(target) {
  return new URL(target, "http://benchmark.invalid").pathname === "/event";
}

/** Detects canonical session message-list reads that must stay at pre-turn state. */
function isSessionMessageListTarget(target) {
  const pathname = new URL(target, "http://benchmark.invalid").pathname;
  return /^\/session\/[^/]+\/message$/.test(pathname);
}

/** Safely tears down the upstream side of an aborted downstream request. */
function upstreamResponseDestroy(active) {
  active.upstreamResponse?.destroy();
  active.upstreamRequest.destroy();
}

/** Returns monotonic milliseconds rounded only to keep tapes reasonably compact. */
function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

/** Refuses accidental overwrite of a private benchmark recording. */
async function refuseExistingTape(filePath, overwrite) {
  if (overwrite) return;
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error(`Tape already exists: ${filePath}. Pass --overwrite to replace it.`);
}

/** Validates the upstream protocol and strips any path unsupported by OpenCode clients. */
function validateUpstream(value) {
  const upstream = new URL(requireText(value, "An upstream URL is required."));
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("Upstream URL must use http or https.");
  }
  return upstream;
}

/** Restricts the benchmark service to loopback interfaces. */
function validateHost(host) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Benchmark proxy must bind to a loopback host.");
  }
  return host;
}

/** Validates the positive playback speed multiplier. */
function validateSpeed(speed) {
  const numeric = Number(speed);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("Replay speed must be a positive number.");
  return numeric;
}

/** Requires a non-empty CLI or programmatic text option. */
function requireText(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

/** Starts an HTTP server and contains startup errors in one promise. */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** Builds the reachable loopback URL from a listening server address. */
function serverUrl(server, fallbackHost) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark proxy did not expose a TCP address.");
  const host = address.family === "IPv6" ? `[${address.address}]` : (address.address || fallbackHost);
  return `http://${host}:${address.port}`;
}

/** Closes listening and active sockets without waiting on open SSE responses. */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}
