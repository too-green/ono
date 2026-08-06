import { MarkdownRenderer, setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { reasoningComplete, reasoningText, reasoningTokenCount } from "../message-helpers";
import { markdownSourcePath, type BlockRenderCtx } from "./tool-primitives";

/** Renders consecutive assistant reasoning parts as one collapsed Thinking/Thought block; referenced by `TimelineRenderer`. Returns true when something was rendered. */
export async function renderReasoningBlock(
  container: HTMLElement,
  parts: JsonObject[],
  info: JsonObject,
  ctx: BlockRenderCtx,
): Promise<boolean> {
  const text = reasoningText(parts);
  if (!text) return false;

  const complete = reasoningComplete(parts);
  const tokens = reasoningTokenCount(info);
  const details = container.createEl("details", { cls: `opencode-session-view__reasoning opencode-session-view__reasoning--${complete ? "complete" : "streaming"}` });
  const summary = details.createEl("summary", { cls: "opencode-session-view__reasoning-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__reasoning-icon" });
  setIcon(icon, "brain");
  summary.createSpan({
    text: complete && tokens ? `Thought for ${tokens.toLocaleString()} tokens` : complete ? "Thought" : "Thinking",
    cls: "opencode-session-view__reasoning-title",
  });
  if (!complete) summary.createSpan({ cls: "opencode-session-view__reasoning-spinner" });

  const body = details.createDiv({ cls: "opencode-session-view__reasoning-body opencode-session-view__markdown markdown-rendered" });
  bindStreamingTextTarget(body, parts);
  await MarkdownRenderer.renderMarkdown(text, body, markdownSourcePath(ctx), ctx.component);
  return true;
}

/** Marks a rendered prose block as directly patchable while its single source part streams. */
export function bindStreamingTextTarget(body: HTMLElement, parts: JsonObject[]): void {
  if (parts.length !== 1) return;
  const partId = readPartId(parts[0]);
  if (!partId) return;
  body.setAttr("data-part-id", partId);
  body.setAttr("data-stream-field", "text");
}

function readPartId(part: JsonObject): string | undefined {
  const direct = part["id"];
  if (typeof direct === "string") return direct;
  const partID = part["partID"];
  if (typeof partID === "string") return partID;
  const partId = part["partId"];
  return typeof partId === "string" ? partId : undefined;
}
