#!/usr/bin/env node

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import builtins from "builtin-modules";
import esbuild from "esbuild";

import {
  launchObsidianForBenchmark,
  quitObsidian,
  restoreNormalObsidian,
  waitForVaultTarget,
} from "../benchmark-runner/obsidian-launcher.mjs";

const execFile = promisify(execFileCallback);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "../..");
const DETACH_MARKER = "    logger.setDebugEnabled(false);\n";
const DETACH_SOURCE = [
  "    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL);",
  "    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_SESSION);",
].join("\n");

/** Runs the quick same-commit renderer-memory A/B and always restores the installed plugin artifact. */
async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ono-lifecycle-memory-"));
  const backupPath = join(temporaryRoot, "installed-main.js");
  const outputDirectory = join(options.outputRoot, timestamp());
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(options.installedMain, backupPath);
  let shouldRestoreObsidian = false;
  let originalLayout;
  let expected;
  try {
    const artifacts = await buildArtifacts(temporaryRoot);
    const runs = [];
    for (const artifact of [artifacts.fixed, artifacts.detachOnUnload]) {
      process.stdout.write(`Starting ${artifact.label} condition...\n`);
      await quitObsidian();
      shouldRestoreObsidian = true;
      await copyFile(artifact.path, options.installedMain);
      const mainProcess = await launchObsidianForBenchmark(options.vault, options.debugPort);
      const attached = await waitForVaultTarget(options.debugPort, options.vault);
      try {
        await waitForPlugin(attached.client, options.pluginId);
        if (!expected) {
          originalLayout = await attached.client.evaluate("app.workspace.getLayout()");
          expected = await captureOpenCodeViews(attached.client);
          if (expected.sessions.length === 0) throw new Error("The benchmark requires at least one open ONO session tab.");
        }
        await ensureOpenCodeViews(attached.client, expected, options.pluginId);
        await delay(options.initialSettleMs);
        const run = await runCondition({
          artifact,
          client: attached.client,
          expected,
          mainPid: mainProcess.pid,
          options,
          outputDirectory,
        });
        runs.push(run);
        await writeFile(join(outputDirectory, `${artifact.label}-partial.json`), `${JSON.stringify(run, null, 2)}\n`);
        if (artifact === artifacts.detachOnUnload && originalLayout) {
          await attached.client.evaluate(`app.workspace.changeLayout(${JSON.stringify(originalLayout)})`);
          await delay(2_000);
        }
      } finally {
        attached.client.close();
      }
    }
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      options: serializableOptions(options),
      expectedViews: { sessions: expected.sessions.length, panels: expected.panelCount },
      artifacts: [artifacts.fixed, artifacts.detachOnUnload].map(({ label, sha256 }) => ({ label, sha256 })),
      runs,
    };
    await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outputDirectory, "summary.md"), renderSummary(report));
    process.stdout.write(`Lifecycle memory report: ${join(outputDirectory, "summary.md")}\n`);
  } finally {
    await quitObsidian().catch(() => undefined);
    await copyFile(backupPath, options.installedMain).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (shouldRestoreObsidian) await restoreNormalObsidian().catch(() => undefined);
  }
}

/** Builds fixed and regression artifacts from the same source, changing only unload-time leaf detachment. */
async function buildArtifacts(temporaryRoot) {
  const source = await readFile(join(projectRoot, "main.ts"), "utf8");
  const badSource = injectDetachOnUnload(source);
  const fixedPath = join(temporaryRoot, "fixed-main.js");
  const badPath = join(temporaryRoot, "detach-on-unload-main.js");
  await Promise.all([
    buildArtifact(source, fixedPath),
    buildArtifact(badSource, badPath),
  ]);
  return {
    fixed: { label: "fixed", path: fixedPath, sha256: await sha256(fixedPath) },
    detachOnUnload: { label: "detach-on-unload", path: badPath, sha256: await sha256(badPath) },
  };
}

/** Inserts the historical custom-view detach calls into the current unload method exactly once. */
export function injectDetachOnUnload(source) {
  if (!source.includes(DETACH_MARKER)) throw new Error("Unable to find the unload insertion marker in main.ts.");
  if (source.includes(DETACH_SOURCE)) throw new Error("main.ts already detaches custom views during unload.");
  return source.replace(DETACH_MARKER, `${DETACH_MARKER}${DETACH_SOURCE}\n`);
}

