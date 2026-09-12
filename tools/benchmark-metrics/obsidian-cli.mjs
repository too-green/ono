import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Parses JSON returned by Obsidian CLI, tolerating a JSON-encoded string result. */
export function parseObsidianEvalJson(source) {
  const payload = source.trim().replace(/^=>\s*/, "");
  const parsed = JSON.parse(payload);
  if (typeof parsed !== "string") return parsed;
  try {
    return JSON.parse(parsed);
  } catch {
    return parsed;
  }
}

/** Minimal vault-scoped Obsidian CLI client used by the metrics orchestrator. */
export class ObsidianCli {
  constructor(vault, executable = "obsidian") {
    this.vault = vault;
    this.executable = executable;
  }

  /** Reloads one development plugin in the selected vault. */
  reloadPlugin(pluginId) {
    return this.run("plugin:reload", [`id=${pluginId}`]);
  }

  /** Executes one fully qualified Obsidian command id. */
  executeCommand(commandId) {
    return this.run("command", [`id=${commandId}`]);
  }

  /** Evaluates JavaScript in the selected vault and decodes its JSON result. */
  async evaluateJson(expression) {
    const code = `(async () => JSON.stringify(await (${expression})))()`;
    const { stdout } = await this.run("eval", [`code=${code}`], 5_000);
    return parseObsidianEvalJson(stdout);
  }

  /** Runs one vault-scoped CLI command without shell interpolation. */
  run(command, args = [], timeout = 120_000) {
    return execFile(this.executable, [command, `vault=${this.vault}`, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
  }
}
