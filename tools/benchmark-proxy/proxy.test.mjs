import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { startRecordProxy, startReplayProxy } from "./proxy.mjs";

test("records private request fingerprints and replays exact HTTP responses", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-proxy-"));
  const tapePath = join(directory, "http-tape.json");
  const observed = { authorization: "", body: "", url: "" };
  const upstream = await startTestServer((request, response) => {
    observed.authorization = String(request.headers.authorization ?? "");
    observed.url = request.url ?? "";
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      observed.body = Buffer.concat(chunks).toString("utf8");
      response.writeHead(206, {
        "content-type": "application/json",
        "x-next-cursor": "cursor-2",
      });
      response.write('{"recorded":');
      setTimeout(() => response.end("true}"), 20);
    });
  });
  context.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const recorder = await startRecordProxy({ upstream: upstream.url, tapePath, port: 0 });
  const requestBody = '{"prompt":"private prompt"}';
  const recordedResponse = await requestBuffer(`${recorder.url}/session/private-id/prompt_async?z=2&a=1&auth_token=private-query-token`, {
    method: "POST",
    headers: {
      authorization: "Basic private-password",
      "content-type": "application/json",
    },
    body: requestBody,
  });
  await recorder.close();

  assert.equal(recordedResponse.statusCode, 206);
  assert.equal(recordedResponse.headers["x-next-cursor"], "cursor-2");
  assert.equal(recordedResponse.body.toString("utf8"), '{"recorded":true}');
  assert.equal(observed.authorization, "Basic private-password");
  assert.equal(observed.body, requestBody);
  assert.match(observed.url, /auth_token=private-query-token/);

  const tapeSource = await readFile(tapePath, "utf8");
  const tape = JSON.parse(tapeSource);
  assert.equal(tape.interactions.length, 1);
  assert.equal(tape.interactions[0].request.bodyBytes, Buffer.byteLength(requestBody));
  assert.match(tape.interactions[0].request.bodySha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(tapeSource, /private prompt|private-password|private-query-token/);

  const replay = await startReplayProxy({ tapePath, port: 0, speed: 10 });
  context.after(() => replay.close());
  const replayedResponse = await requestBuffer(`${replay.url}/session/private-id/prompt_async?a=1&z=2&auth_token=different-token`, {
    method: "POST",
    body: requestBody,
    headers: { "content-type": "application/json" },
  });
  assert.equal(replayedResponse.statusCode, 206);
  assert.equal(replayedResponse.headers["x-next-cursor"], "cursor-2");
  assert.equal(replayedResponse.body.toString("utf8"), '{"recorded":true}');

  const exhausted = await requestBuffer(`${replay.url}/session/private-id/prompt_async?a=1&z=2&auth_token=different-token`, {
    method: "POST",
    body: requestBody,
  });
  assert.equal(exhausted.statusCode, 409);
  assert.doesNotMatch(exhausted.body.toString("utf8"), /private-id|private prompt|a=1/);

  const reset = await requestBuffer(`${replay.url}/__opencode_benchmark/reset`, {
    method: "POST",
    headers: { "x-opencode-benchmark-token": replay.controlToken },
  });
  assert.equal(reset.statusCode, 200);
  const replayedAfterReset = await requestBuffer(`${replay.url}/session/private-id/prompt_async?a=1&z=2&auth_token=different-token`, {
    method: "POST",
    body: requestBody,
  });
  assert.equal(replayedAfterReset.statusCode, 206);
});