/** Bundles one source variant with production settings while preserving identical dependencies and toolchain. */
async function buildArtifact(source, outfile) {
  await esbuild.build({
    absWorkingDir: projectRoot,
    banner: { js: "/* Obsidian OpenCode plugin lifecycle-memory benchmark */" },
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
    format: "cjs",
    loader: { ".svg": "text" },
    logLevel: "silent",
    minify: true,
    outfile,
    platform: "browser",
    sourcemap: false,
    stdin: { contents: source, loader: "ts", resolveDir: projectRoot, sourcefile: "main.ts" },
    target: "es2018",
    treeShaking: true,
  });
}

/** Measures one artifact before and after each real plugin reload in the same renderer. */
async function runCondition(context) {
  const { artifact, client, expected, mainPid, options, outputDirectory } = context;
  const rendererPid = await client.evaluate("process.pid");
  const checkpoints = [await checkpoint(client, rendererPid, "baseline", 0, options)];
  for (let index = 1; index <= options.reloads; index += 1) {
    process.stdout.write(`${artifact.label}: reload ${index}/${options.reloads}\n`);
    await client.evaluate(`(async () => { await app.plugins.disablePlugin(${JSON.stringify(options.pluginId)}); await app.plugins.enablePlugin(${JSON.stringify(options.pluginId)}); })()`);
    await waitForPlugin(client, options.pluginId);
    await ensureOpenCodeViews(client, expected, options.pluginId);
    await delay(options.reloadSettleMs);
    checkpoints.push(await checkpoint(client, rendererPid, "natural", index, options));
  }
  await client.call("HeapProfiler.collectGarbage", {}, 30_000);
  await delay(options.gcSettleMs);
  checkpoints.push(await checkpoint(client, rendererPid, "post-gc", options.reloads, options));
  const vmmap = await runTool("/usr/bin/vmmap", ["-summary", String(rendererPid)], 30_000);
  await writeFile(join(outputDirectory, `${artifact.label}-vmmap.txt`), vmmap.stdout || vmmap.stderr);
  return {
    label: artifact.label,
    rendererPid,
    unloadDetaches: await client.evaluate(`String(app.plugins.plugins[${JSON.stringify(options.pluginId)}].onunload).includes("detachLeavesOfType")`),
    checkpoints,
  };
}

/** Captures whole-renderer physical memory plus JS and DOM context at one settled checkpoint. */
async function checkpoint(client, rendererPid, phase, reload, options) {
  const rssSamples = [];
  const deadline = Date.now() + options.rssSampleMs;
  while (Date.now() < deadline) {
    rssSamples.push(await readRssBytes(rendererPid));
    await delay(options.rssSampleIntervalMs);
  }
  const [footprint, heap, dom, runtime] = await Promise.all([
    runTool("/usr/bin/footprint", ["-p", String(rendererPid), "--format", "bytes", "--swapped"], 30_000),
    client.call("Runtime.getHeapUsage"),
    client.call("Memory.getDOMCounters"),
    client.evaluate(`({
      sessions: app.workspace.getLeavesOfType("opencode-session").length,
      panels: app.workspace.getLeavesOfType("opencode-agent-panel").length,
      layoutHandlers: (app.workspace._["layout-change"] ?? []).length,
      detachedUnknownPanes: (app.workspace._["layout-change"] ?? []).filter((entry) => String(entry.fn).includes("[native code]")).length,
      processMemory: process.memoryUsage()
    })`),
  ]);
  return {
    phase,
    reload,
    measuredAt: new Date().toISOString(),
    rssBytes: summarizeNumbers(rssSamples),
    footprint: parseFootprint(footprint.stdout || footprint.stderr),
    heap,
    dom,
    runtime,
  };
}

/** Parses macOS footprint output into physical, dirty, swapped, and peak byte counters. */
export function parseFootprint(source) {
  const header = source.match(/Footprint:\s*(\d+) B/);
  const total = source.match(/^(\d+) B\s+(\d+) B\s+(\d+) B\s+(\d+) B\s+\d+\s+TOTAL$/m);
  const physical = source.match(/phys_footprint:\s*(\d+) B/);
  const peak = source.match(/phys_footprint_peak:\s*(\d+) B/);
  return {
    footprintBytes: numberMatch(header),
    dirtyBytes: total ? Number(total[1]) : undefined,
    swappedBytes: total ? Number(total[2]) : undefined,
    cleanBytes: total ? Number(total[3]) : undefined,
    reclaimableBytes: total ? Number(total[4]) : undefined,
    physicalBytes: numberMatch(physical),
    peakPhysicalBytes: numberMatch(peak),
  };
}

