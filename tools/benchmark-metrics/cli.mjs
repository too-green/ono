#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { authorizePowerMetrics } from "../benchmark-runner/power-sampler.mjs";
import { listProcesses, processRole, processTree } from "../benchmark-runner/process-sampler.mjs";
import { FootprintSampler } from "./footprint-sampler.mjs";
import { ObsidianCli } from "./obsidian-cli.mjs";
import { TaskGpuSampler } from "./task-gpu-sampler.mjs";

const execFile = promisify(execFileCallback);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "../..");
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/** Runs one raw benchmark recording from plugin reload through replay completion. */
export async function runBenchmarkMetrics(options) {
  const cli = new ObsidianCli(options.vault);
  await authorizePowerMetrics();
  await cli.reloadPlugin(options.pluginId);
  const ready = await waitForBenchmarkReady(cli, options.pluginId, options.expectedSessions, options.readyTimeoutMs);
  const processes = await listProcesses();
  const targets = discoverTargetProcesses(processes, ready.rendererPid);
  const outputDirectory = join(options.outputRoot, timestamp());
  await mkdir(outputDirectory, { recursive: true });

  const partialSamples = await open(join(outputDirectory, "samples.partial.ndjson"), "w", 0o600);
  const rendererMemorySampler = new FootprintSampler(
    targets.renderer,
    join(outputDirectory, "renderer-footprint.txt"),
    join(outputDirectory, "renderer-footprint.stderr.txt"),
    options.sampleIntervalMs / 1_000,
  );
  const gpuMemorySampler = new FootprintSampler(
    targets.gpu,
    join(outputDirectory, "gpu-footprint.txt"),
    join(outputDirectory, "gpu-footprint.stderr.txt"),
    options.sampleIntervalMs / 1_000,
  );
  const gpuSampler = new TaskGpuSampler(
    [targets.renderer.pid, targets.gpu.pid],
    join(outputDirectory, "powermetrics.txt"),
    join(outputDirectory, "powermetrics.stderr.txt"),
    options.sampleIntervalMs,
  );
  const samples = [];
  let gpuSamples = [];
  let rendererMemorySamples = [];
  let gpuMemorySamples = [];
  let outcome = { status: "running" };
  let terminalError;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    await writePrivateJson(join(outputDirectory, "run-metadata.json"), await buildMetadata(options, targets, ready));
    rendererMemorySampler.start();
    gpuMemorySampler.start();
    gpuSampler.start();
    const firstSampleTimeoutMs = Math.max(5_000, options.sampleIntervalMs * 2);
    await Promise.all([
      rendererMemorySampler.waitForFirstSample(firstSampleTimeoutMs),
      gpuMemorySampler.waitForFirstSample(firstSampleTimeoutMs),
      gpuSampler.waitForFirstSample(firstSampleTimeoutMs),
    ]);
    const statusContext = { cli, options, samples, partialSamples, writeQueue: Promise.resolve() };
    await persistStatusSample(statusContext, await captureStatusSample(statusContext, 0, Date.now()));
    await cli.executeCommand(`${options.pluginId}:opencode-benchmark-start-replay`);
    await recordStatusTimeline({
      ...statusContext,
      collectors: [rendererMemorySampler, gpuMemorySampler, gpuSampler],
      interrupted: () => interrupted,
    });
    outcome = { status: "complete", completedAt: new Date().toISOString() };
  } catch (error) {
    outcome = { status: "failed", failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    terminalError = error;
  } finally {
    const stopped = await Promise.allSettled([
      rendererMemorySampler.stop(),
      gpuMemorySampler.stop(),
      gpuSampler.stop(),
    ]);
    rendererMemorySamples = settledSamples(stopped[0]);
    gpuMemorySamples = settledSamples(stopped[1]);
    gpuSamples = settledSamples(stopped[2]);
    const collectorErrors = stopped.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (collectorErrors.length > 0) {
      terminalError ??= new Error(`Metric collector failure: ${collectorErrors.join("; ")}`);
      outcome = { status: "failed", failedAt: new Date().toISOString(), error: terminalError.message, collectorErrors };
    }
    samples.sort((left, right) => left.ordinal - right.ordinal);
    await partialSamples.close();
    const alignmentToleranceMs = Math.max(2_000, options.sampleIntervalMs * 1.5);
    const aligned = alignMetricSamples(samples, rendererMemorySamples, gpuMemorySamples, gpuSamples, targets, alignmentToleranceMs);
    await writePrivateText(join(outputDirectory, "samples.ndjson"), ndjson(aligned));
    await writePrivateText(join(outputDirectory, "gpu-samples.ndjson"), ndjson(attachSessionStatus(gpuSamples, samples, alignmentToleranceMs)));
    await writePrivateText(join(outputDirectory, "renderer-memory.ndjson"), ndjson(attachSessionStatus(rendererMemorySamples, samples, alignmentToleranceMs)));
    await writePrivateText(join(outputDirectory, "gpu-memory.ndjson"), ndjson(attachSessionStatus(gpuMemorySamples, samples, alignmentToleranceMs)));
    await writePrivateJson(join(outputDirectory, "run-result.json"), {
      schemaVersion: 1,
      ...outcome,
      sampleCount: samples.length,
      gpuSampleCount: gpuSamples.length,
    });
    await rm(join(outputDirectory, "samples.partial.ndjson"), { force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  if (terminalError) throw terminalError;
  return { outputDirectory, sampleCount: samples.length, gpuSampleCount: gpuSamples.length };
}

/** Records one status observation for every nominal second without overlapping native collectors. */
async function recordStatusTimeline(context) {
  const replayStarted = Date.now();
  const pending = new Set();
  let completedAt;
  let lastPhase;
  let ordinal = 1;
  let nextScheduledAt = Date.now();
  const schedule = (scheduledAt) => {
    const currentOrdinal = ordinal;
    ordinal += 1;
    const task = captureStatusSample(context, currentOrdinal, scheduledAt)
      .catch((error) => unavailableStatusSample(currentOrdinal, scheduledAt, error))
      .then(async (sample) => {
        await persistStatusSample(context, sample);
        if (sample.benchmark?.phase) lastPhase = sample.benchmark.phase;
        if (sample.benchmark?.phase === "complete" && completedAt === undefined) completedAt = Date.now();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  const timer = setInterval(() => {
    const now = Date.now();
    while (nextScheduledAt <= now) {
      schedule(nextScheduledAt);
      nextScheduledAt += context.options.sampleIntervalMs;
    }
  }, 100);
  schedule(nextScheduledAt);
  nextScheduledAt += context.options.sampleIntervalMs;
  try {
    while (true) {
      if (context.interrupted()) throw new Error("Benchmark metrics recording interrupted.");
      assertCollectorsRunning(...context.collectors);
      if (completedAt !== undefined && Date.now() - completedAt >= context.options.postRunMs) break;
      if (Date.now() - replayStarted >= context.options.timeoutMs) {
        throw new Error(`Benchmark did not complete within ${context.options.timeoutMs / 1000} seconds (last phase: ${lastPhase ?? "unknown"}).`);
      }
      await delay(100);
    }
  } finally {
    clearInterval(timer);
    await Promise.allSettled(pending);
    await context.writeQueue;
  }
}

/** Captures one authoritative benchmark and per-session status observation. */
async function captureStatusSample(context, ordinal, scheduledAtEpochMs) {
  const startedAtEpochMs = Date.now();
  const startedAtMonotonicNs = process.hrtime.bigint();
  const snapshot = await readBenchmarkSnapshot(context.cli, context.options.pluginId);
  if (snapshot.error || !snapshot.benchmark) throw new Error(snapshot.error ?? "Benchmark status is unavailable.");
  const completedAtEpochMs = Date.now();
  const sample = {
    schemaVersion: 1,
    ordinal,
    scheduledAt: new Date(scheduledAtEpochMs).toISOString(),
    schedulingDelayMs: startedAtEpochMs - scheduledAtEpochMs,
    measuredAt: new Date(Math.round((startedAtEpochMs + completedAtEpochMs) / 2)).toISOString(),
    startedAt: new Date(startedAtEpochMs).toISOString(),
    completedAt: new Date(completedAtEpochMs).toISOString(),
    monotonicStartedNs: startedAtMonotonicNs.toString(),
    durationMs: Number(process.hrtime.bigint() - startedAtMonotonicNs) / 1_000_000,
    benchmark: snapshot.benchmark,
  };
  return sample;
}

/** Creates an explicit unavailable record when one scheduled status query fails. */
function unavailableStatusSample(ordinal, scheduledAtEpochMs, error) {
  const measuredAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    ordinal,
    scheduledAt: new Date(scheduledAtEpochMs).toISOString(),
    schedulingDelayMs: Date.now() - scheduledAtEpochMs,
    measuredAt,
    startedAt: measuredAt,
    completedAt: measuredAt,
    durationMs: 0,
    benchmarkUnavailableReason: error instanceof Error ? error.message : String(error),
  };
}

/** Durably serializes one status sample through the shared append queue. */
async function persistStatusSample(context, sample) {
  context.samples.push(sample);
  context.writeQueue = context.writeQueue.then(() => context.partialSamples.appendFile(`${JSON.stringify(sample)}\n`));
  await context.writeQueue;
  if (sample.benchmark) {
    process.stdout.write(`sample ${sample.ordinal}: ${sample.benchmark.phase}, ${sample.benchmark.sessions.filter((session) => session.status === "busy").length}/${sample.benchmark.sessions.length} busy\n`);
  } else {
    process.stdout.write(`sample ${sample.ordinal}: session status unavailable\n`);
  }
}

/** Verifies that all independent 1 Hz process collectors remain live. */
function assertCollectorsRunning(...collectors) {
  for (const collector of collectors) collector.assertRunning();
}

/** Returns samples from one settled collector without hiding its rejection. */
function settledSamples(result) {
  return result.status === "fulfilled" ? result.value : [];
}

/** Waits for benchmark preparation and validates the fixed workspace leaf count. */
export async function waitForBenchmarkReady(cli, pluginId, expectedSessions, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await readBenchmarkSnapshot(cli, pluginId);
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
      await delay(250);
      continue;
    }
    if (last.benchmark?.phase === "ready") {
      const counts = [last.benchmark.configuredLeaves, last.benchmark.configuredSessions, last.benchmark.sessions?.length];
      if (counts.some((count) => count !== expectedSessions)) {
        throw new Error(`Expected ${expectedSessions} unique open sessions; found ${last.benchmark.configuredLeaves} leaves, ${last.benchmark.configuredSessions} configured sessions, and ${last.benchmark.sessions?.length ?? 0} status records.`);
      }
      return last;
    }
    await delay(250);
  }
  throw new Error(`Benchmark plugin was not ready within ${timeoutMs / 1000} seconds. Last state: ${JSON.stringify(last)}`);
}

/** Reads renderer identity and the benchmark's authoritative per-session status snapshot. */
export function readBenchmarkSnapshot(cli, pluginId) {
  const id = JSON.stringify(pluginId);
  return cli.evaluateJson(`(() => {
    const plugin = globalThis.app?.plugins?.plugins?.[${id}];
    if (!plugin) return { loaded: false, error: ${JSON.stringify(`Plugin ${pluginId} is not loaded.`)} };
    try {
      return { loaded: true, rendererPid: globalThis.process?.pid, benchmark: plugin.getBenchmarkStatus() };
    } catch (error) {
      return { loaded: true, rendererPid: globalThis.process?.pid, error: error instanceof Error ? error.message : String(error) };
    }
  })()`);
}

/** Resolves the exact vault renderer and sole GPU helper under its Obsidian app process. */
export function discoverTargetProcesses(processes, rendererPid) {
  const renderer = processes.find((item) => item.pid === rendererPid);
  if (!renderer || !renderer.command.includes("--type=renderer")) throw new Error(`Renderer PID ${rendererPid} was not found in the Obsidian process list.`);
  const roots = processes.filter((item) => item.command.includes("/Applications/Obsidian.app/Contents/MacOS/Obsidian") && !item.command.includes("--type="));
  const root = roots.find((candidate) => processTree(processes, candidate.pid).some((item) => item.pid === rendererPid));
  if (!root) throw new Error(`Renderer PID ${rendererPid} is not a child of an Obsidian main process.`);
  const tree = processTree(processes, root.pid);
  const gpuProcesses = tree.filter((item) => processRole(item, root.pid) === "gpu");
  if (gpuProcesses.length !== 1) throw new Error(`Expected one Obsidian GPU helper, found ${gpuProcesses.length}.`);
  return {
    main: { pid: root.pid, role: "main", command: root.command },
    renderer: { pid: renderer.pid, role: "renderer", command: renderer.command },
    gpu: { pid: gpuProcesses[0].pid, role: "gpu", command: gpuProcesses[0].command },
  };
}

/** Attaches nearest independent memory and GPU observations to each session-status sample. */
export function alignMetricSamples(samples, rendererMemorySamples, gpuMemorySamples, gpuSamples, targets, toleranceMs = 2_000) {
  return samples.map((sample) => {
    const measuredAt = Date.parse(sample.measuredAt);
    const rendererMemory = alignedSample(rendererMemorySamples, measuredAt, toleranceMs);
    const gpuMemory = alignedSample(gpuMemorySamples, measuredAt, toleranceMs);
    const gpuMeasurement = alignedSample(gpuSamples, measuredAt, toleranceMs);
    const gpuByPid = new Map(gpuMeasurement?.processes?.map((processSample) => [processSample.pid, processSample]) ?? []);
    return {
      ...sample,
      system: {
        gpuMeasurement: gpuMeasurement
          ? { sampledAt: gpuMeasurement.sampledAt, elapsedMs: gpuMeasurement.elapsedMs }
          : { unavailableReason: "no-aligned-powermetrics-sample" },
        gpu: gpuMeasurement?.systemGpu,
      },
      processes: {
        renderer: {
          pid: targets.renderer.pid,
          memoryMeasurement: rendererMemory ? { sampledAt: rendererMemory.sampledAt } : { unavailableReason: "no-aligned-footprint-sample" },
          memory: rendererMemory?.memory,
          gpuMeasurement: gpuMeasurement ? { sampledAt: gpuMeasurement.sampledAt, elapsedMs: gpuMeasurement.elapsedMs } : { unavailableReason: "no-aligned-powermetrics-sample" },
          gpu: gpuByPid.get(targets.renderer.pid),
        },
        gpu: {
          pid: targets.gpu.pid,
          memoryMeasurement: gpuMemory ? { sampledAt: gpuMemory.sampledAt } : { unavailableReason: "no-aligned-footprint-sample" },
          memory: gpuMemory?.memory,
          gpuMeasurement: gpuMeasurement ? { sampledAt: gpuMeasurement.sampledAt, elapsedMs: gpuMeasurement.elapsedMs } : { unavailableReason: "no-aligned-powermetrics-sample" },
          gpu: gpuByPid.get(targets.gpu.pid),
        },
      },
    };
  });
}

/** Associates every GPU interval with the nearest authoritative benchmark/session status. */
export function attachSessionStatus(metricSamples, samples, toleranceMs = 2_000) {
  return metricSamples.map((sample) => {
    const nearest = nearestTimedSample(samples, Date.parse(sample.sampledAt));
    const aligned = Boolean(nearest?.benchmark) && Math.abs(Date.parse(nearest.measuredAt) - Date.parse(sample.sampledAt)) <= toleranceMs;
    return {
      ...sample,
      benchmarkMeasuredAt: aligned ? nearest.measuredAt : undefined,
      benchmark: aligned ? nearest.benchmark : undefined,
      benchmarkUnavailableReason: aligned ? undefined : "no-aligned-session-status-sample",
    };
  });
}

/** Returns a metric observation only when it falls inside the alignment tolerance. */
function alignedSample(samples, targetMs, toleranceMs) {
  const nearest = nearestTimedSample(samples, targetMs);
  return nearest && Math.abs(Date.parse(nearest.sampledAt) - targetMs) <= toleranceMs ? nearest : undefined;
}

/** Finds the closest ISO-timestamped observation without assuming equal sampler cadence. */
function nearestTimedSample(samples, targetMs) {
  let nearest;
  let distance = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const candidateDistance = Math.abs(Date.parse(sample.sampledAt ?? sample.measuredAt) - targetMs);
    if (candidateDistance >= distance) continue;
    nearest = sample;
    distance = candidateDistance;
  }
  return nearest;
}

/** Captures reproducibility metadata without deriving benchmark aggregates. */
async function buildMetadata(options, targets, ready) {
  const [macosVersion, macosBuild, architecture, obsidianVersion, commit, branch, status] = await Promise.all([
    commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    commandOutput("/usr/bin/sw_vers", ["-buildVersion"]),
    commandOutput("/usr/bin/uname", ["-m"]),
    commandOutput("obsidian", ["version", `vault=${options.vault}`]),
    commandOutput("/usr/bin/git", ["rev-parse", "HEAD"], projectRoot),
    commandOutput("/usr/bin/git", ["branch", "--show-current"], projectRoot),
    commandOutput("/usr/bin/git", ["status", "--short"], projectRoot),
  ]);
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    configuration: {
      vault: options.vault,
      pluginId: options.pluginId,
      expectedSessions: options.expectedSessions,
      sampleIntervalMs: options.sampleIntervalMs,
      postRunMs: options.postRunMs,
      timeoutMs: options.timeoutMs,
    },
    environment: { macosVersion, macosBuild, architecture, obsidianVersion },
    git: { commit, branch, dirty: Boolean(status) },
    targets,
    initialBenchmarkStatus: ready.benchmark,
    measurementSemantics: {
      physicalBytes: "macOS phys_footprint for the individual process",
      categories: "Dynamic footprint VM categories; values are not guaranteed to be mutually exclusive across processes",
      systemGpuActivePercent: "System-wide GPU active residency reported by the powermetrics gpu_power sampler",
      systemGpuActiveTimeMs: "System-wide GPU active residency multiplied by the powermetrics interval duration",
      systemGpuPowerMilliwatts: "Estimated system-wide GPU power reported by powermetrics; compare only within the same machine",
    },
  };
}

/** Runs one metadata command and degrades missing context to undefined. */
async function commandOutput(command, args, cwd) {
  try {
    const { stdout } = await execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parses the intentionally fixed single-scenario metrics CLI. */
export function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const args = argv.filter((argument) => argument !== "--");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag ?? "end of input"}.`);
    values.set(flag, value);
  }
  const allowed = new Set(["--vault", "--plugin-id", "--expected-sessions", "--sample-seconds", "--post-seconds", "--timeout-seconds", "--ready-timeout-seconds", "--output"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  return {
    help: false,
    vault: values.get("--vault") ?? "sandbox",
    pluginId: values.get("--plugin-id") ?? "ono",
    expectedSessions: integerOption(values, "--expected-sessions", 6, 1),
    sampleIntervalMs: integerOption(values, "--sample-seconds", DEFAULT_SAMPLE_INTERVAL_MS / 1_000, 1) * 1_000,
    postRunMs: numberOption(values, "--post-seconds", 0, 0) * 1000,
    timeoutMs: numberOption(values, "--timeout-seconds", 3600, 1) * 1000,
    readyTimeoutMs: numberOption(values, "--ready-timeout-seconds", 120, 1) * 1000,
    outputRoot: resolve(values.get("--output") ?? join(projectRoot, ".benchmark-results", "metrics")),
  };
}

/** Parses one bounded integer CLI option. */
function integerOption(values, flag, fallback, minimum) {
  const value = Number(values.get(flag) ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${flag} must be an integer of at least ${minimum}.`);
  return value;
}

