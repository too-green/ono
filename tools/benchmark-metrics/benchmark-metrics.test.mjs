import assert from "node:assert/strict";
import test from "node:test";

import { parseFootprint } from "../benchmark-runner/macos-memory.mjs";
import {
  alignMetricSamples,
  attachSessionStatus,
  discoverTargetProcesses,
  parseArguments,
  waitForBenchmarkReady,
} from "./cli.mjs";
import { FootprintStreamParser } from "./footprint-sampler.mjs";
import { parseObsidianEvalJson } from "./obsidian-cli.mjs";
import { createMetricsTable, serializeCsv } from "./plot-report.mjs";
import { parseTaskGpuText, TaskGpuParser } from "./task-gpu-sampler.mjs";

test("parses complete footprint totals and dynamic wired categories", () => {
  const source = [
    "Obsidian Helper (Renderer) [42]: 64-bit    Footprint: 261130160 B (16384 bytes per page)",
    "156581888 B    22331392 B           0 B     9830400 B           0 B      12421    app-specific tag 16",
    "261130160 B    57376768 B    65372160 B    15220736 B           0 B      22676    TOTAL",
    "    phys_footprint: 261162928 B",
    "    phys_footprint_peak: 352864176 B",
  ].join("\n");

  assert.deepEqual(parseFootprint(source), {
    footprintBytes: 261130160,
    dirtyBytes: 261130160,
    swappedBytes: 57376768,
    cleanBytes: 65372160,
    reclaimableBytes: 15220736,
    wiredBytes: 0,
    regions: 22676,
    physicalBytes: 261162928,
    peakPhysicalBytes: 352864176,
    categories: [{
      dirtyBytes: 156581888,
      swappedBytes: 22331392,
      cleanBytes: 0,
      reclaimableBytes: 9830400,
      wiredBytes: 0,
      regions: 12421,
      category: "app-specific tag 16",
    }],
  });
});

test("parses repeated footprint reports using their native timestamps", () => {
  const parser = new FootprintStreamParser({ pid: 42, role: "renderer" });
  parser.push("Time: 2026-09-11 12:00:01.000+00:00\nRenderer [42]: Footprint: 100 B\n    phys_footprint: 90 B\n");
  parser.push("    phys_footprint_peak: 110 B\nTime: 2026-09-11 12:00:02.000+00:00\nRenderer [42]: Footprint: 120 B\n    phys_footprint: 115 B\n    phys_footprint_peak: 125 B\n");
  const samples = parser.finish();

  assert.equal(samples.length, 2);
  assert.equal(samples[0].sampledAt, "2026-09-11T12:00:01.000Z");
  assert.equal(samples[0].memory.physicalBytes, 90);
  assert.equal(samples[1].memory.peakPhysicalBytes, 125);
});

test("scales footprint cadence checks to the configured interval", () => {
  const parser = new FootprintStreamParser({ pid: 42, role: "renderer" }, 5);
  parser.push("Time: 2026-09-11 12:00:01.000+00:00\nRenderer [42]: Footprint: 100 B\n    phys_footprint: 90 B\n    phys_footprint_peak: 110 B\n");
  parser.push("Time: 2026-09-11 12:00:06.000+00:00\nRenderer [42]: Footprint: 120 B\n    phys_footprint: 115 B\n    phys_footprint_peak: 125 B\n");
  const samples = parser.finish();

  assert.equal(samples[1].intervalSincePreviousMs, 5_000);
  assert.equal(samples[1].cadenceDelayed, false);
});

