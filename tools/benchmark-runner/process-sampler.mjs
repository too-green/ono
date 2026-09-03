import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OBSIDIAN_EXECUTABLE = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

/** Lists macOS processes with cumulative CPU time for Obsidian tree discovery. */
export async function listProcesses() {
  const { stdout } = await execFile("/bin/ps", ["-ww", "-axo", "pid=,ppid=,time=,rss=,command="], { maxBuffer: 16 * 1024 * 1024 });
  return parseProcessList(stdout);
}

/** Finds the newest Obsidian main process after an automated launch. */
export function findObsidianMainProcess(processes) {
  return processes
    .filter((process) => process.command.includes(OBSIDIAN_EXECUTABLE) && !process.command.includes("--type="))
    .sort((left, right) => right.pid - left.pid)[0];
}

/** Samples cumulative CPU and resident memory for the complete Obsidian process tree. */
export class ProcessTreeSampler {
  constructor(rootPid, intervalMs = 500) {
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.samples = [];
    this.tracked = new Map();
    this.timer = undefined;
    this.sampleInFlight = undefined;
    this.startedAt = undefined;
  }

  /** Captures the initial process counters and begins periodic peak-memory sampling. */
  async start() {
    this.startedAt = performance.now();
    await this.sample(true);
    this.timer = setInterval(() => void this.sample(false), this.intervalMs);
  }

  /** Stops sampling and returns per-role CPU time plus aggregate RSS statistics. */
  async stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.sampleInFlight) await this.sampleInFlight;
    await this.sample(false);
    const durationMs = performance.now() - (this.startedAt ?? performance.now());
    return summarizeTrackedProcesses(this.tracked, this.samples, durationMs);
  }

  /** Returns process ids currently included in the Obsidian tree. */
  currentPids() {
    return this.samples.at(-1)?.pids ?? [];
  }

  /** Captures one non-overlapping process-tree snapshot. */
  sample(initial) {
    if (this.sampleInFlight) return this.sampleInFlight;
    this.sampleInFlight = listProcesses()
      .then((processes) => {
        const tree = processTree(processes, this.rootPid);
        const timestampMs = performance.now() - (this.startedAt ?? performance.now());
        this.samples.push({
          timestampMs,
          rssBytes: tree.reduce((total, process) => total + process.rssKb * 1024, 0),
          pids: tree.map((process) => process.pid),
        });
        for (const process of tree) {
          const existing = this.tracked.get(process.pid);
          if (!existing) {
            this.tracked.set(process.pid, {
              pid: process.pid,
              role: processRole(process, this.rootPid),
              firstCpuSeconds: initial ? process.cpuSeconds : 0,
              lastCpuSeconds: process.cpuSeconds,
              peakRssBytes: process.rssKb * 1024,
            });
            continue;
          }
          existing.lastCpuSeconds = Math.max(existing.lastCpuSeconds, process.cpuSeconds);
          existing.peakRssBytes = Math.max(existing.peakRssBytes, process.rssKb * 1024);
        }
      })
      .finally(() => {
        this.sampleInFlight = undefined;
      });
    return this.sampleInFlight;
  }
}

/** Samples Activity Monitor-style CPU, memory, and relative POWER columns for fixed pids. */
export class ActivityMonitorSampler {
  constructor(pids) {
    this.pids = [...new Set(pids)];
    this.child = undefined;
    this.output = "";
  }

  /** Starts one-second macOS top sampling for the current Obsidian process tree. */
  start() {
    if (this.pids.length === 0) return;
    const args = ["-l", "99999", "-s", "1", "-stats", "pid,command,cpu,mem,power"];
    for (const pid of this.pids) args.push("-pid", String(pid));
    this.child = spawn("/usr/bin/top", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.output += chunk;
    });
  }

  /** Stops top and summarizes non-initial app-level POWER and CPU samples. */
  async stop() {
    if (!this.child) return emptyActivitySummary();
    const child = this.child;
    this.child = undefined;
    child.kill("SIGINT");
    await waitForChild(child);
    return summarizeTopOutput(this.output, new Set(this.pids));
  }
}

