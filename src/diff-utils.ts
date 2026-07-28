import type { JsonObject, OpenCodeMessageBundle } from "./services/opencode-types";

export interface DiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
  patch?: string;
  status?: "added" | "deleted" | "modified";
}

/** Returns true when an unknown value is a plain JSON object; referenced by loose OpenCode payload readers. */
export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads a nested object field from a loose OpenCode payload; referenced by diff extraction helpers. */
export function readObject(source: JsonObject | undefined, key: string): JsonObject | undefined {
  if (!source) return undefined;
  const value = source[key];
  return isJsonObject(value) ? value : undefined;
}

/** Reads an array of object records from a loose OpenCode payload; referenced by diff extraction helpers. */
export function readObjectArray(source: JsonObject | undefined, key: string): JsonObject[] {
  if (!source) return [];
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject);
}

/** Reads the first non-empty string-like value from a loose OpenCode payload; referenced by diff normalization. */
export function readString(source: JsonObject | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** Reads the first finite numeric value from a loose OpenCode payload; referenced by diff stat normalization. */
export function readNumber(source: JsonObject | undefined, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Extracts normalized file diffs from a user message summary; referenced by the right-sidebar diff panel. */
export function diffFilesFromMessage(bundle: OpenCodeMessageBundle): DiffFileSummary[] {
  const summary = readObject(bundle.info, "summary");
  const candidates = [...readObjectArray(summary, "diffs"), ...readObjectArray(bundle.info, "diffs")];
  return candidates.flatMap(normalizeDiffFile);
}

/** Finds the latest user message id even when no diffs are attached; referenced by empty-turn panel copy. */
export function latestUserTurnId(messages: OpenCodeMessageBundle[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && messageRole(message) === "user") return messageId(message);
  }
  return undefined;
}

/** Aggregates per-turn file summaries into a session-level file list; referenced by the right-sidebar diff panel. */
export function aggregateDiffFiles(diffs: DiffFileSummary[]): DiffFileSummary[] {
  const byFile = new Map<string, DiffFileSummary>();
  for (const diff of diffs) {
    const existing = byFile.get(diff.file);
    if (!existing) {
      byFile.set(diff.file, { ...diff, patch: undefined });
      continue;
    }
    existing.additions += diff.additions;
    existing.deletions += diff.deletions;
    existing.status = existing.status === diff.status ? existing.status : "modified";
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Returns the stable message id from a bundle; referenced by turn matching in session and diff views. */
export function messageId(bundle: OpenCodeMessageBundle): string | undefined {
  return readString(bundle.info, ["id", "messageID", "messageId"]);
}

/** Returns the normalized message role from a bundle; referenced by turn matching in session and diff views. */
export function messageRole(bundle: OpenCodeMessageBundle): string | undefined {
  return readString(bundle.info, ["role", "type"]);
}

/** Normalizes one raw SnapshotFileDiff-style object into displayable path and stats. */
function normalizeDiffFile(raw: JsonObject): DiffFileSummary[] {
  const file = readString(raw, ["file", "path", "filePath", "relativePath"]);
  if (!file) return [];
  const patch = readString(raw, ["patch", "diff"]);
  const patchStats = patch ? countPatchStats(patch) : { additions: 0, deletions: 0 };
  const status = readString(raw, ["status"]);
  return [
    {
      file,
      patch,
      additions: readNumber(raw, ["additions", "added"]) ?? patchStats.additions,
      deletions: readNumber(raw, ["deletions", "deleted", "removals"]) ?? patchStats.deletions,
      status: status === "added" || status === "deleted" || status === "modified" ? status : undefined,
    },
  ];
}

/** Counts added/deleted lines in a unified patch; referenced when OpenCode omits explicit stats. */
function countPatchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
