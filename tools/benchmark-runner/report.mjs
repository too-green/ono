import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DURATION_METRICS = new Set(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"]);
const REPORT_METRICS = [
  ["Wall duration", "wallDurationMs", "ms"],
  ["Renderer task time", "renderer.taskDurationMs", "ms"],
  ["Renderer scripting", "renderer.scriptDurationMs", "ms"],
  ["Renderer layout", "renderer.layoutDurationMs", "ms"],
  ["Style recalculation", "renderer.recalcStyleDurationMs", "ms"],
  ["Main-thread occupancy", "renderer.mainThreadOccupancyPercent", "%"],
  ["Sampled non-idle CPU", "cpuProfile.nonIdleSampledMs", "ms"],
  ["Obsidian process CPU", "processTree.cpuSeconds", "s"],
  ["Obsidian average CPU", "processTree.averageCpuPercent", "%"],
  ["Obsidian peak RSS", "processTree.peakRssBytes", "bytes"],
  ["Activity Monitor POWER", "activityMonitor.meanPower", "relative"],
  ["Long tasks", "collector.longTasks.count", "count"],
  ["Long-task time", "collector.longTasks.totalMs", "ms"],
  ["Long animation frames", "collector.longAnimationFrames.count", "count"],
  ["Renderer poll timeouts", "completion.rendererPollTimeouts", "count"],
  ["Max renderer poll latency", "completion.maxRendererPollLatencyMs", "ms"],
  ["DOM mutation records", "collector.mutationRecords", "count"],
  ["Peak JS heap", "collector.heapPeakBytes", "bytes"],
  ["System CPU power", "power.cpu.meanWatts", "W"],
  ["System GPU power", "power.gpu.meanWatts", "W"],
  ["Package power", "power.package.meanWatts", "W"],
];

/** Converts CDP Performance metrics arrays into a stable name/value object. */
export function performanceMetricsMap(result) {
  return Object.fromEntries((result.metrics ?? []).map((metric) => [metric.name, metric.value]));
}

/** Computes renderer metric deltas, converting protocol seconds into milliseconds. */
export function performanceMetricDeltas(before, after, wallDurationMs) {
  const deltas = {};
  for (const [name, afterValue] of Object.entries(after)) {
    const beforeValue = before[name];
    if (typeof beforeValue !== "number" || typeof afterValue !== "number") continue;
    const delta = afterValue - beforeValue;
    deltas[name] = DURATION_METRICS.has(name) ? delta * 1000 : delta;
  }
  return {
    raw: deltas,
    taskDurationMs: deltas.TaskDuration ?? 0,
    scriptDurationMs: deltas.ScriptDuration ?? 0,
    layoutDurationMs: deltas.LayoutDuration ?? 0,
    recalcStyleDurationMs: deltas.RecalcStyleDuration ?? 0,
    layoutCount: deltas.LayoutCount ?? 0,
    recalcStyleCount: deltas.RecalcStyleCount ?? 0,
    nodesDelta: deltas.Nodes ?? 0,
    eventListenersDelta: deltas.JSEventListeners ?? 0,
    jsHeapUsedDeltaBytes: deltas.JSHeapUsedSize ?? 0,
    mainThreadOccupancyPercent: wallDurationMs > 0 ? (deltas.TaskDuration ?? 0) * 100 / wallDurationMs : 0,
  };
}

/** Summarizes sampled V8 CPU profile time and its highest self-time frames. */
export function summarizeCpuProfile(profile, topCount = 15) {
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
  const selfMicroseconds = new Map();
  let totalMicroseconds = 0;
  let idleMicroseconds = 0;
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index];
    const delta = deltas[index] ?? 0;
    const node = nodes.get(nodeId);
    totalMicroseconds += delta;
    if (node?.callFrame?.functionName === "(idle)") idleMicroseconds += delta;
    selfMicroseconds.set(nodeId, (selfMicroseconds.get(nodeId) ?? 0) + delta);
  }
  const topFrames = [...selfMicroseconds.entries()]
    .map(([nodeId, microseconds]) => {
      const frame = nodes.get(nodeId)?.callFrame ?? {};
      return {
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "",
        lineNumber: frame.lineNumber,
        selfMs: microseconds / 1000,
      };
    })
    .filter((frame) => frame.functionName !== "(idle)")
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, topCount);
  return {
    sampleCount: samples.length,
    totalSampledMs: totalMicroseconds / 1000,
    idleSampledMs: idleMicroseconds / 1000,
    nonIdleSampledMs: (totalMicroseconds - idleMicroseconds) / 1000,
    topFrames,
  };
}

