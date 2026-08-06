import type { JsonObject } from "../../../services/opencode-types";
import {
  beforeAfterDiff,
  languageFromPath,
  parseUnifiedDiffRows,
  stripAnsi,
  type UnifiedDiffRow,
} from "../diff-parsing";
import { readNumber, readObject, readObjectArray, readString } from "../json-helpers";
import {
  renderCodeBlock,
  renderHighlightedCodeLine,
  renderMarkdownSection,
  type BlockRenderCtx,
} from "./tool-primitives";

export interface EditDiff {
  file?: string;
  patch: string;
  additions?: number;
  deletions?: number;
}

export interface DiagnosticEntry {
  location?: string;
  message: string;
}

/** Renders edit/write tools with available diff metadata followed by the post-state or output code block. Referenced by tool-renderer.renderToolBody. */
export async function renderEditTool(
  container: HTMLElement,
  tool: string,
  input: JsonObject,
  output: string | undefined,
  state: JsonObject,
  ctx: BlockRenderCtx,
): Promise<void> {
  const filePath = toolPath(input) ?? patchToolPath(input, state);
  const diffs = diffsFromEditTool(tool, input, state);
  for (const diff of diffs) await renderDiffSection(container, diff, ctx);
  const content = postStateFromTool(tool, input, state);
  if (content) {
    container.createDiv({ text: "Post-state", cls: "opencode-session-view__tool-section-title" });
    await renderCodeBlock(container, content, languageFromPath(filePath), ctx);
  }
  renderDiagnostics(container, filePath, state);
  if (output && diffs.length === 0 && !content) await renderMarkdownSection(container, "Result", output, ctx);
}

/** Renders one unified diff block with an optional affected-file label. */
export async function renderDiffSection(container: HTMLElement, diff: EditDiff, ctx: BlockRenderCtx): Promise<void> {
  const table = container.createDiv({ cls: "opencode-session-view__diff-table" });
  const language = languageFromPath(diff.file);
  for (const row of parseUnifiedDiffRows(diff.patch)) {
    const line = table.createDiv({ cls: `opencode-session-view__diff-line opencode-session-view__diff-line--${row.kind}` });
    line.createSpan({ text: row.oldLine === undefined ? "" : String(row.oldLine), cls: "opencode-session-view__diff-line-number" });
    line.createSpan({ text: row.newLine === undefined ? "" : String(row.newLine), cls: "opencode-session-view__diff-line-number" });
    const code = line.createSpan({ cls: "opencode-session-view__diff-code" });
    if (row.kind === "meta") code.setText(row.text || " ");
    else await renderHighlightedCodeLine(code, row.text || " ", language, ctx);
  }
}

/** Renders LSP diagnostic errors reported in edit/write/apply_patch metadata. */
export function renderDiagnostics(container: HTMLElement, filePath: string | undefined, state: JsonObject): void {
  const diagnostics = diagnosticsFromTool(filePath, state);
  if (diagnostics.length === 0) return;

  const section = container.createDiv({ cls: "opencode-session-view__diagnostics" });
  section.createDiv({ text: "LSP errors", cls: "opencode-session-view__tool-section-title" });
  for (const diagnostic of diagnostics) {
    const row = section.createDiv({ cls: "opencode-session-view__diagnostic" });
    row.createSpan({ text: "ERROR", cls: "opencode-session-view__diagnostic-label" });
    if (diagnostic.location) row.createSpan({ text: diagnostic.location, cls: "opencode-session-view__diagnostic-location" });
    row.createSpan({ text: diagnostic.message, cls: "opencode-session-view__diagnostic-message" });
  }
}

/** Extracts unified diffs from edit/write/apply_patch metadata, falling back to old/new strings. */
export function diffsFromEditTool(tool: string, input: JsonObject, state: JsonObject): EditDiff[] {
  const metadata = readObject(state, "metadata") ?? {};
  const files = patchFilesFromMetadata(metadata);
  if (files.length > 0) return files;

  const single = diffFromTool(input, state);
  if (single) return [single];
  if (tool === "write") {
    const content = readString(input, ["content"]);
    const file = toolPath(input);
    if (content) {
      const patch = [`--- /dev/null`, `+++ ${file ?? "after"}`, ...content.split("\n").map((line) => `+${line}`)].join("\n");
      return [{ file, patch }];
    }
  }
  return [];
}

