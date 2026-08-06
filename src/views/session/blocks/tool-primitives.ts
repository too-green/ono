import { MarkdownRenderer, type Component } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { escapeFence } from "../diff-parsing";

/**
 * Minimal rendering context threaded through every block module.
 * `component` is the SessionView itself (needed by Obsidian's MarkdownRenderer for lifecycle tracking);
 * `sessionId` drives the synthetic markdown source path used for link resolution.
 */
export interface BlockRenderCtx {
  component: Component;
  sessionId?: string;
  sessionDirectory?: string;
}

/** Builds the synthetic source path MarkdownRenderer uses for internal-link resolution. */
export function markdownSourcePath(ctx: BlockRenderCtx): string {
  return `opencode-session/${ctx.sessionId ?? "session"}.md`;
}

/** Defers expensive details body DOM/Markdown work until a tool disclosure is opened. */
export function renderLazyDetailsBody(details: HTMLDetailsElement, bodyClass: string, render: (body: HTMLElement) => Promise<void>): void {
  let hydrated = false;
  details.addEventListener("toggle", () => {
    if (!details.open || hydrated) return;
    hydrated = true;
    const body = details.createDiv({ cls: bodyClass });
    body.createDiv({ text: "Loading details…", cls: "opencode-session-view__tool-empty" });
    void Promise.resolve().then(() => {
      body.empty();
      return render(body);
    });
  });
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
