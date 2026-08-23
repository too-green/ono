import { setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import type { ToolDisplaySetting } from "../../../settings";
import { inlineValue, languageFromPath, parseReadOutputRows, parseUnifiedDiffRows } from "../diff-parsing";
import { readNumber, readObject, readString } from "../json-helpers";
import { displayPath as displayPathRaw, splitPath } from "../path-utils";
import { hashRenderState } from "../render-signature";
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
  taskSessionId,
  todoSubtitle,
  todosFromTool,
} from "./specialized-tool-renderers";
import {
  bindDisclosureState,
  disclosureKey,
  renderCodeBlock,
  renderLazyDetailsBody,
  renderRawTextOutput,
  renderToolDetails,
  type BlockRenderCtx,
} from "./tool-primitives";

export interface ToolInfo {
  title: string;
  subtitle?: string;
}

export interface CollapsedToolDisplay {
  icon: string;
  text: string;
}

interface ToolBlockOptions {
  status: string;
  icon: string;
  part: JsonObject;
  ctx: BlockRenderCtx;
  renderSummary: (summary: HTMLElement) => void;
  renderBody?: (body: HTMLElement) => Promise<void>;
  className?: string;
  disclosureKey?: string;
}

type ToolFileOperation = "new" | "deleted" | "moved";

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
      for (const file of files) renderPatchFileCall(group, file, part, state, ctx);
      return;
    }
  }

  if (tool === "apply_patch" && (status === "pending" || status === "running")) {
    renderPendingPatchCall(container, status, part, ctx);
    return;
  }

  const custom = customToolDisplay(tool, input, ctx.customToolDisplays);
  renderToolBlock(container, {
    status,
    icon: custom?.icon ?? toolIcon(tool),
    part,
    ctx,
    renderSummary: (summary) => {
      renderCollapsedSummary(summary, tool, input, state, info, custom, ctx);
      if (tool === "write" && readObject(state, "metadata")?.exists === false) renderFileOperation(summary, "new");
    },
    renderBody: async (body) => renderToolBody(body, tool, input, output, state, ctx),
    className: tool === "task" ? "opencode-session-view__tool--task" : undefined,
  });
}

