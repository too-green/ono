import { Notice, setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { displayPath as displayPathRaw } from "../path-utils";
import {
  languageFromPath,
  parseReadOutputRows,
  stripAnsi,
} from "../diff-parsing";
import { readObject, readObjectArray, readString, readStringArray } from "../json-helpers";
import {
  renderCodeBlock,
  renderHighlightedCodeLine,
  renderJsonSection,
  renderMarkdownSection,
  type BlockRenderCtx,
} from "./tool-primitives";
import { toolPath } from "./edit-tool";

/** Renders read/read_file output as a syntax-highlighted Obsidian code block using the file extension. Referenced by tool-renderer.renderToolBody. */
export async function renderReadTool(
  container: HTMLElement,
  input: JsonObject,
  output: string | undefined,
  state: JsonObject,
  ctx: BlockRenderCtx,
): Promise<void> {
  const filePath = toolPath(input);
  if (output) await renderReadOutput(container, output, languageFromPath(filePath), ctx);

  const loaded = readStringArray(readObject(state, "metadata") ?? {}, "loaded");
  for (const path of loaded) {
    container.createDiv({ text: `Loaded ${displayPathRaw(path, ctx.sessionDirectory)}`, cls: "opencode-session-view__tool-path" });
  }
  if (!output && loaded.length === 0) container.createDiv({ text: "No output yet.", cls: "opencode-session-view__tool-empty" });
}

/** Renders read output with parsed line numbers in a dedicated gutter. */
export async function renderReadOutput(container: HTMLElement, output: string, language: string, ctx: BlockRenderCtx): Promise<void> {
  const rows = parseReadOutputRows(output);
  if (rows.length === 0) {
    await renderCodeBlock(container, output, language, ctx);
    return;
  }

  const table = container.createDiv({ cls: "opencode-session-view__read-table" });
  for (const row of rows) {
    const line = table.createDiv({ cls: "opencode-session-view__read-line" });
    line.createSpan({ text: String(row.line), cls: "opencode-session-view__read-line-number" });
    const code = line.createSpan({ cls: "opencode-session-view__read-code" });
    await renderHighlightedCodeLine(code, row.text || " ", language, ctx);
  }
}

/** Renders shell tool output in a terminal-styled block with a copy action. */
export async function renderBashTool(container: HTMLElement, input: JsonObject, output: string | undefined): Promise<void> {
  const command = readString(input, ["command", "cmd"]) ?? "";
  const shell = container.createDiv({ cls: "opencode-session-view__terminal" });
  const copy = shell.createEl("button", { attr: { "aria-label": "Copy shell output" }, cls: "opencode-session-view__copy clickable-icon" });
  setIcon(copy, "copy");
  const terminalText = [`$ ${command}`, stripAnsi(output ?? "")].join("\n\n");
  copy.addEventListener("click", () => void copyText(terminalText, "Copied shell output"));
  shell.createEl("pre", { text: terminalText });
}

/** Renders task/subagent spawns without inlining the child conversation. */
export async function renderTaskTool(
  container: HTMLElement,
  input: JsonObject,
  output: string | undefined,
  state: JsonObject,
  ctx: BlockRenderCtx,
): Promise<void> {
  const childId = readString(readObject(state, "metadata") ?? {}, ["sessionId", "sessionID"]);
  await renderJsonSection(container, "Input", input, ctx);
  if (output) await renderMarkdownSection(container, "Result", output, ctx);
  if (childId) container.createDiv({ text: `Child session: ${childId}`, cls: "opencode-session-view__tool-path" });
}

/** Renders todo* tool calls as an inert checklist, matching opencode's dedicated todo renderer intent. */
export async function renderTodoTool(container: HTMLElement, input: JsonObject, state: JsonObject, ctx: BlockRenderCtx): Promise<void> {
  const todos = todosFromTool(input, state);
  if (todos.length === 0) {
    await renderJsonSection(container, "Input", input, ctx);
    return;
  }

  const list = container.createDiv({ cls: "opencode-session-view__todos" });
  for (const todo of todos) {
    const row = list.createDiv({ cls: "opencode-session-view__todo" });
    const checkbox = row.createEl("input", { type: "checkbox", cls: "opencode-session-view__todo-checkbox" });
    checkbox.checked = readString(todo, ["status"]) === "completed";
    checkbox.disabled = true;
    row.createSpan({ text: readString(todo, ["content"]) ?? "Untitled todo", cls: "opencode-session-view__todo-content" });
    const priority = readString(todo, ["priority"]);
    if (priority) row.createSpan({ text: priority, cls: "opencode-session-view__tool-tag" });
  }
}

/** Extracts todo arrays from OpenCode input/metadata records. */
export function todosFromTool(input: JsonObject, state: JsonObject): JsonObject[] {
  const metadata = readObject(state, "metadata") ?? {};
  const metadataTodos = readObjectArray(metadata, "todos");
  return metadataTodos.length > 0 ? metadataTodos : readObjectArray(input, "todos");
}

/** Builds a compact completed/total subtitle for todo tool calls. */
export function todoSubtitle(todos: JsonObject[]): string | undefined {
  if (todos.length === 0) return undefined;
  const completed = todos.filter((todo) => readString(todo, ["status"]) === "completed").length;
  return `${completed}/${todos.length}`;
}

/** Copies arbitrary rendered tool text to the clipboard. */
async function copyText(text: string, notice: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(notice);
}
