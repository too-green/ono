import { setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { inlineValue, languageFromPath } from "../diff-parsing";
import { readObject, readString } from "../json-helpers";
import { displayPath as displayPathRaw, splitPath } from "../path-utils";
import {
  renderEditDiff,
  renderEditTool,
  diffsFromEditTool,
  patchFilesFromMetadata,
  toolPath,
  patchToolPath,
  type EditDiff,
} from "./edit-tool";
import {
  renderBashTool,
  renderReadTool,
  renderTaskTool,
  renderTodoTool,
  todoSubtitle,
  todosFromTool,
} from "./specialized-tool-renderers";
import { renderJsonSection, renderLazyDetailsBody, renderMarkdownSection, renderCodeBlock, type BlockRenderCtx } from "./tool-primitives";

const PRIMARY_ARG_KEYS = ["description", "query", "path", "filePath", "filepath", "pattern", "name", "command"];

export interface ToolInfo {
  title: string;
  subtitle?: string;
  tags: string[];
}

/** Renders one collapsed-by-default tool call with specialized expanded states for common opencode tools; called by timeline and context renderers. */
export async function renderToolCall(container: HTMLElement, part: JsonObject, ctx: BlockRenderCtx): Promise<void> {
  const tool = normalizedToolName(part);
  const state = readObject(part, "state") ?? {};
  const input = readObject(state, "input") ?? {};
  const output = readString(state, ["output", "error"]);
  const status = readString(state, ["status"]) ?? "unknown";
  const info = toolInfo(tool, input, state);

  if (tool === "apply_patch" && status === "completed") {
    const metadata = readObject(state, "metadata") ?? {};
    const files = patchFilesFromMetadata(metadata);
    if (files.length > 0) {
      const group = container.createDiv({
        cls: "opencode-session-view__patch-files",
        attr: { role: "group", "aria-label": "Patched files" },
      });
      for (const file of files) renderPatchFileCall(group, file, state, ctx);
      return;
    }
  }

  if (tool === "apply_patch" && (status === "pending" || status === "running")) {
    renderPendingPatchCall(container, status);
    return;
  }

  const details = container.createEl("details", { cls: `opencode-session-view__tool opencode-session-view__tool--${status}` });
  const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
  if (hasToolIcon(tool)) {
    const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
    setIcon(icon, toolIcon(tool));
  }
  if (isPathTool(tool)) renderPathToolSummary(summary, tool, input, state, ctx);
  else if (isContextLocationTool(tool)) renderContextLocationSummary(summary, tool, input, ctx);
  else if (tool === "bash" || tool === "shell") renderBashToolSummary(summary, input, state);
  else {
    summary.createSpan({ text: info.title, cls: "opencode-session-view__tool-title" });
    if (info.subtitle) summary.createSpan({ text: info.subtitle, cls: "opencode-session-view__tool-subtitle" });
  }
  if (status !== "completed" && status !== "error") summary.createSpan({ text: status, cls: "opencode-session-view__tool-status" });

  renderLazyDetailsBody(details, "opencode-session-view__tool-body", async (body) => renderToolBody(body, tool, input, output, state, info.tags, ctx));
}

/** Renders a non-expandable placeholder while apply_patch has no authoritative per-file metadata. */
function renderPendingPatchCall(container: HTMLElement, status: string): void {
  const block = container.createDiv({ cls: `opencode-session-view__tool opencode-session-view__tool--${status} opencode-session-view__tool--static` });
  const summary = block.createDiv({ cls: "opencode-session-view__tool-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
  setIcon(icon, "pencil");
  summary.createSpan({ text: "Patching files…", cls: "opencode-session-view__tool-title" });
  summary.createSpan({ text: status, cls: "opencode-session-view__tool-status" });
}

/** Renders one completed apply-patch file as an independently collapsible edit-style block. */
function renderPatchFileCall(container: HTMLElement, diff: EditDiff, state: JsonObject, ctx: BlockRenderCtx): void {
  const details = container.createEl("details", {
    cls: "opencode-session-view__tool opencode-session-view__tool--completed opencode-session-view__tool--patch-file",
  });
  const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
  setIcon(icon, "pencil");
  renderPatchFileSummary(summary, diff, ctx);
  renderDiffTotals(summary, [diff]);
  const operation = patchOperationLabel(diff.operation);
  if (operation) summary.createSpan({ text: operation, cls: "opencode-session-view__tool-status" });
  renderLazyDetailsBody(details, "opencode-session-view__tool-body", async (body) => renderEditDiff(body, diff, state, ctx));
}

/** Renders operation-aware source and target paths for one completed patch file. */
function renderPatchFileSummary(summary: HTMLElement, diff: EditDiff, ctx: BlockRenderCtx): void {
  const path = diff.targetPath ?? diff.file ?? diff.sourcePath;
  if (path) renderDisplayPath(summary, path, ctx.sessionDirectory);
  else summary.createSpan({ text: "Patched file", cls: "opencode-session-view__tool-title" });
}

/** Returns the operation label that distinguishes non-update patch results. */
function patchOperationLabel(operation: EditDiff["operation"]): string | undefined {
  if (operation === "add") return "Created";
  if (operation === "delete") return "Deleted";
  if (operation === "move") return "Moved";
  return undefined;
}

/** Renders the specialized expanded body for a tool once its disclosure has been opened. */
async function renderToolBody(
  container: HTMLElement,
  tool: string,
  input: JsonObject,
  output: string | undefined,
  state: JsonObject,
  tags: string[],
  ctx: BlockRenderCtx,
): Promise<void> {
  if (tool === "read" || tool === "read_file") await renderReadTool(container, input, output, state, ctx);
  else if (tool === "bash" || tool === "shell") await renderBashTool(container, input, output);
  else if (tool === "edit" || tool === "write" || tool === "apply_patch") await renderEditTool(container, tool, input, output, state, ctx);
  else if (tool === "task") await renderTaskTool(container, input, output, state, ctx);
  else if (tool.startsWith("todo")) await renderTodoTool(container, input, state, ctx);
  else await renderGenericTool(container, input, output, tags, ctx);
}

/** Renders unknown tools as readable input/output sections plus up to three argument tags. */
async function renderGenericTool(container: HTMLElement, input: JsonObject, output: string | undefined, tags: string[], ctx: BlockRenderCtx): Promise<void> {
  if (tags.length > 0) {
    const tagWrap = container.createDiv({ cls: "opencode-session-view__tool-tags" });
    for (const tag of tags) tagWrap.createSpan({ text: tag, cls: "opencode-session-view__tool-tag" });
  }
  await renderJsonSection(container, "Input", input, ctx);
  if (output) await renderMarkdownSection(container, "Output", output, ctx);
}

/** Normalizes OpenCode tool names so aliases share one renderer path. */
export function normalizedToolName(part: JsonObject): string {
  return (readString(part, ["tool", "name"]) ?? "tool").toLowerCase();
}

/** Builds fallback tool title/subtitle/tags using the getToolInfo-style primary argument extraction from the spec. */
export function toolInfo(tool: string, input: JsonObject, state: JsonObject): ToolInfo {
  const title = readString(state, ["title"]) ?? toolTitle(tool, input);
  const subtitle = tool.startsWith("todo") ? todoSubtitle(todosFromTool(input, state)) : primaryArg(input);
  const tags = Object.entries(input)
    .filter(([key]) => !PRIMARY_ARG_KEYS.includes(key))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${inlineValue(value)}`);
  return { title, subtitle, tags };
}

/** Returns true for tools whose collapsed row should prioritize a filesystem path over the tool title. */
export function isPathTool(tool: string): boolean {
  return tool === "read" || tool === "read_file" || tool === "edit" || tool === "write" || tool === "apply_patch";
}

/** Returns true for context tools that carry a directory plus optional search pattern. */
export function isContextLocationTool(tool: string): boolean {
  return tool === "list" || tool === "glob" || tool === "grep";
}

/** Renders path-tool summaries as muted path text with the final segment emphasized. */
function renderPathToolSummary(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject, ctx: BlockRenderCtx): void {
  const rawPath = toolPath(input) ?? patchToolPath(input, state);
  if (!rawPath) {
    const failedPatch = tool === "apply_patch" && readString(state, ["status"]) === "error";
    summary.createSpan({ text: failedPatch ? "Patch failed" : toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
    return;
  }

  renderDisplayPath(summary, rawPath, ctx.sessionDirectory);
  renderDiffStats(summary, tool, input, state);
}

/** Appends edit/write/apply_patch additions/deletions to the collapsed row. */
function renderDiffStats(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
  if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") return;
  renderDiffTotals(summary, diffsFromEditTool(tool, input, state));
}

/** Appends aggregate additions/deletions for the supplied file changes. */
function renderDiffTotals(summary: HTMLElement, diffs: EditDiff[]): void {
  const totals = diffs.reduce(
    (acc, diff) => ({ additions: acc.additions + (diff.additions ?? 0), deletions: acc.deletions + (diff.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  if (totals.additions === 0 && totals.deletions === 0) return;
  const stats = summary.createSpan({ cls: "opencode-session-view__diff-stats" });
  stats.createSpan({ text: `+${totals.additions}`, cls: "opencode-session-view__diff-stat-add" });
  stats.createSpan({ text: `−${totals.deletions}`, cls: "opencode-session-view__diff-stat-del" });
}

/** Renders list/glob/grep rows with the same path normalization used by standalone path tools. */
function renderContextLocationSummary(summary: HTMLElement, tool: string, input: JsonObject, ctx: BlockRenderCtx): void {
  const rawPath = readString(input, ["path"]);
  const pattern = readString(input, ["pattern"]);
  const include = readString(input, ["include"]);

  if (tool === "list") summary.createSpan({ text: toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
  if (rawPath) renderDisplayPath(summary, rawPath, ctx.sessionDirectory);
  if (pattern) summary.createSpan({ text: `pattern=${pattern}`, cls: "opencode-session-view__tool-tag" });
  if (include) summary.createSpan({ text: `include=${include}`, cls: "opencode-session-view__tool-tag" });
}

/** Renders bash collapsed rows with only the command as muted text, avoiding duplicate title/subtitle. */
function renderBashToolSummary(summary: HTMLElement, input: JsonObject, state: JsonObject): void {
  const command = readString(input, ["command", "cmd"]) ?? readString(state, ["title"]) ?? "Shell";
  summary.createSpan({ text: command, cls: "opencode-session-view__tool-subtitle" });
}

/** Appends a muted-prefix/emphasized-basename path span using the global tool path policy. */
export function renderDisplayPath(container: HTMLElement, rawPath: string, sessionDirectory?: string): void {
  const display = displayPathRaw(rawPath, sessionDirectory);
  const split = splitPath(display);
  const path = container.createSpan({ cls: "opencode-session-view__tool-display-path" });
  if (split.prefix) path.createSpan({ text: split.prefix, cls: "opencode-session-view__tool-path-prefix" });
  path.createSpan({ text: split.basename, cls: "opencode-session-view__tool-path-basename" });
}

/** Chooses concise collapsed-state labels for common tools. */
export function toolTitle(tool: string, input: JsonObject): string {
  if (tool === "read" || tool === "read_file") return "Read";
  if (tool === "glob" || tool === "grep") return "Search";
  if (tool === "list") return "List";
  if (tool === "bash" || tool === "shell") return "Shell";
  if (tool === "edit") return "Edit";
  if (tool === "write") return "Write";
  if (tool === "apply_patch") return "Patch";
  if (tool === "task") return readString(input, ["description"]) ?? "Task";
  if (tool.startsWith("todo")) return "Todos";
  return tool;
}

/** Returns the best single-line descriptor from a tool input object. */
export function primaryArg(input: JsonObject): string | undefined {
  for (const key of PRIMARY_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** Returns true when a tool has a representative icon; generic tools intentionally do not. */
export function hasToolIcon(tool: string): boolean {
  return isPathTool(tool) || isContextLocationTool(tool) || tool === "bash" || tool === "shell" || tool === "task" || tool.startsWith("todo");
}

/** Chooses muted Lucide icons for non-generic collapsed tool rows. */
export function toolIcon(tool: string): string {
  if (tool === "read" || tool === "read_file") return "eye";
  if (tool === "grep" || tool === "glob") return "search";
  if (tool === "list") return "list";
  if (tool === "bash" || tool === "shell") return "terminal";
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "pencil";
  if (tool === "task") return "brain";
  if (tool.startsWith("todo")) return "list-checks";
  return "wrench";
}

/** Re-exported for context-tool-group; using file-extension language hint is shared policy. */
export { languageFromPath, renderCodeBlock };

/** Summarizes grouped context tools as read/search/list counts. */
export function contextSummary(parts: JsonObject[]): string {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const tool = normalizedToolName(part);
    const label = tool === "read" || tool === "read_file" ? "read" : tool === "grep" || tool === "glob" ? "search" : "list";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(", ");
}
