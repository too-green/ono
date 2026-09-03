import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parsePowerMetrics } from "./power-sampler.mjs";
import { parseCpuTime, parseProcessList } from "./process-sampler.mjs";
import { performanceMetricDeltas, summarizeCpuProfile } from "./report.mjs";
import { analyzeTape, decodeTimedEvents } from "./tape-analysis.mjs";

test("analyzes prompted sessions, timed SSE events, and workload completion", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-benchmark-runner-"));
  const tapePath = join(directory, "tape.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const frames = [
    'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"busy"}}}\n\n',
    'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","delta":"hello"}}\n\n',
    'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"idle"}}}\n\n',
    'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"busy"}}}\n\n',
    'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"idle"}}}\n\n',
  ];
  const tape = {
    version: 1,
    createdAt: new Date().toISOString(),
    interactions: [
      interaction("POST", "/session/session-1/prompt_async", "end", []),
      interaction("GET", "/event?directory=%2Fvault", "open", frames.map((frame, index) => ({
        atMs: [10, 20, 80, 400, 500][index],
        data: Buffer.from(frame).toString("base64"),
      }))),
    ],
  };
  await writeFile(tapePath, `${JSON.stringify(tape)}\n`);
  const analysis = await analyzeTape(tapePath);
  assert.equal(analysis.promptedSessionCount, 1);
  assert.equal(analysis.completedSessionCount, 1);
  assert.equal(analysis.eventCount, 5);
  assert.equal(analysis.deltaCount, 1);
  assert.equal(analysis.deltaCharacters, 5);
  assert.equal(analysis.workloadDurationMs, 80);
  assert.equal(decodeTimedEvents(tape.interactions[1].response.chunks).length, 5);
});

test("parses process CPU time and stable ps columns", () => {
  assert.equal(parseCpuTime("01:02.50"), 62.5);
  assert.equal(parseCpuTime("1:01:02.50"), 3662.5);
  const processes = parseProcessList("  42   1 01:02.50 1024 /Applications/Obsidian.app/Contents/MacOS/Obsidian --flag\n");
  assert.deepEqual(processes[0], {
    pid: 42,
    ppid: 1,
    cpuSeconds: 62.5,
    rssKb: 1024,
    command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian --flag",
  });
});

test("summarizes powermetrics watts and approximate joules", () => {
  const source = [
    "Clusters Total Power: 1000 mW",
    "GPU Power: 500 mW",
    "Package Power: 2 W",
    "Clusters Total Power: 2000 mW",
    "GPU Power: 1 W",
    "Package Power: 3 W",
  ].join("\n");
  const summary = parsePowerMetrics(source, 2_000);
  assert.equal(summary.available, true);
  assert.equal(summary.cpu.meanWatts, 1.5);
  assert.equal(summary.gpu.meanWatts, 0.75);
  assert.equal(summary.package.approximateJoules, 5);
});

test("computes renderer deltas and sampled CPU self time", () => {
  const deltas = performanceMetricDeltas(
    { TaskDuration: 1, ScriptDuration: 0.5, Nodes: 10 },
    { TaskDuration: 1.25, ScriptDuration: 0.65, Nodes: 14 },
    500,
  );
  assert.equal(deltas.taskDurationMs, 250);
  assert.equal(Math.round(deltas.scriptDurationMs), 150);
  assert.equal(deltas.nodesDelta, 4);
  assert.equal(deltas.mainThreadOccupancyPercent, 50);
  const profile = summarizeCpuProfile({
    nodes: [
      { id: 1, callFrame: { functionName: "(idle)", url: "" } },
      { id: 2, callFrame: { functionName: "render", url: "main.js" } },
    ],
    samples: [1, 2, 2],
    timeDeltas: [1_000, 2_000, 3_000],
  });
  assert.equal(profile.totalSampledMs, 6);
  assert.equal(profile.nonIdleSampledMs, 5);
  assert.equal(profile.topFrames[0].functionName, "render");
});

/** Creates one schema-valid synthetic tape interaction. */
function interaction(method, target, terminal, chunks) {
  return {
    sequence: 0,
    request: {
      method,
      target,
      bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bodyBytes: 0,
    },
    response: {
      statusCode: 200,
      statusMessage: "OK",
      headers: [["content-type", target.startsWith("/event") ? "text/event-stream" : "application/json"]],
      startedAtMs: 0,
      chunks,
      bodyBytes: chunks.reduce((total, chunk) => total + Buffer.from(chunk.data, "base64").length, 0),
      terminal,
      endedAtMs: terminal === "open" ? chunks.at(-1)?.atMs ?? 0 : 0,
      generated: false,
    },
  };
}