/** Renders the common icon, summary, state, disclosure, lazy body, and raw-context control used by every tool block. */
function renderToolBlock(container: HTMLElement, options: ToolBlockOptions): void {
  const classes = [
    "opencode-session-view__tool",
    `opencode-session-view__tool--${options.status}`,
    options.renderBody ? "" : "opencode-session-view__tool--static",
    options.className ?? "",
  ].filter(Boolean).join(" ");
  const block = options.renderBody
    ? container.createEl("details", { cls: classes })
    : container.createDiv({ cls: classes });
  block.dataset.toolName = normalizedToolName(options.part);
  block.dataset.toolDetailSignature = toolDetailSignature(options.part);
  if (options.renderBody) {
    bindDisclosureState(
      block as HTMLDetailsElement,
      options.disclosureKey ?? disclosureKey(options.ctx, "tool", [options.part]),
      options.ctx.openDisclosures,
    );
  }
  const summary = options.renderBody
    ? block.createEl("summary", { cls: "opencode-session-view__tool-summary" })
    : block.createDiv({ cls: "opencode-session-view__tool-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
  setIcon(icon, options.icon);
  options.renderSummary(summary);
  if (!options.renderBody) return;
  renderLazyDetailsBody(block as HTMLDetailsElement, "opencode-session-view__tool-body", async (body) => {
    await renderToolDetails(body, options.part, options.ctx, options.renderBody!);
  });
}

/** Hashes tool detail inputs separately from transient status so retained bodies refresh only when needed. */
function toolDetailSignature(part: JsonObject): string {
  const state = { ...(readObject(part, "state") ?? {}) };
  delete state.status;
  delete state.title;
  return hashRenderState(JSON.stringify([normalizedToolName(part), state]));
}

/** Hashes detail-relevant state for a grouped context-tool disclosure. */
export function toolPartsDetailSignature(parts: JsonObject[]): string {
  return hashRenderState(JSON.stringify(parts.map(toolDetailSignature)));
}

/** Renders a non-expandable placeholder while apply_patch has no authoritative per-file metadata. */
function renderPendingPatchCall(container: HTMLElement, status: string, part: JsonObject, ctx: BlockRenderCtx): void {
  renderToolBlock(container, {
    status,
    icon: configuredToolIcon("apply_patch", ctx.customToolDisplays),
    part,
    ctx,
    renderSummary: (summary) => summary.createSpan({ text: "Patching files…", cls: "opencode-session-view__tool-title" }),
  });
}

/** Renders one completed apply-patch file as an independently collapsible edit-style block. */
function renderPatchFileCall(container: HTMLElement, diff: EditDiff, part: JsonObject, state: JsonObject, ctx: BlockRenderCtx): void {
  renderToolBlock(container, {
    status: "completed",
    icon: configuredToolIcon("apply_patch", ctx.customToolDisplays),
    part,
    ctx,
    disclosureKey: disclosureKey(ctx, "patch-file", [part], diff.targetPath ?? diff.file ?? diff.sourcePath),
    className: "opencode-session-view__tool--patch-file",
    renderSummary: (summary) => {
      renderPatchFileSummary(summary, diff, ctx);
      renderDiffTotals(summary, [diff]);
      const operation = patchOperationLabel(diff.operation);
      if (operation) renderFileOperation(summary, operation);
    },
    renderBody: async (body) => renderEditDiff(body, diff, state, ctx),
  });
}

/** Renders operation-aware source and target paths for one completed patch file. */
function renderPatchFileSummary(summary: HTMLElement, diff: EditDiff, ctx: BlockRenderCtx): void {
  const path = diff.targetPath ?? diff.file ?? diff.sourcePath;
  if (path) renderDisplayPath(summary, path, ctx.sessionDirectory);
  else summary.createSpan({ text: "Patched file", cls: "opencode-session-view__tool-title" });
}

/** Returns the display operation that distinguishes non-update patch results. */
function patchOperationLabel(operation: EditDiff["operation"]): ToolFileOperation | undefined {
  if (operation === "add") return "new";
  if (operation === "delete") return "deleted";
  if (operation === "move") return "moved";
  return undefined;
}

/** Appends a responsive full/initial file-operation label after collapsed diff totals. */
function renderFileOperation(summary: HTMLElement, operation: ToolFileOperation): void {
  const label = operation === "new" ? "New" : operation === "deleted" ? "Deleted" : "Moved";
  // No hint attrs: the visible text is the accessible name; CSS display-toggling keeps screen readers on the shown span.
  const element = summary.createSpan({ cls: `opencode-session-view__file-operation opencode-session-view__file-operation--${operation}` });
  element.createSpan({ text: label, cls: "opencode-session-view__file-operation-full" });
  element.createSpan({ text: label[0], cls: "opencode-session-view__file-operation-compact" });
}

/** Renders the specialized expanded body for a tool once its disclosure has been opened. */
async function renderToolBody(
  container: HTMLElement,
  tool: string,
  input: JsonObject,
  output: string | undefined,
  state: JsonObject,
  ctx: BlockRenderCtx,
): Promise<void> {
  if (tool === "read" || tool === "read_file") await renderReadTool(container, input, output, state, ctx);
  else if (tool === "bash" || tool === "shell") await renderBashTool(container, input, output);
  else if (tool === "edit" || tool === "write" || tool === "apply_patch") await renderEditTool(container, tool, input, output, state, ctx);
  else if (tool === "task") await renderTaskTool(container, input, output, state, ctx);
  else if (tool.startsWith("todo")) await renderTodoTool(container, input, state, ctx);
  else renderGenericTool(container, output);
}

/** Renders generic/search/skill output verbatim when raw context is disabled. */
function renderGenericTool(container: HTMLElement, output: string | undefined): void {
  renderRawTextOutput(container, output);
}

/** Normalizes OpenCode tool names so aliases share one renderer path. */
export function normalizedToolName(part: JsonObject): string {
  return (readString(part, ["tool", "name"]) ?? "tool").toLowerCase();
}

/** Builds the remaining specialized title/count information used by task and todo summaries. */
export function toolInfo(tool: string, input: JsonObject, state: JsonObject): ToolInfo {
  const title = readString(state, ["title"]) ?? toolTitle(tool, input);
  const subtitle = tool.startsWith("todo") ? todoSubtitle(todosFromTool(input, state)) : undefined;
  return { title, subtitle };
}

/** Resolves a user-defined collapsed icon and argument value for an exact normalized tool name. */
export function customToolDisplay(
  tool: string,
  input: JsonObject,
  displays: ToolDisplaySetting[] | undefined,
): CollapsedToolDisplay | undefined {
  const display = displays?.find((item) => item.tool.trim().toLowerCase() === tool);
  if (!display) return undefined;
  const value = display.displayArgument ? input[display.displayArgument] : undefined;
  return {
    icon: display.icon || "wrench",
    text: value === undefined ? tool : inlineValue(value),
  };
}

/** Chooses a configured icon while preserving specialized summary content such as patch-file paths. */
export function configuredToolIcon(tool: string, displays: ToolDisplaySetting[] | undefined): string {
  return displays?.find((item) => item.tool.trim().toLowerCase() === tool)?.icon || toolIcon(tool);
}

/** Supplies the tool-specific text placed inside the common collapsed block container. */
function renderCollapsedSummary(
  summary: HTMLElement,
  tool: string,
  input: JsonObject,
  state: JsonObject,
  info: ToolInfo,
  custom: CollapsedToolDisplay | undefined,
  ctx: BlockRenderCtx,
): void {
  if (tool === "task") {
    renderTaskToolSummary(summary, input, state, info, ctx);
    return;
  }
  if (custom) {
    summary.createSpan({ text: custom.text, cls: "opencode-session-view__tool-subtitle" });
    return;
  }
  if (isPathTool(tool)) {
    renderPathToolSummary(summary, tool, input, state, ctx);
    return;
  }
  if (tool === "bash" || tool === "shell") {
    renderBashToolSummary(summary, input, state);
    return;
  }
  if (tool === "glob" || tool === "grep") {
    summary.createSpan({ text: readString(input, ["pattern"]) ?? tool, cls: "opencode-session-view__tool-subtitle" });
    return;
  }
  if (tool === "skill") {
    summary.createSpan({ text: readString(input, ["name"]) ?? tool, cls: "opencode-session-view__tool-subtitle" });
    return;
  }
  if (tool === "list") {
    renderContextLocationSummary(summary, tool, input, ctx);
    return;
  }
  if (tool.startsWith("todo")) {
    summary.createSpan({ text: info.subtitle ?? "0/0 done", cls: "opencode-session-view__tool-subtitle" });
    return;
  }
  summary.createSpan({ text: tool, cls: "opencode-session-view__tool-subtitle" });
}

/** Renders the resolved child-session link followed by the task description as faint metadata. */
function renderTaskToolSummary(summary: HTMLElement, input: JsonObject, state: JsonObject, info: ToolInfo, ctx: BlockRenderCtx): void {
  renderTaskSessionAction(summary, input, state, ctx);
  summary.createSpan({
    text: readString(input, ["description"]) ?? info.title,
    cls: "opencode-session-view__tool-subtitle opencode-session-view__task-description",
  });
}

/** Appends a child-session title button once v1 task metadata and descendant identity are available. */
function renderTaskSessionAction(summary: HTMLElement, input: JsonObject, state: JsonObject, ctx: BlockRenderCtx): void {
  const sessionId = taskSessionId(input, state);
  const session = sessionId ? ctx.resolveSession?.(sessionId) : undefined;
  if (!sessionId || !session || session.title === sessionId || !ctx.openSession) return;
  // Hint adds info the link text lacks: the subagent mode. Model/variant isn't exposed by the v1 session/message payloads.
  const subagentType = readString(input, ["subagent_type", "subagentType", "agent"]);
  const link = summary.createEl("a", {
    cls: "opencode-session-view__task-session",
    attr: {
      href: "#",
      ...(subagentType ? { "aria-label": `@${subagentType} subagent` } : {}),
    },
  });
  link.createSpan({ text: session.title, cls: "opencode-session-view__task-session-title" });
  link.addEventListener("pointerdown", (event) => event.stopPropagation());
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void ctx.openSession?.(sessionId, session.title);
  });
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
    summary.createSpan({
      text: failedPatch ? "Patch failed" : toolTitle(tool, input),
      cls: failedPatch ? "opencode-session-view__tool-subtitle" : "opencode-session-view__tool-title",
    });
    return;
  }

  if (tool === "read" || tool === "read_file") {
    renderReadDisplayPath(summary, rawPath, input, state, ctx.sessionDirectory);
    return;
  }
  renderDisplayPath(summary, rawPath, ctx.sessionDirectory);
  renderDiffStats(summary, tool, input, state);
}

