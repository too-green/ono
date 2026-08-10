import { MarkdownRenderer, setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { reasoningComplete, reasoningText, reasoningTokenCount } from "../message-helpers";
import { bindDisclosureState, blockPartId, disclosureKey, markdownSourcePath, type BlockRenderCtx } from "./tool-primitives";

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
  bindDisclosureState(details, disclosureKey(ctx, "reasoning", parts.slice(0, 1)), ctx.openDisclosures);
  const summary = details.createEl("summary", { cls: "opencode-session-view__reasoning-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__reasoning-icon" });
  setIcon(icon, "brain");
  summary.createSpan({
    text: complete && tokens ? `Thought for ${tokens.toLocaleString()} tokens` : complete ? "Thought" : "Thinking",
    cls: "opencode-session-view__reasoning-title",
  });

  const body = details.createDiv({ cls: "opencode-session-view__reasoning-body opencode-session-view__markdown markdown-rendered" });
  bindStreamingTextTarget(body, parts);
  await MarkdownRenderer.renderMarkdown(text, body, markdownSourcePath(ctx), ctx.component);
  return true;
}

/** Marks a rendered prose block as directly patchable by every grouped source part. */
export function bindStreamingTextTarget(body: HTMLElement, parts: JsonObject[]): void {
  const partIds = parts.map(blockPartId).filter((id): id is string => !!id);
  if (partIds.length === 0) return;
  body.setAttr("data-part-id", partIds[0]);
  body.setAttr("data-part-ids", partIds.join(" "));
  body.setAttr("data-stream-field", "text");
}