test("rebases open SSE recordings at the first prompt and preserves open playback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-open-sse-"));
  const tapePath = join(directory, "open-sse-tape.json");
  let eventResponse;
  const upstream = await startTestServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://test.invalid").pathname;
    if (pathname === "/event") {
      eventResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"server.heartbeat"}\n\n');
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(204);
      response.end();
      setTimeout(() => eventResponse?.write('data: {"type":"message.part.delta","properties":{"delta":"captured"}}\n\n'), 15);
    });
  });
  context.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const recorder = await startRecordProxy({ upstream: upstream.url, tapePath, port: 0 });
  const recordedStream = openStreamingRequest(`${recorder.url}/event?directory=%2Fvault`);
  await recordedStream.waitForText("server.heartbeat");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const promptResponse = await requestBuffer(`${recorder.url}/session/session-id/prompt_async?directory=%2Fvault`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(promptResponse.statusCode, 204);
  await recordedStream.waitForText("captured");
  await recorder.close();

  const tape = JSON.parse(await readFile(tapePath, "utf8"));
  assert.equal(tape.capture.trigger, "first-prompt");
  const eventInteraction = tape.interactions.find((interaction) => interaction.request.target.startsWith("/event?"));
  assert.ok(eventInteraction);
  assert.equal(eventInteraction.response.terminal, "open");
  const eventBytes = Buffer.concat(eventInteraction.response.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8");
  assert.doesNotMatch(eventBytes, /server\.heartbeat/);
  assert.match(eventBytes, /captured/);
  assert.ok(eventInteraction.response.chunks[0].atMs < 100);

  eventInteraction.response.terminal = "pending";
  eventInteraction.response.endedAtMs = null;
  await writeFile(tapePath, `${JSON.stringify(tape, null, 2)}\n`);
  const replay = await startReplayProxy({ tapePath, port: 0, speed: 1, paused: true });
  context.after(() => replay.close());
  const replayedStream = openStreamingRequest(`${replay.url}/event?directory=%2Fvault`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(replayedStream.hasText("captured"), false);
  replay.start();
  await replayedStream.waitForText("captured");
  assert.equal(replayedStream.closed, false);
  const reset = await requestBuffer(`${replay.url}/__opencode_benchmark/reset`, {
    method: "POST",
    headers: { "x-opencode-benchmark-token": replay.controlToken },
  });
  assert.equal(reset.statusCode, 200);
  await replayedStream.waitForClose();
});

test("advances repeated GET snapshots and keeps the final completed response", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-snapshots-"));
  const tapePath = join(directory, "snapshots-tape.json");
  const counts = new Map();
  const upstream = await startTestServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://test.invalid").pathname;
    const count = (counts.get(pathname) ?? 0) + 1;
    counts.set(pathname, count);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ count }));
  });
  context.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const recorder = await startRecordProxy({ upstream: upstream.url, tapePath, port: 0 });
  await requestBuffer(`${recorder.url}/session/status`);
  await requestBuffer(`${recorder.url}/session/status`);
  await requestBuffer(`${recorder.url}/session/session-id/message?limit=30`);
  await requestBuffer(`${recorder.url}/session/session-id/message?limit=30`);
  await recorder.close();

  const replay = await startReplayProxy({ tapePath, port: 0, speed: 100 });
  context.after(() => replay.close());
  const first = await requestBuffer(`${replay.url}/session/status`);
  const second = await requestBuffer(`${replay.url}/session/status`);
  const stable = await requestBuffer(`${replay.url}/session/status`);
  assert.deepEqual([first, second, stable].map((item) => JSON.parse(item.body.toString("utf8")).count), [1, 2, 2]);
  const initialMessages = await requestBuffer(`${replay.url}/session/session-id/message?limit=30`);
  const canonicalRefresh = await requestBuffer(`${replay.url}/session/session-id/message?limit=30`);
  assert.deepEqual(
    [initialMessages, canonicalRefresh].map((item) => JSON.parse(item.body.toString("utf8")).count),
    [1, 1],
  );
});