/** Writes private per-run artifacts plus aggregate JSON and Markdown summaries. */
export async function writeBenchmarkReport(outputDirectory, report, rawProfiles, rawPowerReports) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < report.runs.length; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    await writePrivateJson(join(outputDirectory, `run-${number}.json`), report.runs[index]);
    await writePrivateJson(join(outputDirectory, `cpu-profile-${number}.json`), rawProfiles[index]);
    if (rawPowerReports[index]) await writePrivateText(join(outputDirectory, `powermetrics-${number}.txt`), rawPowerReports[index]);
  }
  const aggregate = { ...report, aggregate: aggregateRuns(report.runs) };
  await writePrivateJson(join(outputDirectory, "summary.json"), aggregate);
  await writePrivateText(join(outputDirectory, "summary.md"), markdownReport(aggregate));
  return aggregate;
}

/** Computes median report values across repeated deterministic runs. */
function aggregateRuns(runs) {
  const medians = {};
  for (const [, path] of REPORT_METRICS) {
    const values = runs.map((run) => readPath(run, path)).filter((value) => typeof value === "number" && Number.isFinite(value));
    if (values.length > 0) medians[path] = median(values);
  }
  return { runCount: runs.length, medians };
}

/** Renders the compact report intended for before/after human comparison. */
function markdownReport(report) {
  const lines = [
    "# OpenCode Streaming Benchmark",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Git: \`${report.git.commit}\` (${report.git.branch}${report.git.dirty ? ", dirty" : ""})`,
    `- Vault: \`${report.configuration.vault}\``,
    `- Tape SHA-256: \`${report.workload.sha256}\``,
    `- Sessions: ${report.workload.promptedSessionCount}`,
    `- SSE events/deltas: ${report.workload.eventCount} / ${report.workload.deltaCount}`,
    `- Runs: ${report.runs.length}`,
    "",
    "| Metric | Median |",
    "|---|---:|",
  ];
  for (const [label, path, unit] of REPORT_METRICS) {
    const value = report.aggregate.medians[path];
    if (value === undefined || (path.startsWith("power.") && !report.runs.some((run) => run.power?.available))) continue;
    lines.push(`| ${label} | ${formatValue(value, unit)} |`);
  }
  lines.push("", "## Top Renderer Frames", "");
  const frames = report.runs[0]?.cpuProfile?.topFrames ?? [];
  if (frames.length === 0) lines.push("No sampled frames.");
  else {
    lines.push("| Function | Self time | Source |", "|---|---:|---|");
    for (const frame of frames.slice(0, 10)) {
      lines.push(`| \`${escapeCell(frame.functionName)}\` | ${formatValue(frame.selfMs, "ms")} | \`${escapeCell(shortSource(frame.url))}\` |`);
    }
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    "- Renderer and process CPU are attributable metrics; lower is better for the same tape.",
    "- Activity Monitor POWER is a relative score, not watts.",
    "- CPU/GPU/package watts are whole-system estimates from powermetrics and include measurement overhead.",
    "- Compare medians from the same tape, speed, vault layout, power mode, and profiler settings.",
    "",
  );
  return lines.join("\n");
}

/** Reads one dotted numeric path from a run object. */
function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

/** Computes the middle value or mean of the two middle values. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Formats report units without implying unsupported precision. */
function formatValue(value, unit) {
  if (unit === "bytes") return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (unit === "count") return String(Math.round(value));
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "W") return `${value.toFixed(3)} W`;
  if (unit === "s") return `${value.toFixed(3)} s`;
  if (unit === "relative") return value.toFixed(2);
  return `${value.toFixed(1)} ${unit}`;
}

/** Shortens source URLs while preserving enough profiler identity for diagnosis. */
function shortSource(url) {
  if (!url) return "";
  return url.length > 90 ? `…${url.slice(-89)}` : url;
}

/** Escapes Markdown table separators in profiler labels. */
function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/`/g, "'");
}

/** Writes one user-only JSON artifact. */
function writePrivateJson(filePath, value) {
  return writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Writes one user-only text artifact. */
function writePrivateText(filePath, value) {
  return writeFile(filePath, value, { mode: 0o600 });
}
