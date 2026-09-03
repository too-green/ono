import { spawn } from "node:child_process";

/** Obtains one administrator authorization before protected power sampling begins. */
export function authorizePowerMetrics() {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Administrator authorization for powermetrics failed.")));
  });
}

/** Captures system CPU/GPU power, thermal state, and per-process energy diagnostics. */
export class PowerMetricsSampler {
  constructor(sampleRateMs = 1000) {
    this.sampleRateMs = sampleRateMs;
    this.child = undefined;
    this.stdout = "";
    this.stderr = "";
    this.startedAt = undefined;
  }

  /** Starts protected powermetrics sampling in its own signalable process group. */
  start() {
    const args = [
      "-n",
      "/usr/bin/powermetrics",
      "--sample-rate", String(this.sampleRateMs),
      "--sample-count", "-1",
      "--buffer-size", "1",
      "--samplers", "tasks,cpu_power,gpu_power,thermal",
      "--show-process-coalition",
      "--show-process-energy",
      "--show-process-gpu",
      "--show-process-samp-norm",
      "--handle-invalid-values",
    ];
    this.startedAt = performance.now();
    this.child = spawn("/usr/bin/sudo", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdout += chunk;
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  /** Stops sampling and returns parsed system power plus the private raw report. */
  async stop() {
    if (!this.child) return { summary: emptyPowerSummary(), raw: "" };
    const child = this.child;
    this.child = undefined;
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
    await waitForChild(child);
    const durationMs = performance.now() - (this.startedAt ?? performance.now());
    return {
      summary: parsePowerMetrics(this.stdout, durationMs, this.stderr),
      raw: `${this.stdout}${this.stderr ? `\n--- stderr ---\n${this.stderr}` : ""}`,
    };
  }
}

/** Parses stable power labels while retaining unsupported details in the raw artifact. */
export function parsePowerMetrics(source, durationMs, stderr = "") {
  const cpu = powerValues(source, /(?:CPU|Clusters Total) Power:\s*([\d.]+)\s*(mW|W)/gi);
  const gpu = powerValues(source, /GPU Power:\s*([\d.]+)\s*(mW|W)/gi);
  const packagePower = powerValues(source, /Package Power:\s*([\d.]+)\s*(mW|W)/gi);
  const thermalStates = [...new Set(
    source
      .split("\n")
      .filter((line) => /thermal pressure|pressure level/i.test(line))
      .map((line) => line.trim())
      .filter(Boolean),
  )];
  return {
    available: cpu.length > 0 || gpu.length > 0 || packagePower.length > 0,
    durationMs,
    cpu: summarizeWatts(cpu, durationMs),
    gpu: summarizeWatts(gpu, durationMs),
    package: summarizeWatts(packagePower, durationMs),
    thermalStates,
    stderr: stderr.trim() || undefined,
  };
}

/** Extracts and normalizes W/mW matches from powermetrics text. */
function powerValues(source, pattern) {
  const values = [];
  for (const match of source.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    values.push(match[2].toLowerCase() === "mw" ? value / 1000 : value);
  }
  return values;
}

/** Computes average, peak, and approximate energy from periodic watt samples. */
function summarizeWatts(values, durationMs) {
  if (values.length === 0) return { sampleCount: 0, meanWatts: 0, peakWatts: 0, approximateJoules: 0 };
  const meanWatts = values.reduce((total, value) => total + value, 0) / values.length;
  return {
    sampleCount: values.length,
    meanWatts,
    peakWatts: Math.max(...values),
    approximateJoules: meanWatts * durationMs / 1000,
  };
}

/** Returns a stable unavailable shape when protected counters were not captured. */
function emptyPowerSummary() {
  return {
    available: false,
    durationMs: 0,
    cpu: summarizeWatts([], 0),
    gpu: summarizeWatts([], 0),
    package: summarizeWatts([], 0),
    thermalStates: [],
  };
}

/** Waits for the detached sampler process group leader to exit. */
function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
