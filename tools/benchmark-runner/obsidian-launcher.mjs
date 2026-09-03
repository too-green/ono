import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { CdpClient } from "./cdp-client.mjs";
import { findObsidianMainProcess, listProcesses } from "./process-sampler.mjs";

const execFile = promisify(execFileCallback);
const OBSIDIAN_APP = "/Applications/Obsidian.app";

/** Gracefully closes Obsidian so Chromium launch flags are accepted on restart. */
export async function quitObsidian(timeoutMs = 30_000) {
  await execFile("/usr/bin/osascript", ["-e", 'tell application "Obsidian" to quit']).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findObsidianMainProcess(await listProcesses())) return;
    await delay(250);
  }
  throw new Error("Obsidian did not quit gracefully within 30 seconds.");
}

/** Cold-launches Obsidian with a loopback CDP port and activates the benchmark vault. */
export async function launchObsidianForBenchmark(vault, debugPort) {
  await execFile("/usr/bin/open", [
    "-na", OBSIDIAN_APP,
    "--args",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
  ]);
  await waitForCdp(debugPort, 30_000);
  await execFile("/usr/bin/open", [`obsidian://open?vault=${encodeURIComponent(vault)}`]);
  const process = await waitForObsidianMain(30_000);
  return process;
}

/** Relaunches Obsidian normally after the benchmark closes its debug endpoint. */
export async function restoreNormalObsidian() {
  await execFile("/usr/bin/open", ["-a", OBSIDIAN_APP]);
}

/** Finds and attaches to the page target whose Obsidian vault name matches. */
export async function waitForVaultTarget(debugPort, vault, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      for (const target of targets.filter((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl)) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl);
        try {
          const targetVault = await client.evaluate("globalThis.app?.vault?.getName?.() ?? ''");
          if (targetVault === vault) return { client, target };
        } catch (error) {
          lastError = error;
        }
        client.close();
      }
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`Unable to find the Obsidian renderer for vault ${vault}.${lastError ? ` ${lastError.message}` : ""}`);
}

/** Waits until the recorded session views have mounted before profiling starts. */
export async function waitForSessionViews(client, expectedCount, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await client.evaluate(`({
        count: document.querySelectorAll('.opencode-session-view').length,
        timelines: document.querySelectorAll('.opencode-session-view__timeline').length,
        errors: document.querySelectorAll('.opencode-session-view__error').length
      })`);
      if (state?.count >= expectedCount && state?.timelines >= expectedCount) return state;
    } catch {
      // Renderer reloads temporarily destroy the execution context.
    }
    await delay(250);
  }
  throw new Error(`Expected ${expectedCount} session views, but the sandbox layout did not restore them.`);
}

/** Reads browser/version metadata from the Electron CDP endpoint. */
export function readCdpVersion(debugPort) {
  return fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
}

/** Waits for the cold-launched Obsidian main process. */
async function waitForObsidianMain(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const process = findObsidianMainProcess(await listProcesses());
    if (process) return process;
    await delay(250);
  }
  throw new Error("Obsidian main process did not appear after launch.");
}

/** Waits until Electron exposes its remote debugging HTTP endpoint. */
async function waitForCdp(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Obsidian did not expose CDP on port ${debugPort}.`);
}

/** Fetches one JSON endpoint with explicit non-2xx failure handling. */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

/** Sleeps between launch and renderer readiness probes. */
function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
