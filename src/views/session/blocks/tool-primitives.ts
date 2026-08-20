import { MarkdownRenderer, setIcon, type Component } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import type { ToolDisplaySetting } from "../../../settings";
import { escapeFence } from "../diff-parsing";

/**
 * Minimal rendering context threaded through every block module.
 * `component` is the SessionView itself (needed by Obsidian's MarkdownRenderer for lifecycle tracking);
 * `sessionId` drives the synthetic markdown source path used for link resolution.
 */
export interface BlockRenderCtx {
  component: Component;
  sessionId?: string;
  messageId?: string;
  sessionDirectory?: string;
  customToolDisplays?: ToolDisplaySetting[];
  openDisclosures?: Set<string>;
  resolveSession?: (sessionId: string) => { title: string; directory?: string } | undefined;
  openSession?: (sessionId: string, title: string) => void | Promise<void>;
}

interface LazyDetailsState {
  bodyClass: string;
  render: (body: HTMLElement) => Promise<void>;
  body?: HTMLElement;
  hydrated: boolean;
  version: number;
}

const lazyDetailsStates = new WeakMap<HTMLDetailsElement, LazyDetailsState>();
const lazyRenderOwners = new WeakMap<HTMLElement, HTMLDetailsElement>();

/** Builds the synthetic source path MarkdownRenderer uses for internal-link resolution. */
export function markdownSourcePath(ctx: BlockRenderCtx): string {
  return `opencode-session/${ctx.sessionId ?? "session"}.md`;
}

/** Reads the stable OpenCode identifier shared by streamed part payload variants. */
export function blockPartId(part: JsonObject): string | undefined {
  const id = part.id ?? part.partID ?? part.partId;
  return typeof id === "string" ? id : undefined;
}

/** Builds a session/message/part-scoped key for disclosure and block identity. */
export function disclosureKey(ctx: BlockRenderCtx, kind: string, parts: JsonObject[], suffix?: string): string {
  const partIds = parts.map(blockPartId).filter((id): id is string => !!id);
  return [ctx.sessionId ?? "session", ctx.messageId ?? "message", kind, partIds.join(",") || "part", suffix].filter(Boolean).join(":");
}

/** Restores and records one disclosure's open state across keyed or fallback renders. */
export function bindDisclosureState(details: HTMLDetailsElement, key: string, state: Set<string> | undefined): void {
  details.dataset.disclosureKey = key;
  details.open = state?.has(key) === true;
  details.addEventListener("toggle", () => {
    if (!state) return;
    if (details.open) state.add(key);
    else state.delete(key);
  });
}

/** Defers expensive details body DOM/Markdown work until a tool disclosure is opened. */
export function renderLazyDetailsBody(details: HTMLDetailsElement, bodyClass: string, render: (body: HTMLElement) => Promise<void>): void {
  const existing = lazyDetailsStates.get(details);
  if (existing) {
    existing.bodyClass = bodyClass;
    existing.render = render;
    return;
  }
  lazyDetailsStates.set(details, { bodyClass, render, hydrated: false, version: 0 });
  details.addEventListener("toggle", () => hydrateLazyDetailsBody(details));
  hydrateLazyDetailsBody(details);
}

/** Transfers the latest lazy renderer to a retained details shell and optionally refreshes its body. */
export function adoptLazyDetailsBody(current: HTMLDetailsElement, next: HTMLDetailsElement, resetBody: boolean): boolean {
  const currentState = lazyDetailsStates.get(current);
  const nextState = lazyDetailsStates.get(next);
  if (!currentState || !nextState) return false;
  currentState.bodyClass = nextState.bodyClass;
  currentState.render = nextState.render;
  if (resetBody) {
    currentState.version += 1;
    currentState.body?.remove();
    currentState.body = undefined;
    currentState.hydrated = false;
  }
  hydrateLazyDetailsBody(current);
  return true;
}

/** Hydrates one open details body from its latest registered renderer. */
function hydrateLazyDetailsBody(details: HTMLDetailsElement): void {
  const state = lazyDetailsStates.get(details);
  if (!state || !details.open || state.hydrated) return;
  state.hydrated = true;
  const version = ++state.version;
  const body = details.createDiv({ cls: state.bodyClass });
  state.body = body;
  body.createDiv({ text: "Loading details…", cls: "opencode-session-view__tool-empty" });
  const scratch = document.createElement("div");
  lazyRenderOwners.set(scratch, details);
  void Promise.resolve()
    .then(() => state.render(scratch))
    .then(() => {
      if (lazyDetailsStates.get(details) !== state || state.version !== version || state.body !== body || body.parentElement !== details) return;
      body.replaceChildren(...Array.from(scratch.childNodes));
    })
    .catch((error) => console.warn("[opencode-plugin:tool-details] render failed", error));
}

