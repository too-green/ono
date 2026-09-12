import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** Streaming parser for powermetrics task tables with explicit `GPU ms/s` columns. */
export class TaskGpuParser {
  constructor(pids) {
    this.pids = [...new Set(pids)];
    this.buffer = "";
    this.current = undefined;
    this.samples = [];
  }

  /** Consumes an arbitrary text chunk from powermetrics stdout. */
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  /** Flushes the final partial line and sample. */
  finish() {
    if (this.buffer) this.consumeLine(this.buffer);
    this.buffer = "";
    this.commitCurrent();
    return this.samples;
  }

  /** Reports whether a finalized or currently open interval contains system GPU activity. */
  hasSystemGpuSample() {
    return Number.isFinite(this.current?.systemGpu.activePercent)
      || this.samples.some((sample) => sample.systemGpuAvailable);
  }

  /** Reduces one text line into the current sample. */
  consumeLine(line) {
    const marker = line.match(/^\*\*\* Sampled system activity \((.+)\) \(([\d.]+)ms elapsed\) \*\*\*$/);
    if (marker) {
      this.commitCurrent();
      const parsedTime = Date.parse(marker[1]);
      this.current = {
        ordinal: this.samples.length,
        sampledAt: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString(),
        elapsedMs: Number(marker[2]),
        hasGpuColumn: false,
        gpuColumnStart: undefined,
        systemGpu: {},
        values: new Map(),
      };
      return;
    }
    if (!this.current) return;
    const activeFrequency = line.match(/^GPU(?: HW)? active frequency:\s*([\d.]+) MHz/);
    if (activeFrequency) {
      this.current.systemGpu.activeFrequencyMHz = Number(activeFrequency[1]);
      return;
    }
    const activeResidency = line.match(/^GPU(?: HW)? active residency:\s*([\d.]+)%/);
    if (activeResidency) {
      this.current.systemGpu.activePercent = Number(activeResidency[1]);
      return;
    }
    const idleResidency = line.match(/^GPU idle residency:\s*([\d.]+)%/);
    if (idleResidency) {
      this.current.systemGpu.idlePercent = Number(idleResidency[1]);
      return;
    }
    const power = line.match(/^GPU Power:\s*([\d.]+)\s*(mW|W)/);
    if (power) {
      this.current.systemGpu.powerMilliwatts = Number(power[1]) * (power[2] === "W" ? 1_000 : 1);
      return;
    }
    if (line.includes("GPU ms/s") && /\bID\b/.test(line)) {
      this.current.hasGpuColumn = true;
      this.current.gpuColumnStart = line.indexOf("GPU ms/s");
      return;
    }
    if (!this.current.hasGpuColumn) return;
    for (const pid of this.pids) {
      const match = line.match(new RegExp(`^\\s*(.*?)\\s+${pid}\\s+(.+?)\\s*$`));
      if (!match) continue;
      const gpuText = line.slice(this.current.gpuColumnStart).trim().split(/\s+/)[0];
      const value = gpuText ? Number(gpuText) : Number.NaN;
      this.current.values.set(pid, {
        name: match[1].trim(),
        gpuMsPerSecond: Number.isFinite(value) ? value : undefined,
      });
    }
  }