test("drops closed pre-capture streams and times reconnects from the capture epoch", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-reconnect-"));
  const tapePath = join(directory, "reconnect-tape.json");
  let eventCount = 0;
  const upstream = await startTestServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://test.invalid").pathname;
    if (pathname === "/event") {
      eventCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: {"type":"${eventCount === 1 ? "server.heartbeat" : "message.part.delta"}"}\n\n`);
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(204);
      response.end();
    });
  });
  context.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const recorder = await startRecordProxy({ upstream: upstream.url, tapePath, port: 0 });
  await requestBuffer(`${recorder.url}/event?directory=%2Fvault`);
  await requestBuffer(`${recorder.url}/session/session-id/prompt_async`, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await requestBuffer(`${recorder.url}/event?directory=%2Fvault`);
  await recorder.close();

  const tape = JSON.parse(await readFile(tapePath, "utf8"));
  const events = tape.interactions.filter((interaction) => interaction.request.target.startsWith("/event?"));
  assert.equal(events.length, 1);
  assert.ok(events[0].response.startedAtMs >= 20);
  const eventBytes = Buffer.from(events[0].response.chunks[0].data, "base64").toString("utf8");
  assert.match(eventBytes, /message\.part\.delta/);
  assert.doesNotMatch(eventBytes, /server\.heartbeat/);
});

test("preserves SSE chunk boundaries and relative timing", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-sse-"));
  const tapePath = join(directory, "sse-tape.json");
  const upstream = await startTestServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write('data: {"type":"message.part.delta","properties":{"delta":"a"}}\n\n');
    setTimeout(() => {
      response.write('data: {"type":"message.part.delta","properties":{"delta":"b"}}\n\n');
      response.end();
    }, 35);
  });
  context.after(async () => {
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });

  const recorder = await startRecordProxy({ upstream: upstream.url, tapePath, port: 0 });
  const expected = await requestBuffer(`${recorder.url}/event?directory=%2Fvault`);
  await recorder.close();
  const tape = JSON.parse(await readFile(tapePath, "utf8"));
  const chunks = tape.interactions[0].response.chunks;
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].atMs - chunks[0].atMs >= 20);

  const replay = await startReplayProxy({ tapePath, port: 0, speed: 1 });
  context.after(() => replay.close());
  const startedAt = performance.now();
  const actual = await requestBuffer(`${replay.url}/event?directory=%2Fvault`);
  const durationMs = performance.now() - startedAt;
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.headers["content-type"], "text/event-stream");
  assert.deepEqual(actual.body, expected.body);
  assert.ok(durationMs >= 20);
});

/** Starts an ephemeral loopback HTTP server for black-box proxy tests. */
function startTestServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not expose a TCP address."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        /** Closes all test upstream sockets. */
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

/** Performs one HTTP request and resolves its complete status, headers, and bytes. */
function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? "GET",
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Opens a streaming request with text and close waiters for SSE lifecycle tests. */
function openStreamingRequest(url) {
  const chunks = [];
  const textWaiters = new Set();
  const closeWaiters = new Set();
  const state = {
    closed: false,
    /** Returns whether accumulated response bytes already contain text. */
    hasText(text) {
      return Buffer.concat(chunks).toString("utf8").includes(text);
    },
    /** Resolves when accumulated response bytes contain the requested text. */
    waitForText(text) {
      const current = Buffer.concat(chunks).toString("utf8");
      if (current.includes(text)) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          textWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for streamed text: ${text}`));
        }, 2_000);
        const waiter = { text, resolve, timeout };
        textWaiters.add(waiter);
      });
    },
    /** Resolves after the streaming response closes or errors. */
    waitForClose() {
      if (state.closed) return Promise.resolve();
      return new Promise((resolve) => closeWaiters.add(resolve));
    },
  };
  const request = http.get(url, (response) => {
    response.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      for (const waiter of textWaiters) {
        if (!text.includes(waiter.text)) continue;
        clearTimeout(waiter.timeout);
        textWaiters.delete(waiter);
        waiter.resolve(text);
      }
    });
    response.on("error", close);
    response.on("close", close);
  });
  request.on("error", close);
  return state;

  /** Settles lifecycle waiters when either side closes the stream. */
  function close() {
    if (state.closed) return;
    state.closed = true;
    for (const resolve of closeWaiters) resolve();
    closeWaiters.clear();
  }
}