/** Parses stable ps columns while preserving spaces in command paths. */
export function parseProcessList(source) {
  const processes = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuSeconds: parseCpuTime(match[3]),
      rssKb: Number(match[4]),
      command: match[5],
    });
  }
  return processes;
}

/** Converts macOS ps CPU-time formats into cumulative seconds. */
export function parseCpuTime(value) {
  const fields = value.split(":").map(Number);
  if (fields.some((field) => !Number.isFinite(field))) return 0;
  if (fields.length === 3) return fields[0] * 3600 + fields[1] * 60 + fields[2];
  if (fields.length === 2) return fields[0] * 60 + fields[1];
  return fields[0] ?? 0;
}

/** Resolves the root and every recursive descendant from one process snapshot. */
function processTree(processes, rootPid) {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (selected.has(process.pid) || !selected.has(process.ppid)) continue;
      selected.add(process.pid);
      changed = true;
    }
  }
  return processes.filter((process) => selected.has(process.pid));
}

/** Classifies Electron helper processes for report aggregation. */
function processRole(process, rootPid) {
  if (process.pid === rootPid) return "main";
  if (process.command.includes("--type=renderer")) return "renderer";
  if (process.command.includes("--type=gpu-process")) return "gpu";
  if (process.command.includes("--type=utility")) return "utility";
  return "helper";
}

/** Aggregates cumulative process counters into app and Electron-role totals. */
function summarizeTrackedProcesses(tracked, samples, durationMs) {
  const byRole = {};
  const processes = [];
  let cpuSeconds = 0;
  for (const process of tracked.values()) {
    const usedCpuSeconds = Math.max(0, process.lastCpuSeconds - process.firstCpuSeconds);
    cpuSeconds += usedCpuSeconds;
    const role = byRole[process.role] ?? { cpuSeconds: 0, peakRssBytes: 0, processCount: 0 };
    role.cpuSeconds += usedCpuSeconds;
    role.peakRssBytes += process.peakRssBytes;
    role.processCount += 1;
    byRole[process.role] = role;
    processes.push({ pid: process.pid, role: process.role, cpuSeconds: usedCpuSeconds, peakRssBytes: process.peakRssBytes });
  }
  return {
    durationMs,
    cpuSeconds,
    averageCpuPercent: durationMs > 0 ? cpuSeconds * 100_000 / durationMs : 0,
    peakRssBytes: Math.max(0, ...samples.map((sample) => sample.rssBytes)),
    endRssBytes: samples.at(-1)?.rssBytes ?? 0,
    processCount: tracked.size,
    byRole,
    processes,
  };
}

/** Parses repeated top tables into aggregate Obsidian CPU and relative POWER samples. */
function summarizeTopOutput(source, expectedPids) {
  const samples = new Map();
  let sampleIndex = 0;
  for (const line of source.split("\n")) {
    if (/^PID\s+COMMAND\s+%CPU\s+MEM\s+POWER/.test(line)) {
      sampleIndex += 1;
      continue;
    }
    const match = line.match(/^\s*(\d+)\s+(.+?)\s+([\d.]+)\s+(\S+)\s+([\d.]+)\s*$/);
    if (!match || sampleIndex <= 1 || !expectedPids.has(Number(match[1]))) continue;
    const sample = samples.get(sampleIndex) ?? { cpuPercent: 0, power: 0, processCount: 0 };
    sample.cpuPercent += Number(match[3]);
    sample.power += Number(match[5]);
    sample.processCount += 1;
    samples.set(sampleIndex, sample);
  }
  const values = [...samples.values()];
  if (values.length === 0) return emptyActivitySummary();
  return {
    sampleCount: values.length,
    meanCpuPercent: mean(values.map((sample) => sample.cpuPercent)),
    peakCpuPercent: Math.max(...values.map((sample) => sample.cpuPercent)),
    meanPower: mean(values.map((sample) => sample.power)),
    peakPower: Math.max(...values.map((sample) => sample.power)),
  };
}

/** Returns a stable empty shape when a run is too short for top's second sample. */
function emptyActivitySummary() {
  return { sampleCount: 0, meanCpuPercent: 0, peakCpuPercent: 0, meanPower: 0, peakPower: 0 };
}

/** Computes one arithmetic mean for report summaries. */
function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Waits for one child process to exit after a sampler signal. */
function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