test("parses per-process GPU interval time and equivalent percentage", () => {
  const header = "Name                               ID     CPU ms/s  User%  Deadlines (<2 ms, 2-5 ms)  Wakeups (Intr, Pkg idle)  GPU ms/s";
  const gpuColumnStart = header.indexOf("GPU ms/s");
  const source = [
    "*** Sampled system activity (Fri Sep 11 12:00:01 2026 +0000) (1000.00ms elapsed) ***",
    header,
    `${"Obsidian Helper (Renderer)        101 10.00".padEnd(gpuColumnStart)}25.00`,
    `${"Obsidian Helper (GPU)             202 20.00".padEnd(gpuColumnStart)}50.00`,
    "*** Sampled system activity (Fri Sep 11 12:00:02 2026 +0000) (500.00ms elapsed) ***",
    header,
    `${"Obsidian Helper (GPU)             202 20.00".padEnd(gpuColumnStart)}10.00`,
  ].join("\n");
  const samples = parseTaskGpuText(source, [101, 202]);

  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0].processes[0], {
    pid: 101,
    name: "Obsidian Helper (Renderer)",
    gpuMsPerSecond: 25,
    intervalGpuTimeMs: 25,
    gpuTimeEquivalentPercent: 2.5,
    unavailableReason: undefined,
  });
  assert.equal(samples[1].processes[0].unavailableReason, "process-not-listed");
  assert.equal(samples[1].processes[1].intervalGpuTimeMs, 5);
});

test("reads GPU time from its header column instead of adjacent task metrics", () => {
  const source = [
    "*** Sampled system activity (Fri Sep 11 12:00:01 2026 +0000) (1000.00ms elapsed) ***",
    "Name                               ID     CPU ms/s  User%  Deadlines (<2 ms, 2-5 ms)  Wakeups (Intr, Pkg idle)  GPU ms/s  Energy",
    "Obsidian Helper (GPU)              202    235.32    61.90  2.91    0.00               195.20  9.00              0.00      91.00",
    "GPU HW active frequency: 612 MHz",
    "GPU HW active residency:  23.28% (444 MHz: 3.4% 612 MHz: 19.88%)",
    "GPU idle residency:  76.72%",
    "GPU Power: 197 mW",
  ].join("\n");

  const [sample] = parseTaskGpuText(source, [202]);

  assert.equal(sample.processes[0].gpuMsPerSecond, 0);
  assert.equal(sample.systemGpuAvailable, true);
  assert.deepEqual(sample.systemGpu, {
    activeFrequencyMHz: 612,
    activePercent: 23.28,
    idlePercent: 76.72,
    powerMilliwatts: 197,
    activeTimeMs: 232.8,
    unavailableReason: undefined,
  });
});

test("makes an open system GPU interval available to the readiness check", () => {
  const parser = new TaskGpuParser([202]);
  parser.push([
    "*** Sampled system activity (Fri Sep 11 12:00:01 2026 +0000) (5000.00ms elapsed) ***",
    "GPU HW active residency:  23.96% (389 MHz: 20%)",
    "",
  ].join("\n"));

  assert.equal(parser.samples.length, 0);
  assert.equal(parser.hasSystemGpuSample(), true);
});