/** Restores the same session IDs and sessions panel when an unload condition removes them. */
async function ensureOpenCodeViews(client, expected, pluginId) {
  await client.evaluate(`(async () => {
    const expected = ${JSON.stringify(expected)};
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const openIds = new Set(app.workspace.getLeavesOfType("opencode-session").map((leaf) => leaf.getViewState().state?.sessionId));
    for (const state of expected.sessions) {
      const id = state.state?.sessionId;
      if (typeof id !== "string" || openIds.has(id)) continue;
      let leaf;
      try {
        leaf = app.workspace.getLeaf("tab");
      } catch {
        leaf = app.workspace.createLeafInParent(app.workspace.rootSplit, app.workspace.rootSplit.children.length);
      }
      await leaf.setViewState({ type: "opencode-session", state: { sessionId: id, sessionTitle: state.state?.sessionTitle }, active: true });
      app.workspace.revealLeaf(leaf);
      openIds.add(id);
    }
    if (expected.panelCount > 0 && app.workspace.getLeavesOfType("opencode-agent-panel").length === 0) await plugin.activateSessionsPanel();
    await Promise.all(app.workspace.getLeavesOfType("opencode-session").map((leaf) => leaf.loadIfDeferred?.()));
    await Promise.all(app.workspace.getLeavesOfType("opencode-agent-panel").map((leaf) => leaf.loadIfDeferred?.()));
  })()`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await client.evaluate(`({
      sessions: app.workspace.getLeavesOfType("opencode-session").length,
      timelines: document.querySelectorAll(".opencode-session-view__timeline").length,
      panels: app.workspace.getLeavesOfType("opencode-agent-panel").length
    })`);
    if (ready.sessions >= expected.sessions.length && ready.timelines >= expected.sessions.length && ready.panels >= expected.panelCount) return;
    await delay(250);
  }
  throw new Error("ONO views did not return to the expected settled layout after reload.");
}

/** Captures the stable custom-view state used to equalize both conditions. */
function captureOpenCodeViews(client) {
  return client.evaluate(`({
    sessions: app.workspace.getLeavesOfType("opencode-session").map((leaf) => leaf.getViewState()),
    panelCount: app.workspace.getLeavesOfType("opencode-agent-panel").length
  })`);
}

/** Waits for the plugin manager to expose one loaded plugin instance. */
async function waitForPlugin(client, pluginId) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(`Boolean(globalThis.app?.plugins?.plugins?.[${JSON.stringify(pluginId)}]?._loaded)`)) return;
    } catch {
      // Cold vault startup may replace the execution context after CDP target discovery.
    }
    await delay(250);
  }
  throw new Error(`Plugin ${pluginId} did not load.`);
}

/** Reads one renderer resident-set sample from macOS ps. */
async function readRssBytes(pid) {
  const { stdout } = await execFile("/bin/ps", ["-o", "rss=", "-p", String(pid)]);
  const rssKb = Number(stdout.trim());
  if (!Number.isFinite(rssKb)) throw new Error(`Unable to parse renderer RSS: ${stdout}`);
  return rssKb * 1024;
}

/** Runs one diagnostic command while preserving stderr for failed-tool reporting. */
async function runTool(command, args, timeout) {
  try {
    return await execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout });
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

/** Summarizes repeated numeric samples without discarding their raw sequence. */
function summarizeNumbers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    samples: values,
  };
}

/** Extracts the first numeric capture from one regular-expression result. */
function numberMatch(match) {
  return match ? Number(match[1]) : undefined;
}

/** Computes one SHA-256 artifact identity for the report. */
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Renders a compact comparison focused on memory deltas and leaked-pane slope. */
function renderSummary(report) {
  const lines = [
    "# ONO Lifecycle Memory A/B",
    "",
    `Generated: ${report.generatedAt}`,
    `Views per condition: ${report.expectedViews.sessions} sessions, ${report.expectedViews.panels} panel(s)`,
    `Reloads per condition: ${report.options.reloads}`,
    "",
    "| Condition | Pane growth | Footprint reload 1-to-N | RSS reload 1-to-N | DOM node growth | Listener growth |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const run of report.runs) {
    const natural = run.checkpoints.filter((item) => item.phase === "natural");
    const first = natural[0];
    const last = natural.at(-1);
    lines.push(`| ${run.label} | ${last.runtime.detachedUnknownPanes - first.runtime.detachedUnknownPanes} | ${formatDelta(last.footprint.physicalBytes, first.footprint.physicalBytes)} | ${formatDelta(last.rssBytes.median, first.rssBytes.median)} | ${last.dom.nodes - first.dom.nodes} | ${last.dom.jsEventListeners - first.dom.jsEventListeners} |`);
  }
  if (report.runs.length === 2) {
    const fixed = steadyGrowth(report.runs[0]);
    const bad = steadyGrowth(report.runs[1]);
    const excessPanes = bad.panes - fixed.panes;
    if (excessPanes > 0) {
      lines.push(
        "",
        `Excess physical-footprint growth per leaked pane: **${formatBytes((bad.footprint - fixed.footprint) / excessPanes)}**.`,
        `Excess RSS growth per leaked pane: **${formatBytes((bad.rss - fixed.rss) / excessPanes)}**.`,
        `Excess DOM growth per leaked pane: **${((bad.nodes - fixed.nodes) / excessPanes).toFixed(1)} nodes and ${((bad.listeners - fixed.listeners) / excessPanes).toFixed(1)} listeners**.`,
      );
    }
  }
  lines.push("", "`report.json` contains every checkpoint and raw RSS sample. `*-vmmap.txt` contains final native region summaries.", "");
  return lines.join("\n");
}