/** Renders a per-block raw-context control and switches between specialized output and the complete source part. */
export async function renderToolDetails(
  container: HTMLElement,
  part: JsonObject,
  ctx: BlockRenderCtx,
  renderFormatted: (body: HTMLElement) => Promise<void>,
): Promise<void> {
  const toolbar = container.createDiv({ cls: "opencode-session-view__tool-body-toolbar" });
  const toolName = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "tool";
  toolbar.createSpan({ text: toolName, cls: "opencode-session-view__tool-raw-name" });
  const toggle = toolbar.createEl("button", {
    cls: "opencode-session-view__raw-toggle clickable-icon",
    attr: { type: "button", "aria-label": "Show raw tool context", "aria-pressed": "false" },
  });
  const icon = toggle.createSpan({ cls: "opencode-session-view__raw-toggle-icon" });
  setIcon(icon, "braces");
  const label = toggle.createSpan({ cls: "opencode-session-view__raw-toggle-label" });
  const content = container.createDiv({ cls: "opencode-session-view__tool-body-content" });
  const details = lazyRenderOwners.get(container) ?? container.closest<HTMLDetailsElement>("details");
  let raw = details?.dataset.toolRaw === "true";
  let renderVersion = 0;

  const refreshToggle = (): void => {
    toggle.setAttr("aria-pressed", String(raw));
    toggle.setAttr("aria-label", raw ? "Show formatted tool context" : "Show raw tool context");
    label.setText(raw ? "Show formatted" : "Show raw");
  };

  const renderCurrent = async (): Promise<void> => {
    const version = ++renderVersion;
    const next = document.createElement("div");
    if (raw) {
      await renderCodeBlock(next, JSON.stringify(part, null, 2), "json", ctx);
    } else {
      await renderFormatted(next);
    }
    if (version !== renderVersion) return;
    content.replaceChildren(...Array.from(next.childNodes));
  };

  toggle.addEventListener("click", () => {
    raw = !raw;
    if (details) details.dataset.toolRaw = String(raw);
    refreshToggle();
    void renderCurrent();
  });
  refreshToggle();
  await renderCurrent();
}

/** Renders markdown through Obsidian's renderer into a fresh markdown-rendered body. */
export async function renderMarkdown(container: HTMLElement, markdown: string, ctx: BlockRenderCtx): Promise<void> {
  const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
  await MarkdownRenderer.renderMarkdown(markdown, body, markdownSourcePath(ctx), ctx.component);
}

/** Renders a labeled markdown output section. */
export async function renderMarkdownSection(container: HTMLElement, label: string, markdown: string, ctx: BlockRenderCtx): Promise<void> {
  container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
  const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
  await MarkdownRenderer.renderMarkdown(markdown, body, markdownSourcePath(ctx), ctx.component);
}

/** Uses MarkdownRenderer fenced code blocks so Obsidian supplies native syntax highlighting. */
export async function renderCodeBlock(container: HTMLElement, code: string, language: string, ctx: BlockRenderCtx): Promise<void> {
  const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
  await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${escapeFence(code)}\n\`\`\``, body, markdownSourcePath(ctx), ctx.component);
}

/** Renders one code line through Obsidian's fenced-code highlighter, then embeds the highlighted tokens inline. */
export async function renderHighlightedCodeLine(container: HTMLElement, code: string, language: string, ctx: BlockRenderCtx): Promise<void> {
  const scratch = document.createElement("div");
  scratch.addClass("markdown-rendered");
  await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${escapeFence(code)}\n\`\`\``, scratch, markdownSourcePath(ctx), ctx.component);
  const highlighted = scratch.querySelector("code");
  if (!highlighted) {
    container.setText(code);
    return;
  }
  while (highlighted.firstChild) container.appendChild(highlighted.firstChild);
}

/** Highlights many code rows in one fenced block; referenced by the shared diff renderer. */
export async function renderHighlightedCodeLines(
  containers: HTMLElement[],
  lines: string[],
  language: string,
  ctx: BlockRenderCtx,
  shouldCommit: () => boolean = () => true,
): Promise<void> {
  if (containers.length === 0) return;
  const scratch = document.createElement("div");
  scratch.addClass("markdown-rendered");
  await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${escapeFence(lines.join("\n"))}\n\`\`\``, scratch, markdownSourcePath(ctx), ctx.component);
  if (!shouldCommit()) return;
  const highlighted = scratch.querySelector("code");
  const highlightedLines = highlighted ? splitHighlightedCodeLines(highlighted, lines.length) : [];
  for (const [index, container] of containers.entries()) {
    if (!container.parentElement?.parentElement) continue;
    const highlightedLine = highlightedLines[index];
    if (!highlightedLine?.hasChildNodes()) {
      container.setText(lines[index] ?? " ");
      continue;
    }
    container.appendChild(highlightedLine);
  }
}

/** Splits highlighted markup at text newlines while preserving token spans within each returned fragment. */
function splitHighlightedCodeLines(code: Element, lineCount: number): DocumentFragment[] {
  const text = code.textContent ?? "";
  const fragments: DocumentFragment[] = [];
  let start = 0;
  for (let index = 0; index < lineCount; index += 1) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const range = document.createRange();
    const startPoint = textBoundary(code, start);
    const endPoint = textBoundary(code, end);
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    fragments.push(range.cloneContents());
    range.detach();
    start = newline === -1 ? text.length : newline + 1;
  }
  return fragments;
}

/** Resolves one text offset to the DOM boundary needed for highlighted-range cloning. */
function textBoundary(root: Element, target: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let last: Text | undefined;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    last = node;
    const end = consumed + node.data.length;
    if (target <= end) return { node, offset: target - consumed };
    consumed = end;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

/** Renders a labeled JSON section through Obsidian's code block highlighter. */
export async function renderJsonSection(container: HTMLElement, label: string, value: JsonObject, ctx: BlockRenderCtx): Promise<void> {
  container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
  await renderCodeBlock(container, JSON.stringify(value, null, 2), "json", ctx);
}

/** Renders tool output verbatim in an Obsidian-native code-style surface. */
export function renderRawTextOutput(container: HTMLElement, output: string | undefined): void {
  if (output === undefined) {
    container.createDiv({ text: "No output yet.", cls: "opencode-session-view__tool-empty" });
    return;
  }
  const block = container.createEl("pre", { cls: "opencode-session-view__tool-output-raw" });
  block.createEl("code", { text: output });
}
