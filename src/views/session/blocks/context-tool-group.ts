import { setIcon } from "obsidian";

import type { JsonObject } from "../../../services/opencode-types";
import { contextSummary, renderToolCall } from "./tool-renderer";
import { renderLazyDetailsBody, type BlockRenderCtx } from "./tool-primitives";

/** Renders consecutive read/search/list tools under one collapsed context-gathering container; called by `TimelineRenderer`. */
export async function renderContextToolGroup(container: HTMLElement, parts: JsonObject[], ctx: BlockRenderCtx): Promise<void> {
  const details = container.createEl("details", { cls: "opencode-session-view__tool-group opencode-session-view__tool" });
  const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
  const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
  setIcon(icon, "search");
  summary.createSpan({ text: "Gathered context", cls: "opencode-session-view__tool-title" });
  summary.createSpan({ text: contextSummary(parts), cls: "opencode-session-view__tool-subtitle" });

  renderLazyDetailsBody(details, "opencode-session-view__tool-group-list", async (list) => {
    for (const part of parts) await renderToolCall(list, part, ctx);
  });
}