test("resolves the renderer and sole GPU helper from one Obsidian process tree", () => {
  const processes = [
    { pid: 10, ppid: 1, command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" },
    { pid: 11, ppid: 10, command: "Obsidian Helper --type=gpu-process" },
    { pid: 12, ppid: 10, command: "Obsidian Helper --type=renderer" },
    { pid: 20, ppid: 1, command: "/Applications/Other.app/Contents/MacOS/Other" },
  ];

  assert.deepEqual(discoverTargetProcesses(processes, 12), {
    main: { pid: 10, role: "main", command: processes[0].command },
    renderer: { pid: 12, role: "renderer", command: processes[2].command },
    gpu: { pid: 11, role: "gpu", command: processes[1].command },
  });
});

test("aligns GPU measurements and session state by timestamp", () => {
  const benchmark = { phase: "playing", sessions: [{ sessionId: "ses-a", status: "busy" }] };
  const samples = [{
    measuredAt: "2026-09-11T12:00:01.100Z",
    benchmark,
    processes: { renderer: { pid: 101 }, gpu: { pid: 202 } },
  }];
  const gpuSamples = [{
    sampledAt: "2026-09-11T12:00:01.000Z",
    elapsedMs: 1000,
    systemGpu: { activePercent: 12.5 },
    processes: [{ pid: 101, gpuMsPerSecond: 4 }, { pid: 202, gpuMsPerSecond: 8 }],
  }];

  const memorySamples = [{ sampledAt: "2026-09-11T12:00:01.050Z", pid: 101, memory: { physicalBytes: 100 } }];
  const targets = { renderer: { pid: 101 }, gpu: { pid: 202 } };
  const aligned = alignMetricSamples(samples, memorySamples, [], gpuSamples, targets);
  assert.equal(aligned[0].processes.renderer.gpu.gpuMsPerSecond, 4);
  assert.equal(aligned[0].processes.gpu.gpu.gpuMsPerSecond, 8);
  assert.equal(aligned[0].system.gpu.activePercent, 12.5);
  assert.equal(aligned[0].processes.renderer.memory.physicalBytes, 100);
  assert.equal(aligned[0].processes.gpu.memoryMeasurement.unavailableReason, "no-aligned-footprint-sample");
  assert.deepEqual(attachSessionStatus(gpuSamples, samples)[0].benchmark, benchmark);
});

test("flattens aligned samples into one CSV table", () => {
  const samples = [{
    measuredAt: "2026-09-11T12:00:01.000Z",
    benchmark: {
      phase: "playing",
      totalEvents: 20,
      emittedEvents: 10,
      sessions: [{ sessionId: "ses-a", status: "busy", totalEvents: 10, emittedEvents: 5 }],
    },
    system: { gpuMeasurement: { elapsedMs: 5_000 }, gpu: { activePercent: 12.5 } },
    processes: {
      renderer: {
        memory: {
          physicalBytes: 100,
          categories: [{ category: "MALLOC, metadata", dirtyBytes: 50 }],
        },
      },
    },
  }];

  const table = createMetricsTable(samples);
  const csv = serializeCsv(table);

  assert.equal(table.rows[0]["benchmark.replayProgressPercent"], 50);
  assert.equal(table.rows[0]["benchmark.sessions.session_1.progressPercent"], 50);
  assert.equal(table.rows[0]["benchmark.sessions.session_1.busy"], 1);
  assert.equal(table.rows[0]["system.gpu.activePercent"], 12.5);
  assert.equal(table.rows[0]["system.gpu.activeTimeMs"], 625);
  assert.match(csv, /"processes\.renderer\.memory\.categories\.MALLOC, metadata\.dirtyBytes"/);
});

test("parses Obsidian eval JSON and fixed-scenario defaults", () => {
  assert.deepEqual(parseObsidianEvalJson('{"phase":"ready"}'), { phase: "ready" });
  assert.deepEqual(parseObsidianEvalJson('=> {"phase":"ready"}'), { phase: "ready" });
  assert.deepEqual(parseObsidianEvalJson('"{\\"phase\\":\\"ready\\"}"'), { phase: "ready" });
  const options = parseArguments([]);
  assert.equal(options.vault, "sandbox");
  assert.equal(options.expectedSessions, 6);
  assert.equal(options.sampleIntervalMs, 1_000);
  assert.equal(options.postRunMs, 0);
  assert.equal(parseArguments(["--sample-seconds", "5"]).sampleIntervalMs, 5_000);
  assert.equal(parseArguments(["--vault", "sandbox-ono", "--", "--sample-seconds", "5"]).sampleIntervalMs, 5_000);
  assert.throws(() => parseArguments(["--sample-seconds", "1.5"]), /integer of at least 1/);
  assert.throws(() => parseArguments(["--sample-seconds", "0"]), /integer of at least 1/);
  assert.throws(() => parseArguments(["--expected-sessions", "0"]), /at least 1/);
  assert.throws(() => parseArguments(["--scenario", "other"]), /Unknown option/);
});

test("waits for ready and rejects an unexpected workspace session count", async () => {
  const ready = {
    loaded: true,
    rendererPid: 12,
    benchmark: {
      phase: "ready",
      configuredLeaves: 6,
      configuredSessions: 6,
      sessions: Array.from({ length: 6 }, (_, index) => ({ sessionId: `ses-${index}`, status: "idle" })),
    },
  };
  let calls = 0;
  const cli = {
    evaluateJson: async () => {
      calls += 1;
      return calls === 1 ? { loaded: true, error: "plugin.getBenchmarkStatus is not a function" } : ready;
    },
  };
  await assert.doesNotReject(waitForBenchmarkReady(cli, "ono", 6, 500));
  assert.equal(calls, 2);
  await assert.rejects(waitForBenchmarkReady(cli, "ono", 5, 100), /Expected 5 unique open sessions/);
});