  /** Finalizes one interval and computes only the requested direct GPU measurements. */
  commitCurrent() {
    if (!this.current) return;
    const systemGpuActivePercent = this.current.systemGpu.activePercent;
    const processes = this.pids.map((pid) => {
      const value = this.current.values.get(pid);
      const gpuMsPerSecond = value?.gpuMsPerSecond;
      const intervalGpuTimeMs = gpuMsPerSecond === undefined ? undefined : gpuMsPerSecond * this.current.elapsedMs / 1000;
      return {
        pid,
        name: value?.name,
        gpuMsPerSecond,
        intervalGpuTimeMs,
        gpuTimeEquivalentPercent: gpuMsPerSecond === undefined ? undefined : gpuMsPerSecond / 10,
        unavailableReason: gpuMsPerSecond !== undefined
          ? undefined
          : !this.current.hasGpuColumn
            ? "gpu-column-unavailable"
            : value
              ? "gpu-value-invalid"
              : "process-not-listed",
      };
    });
    this.samples.push({
      ordinal: this.current.ordinal,
      sampledAt: this.current.sampledAt,
      elapsedMs: this.current.elapsedMs,
      intervalSincePreviousMs: this.samples.length > 0 ? Date.parse(this.current.sampledAt) - Date.parse(this.samples.at(-1).sampledAt) : undefined,
      gpuColumnAvailable: this.current.hasGpuColumn,
      systemGpuAvailable: Number.isFinite(this.current.systemGpu.activePercent),
      systemGpu: {
        ...this.current.systemGpu,
        activeTimeMs: Number.isFinite(systemGpuActivePercent)
          ? systemGpuActivePercent / 100 * this.current.elapsedMs
          : undefined,
        unavailableReason: Number.isFinite(this.current.systemGpu.activePercent) ? undefined : "gpu-power-sample-unavailable",
      },
      processes,
    });
    this.current = undefined;
  }
}

/** Parses a complete powermetrics text fixture; referenced by tests and offline diagnostics. */
export function parseTaskGpuText(source, pids) {
  const parser = new TaskGpuParser(pids);
  parser.push(source);
  return parser.finish();
}

/** Runs one privileged system GPU stream and preserves its complete raw output. */
export class TaskGpuSampler {
  constructor(pids, rawPath, stderrPath, intervalMs = 1000) {
    this.pids = pids;
    this.rawPath = rawPath;
    this.stderrPath = stderrPath;
    this.intervalMs = intervalMs;
    this.parser = new TaskGpuParser(pids);
    this.child = undefined;
    this.exit = undefined;
    this.rawStream = undefined;
    this.stderrStream = undefined;
  }

  /** Starts line-buffered task/GPU sampling after the caller has authorized sudo. */
  start() {
    this.rawStream = createWriteStream(this.rawPath, { mode: 0o600 });
    this.stderrStream = createWriteStream(this.stderrPath, { mode: 0o600 });
    const args = [
      "/usr/bin/powermetrics",
      "--sample-rate", String(this.intervalMs),
      "--sample-count", "-1",
      "--buffer-size", "1",
      "--samplers", "gpu_power",
      "--handle-invalid-values",
    ];
    // Keep sudo attached to the invoking terminal so macOS can reuse the `sudo -v`
    // authorization ticket; sudo relays the later SIGINT to powermetrics.
    this.child = spawn("/usr/bin/sudo", args, { stdio: ["inherit", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.rawStream.write(chunk);
      this.parser.push(chunk);
    });
    this.child.stderr.on("data", (chunk) => this.stderrStream.write(chunk));
    this.exit = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  /** Waits until powermetrics produces a parseable task interval before replay begins. */
  async waitForFirstSample(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.parser.hasSystemGpuSample()) return;
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error("powermetrics exited before producing a GPU sample. See powermetrics.stderr.txt.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`powermetrics produced no parseable system GPU sample within ${timeoutMs / 1000} seconds.`);
  }

  /** Fails when powermetrics exits unexpectedly during an active recording. */
  assertRunning() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error("powermetrics stopped during the benchmark. See powermetrics.stderr.txt.");
    }
  }

  /** Stops the detached sampler process group and returns normalized per-process intervals. */
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child) return [];
    const stoppedByRecorder = child.exitCode === null && child.signalCode === null;
    if (stoppedByRecorder) {
      child.kill("SIGINT");
    }
    let result;
    let exitError;
    try {
      result = await this.exit;
    } catch (error) {
      exitError = error;
    } finally {
      this.rawStream.end();
      this.stderrStream.end();
      await Promise.all([finished(this.rawStream), finished(this.stderrStream)]);
    }
    const samples = this.parser.finish();
    if (exitError) throw exitError;
    if (!stoppedByRecorder || samples.length === 0) {
      throw new Error(`powermetrics exited unexpectedly with status ${result?.code ?? result?.signal ?? "unknown"}. See powermetrics.stderr.txt.`);
    }
    return samples;
  }
}
