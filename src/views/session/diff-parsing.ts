/** Pure diff/output parsing helpers for tool-call rendering. Extracted from SessionView for unit testing. */

export type DiffRowKind = "context" | "add" | "del" | "meta";

export interface UnifiedDiffRow {
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export type FoldedUnifiedDiffRow =
  | { type: "row"; row: UnifiedDiffRow }
  | { type: "fold"; rows: UnifiedDiffRow[] };

export interface ReadOutputRow {
  line: number;
  text: string;
}

/** Extension → Obsidian fenced-code language map; falls back to the raw extension. */
export function languageFromPath(filePath: string | undefined): string {
  const ext = filePath?.split(".").pop()?.toLowerCase();
  const languageByExtension: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    jsonc: "jsonc",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
  };
  return ext ? languageByExtension[ext] ?? ext : "text";
}

/** Strips ANSI control codes from terminal output before display/copy. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Prevents nested triple-backtick content from breaking generated fenced code blocks. */
export function escapeFence(code: string): string {
  return code.replace(/```/g, "``\\`");
}

/** Formats arbitrary values for compact key=value tags; truncates long strings. */
export function inlineValue(value: unknown): string {
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return String(value);
  return JSON.stringify(value).slice(0, 40);
}

/** Produces a simple diff block from complete before/after strings when no patch is supplied. */
export function beforeAfterDiff(before: string, after: string, file?: string): string {
  return [`--- ${file ?? "before"}`, `+++ ${file ?? "after"}`, ...before.split("\n").map((line) => `-${line}`), ...after.split("\n").map((line) => `+${line}`)].join("\n");
}

/**
 * Parses unified diff text into display rows with old/new line numbers and no +/- glyph prefix.
 * Skips git/file headers and hunk-only meta lines so the renderer can show a clean line-numbered table.
 */
export function parseUnifiedDiffRows(patch: string): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("Index: ") || raw.startsWith("====") || raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;

    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "meta", text: hunk[3] || `Lines ${oldLine}-${newLine}` });
      continue;
    }

    if (raw.startsWith("-")) {
      rows.push({ kind: "del", oldLine, text: raw.slice(1) });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("+")) {
      rows.push({ kind: "add", newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (!raw.startsWith("\\")) rows.push({ kind: "meta", text: raw });
  }

  return rows;
}

/** Collapses context farther than the requested distance from changes; referenced by Session Island diff rendering. */
export function foldUnifiedDiffContext(rows: UnifiedDiffRow[], contextLines = 3): FoldedUnifiedDiffRow[] {
  if (contextLines < 0) return rows.map((row) => ({ type: "row", row }));
  const result: FoldedUnifiedDiffRow[] = [];
  let hunkStart = 0;

  for (let index = 0; index <= rows.length; index += 1) {
    if (index < rows.length && rows[index]?.kind !== "meta") continue;
    appendFoldedHunk(result, rows.slice(hunkStart, index), contextLines);
    if (index < rows.length) result.push({ type: "row", row: rows[index]! });
    hunkStart = index + 1;
  }
  return result;
}

/** Appends one parsed hunk while retaining nearby context and grouping omitted runs. */
function appendFoldedHunk(result: FoldedUnifiedDiffRow[], rows: UnifiedDiffRow[], contextLines: number): void {
  const changed = rows.flatMap((row, index) => row.kind === "add" || row.kind === "del" ? [index] : []);
  if (changed.length === 0) {
    result.push(...rows.map((row) => ({ type: "row" as const, row })));
    return;
  }

  let folded: UnifiedDiffRow[] = [];
  const flushFold = (): void => {
    if (folded.length > 0) result.push({ type: "fold", rows: folded });
    folded = [];
  };
  let nextChange = 0;
  for (const [index, row] of rows.entries()) {
    while (changed[nextChange] !== undefined && changed[nextChange]! < index) nextChange += 1;
    const previousIndex = changed[nextChange - 1];
    const nextIndex = changed[nextChange];
    const nearChange = row.kind !== "context"
      || (previousIndex !== undefined && index - previousIndex <= contextLines)
      || (nextIndex !== undefined && nextIndex - index <= contextLines);
    if (!nearChange) {
      folded.push(row);
      continue;
    }
    flushFold();
    result.push({ type: "row", row });
  }
  flushFold();
}

/** Extracts OpenCode read tool `<content>` rows like `123: code` while omitting path/type wrappers. */
export function parseReadOutputRows(output: string): ReadOutputRow[] {
  const content = output.match(/<content>\s*([\s\S]*?)\s*<\/content>/)?.[1] ?? output;
  return content.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
    const match = line.match(/^(\d+):\s?(.*)$/);
    if (!match) return [];
    return [{ line: Number(match[1]), text: match[2] ?? "" }];
  });
}
