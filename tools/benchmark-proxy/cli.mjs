#!/usr/bin/env node

import { resolve } from "node:path";

import { startRecordProxy, startReplayProxy } from "./proxy.mjs";

const HELP = `OpenCode benchmark record/replay proxy

Usage:
  node tools/benchmark-proxy/cli.mjs record --upstream <url> --tape <file> [options]
  node tools/benchmark-proxy/cli.mjs replay --tape <file> [options]

Options:
  --host <host>       Loopback host (default: 127.0.0.1)
  --port <port>       Proxy port (default: 4097)
  --speed <factor>    Replay speed multiplier (default: 1)
  --paused            Wait for an authenticated /start control request
  --overwrite         Replace an existing recording
  --help              Show this help
`;

/** Parses CLI flags and starts the selected benchmark proxy mode. */
async function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const common = {
    host: parsed.host,
    port: parsed.port,
    tapePath: resolve(parsed.tape),
  };
  const proxy = parsed.mode === "record"
    ? await startRecordProxy({ ...common, upstream: parsed.upstream, overwrite: parsed.overwrite })
    : await startReplayProxy({ ...common, speed: parsed.speed, paused: parsed.paused });

  process.stdout.write([
    `OpenCode benchmark proxy is listening at ${proxy.url}`,
    `Mode: ${proxy.mode}`,
    `Tape: ${common.tapePath}`,
    `Control token: ${proxy.controlToken}`,
    "Press Ctrl-C to stop.",
    "",
  ].join("\n"));

  let closing = false;
  /** Flushes recordings and closes active playback on process termination. */
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await proxy.close();
  };
  /** Reports shutdown persistence failures instead of leaving the process half-open. */
  const handleSignal = () => void shutdown()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`Unable to close benchmark proxy: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}

/** Converts supported long options into validated proxy startup arguments. */
function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const mode = argv[0];
  if (mode !== "record" && mode !== "replay") throw new Error("First argument must be record or replay.\n\nUse --help for usage.");
  const values = new Map();
  let overwrite = false;
  let paused = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (flag === "--paused") {
      paused = true;
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
  const upstream = values.get("--upstream");
  if (mode === "record" && !upstream) throw new Error("--upstream is required in record mode.");
  const allowed = new Set(["--tape", "--upstream", "--host", "--port", "--speed"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  }
  return {
    help: false,
    mode,
    tape,
    upstream,
    host: values.get("--host") ?? "127.0.0.1",
    port: parsePort(values.get("--port") ?? "4097"),
    speed: parsePositiveNumber(values.get("--speed") ?? "1", "--speed"),
    overwrite,
    paused,
  };
}

/** Parses one valid TCP port for CLI startup. */
function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
  return port;
}

/** Parses one positive numeric CLI option. */
function parsePositiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number.`);
  return number;
}

void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
