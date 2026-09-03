#!/usr/bin/env node

import { resolve } from "node:path";

import { runBenchmark } from "./runner.mjs";

const HELP = `Automated Obsidian OpenCode streaming benchmark

Usage:
  npm run benchmark:run -- --tape <file> [options]

Options:
  --vault <name>             Obsidian vault to profile (default: sandbox)
  --iterations <count>       Measured deterministic runs (default: 3)
  --expected-sessions <n>    Override unique prompted sessions from tape
  --speed <factor>           Replay speed multiplier (default: 1)
  --cooldown-seconds <n>     Idle pause before each run (default: 3)
  --settle-ms <n>            Required DOM quiet period (default: 750)
  --timeout-seconds <n>      Minimum per-run timeout (default: 120)
  --replay-port <port>       Plugin replay server port (default: 4097)
  --debug-port <port>        Temporary Electron CDP port (default: 9222)
  --output <directory>       Private artifact root (default: .benchmark-results)
  --power                    Add sudo powermetrics CPU/GPU/thermal sampling
  --no-restore               Leave Obsidian closed instead of reopening normally
  --help                     Show this help
`;

/** Parses benchmark options, handles interruption, and prints the report path. */
async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runBenchmark({
      ...options,
      onProgress: (message) => process.stdout.write(`${message}\n`),
    }, abortController.signal);
    process.stdout.write(`Benchmark report: ${result.outputDirectory}/summary.md\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

/** Converts supported long options into validated runner configuration. */
function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const values = new Map();
  let power = false;
  let restoreObsidian = true;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--power") {
      power = true;
      continue;
    }
    if (flag === "--no-restore") {
      restoreObsidian = false;
      continue;
    }
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    values.set(flag, value);
    index += 1;
  }
  const tape = values.get("--tape");
  if (!tape) throw new Error("--tape is required.");
  const allowed = new Set([
    "--tape", "--vault", "--iterations", "--expected-sessions", "--speed", "--cooldown-seconds",
    "--settle-ms", "--timeout-seconds", "--replay-port", "--debug-port", "--output",
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  return {
    help: false,
    tapePath: resolve(tape),
    vault: values.get("--vault") ?? "sandbox",
    iterations: integerOption(values, "--iterations", 3, 1),
    expectedSessions: optionalInteger(values, "--expected-sessions", 1),
    speed: numberOption(values, "--speed", 1, 0.01),
    cooldownMs: numberOption(values, "--cooldown-seconds", 3, 0) * 1000,
    settleMs: numberOption(values, "--settle-ms", 750, 0),
    timeoutMs: numberOption(values, "--timeout-seconds", 120, 1) * 1000,
    replayPort: integerOption(values, "--replay-port", 4097, 1, 65_535),
    debugPort: integerOption(values, "--debug-port", 9222, 1, 65_535),
    outputRoot: resolve(values.get("--output") ?? ".benchmark-results"),
    power,
    restoreObsidian,
    profilerSamplingIntervalUs: 1000,
    processSampleIntervalMs: 500,
    powerSampleIntervalMs: 1000,
  };
}

/** Parses one bounded integer option. */
function integerOption(values, flag, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(values.get(flag) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

/** Parses one optional bounded integer option. */
function optionalInteger(values, flag, minimum) {
  return values.has(flag) ? integerOption(values, flag, 0, minimum) : undefined;
}

/** Parses one finite numeric option. */
function numberOption(values, flag, fallback, minimum) {
  const value = Number(values.get(flag) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${flag} must be at least ${minimum}.`);
  return value;
}

void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
