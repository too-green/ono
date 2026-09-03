import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { startReplayProxy } from "../benchmark-proxy/proxy.mjs";
import { installCollectorExpression, readCollectorExpression, stopCollectorExpression } from "./collector-source.mjs";
import {
  launchObsidianForBenchmark,
  quitObsidian,
  readCdpVersion,
  restoreNormalObsidian,
  waitForSessionViews,
  waitForVaultTarget,
} from "./obsidian-launcher.mjs";
import { ActivityMonitorSampler, ProcessTreeSampler } from "./process-sampler.mjs";
import { authorizePowerMetrics, PowerMetricsSampler } from "./power-sampler.mjs";
import {
  performanceMetricDeltas,
  performanceMetricsMap,
  summarizeCpuProfile,
  writeBenchmarkReport,
} from "./report.mjs";
import { analyzeTape } from "./tape-analysis.mjs";

const execFile = promisify(execFileCallback);

/** Runs deterministic replay profiling and restores a normal non-debug Obsidian launch. */
export async function runBenchmark(options, signal) {
  if (process.platform !== "darwin") throw new Error("The automated Obsidian runner currently supports macOS only.");
  const workload = await analyzeTape(options.tapePath);
  const expectedSessions = options.expectedSessions ?? workload.promptedSessionCount;
  if (expectedSessions < 1) throw new Error("The tape contains no recorded prompt sessions.");
  if (options.power) await authorizePowerMetrics();

  let proxy;
  let client;
  let obsidianClosedForBenchmark = false;
  let benchmarkObsidianLaunched = false;
  const rawProfiles = [];
  const rawPowerReports = [];
  const runs = [];
  const git = await readGitMetadata();
  const generatedAt = new Date().toISOString();
  const outputDirectory = join(options.outputRoot, `${fileTimestamp(generatedAt)}-${git.commit.slice(0, 8)}`);

  try {
    throwIfAborted(signal);
    options.onProgress?.("Closing Obsidian gracefully so Electron accepts the debugging port...");
    await quitObsidian();
    obsidianClosedForBenchmark = true;
    proxy = await startReplayProxy({
      tapePath: options.tapePath,
      port: options.replayPort,
      host: "127.0.0.1",
      speed: options.speed,
      paused: true,
    });
    options.onProgress?.(`Launching Obsidian and restoring vault ${options.vault}...`);
    const mainProcess = await launchObsidianForBenchmark(options.vault, options.debugPort);
    benchmarkObsidianLaunched = true;
    const attached = await waitForVaultTarget(options.debugPort, options.vault);
    client = attached.client;
    const [cdpVersion, rendererMetadata] = await Promise.all([
      readCdpVersion(options.debugPort),
      client.evaluate(`({
        title: document.title,
        vault: globalThis.app?.vault?.getName?.() ?? '',
        electron: globalThis.process?.versions?.electron,
        chrome: globalThis.process?.versions?.chrome,
        platform: globalThis.process?.platform
      })`),
    ]);
    await waitForSessionViews(client, expectedSessions);

    for (let index = 0; index < options.iterations; index += 1) {
      throwIfAborted(signal);
      if (index > 0) {
        proxy.reset();
        await client.call("Page.reload", { ignoreCache: true });
        await waitForSessionViews(client, expectedSessions);
      }
      if (options.cooldownMs > 0) {
        options.onProgress?.(`Run ${index + 1}/${options.iterations}: idle cooldown...`);
        await abortableDelay(options.cooldownMs, signal);
      }
      options.onProgress?.(`Run ${index + 1}/${options.iterations}: profiling ${expectedSessions} streamed sessions...`);
      const measured = await measureIteration({
        client,
        proxy,
        workload,
        expectedSessions,
        mainPid: mainProcess.pid,
        options,
        signal,
      });
      runs.push(measured.run);
      rawProfiles.push(measured.rawProfile);
      rawPowerReports.push(measured.rawPower);
    }

    const report = {
      schemaVersion: 1,
      generatedAt,
      git,
      configuration: {
        vault: options.vault,
        iterations: options.iterations,
        replaySpeed: options.speed,
        replayPort: options.replayPort,
        debugPort: options.debugPort,
        expectedSessions,
        cooldownMs: options.cooldownMs,
        settleMs: options.settleMs,
        profilerSamplingIntervalUs: options.profilerSamplingIntervalUs,
        powerMetricsEnabled: options.power,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cdp: cdpVersion,
        renderer: rendererMetadata,
        target: { id: attached.target.id, title: attached.target.title, type: attached.target.type },
      },
      workload,
      runs,
    };
    const aggregate = await writeBenchmarkReport(outputDirectory, report, rawProfiles, rawPowerReports);
    return { outputDirectory, report: aggregate };
  } finally {
    client?.close();
    await proxy?.close().catch(() => undefined);
    if (obsidianClosedForBenchmark) {
      if (benchmarkObsidianLaunched) await quitObsidian().catch(() => undefined);
      if (options.restoreObsidian) await restoreNormalObsidian().catch(() => undefined);
    }
  }
}