/** Renders directory paths uniformly faint and file paths with an optional faint requested line range. */
function renderReadDisplayPath(container: HTMLElement, rawPath: string, input: JsonObject, state: JsonObject, sessionDirectory?: string): void {
  const display = displayPathRaw(rawPath, sessionDirectory);
  const path = container.createSpan({ cls: "opencode-session-view__tool-display-path" });
  if (readPathKind(state) === "directory") {
    path.createSpan({ text: display, cls: "opencode-session-view__tool-path-prefix" });
    return;
  }

  const split = splitPath(display);
  if (split.prefix) path.createSpan({ text: split.prefix, cls: "opencode-session-view__tool-path-prefix" });
  path.createSpan({ text: split.basename, cls: "opencode-session-view__tool-path-basename" });
  const range = readLineRange(input, state);
  if (range) path.createSpan({ text: `(${range})`, cls: "opencode-session-view__read-range" });
}

/** Identifies completed directory reads from v1 display metadata or persisted structured output. */
function readPathKind(state: JsonObject): "file" | "directory" | undefined {
  const display = readObject(readObject(state, "metadata") ?? {}, "display");
  const metadataType = display ? readString(display, ["type"]) : undefined;
  if (metadataType === "file" || metadataType === "directory") return metadataType;
  const outputType = readString(state, ["output"])?.match(/<type>\s*(file|directory)\s*<\/type>/i)?.[1]?.toLowerCase();
  return outputType === "file" || outputType === "directory" ? outputType : undefined;
}