/** Converts apply_patch metadata files into renderable unified diff blocks. */
export function patchFilesFromMetadata(metadata: JsonObject): EditDiff[] {
  return readObjectArray(metadata, "files").flatMap((file) => {
    const path = readString(file, ["relativePath", "filePath", "path", "file"]);
    const patch = readString(file, ["patch", "diff"]);
    const additions = readNumber(file, ["additions"]);
    const deletions = readNumber(file, ["deletions"]);
    if (patch) return [{ file: path, patch, additions, deletions }];

    const before = readString(file, ["before"]);
    const after = readString(file, ["after"]);
    if (before === undefined && after === undefined) return [];
    return [{ file: path, patch: beforeAfterDiff(before ?? "", after ?? "", path), additions, deletions }];
  });
}

/** Creates a single unified diff from edit metadata or old/new strings. */
export function diffFromTool(input: JsonObject, state: JsonObject): EditDiff | undefined {
  const metadata = readObject(state, "metadata") ?? {};
  const filediff = readObject(metadata, "filediff");
  if (filediff) {
    const patch = readString(filediff, ["patch"]);
    const file = readString(filediff, ["file", "filePath", "path"]) ?? toolPath(input);
    const additions = readNumber(filediff, ["additions"]);
    const deletions = readNumber(filediff, ["deletions"]);
    if (patch) return { file, patch, additions, deletions };
    const before = readString(filediff, ["before"]) ?? "";
    const after = readString(filediff, ["after"]) ?? "";
    return { file, patch: beforeAfterDiff(before, after, file), additions, deletions };
  }
  const oldString = readString(input, ["oldString", "old"]);
  const newString = readString(input, ["newString", "new"]);
  if (!oldString && !newString) return undefined;
  const file = toolPath(input);
  return { file, patch: beforeAfterDiff(oldString ?? "", newString ?? "", file) };
}

/** Returns best available post-edit/write contents for the expanded code block. */
export function postStateFromTool(tool: string, input: JsonObject, state: JsonObject): string | undefined {
  if (tool === "write") return readString(input, ["content"]);
  const metadata = readObject(state, "metadata") ?? {};
  const filediff = readObject(metadata, "filediff");
  return (filediff ? readString(filediff, ["after"]) : undefined) ?? readString(input, ["newString", "new"]);
}

/** Extracts severity-1 diagnostics from OpenCode edit/write metadata. */
export function diagnosticsFromTool(filePath: string | undefined, state: JsonObject): DiagnosticEntry[] {
  const metadata = readObject(state, "metadata") ?? {};
  const diagnosticsByFile = readObject(metadata, "diagnostics");
  if (!diagnosticsByFile) return [];
  const key = filePath && diagnosticsByFile[filePath] ? filePath : Object.keys(diagnosticsByFile)[0];
  const raw = key ? diagnosticsByFile[key] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const diagnostic = item as JsonObject;
    if (readNumber(diagnostic, ["severity"]) !== 1) return [];
    const range = readObject(diagnostic, "range");
    const start = range ? readObject(range, "start") : undefined;
    const line = start ? readNumber(start, ["line"]) : undefined;
    const character = start ? readNumber(start, ["character"]) : undefined;
    const location = line !== undefined && character !== undefined ? `[${line + 1}:${character + 1}]` : undefined;
    const message = readString(diagnostic, ["message"]) ?? "Unknown diagnostic";
    return [{ location, message }];
  }).slice(0, 3);
}

/** Reads the preferred path-like input key from read/edit/write tool arguments. */
export function toolPath(input: JsonObject): string | undefined {
  return readString(input, ["filePath", "filepath", "path"]);
}

/** Extracts the first affected file from apply_patch-style inputs or metadata. */
export function patchToolPath(input: JsonObject, state: JsonObject): string | undefined {
  const metadata = readObject(state, "metadata") ?? {};
  const filediff = readObject(metadata, "filediff");
  const diffFile = filediff ? readString(filediff, ["file", "filePath", "path"]) : undefined;
  if (diffFile) return diffFile;

  const metadataFiles = readObjectArray(metadata, "files");
  const inputFiles = readObjectArray(input, "files");
  const first = [...metadataFiles, ...inputFiles][0];
  return first ? readString(first, ["filePath", "relativePath", "path", "file"]) : undefined;
}

/** Strips ANSI control codes from terminal output before display/copy. */
export function stripAnsiFromText(text: string): string {
  return stripAnsi(text);
}

/** Re-exported for tests that want to round-trip diffs through the parser. */
export { parseUnifiedDiffRows, type UnifiedDiffRow };
