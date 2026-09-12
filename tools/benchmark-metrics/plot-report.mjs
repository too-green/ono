#!/usr/bin/env node

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "../..");
const metricsRoot = join(projectRoot, ".benchmark-results", "metrics");
const MIB = 1024 * 1024;

/** Finds the newest successfully completed metrics run. */
async function latestCompletedRun() {
  const entries = (await readdir(metricsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const entry of entries) {
    const directory = join(metricsRoot, entry);
    try {
      const result = JSON.parse(await readFile(join(directory, "run-result.json"), "utf8"));
      if (result.status === "complete") return directory;
    } catch {
      // Ignore incomplete artifact directories while selecting the latest successful run.
    }
  }
  throw new Error(`No completed metrics run found under ${metricsRoot}.`);
}

/** Reads one newline-delimited JSON artifact. */
async function readNdjson(filePath) {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Replaces variable arrays with stable keyed objects before flattening one sample. */
function normalizeSample(sample, playbackStartMs) {
  const normalized = {
    timestamp: sample.measuredAt,
    secondsFromReplayStart: (Date.parse(sample.measuredAt) - playbackStartMs) / 1000,
    ...sample,
  };
  if (sample.benchmark) {
    normalized.benchmark = {
      ...sample.benchmark,
      replayProgressPercent: sample.benchmark.totalEvents > 0
        ? sample.benchmark.emittedEvents / sample.benchmark.totalEvents * 100
        : undefined,
      busySessions: sample.benchmark.sessions.filter((session) => session.status === "busy").length,
      sessions: Object.fromEntries(sample.benchmark.sessions.map((session, index) => [
        `session_${index + 1}`,
        {
          ...session,
          busy: session.status === "busy" ? 1 : 0,
          progressPercent: session.totalEvents > 0 ? session.emittedEvents / session.totalEvents * 100 : undefined,
        },
      ])),
    };
  }
  if (sample.system) {
    normalized.system = {
      ...sample.system,
      gpuMeasurement: sample.system.gpuMeasurement ? { ...sample.system.gpuMeasurement } : undefined,
      gpu: sample.system.gpu ? { ...sample.system.gpu } : undefined,
    };
    if (Number.isFinite(normalized.system.gpu?.activePercent)
      && Number.isFinite(normalized.system.gpuMeasurement?.elapsedMs)
      && !Number.isFinite(normalized.system.gpu.activeTimeMs)) {
      normalized.system.gpu.activeTimeMs = normalized.system.gpu.activePercent / 100 * normalized.system.gpuMeasurement.elapsedMs;
    }
  }
  normalized.processes = Object.fromEntries(Object.entries(sample.processes ?? {}).map(([role, process]) => [
    role,
    { ...process, memory: process.memory ? { ...process.memory } : undefined },
  ]));
  for (const role of ["renderer", "gpu"]) {
    const memory = normalized.processes?.[role]?.memory;
    if (!memory?.categories) continue;
    normalized.processes[role].memory = {
      ...memory,
      categories: Object.fromEntries(memory.categories.map((category) => [category.category, category])),
    };
  }
  return normalized;
}

/** Flattens nested sample fields into one wide table row. */
function flatten(value, prefix = "", row = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, row);
    return row;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => flatten(child, `${prefix}.${index}`, row));
    return row;
  }
  if (value !== undefined) row[prefix] = value;
  return row;
}

/** Creates the consolidated one-row-per-second table used by the dashboard. */
export function createMetricsTable(samples) {
  const playing = samples.find((sample) => sample.benchmark?.phase === "playing");
  if (!playing) throw new Error("Completed run has no playing status sample.");
  const playbackStartMs = Date.parse(playing.measuredAt);
  const rows = samples.map((sample) => flatten(normalizeSample(sample, playbackStartMs)));
  const preferred = ["timestamp", "secondsFromReplayStart"];
  const discovered = new Set(rows.flatMap((row) => Object.keys(row)));
  const headers = [...preferred.filter((header) => discovered.delete(header)), ...discovered];
  return { headers, rows };
}