/** Measures one replay iteration across renderer, process-tree, and optional power layers. */
async function measureIteration(context) {
  const { client, proxy, workload, expectedSessions, mainPid, options, signal } = context;
  let profilerStarted = false;
  let processSampler;
  let activitySampler;
  let powerSampler;
  let processTree;
  let activityMonitor;
  let powerResult = { summary: { available: false }, raw: "" };
  try {
    await client.call("Performance.enable");
    await client.call("Profiler.enable");
    await client.call("Profiler.setSamplingInterval", { interval: options.profilerSamplingIntervalUs });
    const performanceBefore = performanceMetricsMap(await client.call("Performance.getMetrics"));
    await client.evaluate(installCollectorExpression());
    await client.call("Profiler.start");
    profilerStarted = true;

    processSampler = new ProcessTreeSampler(mainPid, options.processSampleIntervalMs);
    await processSampler.start();
    activitySampler = new ActivityMonitorSampler(processSampler.currentPids());
    activitySampler.start();
    if (options.power) {
      powerSampler = new PowerMetricsSampler(options.powerSampleIntervalMs);
      powerSampler.start();
    }

    const startedAt = performance.now();
    proxy.start();
    const completion = await waitForCompletion({
      client,
      expectedSessions,
      minimumDurationMs: workload.workloadDurationMs / options.speed,
      settleMs: options.settleMs,
      timeoutMs: Math.max(options.timeoutMs, workload.workloadDurationMs / options.speed + 60_000),
      signal,
    });
    await client.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const wallDurationMs = performance.now() - startedAt;
    const collector = await client.evaluate(stopCollectorExpression());
    const performanceAfter = performanceMetricsMap(await client.call("Performance.getMetrics"));
    const profileResult = await client.call("Profiler.stop", {}, 60_000);
    profilerStarted = false;
    [processTree, activityMonitor, powerResult] = await Promise.all([
      processSampler.stop(),
      activitySampler.stop(),
      powerSampler ? powerSampler.stop() : Promise.resolve(powerResult),
    ]);
    const cpuProfile = summarizeCpuProfile(profileResult.profile);
    const renderer = performanceMetricDeltas(performanceBefore, performanceAfter, wallDurationMs);
    return {
      rawProfile: profileResult.profile,
      rawPower: powerResult.raw,
      run: {
        wallDurationMs,
        completion,
        renderer,
        cpuProfile,
        processTree,
        activityMonitor,
        power: powerResult.summary,
        collector,
        normalization: {
          rendererTaskMsPer1000Events: workload.eventCount > 0 ? renderer.taskDurationMs * 1000 / workload.eventCount : 0,
          processCpuMsPer1000Events: workload.eventCount > 0 ? processTree.cpuSeconds * 1_000_000 / workload.eventCount : 0,
          rendererTaskMsPer1000Deltas: workload.deltaCount > 0 ? renderer.taskDurationMs * 1000 / workload.deltaCount : 0,
        },
      },
    };
  } finally {
    if (profilerStarted) await client.call("Profiler.stop", {}, 60_000).catch(() => undefined);
    if (!processTree && processSampler) await processSampler.stop().catch(() => undefined);
    if (!activityMonitor && activitySampler) await activitySampler.stop().catch(() => undefined);
    if (powerSampler && !powerResult.raw) await powerSampler.stop().catch(() => undefined);
  }
}

/** Waits for every recorded session to work, finish, and leave the DOM quiet. */
async function waitForCompletion(context) {
  const startedAt = performance.now();
  const deadline = startedAt + context.timeoutMs;
  let lastState;
  let rendererPollTimeouts = 0;
  let maxRendererPollLatencyMs = 0;
  while (performance.now() < deadline) {
    throwIfAborted(context.signal);
    const pollStartedAt = performance.now();
    try {
      lastState = await context.client.evaluate(readCollectorExpression());
    } catch (error) {
      maxRendererPollLatencyMs = Math.max(maxRendererPollLatencyMs, performance.now() - pollStartedAt);
      if (!isRuntimeEvaluationTimeout(error)) throw error;
      rendererPollTimeouts += 1;
      continue;
    }
    maxRendererPollLatencyMs = Math.max(maxRendererPollLatencyMs, performance.now() - pollStartedAt);
    const elapsedMs = performance.now() - startedAt;
    const quietMs = lastState ? lastState.now - lastState.lastMutationAt : 0;
    if (
      lastState?.busySessionViewsSeen >= context.expectedSessions
      && lastState.currentBusyCount === 0
      && elapsedMs >= context.minimumDurationMs
      && quietMs >= context.settleMs
    ) {
      return {
        kind: "all-recorded-sessions-idle-and-dom-quiet",
        elapsedMs,
        quietMs,
        busySessionViewsSeen: lastState.busySessionViewsSeen,
        rendererPollTimeouts,
        maxRendererPollLatencyMs,
      };
    }
    await abortableDelay(250, context.signal);
  }
  throw new Error(`Benchmark timed out waiting for ${context.expectedSessions} session views to finish. Last state: ${JSON.stringify(lastState)}`);
}

/** Distinguishes temporary main-thread stalls from fatal CDP evaluation failures. */
function isRuntimeEvaluationTimeout(error) {
  return error instanceof Error && error.message === "CDP command timed out: Runtime.evaluate";
}

/** Reads commit identity without mutating repository state. */
async function readGitMetadata() {
  const [{ stdout: commit }, { stdout: branch }, { stdout: status }] = await Promise.all([
    execFile("/usr/bin/git", ["rev-parse", "HEAD"]),
    execFile("/usr/bin/git", ["branch", "--show-current"]),
    execFile("/usr/bin/git", ["status", "--short"]),
  ]);
  return { commit: commit.trim(), branch: branch.trim() || "detached", dirty: Boolean(status.trim()) };
}

/** Produces a filesystem-safe UTC timestamp for benchmark artifact directories. */
function fileTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/[:.]/g, "-");
}

/** Rejects promptly when the user interrupts automated profiling. */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Benchmark interrupted", "AbortError");
}

/** Sleeps without preventing Ctrl-C cleanup. */
function abortableDelay(durationMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Benchmark interrupted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, durationMs);
    signal?.addEventListener("abort", cancel, { once: true });
    function finish() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timeout);
      reject(new DOMException("Benchmark interrupted", "AbortError"));
    }
  });
}
