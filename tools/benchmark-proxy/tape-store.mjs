import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const TAPE_VERSION = 1;

const PERSIST_DELAY_MS = 5_000;
const RESPONSE_TERMINALS = new Set(["end", "open", "error", "aborted"]);

/** Creates an empty versioned proxy tape; referenced by the record proxy. */
export function createTape() {
  return {
    version: TAPE_VERSION,
    createdAt: new Date().toISOString(),
    interactions: [],
  };
}

/** Loads and validates one proxy tape; referenced by replay startup. */
export async function loadTape(filePath) {
  const source = await readFile(filePath, "utf8");
  const tape = JSON.parse(source);
  finalizePendingSseResponses(tape);
  validateTape(tape);
  return tape;
}

/** Converts captured long-lived SSE responses into replayable open streams. */
export function finalizePendingSseResponses(tape) {
  if (!isRecord(tape) || !Array.isArray(tape.interactions)) return;
  for (const interaction of tape.interactions) {
    if (!isRecord(interaction) || !isRecord(interaction.request) || !isRecord(interaction.response)) continue;
    const response = interaction.response;
    if (response.terminal !== "pending" || response.statusCode === null || !isEventTarget(interaction.request.target)) continue;
    const lastChunkAtMs = Array.isArray(response.chunks) ? response.chunks.at(-1)?.atMs : undefined;
    response.terminal = "open";
    response.endedAtMs = typeof lastChunkAtMs === "number" ? lastChunkAtMs : response.startedAtMs;
  }
}

/** Persists a mutable tape atomically while record-mode responses are active. */
export class TapeWriter {
  constructor(filePath, tape) {
    this.filePath = filePath;
    this.tape = tape;
    this.persistTimer = undefined;
    this.persistInFlight = undefined;
    this.persistRequested = false;
    this.lastScheduledError = undefined;
  }

  /** Debounces persistence after response chunks; referenced by record request handlers. */
  schedulePersist() {
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch((error) => {
        this.lastScheduledError = error;
      });
    }, PERSIST_DELAY_MS);
  }

  /** Queues an atomic snapshot write without overlapping an earlier write. */
  persist() {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistRequested = true;
    if (!this.persistInFlight) this.persistInFlight = this.persistLatestSnapshots();
    return this.persistInFlight.then(() => {
      this.lastScheduledError = undefined;
    });
  }

  /** Coalesces changes made during a write into only one subsequent full snapshot. */
  async persistLatestSnapshots() {
    try {
      while (this.persistRequested) {
        this.persistRequested = false;
        const snapshot = `${JSON.stringify(this.tape, null, 2)}\n`;
        await writePrivateFileAtomically(this.filePath, snapshot);
      }
    } finally {
      this.persistInFlight = undefined;
    }
  }

  /** Flushes the newest tape state during graceful proxy shutdown. */
  async close() {
    try {
      await this.persist();
    } catch (error) {
      throw this.lastScheduledError ?? error;
    }
  }
}

/** Rejects malformed or incompatible tape data before opening a replay server. */
function validateTape(tape) {
  if (!isRecord(tape) || tape.version !== TAPE_VERSION || !Array.isArray(tape.interactions)) {
    throw new Error(`Unsupported benchmark tape; expected version ${TAPE_VERSION}.`);
  }
  for (const interaction of tape.interactions) validateInteraction(interaction);
}

/** Validates fields needed for deterministic request matching and response playback. */
function validateInteraction(interaction) {
  if (!isRecord(interaction) || !isRecord(interaction.request) || !isRecord(interaction.response)) {
    throw new Error("Benchmark tape contains an invalid interaction.");
  }
  const request = interaction.request;
  const response = interaction.response;
  if (typeof request.method !== "string" || typeof request.target !== "string") {
    throw new Error("Benchmark tape contains an invalid request descriptor.");
  }
  if (request.bodySha256 !== null && typeof request.bodySha256 !== "string") {
    throw new Error("Benchmark tape contains an invalid request digest.");
  }
  if (!Number.isInteger(request.bodyBytes) || request.bodyBytes < 0) {
    throw new Error("Benchmark tape contains an invalid request size.");
  }
  if (response.statusCode !== null && !Number.isInteger(response.statusCode)) {
    throw new Error("Benchmark tape contains an invalid response status.");
  }
  if (!Array.isArray(response.headers) || !Array.isArray(response.chunks)) {
    throw new Error("Benchmark tape contains invalid response data.");
  }
  if (!RESPONSE_TERMINALS.has(response.terminal)) {
    throw new Error("Benchmark tape contains an incomplete response; stop recording gracefully before replay.");
  }
  for (const header of response.headers) {
    if (!Array.isArray(header) || header.length !== 2 || header.some((value) => typeof value !== "string")) {
      throw new Error("Benchmark tape contains an invalid response header.");
    }
  }
  for (const chunk of response.chunks) {
    if (!isRecord(chunk) || typeof chunk.data !== "string" || typeof chunk.atMs !== "number") {
      throw new Error("Benchmark tape contains an invalid response chunk.");
    }
  }
}

/** Writes a private file through a same-directory temporary path and rename. */
async function writePrivateFileAtomically(filePath, contents) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** Narrows parsed JSON objects for tape validation. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Detects an OpenCode SSE request without exposing its query values. */
function isEventTarget(target) {
  if (typeof target !== "string") return false;
  try {
    return new URL(target, "http://benchmark.invalid").pathname === "/event";
  } catch {
    return false;
  }
}
