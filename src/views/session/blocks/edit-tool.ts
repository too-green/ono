import type { JsonObject } from "../../../services/opencode-types";
import {
  beforeAfterDiff,
  foldUnifiedDiffContext,
  languageFromPath,
  parseUnifiedDiffRows,
  stripAnsi,
  type UnifiedDiffRow,
} from "../diff-parsing";
import { readNumber, readObject, readObjectArray, readString } from "../json-helpers";
import { displayPath } from "../path-utils";
import {
  renderCodeBlock,
  renderHighlightedCodeLines,
  renderMarkdownSection,
  type BlockRenderCtx,
} from "./tool-primitives";

export const DIFF_ACTIVE_ROW_EVENT = "opencode-diff-active-row";

export interface DiffRenderOptions {
  foldContext?: boolean;
  shouldCommit?: () => boolean;
}

export interface EditDiff {
  file?: string;
  sourcePath?: string;
  targetPath?: string;
  operation?: "add" | "update" | "delete" | "move";
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

/** Renders one apply-patch file diff and its target-specific diagnostics; referenced by tool-renderer.renderPatchFileCall. */
export async function renderEditDiff(
  container: HTMLElement,
  diff: EditDiff,
  state: JsonObject,
  ctx: BlockRenderCtx,
): Promise<void> {
  if (diff.operation === "move" && diff.sourcePath) {
    const move = container.createDiv({ cls: "opencode-session-view__move-source" });
    move.createSpan({ text: "Moved from", cls: "opencode-session-view__tool-section-title" });
    move.createSpan({ text: displayPath(diff.sourcePath, ctx.sessionDirectory), cls: "opencode-session-view__tool-path" });
  }
  if (diff.patch.trim()) await renderDiffSection(container, diff, ctx);
  renderDiagnostics(container, diff.targetPath ?? diff.file, state, false);
}

/** Renders one unified diff block, optionally folding distant context for Session Island navigation. */
export async function renderDiffSection(container: HTMLElement, diff: EditDiff, ctx: BlockRenderCtx, options: DiffRenderOptions = {}): Promise<void> {
  const table = container.createDiv({ cls: "opencode-session-view__diff-table" });
  if (options.foldContext) table.setAttr("role", "rowgroup");
  const language = languageFromPath(diff.file);
  const parsed = parseUnifiedDiffRows(diff.patch);
  const rows = options.foldContext ? foldUnifiedDiffContext(parsed) : parsed.map((row) => ({ type: "row" as const, row }));
  const codeContainers: HTMLElement[] = [];
  const codeLines: string[] = [];
  for (const item of rows) {
    if (item.type === "fold") {
      renderContextFold(table, item.rows, language, ctx, options.shouldCommit);
      continue;
    }
    const code = renderDiffLine(table, item.row, options.foldContext === true);
    if (item.row.kind === "meta") code.setText(item.row.text || " ");
    else {
      codeContainers.push(code);
      codeLines.push(item.row.text || " ");
    }
  }
  await renderHighlightedCodeLines(codeContainers, codeLines, language, ctx, options.shouldCommit);
}

/** Requests collapse of the context region containing one active row; referenced by Session Island key handling. */
export function collapseExpandedDiffContext(row: HTMLElement): boolean {
  if (!row.dataset.diffFoldId) return false;
  row.dispatchEvent(new Event("opencode-diff-collapse"));
  return true;
}

let diffRowSequence = 0;

/** Creates one line-numbered row and marks navigable Session Island rows as active-descendant targets. */
function renderDiffLine(table: HTMLElement, row: UnifiedDiffRow, navigable: boolean, before?: Node, foldId?: string): HTMLElement {
  const line = document.createElement("div");
  line.className = `opencode-session-view__diff-line opencode-session-view__diff-line--${row.kind}`;
  if (navigable) {
    line.id = `opencode-diff-row-${++diffRowSequence}`;
    line.dataset.diffRow = "";
    line.setAttribute("role", "row");
  }
  if (foldId) line.dataset.diffFoldId = foldId;
  const lineNumber = row.kind === "del" ? row.oldLine : row.newLine;
  const gutter = line.createSpan({ text: lineNumber === undefined ? "" : String(lineNumber), cls: "opencode-session-view__diff-line-number" });
  const code = line.createSpan({ cls: "opencode-session-view__diff-code" });
  if (navigable) {
    gutter.setAttr("role", "gridcell");
    code.setAttr("role", "gridcell");
  }
  table.insertBefore(line, before ?? null);
  return code;
}

/** Renders one expandable placeholder that can restore and re-collapse its omitted context rows. */
function renderContextFold(
  table: HTMLElement,
  rows: UnifiedDiffRow[],
  language: string,
  ctx: BlockRenderCtx,
  shouldCommit: () => boolean = () => true,
  before?: Node,
): HTMLElement {
  const foldId = `opencode-diff-fold-${++diffRowSequence}`;
  const placeholder = document.createElement("div");
  placeholder.className = "opencode-session-view__diff-line opencode-session-view__diff-line--fold";
  placeholder.id = `opencode-diff-row-${++diffRowSequence}`;
  placeholder.dataset.diffRow = "";
  placeholder.dataset.diffFolded = "";
  placeholder.setAttribute("role", "row");
  placeholder.setAttribute("aria-expanded", "false");
  placeholder.setAttribute("aria-label", `${rows.length} unchanged lines collapsed. Press Space or Right Arrow to expand.`);
  placeholder.createSpan({ cls: "opencode-session-view__diff-line-number", attr: { role: "gridcell" } });
  placeholder.createSpan({ text: `${rows.length} unchanged lines`, cls: "opencode-session-view__diff-code", attr: { role: "gridcell" } });
  table.insertBefore(placeholder, before ?? null);

  const collapse = (): void => {
    const expanded = Array.from(table.querySelectorAll<HTMLElement>(`[data-diff-fold-id="${foldId}"]`));
    const first = expanded[0];
    if (!first) return;
    const restored = renderContextFold(table, rows, language, ctx, shouldCommit, first);
    for (const line of expanded) line.remove();
    requestActiveDiffRow(restored);
  };
  placeholder.addEventListener("click", (event) => {
    event.stopPropagation();
    const containers: HTMLElement[] = [];
    const lines: string[] = [];
    let first: HTMLElement | undefined;
    for (const row of rows) {
      const code = renderDiffLine(table, row, true, placeholder, foldId);
      const line = code.parentElement!;
      first ??= line;
      line.addEventListener("opencode-diff-collapse", collapse);
      containers.push(code);
      lines.push(row.text || " ");
    }
    placeholder.remove();
    if (first) requestActiveDiffRow(first);
    void renderHighlightedCodeLines(containers, lines, language, ctx, shouldCommit);
  });
  return placeholder;
}

/** Moves the Session Island active descendant after a context fold changes shape. */
function requestActiveDiffRow(row: HTMLElement): void {
  row.dispatchEvent(new CustomEvent(DIFF_ACTIVE_ROW_EVENT, { bubbles: true, detail: { row } }));
}

/** Renders LSP diagnostic errors reported in edit/write/apply_patch metadata. */
export function renderDiagnostics(container: HTMLElement, filePath: string | undefined, state: JsonObject, allowFallback = true): void {
  const diagnostics = diagnosticsFromTool(filePath, state, allowFallback);
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
    const content = optionalText(input, ["content"]);
    const file = toolPath(input);
    if (content !== undefined) {
      const lines = content.replace(/\r\n?/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const patch = [`--- /dev/null`, `+++ ${file ?? "after"}`, ...lines.map((line) => `+${line}`)].join("\n");
      return [{ file, patch, additions: lines.length, deletions: 0 }];
    }
  }
  return [];
}

/** Converts apply_patch metadata files into renderable unified diff blocks. */
export function patchFilesFromMetadata(metadata: JsonObject): EditDiff[] {
  return readObjectArray(metadata, "files").flatMap((file) => {
    const relativePath = readString(file, ["relativePath"]);
    const sourcePath = readString(file, ["filePath", "path", "file"]);
    const movePath = readString(file, ["movePath"]);
    const path = relativePath ?? movePath ?? sourcePath;
    const operation = patchOperation(readString(file, ["type", "status"]));
    const patch = optionalText(file, ["patch", "diff"]);
    const additions = readNumber(file, ["additions"]);
    const deletions = readNumber(file, ["deletions"]);
    const identity: Omit<EditDiff, "patch"> = { additions, deletions };
    if (path) identity.file = path;
    if (sourcePath) identity.sourcePath = sourcePath;
    if (movePath ?? sourcePath) identity.targetPath = movePath ?? sourcePath;
    if (operation) identity.operation = operation;
    if (patch !== undefined) return [{ ...identity, patch }];

    const before = optionalText(file, ["before"]);
    const after = optionalText(file, ["after"]);
    if (before === undefined && after === undefined) return [];
    return [{ ...identity, patch: beforeAfterDiff(before ?? "", after ?? "", path) }];
  });
}

/** Reads text metadata without discarding valid empty strings such as pure-move diffs. */
function optionalText(source: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Narrows apply-patch operation metadata to the supported v1 operation set. */
function patchOperation(value: string | undefined): EditDiff["operation"] {
  return value === "add" || value === "update" || value === "delete" || value === "move" ? value : undefined;
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
export function diagnosticsFromTool(filePath: string | undefined, state: JsonObject, allowFallback = true): DiagnosticEntry[] {
  const metadata = readObject(state, "metadata") ?? {};
  const diagnosticsByFile = readObject(metadata, "diagnostics");
  if (!diagnosticsByFile) return [];
  const key = filePath && diagnosticsByFile[filePath] ? filePath : allowFallback ? Object.keys(diagnosticsByFile)[0] : undefined;
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