/** Returns reload-one-to-final growth so cold-start allocator cleanup cannot dominate the comparison. */
function steadyGrowth(run) {
  const natural = run.checkpoints.filter((item) => item.phase === "natural");
  const first = natural[0];
  const last = natural.at(-1);
  return {
    panes: last.runtime.detachedUnknownPanes - first.runtime.detachedUnknownPanes,
    footprint: last.footprint.physicalBytes - first.footprint.physicalBytes,
    rss: last.rssBytes.median - first.rssBytes.median,
    nodes: last.dom.nodes - first.dom.nodes,
    listeners: last.dom.jsEventListeners - first.dom.jsEventListeners,
  };
}

/** Formats one byte delta as signed MiB. */
function formatDelta(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return "n/a";
  const mib = (value - baseline) / 1024 / 1024;
  return `${mib >= 0 ? "+" : ""}${mib.toFixed(1)} MiB`;
}

/** Formats a byte quantity in MiB for compact benchmark interpretation. */
function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

/** Parses the intentionally small quick-test CLI surface. */
function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag ?? "end of input"}.`);
    values.set(flag, value);
  }
  const allowed = new Set(["--vault", "--plugin-id", "--installed-main", "--reloads", "--debug-port", "--output", "--settle-seconds"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  const reloads = Number(values.get("--reloads") ?? 8);
  const settleSeconds = Number(values.get("--settle-seconds") ?? 8);
  if (!Number.isInteger(reloads) || reloads < 1) throw new Error("--reloads must be a positive integer.");
  if (!Number.isFinite(settleSeconds) || settleSeconds < 1) throw new Error("--settle-seconds must be at least 1.");
  return {
    help: false,
    vault: values.get("--vault") ?? "TheVault",
    pluginId: values.get("--plugin-id") ?? "ono",
    installedMain: resolve(values.get("--installed-main") ?? "/Users/ahmedyaseen/TheVault/.obsidian/plugins/ONO/main.js"),
    reloads,
    debugPort: Number(values.get("--debug-port") ?? 9222),
    outputRoot: resolve(values.get("--output") ?? join(projectRoot, ".benchmark-results", "lifecycle-memory")),
    initialSettleMs: 15_000,
    reloadSettleMs: settleSeconds * 1000,
    gcSettleMs: 5_000,
    rssSampleMs: 5_000,
    rssSampleIntervalMs: 500,
  };
}

/** Removes internal paths and sampling constants that add no value to the portable report. */
function serializableOptions(options) {
  return {
    vault: options.vault,
    pluginId: options.pluginId,
    installedMain: basename(options.installedMain),
    reloads: options.reloads,
    initialSettleMs: options.initialSettleMs,
    reloadSettleMs: options.reloadSettleMs,
    gcSettleMs: options.gcSettleMs,
    rssSampleMs: options.rssSampleMs,
    rssSampleIntervalMs: options.rssSampleIntervalMs,
  };
}

/** Returns CLI usage for reproducing the same lifecycle comparison later. */
function helpText() {
  return `ONO whole-renderer lifecycle memory A/B\n\nUsage:\n  npm run benchmark:lifecycle-memory -- [options]\n\nOptions:\n  --vault <name>           Vault to exercise (default: TheVault)\n  --plugin-id <id>         Plugin id (default: ono)\n  --installed-main <path>  Installed plugin main.js\n  --reloads <count>        Reloads per condition (default: 8)\n  --settle-seconds <n>     Natural cooldown after each reload (default: 8)\n  --debug-port <port>      Temporary CDP port (default: 9222)\n  --output <directory>     Report root\n`;
}

/** Produces a filesystem-safe local timestamp. */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Sleeps between lifecycle transitions and memory checkpoints. */
function delay(durationMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

if (resolve(process.argv[1] ?? "") === currentFile) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