/** Parses one bounded numeric CLI option. */
function numberOption(values, flag, fallback, minimum) {
  const value = Number(values.get(flag) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${flag} must be at least ${minimum}.`);
  return value;
}

/** Writes one private JSON artifact. */
function writePrivateJson(filePath, value) {
  return writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Writes one private text artifact. */
function writePrivateText(filePath, value) {
  return writeFile(filePath, value, { mode: 0o600 });
}

/** Serializes records as newline-delimited JSON. */
function ndjson(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

/** Produces a filesystem-safe UTC run directory name. */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Sleeps between absolute sampling deadlines and readiness polls. */
function delay(durationMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

/** Documents the single fixed benchmark recording command. */
function helpText() {
  return `ONO benchmark process metrics\n\nUsage:\n  tools/benchmark-metrics/run.sh [options]\n\nOptions:\n  --vault <name>                 Vault to profile (default: sandbox)\n  --plugin-id <id>               Plugin id (default: ono)\n  --expected-sessions <count>    Required open session leaves (default: 6)\n  --sample-seconds <seconds>     Sampling interval, as a whole number (default: 1)\n  --post-seconds <seconds>       Continue after replay completion (default: 0)\n  --timeout-seconds <seconds>    Replay timeout (default: 3600)\n  --ready-timeout-seconds <n>    Plugin preparation timeout (default: 120)\n  --output <directory>           Artifact root (default: .benchmark-results/metrics)\n`;
}

/** Parses options, executes the recording, and prints its artifact directory. */
async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const result = await runBenchmarkMetrics(options);
  process.stdout.write(`Benchmark metrics: ${result.outputDirectory}\n`);
}

if (resolve(process.argv[1] ?? "") === currentFile) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