/** Serializes the consolidated table as RFC 4180-style CSV. */
export function serializeCsv(table) {
  const cell = (value) => {
    if (value === undefined || value === null) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[table.headers, ...table.rows.map((row) => table.headers.map((header) => row[header]))]
    .map((values) => values.map(cell).join(","))
    .join("\n")}\n`;
}

/** Builds one toggleable Plotly trace for a numeric table column. */
function metricTrace(table, column, name, axis, divisor = 1, visible = "legendonly") {
  const y = table.rows.map((row) => Number.isFinite(row[column]) ? row[column] / divisor : null);
  if (!y.some(Number.isFinite)) return undefined;
  return {
    type: "scatter",
    mode: "lines",
    x: table.rows.map((row) => row.secondsFromReplayStart),
    y,
    name,
    yaxis: axis,
    visible,
    connectgaps: false,
    line: { width: 2 },
    hovertemplate: `${name}: %{y:.2f}<extra></extra>`,
  };
}

/** Derives all graph traces from the consolidated table. */
function preparePlot(table) {
  const traces = [];
  const add = (...arguments_) => {
    const trace = metricTrace(table, ...arguments_);
    if (trace) traces.push(trace);
  };

  add("processes.renderer.memory.physicalBytes", "Renderer memory (MiB)", "y", MIB, true);
  add("processes.gpu.memory.physicalBytes", "GPU helper memory (MiB)", "y", MIB, true);
  add("system.gpu.activePercent", "System GPU active (%)", "y2", 1, true);
  add("system.gpu.activeTimeMs", "System GPU active time (ms / interval)", "y3", 1, true);
  add("benchmark.replayProgressPercent", "Replay progress (%)", "y2", 1, true);

  for (const role of ["renderer", "gpu"]) {
    const label = role === "renderer" ? "Renderer" : "GPU helper";
    for (const [field, fieldLabel] of [
      ["dirtyBytes", "dirty memory"],
      ["swappedBytes", "swapped memory"],
      ["cleanBytes", "clean memory"],
      ["reclaimableBytes", "reclaimable memory"],
      ["wiredBytes", "wired memory"],
    ]) add(`processes.${role}.memory.${field}`, `${label} ${fieldLabel} (MiB)`, "y", MIB);
  }

  add("system.gpu.powerMilliwatts", "System GPU power (mW)", "y3");
  add("system.gpu.activeFrequencyMHz", "System GPU frequency (MHz)", "y3");
  add("benchmark.busySessions", "Busy sessions", "y3");
  add("benchmark.emittedEvents", "Emitted events", "y3");

  for (const role of ["renderer", "gpu"]) {
    const label = role === "renderer" ? "Renderer" : "GPU helper";
    const column = `processes.${role}.gpu.gpuTimeEquivalentPercent`;
    if (!table.rows.some((row) => Number.isFinite(row[column]) && row[column] > 0)) continue;
    add(column, `${label} GPU-time equivalent (%)`, "y2");
    add(`processes.${role}.gpu.intervalGpuTimeMs`, `${label} GPU time (ms / interval)`, "y3");
  }

  const sessionProgressColumns = table.headers.filter((header) => /^benchmark\.sessions\.session_\d+\.progressPercent$/.test(header));
  for (const column of sessionProgressColumns) {
    const session = column.match(/session_(\d+)/)?.[1];
    add(column, `Session ${session} progress (%)`, "y2");
    add(column.replace("progressPercent", "busy"), `Session ${session} busy`, "y3");
  }

  const categoryColumns = table.headers.filter((header) => /^processes\.renderer\.memory\.categories\..+\.dirtyBytes$/.test(header));
  for (const column of categoryColumns) {
    const category = column.slice("processes.renderer.memory.categories.".length, -".dirtyBytes".length);
    add(column, `Renderer ${category} dirty (MiB)`, "y", MIB);
  }

  return {
    traces,
    hasSystemGpu: table.rows.some((row) => Number.isFinite(row["system.gpu.activePercent"])),
  };
}

/** Escapes embedded JSON so table content cannot terminate the script element. */
function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Escapes metadata rendered as HTML text. */
function html(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Renders one intentionally simple, legend-controlled Plotly timeline. */
function renderHtml(runName, metadata, plot) {
  const gpuNote = plot.hasSystemGpu
    ? "GPU activity is system-wide. Per-process GPU attribution is disabled because powermetrics returned only zeros for this workload."
    : "This older recording has no system GPU activity. Run the updated benchmark recorder to populate it.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ONO benchmark ${html(runName)}</title>
  <script src="https://cdn.plot.ly/plotly-3.7.0.min.js" charset="utf-8"></script>
  <style>
    body { margin:0; color:#222; background:#fff; font:14px/1.4 system-ui,sans-serif; }
    main { width:min(1500px,calc(100% - 32px)); margin:24px auto; }
    h1 { margin:0 0 4px; font-size:24px; }
    p { margin:4px 0; color:#555; }
    a { color:#2563eb; }
    #plot { width:100%; height:calc(100vh - 150px); min-height:600px; }
  </style>
</head>
<body><main>
  <h1>Benchmark metrics</h1>
  <p>${html(runName)} · ${html(metadata.environment.obsidianVersion)} · <a href="metrics.csv">metrics.csv</a></p>
  <p>${html(gpuNote)} Click a legend item to toggle it; double-click to isolate it.</p>
  <div id="plot"></div>
</main>
<script>
const traces = ${scriptJson(plot.traces)};
Plotly.newPlot('plot', traces, {
  margin:{l:70,r:105,t:30,b:60},
  hovermode:'x unified',
  legend:{orientation:'h',y:1.02,itemclick:'toggle',itemdoubleclick:'toggleothers'},
  xaxis:{title:'Seconds from replay start',domain:[0,.88]},
  yaxis:{title:'Memory (MiB)'},
  yaxis2:{title:'Percent',anchor:'free',overlaying:'y',side:'right',position:.90,showgrid:false},
  yaxis3:{title:'Count / mW / MHz',anchor:'free',overlaying:'y',side:'right',position:1,showgrid:false},
}, {responsive:true,displaylogo:false,scrollZoom:true});
</script></body></html>`;
}

/** Writes the consolidated CSV first, then builds the dashboard from that table. */
async function main(argv) {
  const runDirectory = resolve(argv[0] ?? await latestCompletedRun());
  const [metadata, samples] = await Promise.all([
    readFile(join(runDirectory, "run-metadata.json"), "utf8").then(JSON.parse),
    readNdjson(join(runDirectory, "samples.ndjson")),
  ]);
  const table = createMetricsTable(samples);
  const tablePath = join(runDirectory, "metrics.csv");
  await writeFile(tablePath, serializeCsv(table), { mode: 0o600 });

  const reportPath = join(runDirectory, "report.html");
  await writeFile(reportPath, renderHtml(basename(runDirectory), metadata, preparePlot(table)), { mode: 0o600 });
  await rm(join(runDirectory, "report-summary.json"), { force: true });
  process.stdout.write(`${tablePath}\n${reportPath}\n`);
}

if (resolve(process.argv[1] ?? "") === currentFile) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
