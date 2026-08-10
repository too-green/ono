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
  let hydrated = false;
  const hydrate = (): void => {
    if (!details.open || hydrated) return;
    hydrated = true;
    const body = details.createDiv({ cls: bodyClass });
    body.createDiv({ text: "Loading details…", cls: "opencode-session-view__tool-empty" });
    void Promise.resolve().then(() => {
      body.empty();
      return render(body);
    });
  };
  details.addEventListener("toggle", hydrate);
  hydrate();
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
  toggle.createSpan({ text: "Show raw", cls: "opencode-session-view__raw-toggle-label" });
  const content = container.createDiv({ cls: "opencode-session-view__tool-body-content" });
  let raw = false;
  let renderVersion = 0;

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
    toggle.setAttr("aria-pressed", String(raw));
    toggle.setAttr("aria-label", raw ? "Show formatted tool context" : "Show raw tool context");
    void renderCurrent();
  });
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