/** Returns the exact or requested file-line window only when offset or limit was explicitly supplied. */
function readLineRange(input: JsonObject, state: JsonObject): string | undefined {
  const offset = readNumber(input, ["offset"]);
  const limit = readNumber(input, ["limit"]);
  if (offset === undefined && limit === undefined) return undefined;

  const display = readObject(readObject(state, "metadata") ?? {}, "display");
  const metadataStart = display ? readNumber(display, ["lineStart"]) : undefined;
  const metadataEnd = display ? readNumber(display, ["lineEnd"]) : undefined;
  const rows = parseReadOutputRows(readString(state, ["output"]) ?? "");
  const start = metadataStart ?? rows[0]?.line ?? offset ?? 1;
  const end = metadataEnd ?? rows[rows.length - 1]?.line ?? (limit === undefined ? undefined : start + limit - 1);
  if (end === undefined || end < start) return undefined;
  return start === end ? String(start) : `${start}-${end}`;
}

/** Appends edit/write/apply_patch additions/deletions to the collapsed row. */
function renderDiffStats(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
  if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") return;
  renderDiffTotals(summary, diffsFromEditTool(tool, input, state));
}

/** Appends aggregate additions/deletions for the supplied file changes. */
function renderDiffTotals(summary: HTMLElement, diffs: EditDiff[]): void {
  const totals = diffs.reduce(
    (acc, diff) => {
      const rows = diff.additions === undefined || diff.deletions === undefined ? parseUnifiedDiffRows(diff.patch) : [];
      return {
        additions: acc.additions + (diff.additions ?? rows.filter((row) => row.kind === "add").length),
        deletions: acc.deletions + (diff.deletions ?? rows.filter((row) => row.kind === "del").length),
      };
    },
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

/** Returns true because every tool uses the shared icon-bearing collapsed container. */
export function hasToolIcon(_tool: string): boolean {
  return true;
}

/** Chooses muted Lucide icons for built-in tools and a generic wrench for fallback tools. */
export function toolIcon(tool: string): string {
  if (tool === "read" || tool === "read_file") return "eye";
  if (tool === "grep" || tool === "glob") return "search";
  if (tool === "list") return "list";
  if (tool === "bash" || tool === "shell") return "terminal";
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "pencil";
  if (tool === "question") return "message-circle-question-mark";
  if (tool === "skill") return "graduation-cap";
  if (tool === "task") return "bot";
  if (tool.startsWith("todo")) return "square-check-big";
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
