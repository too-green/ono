import { setIcon } from "obsidian";
import type { SessionVisualStatus, WorkingAnimation } from "./session-state";

/** Lucide glyph for each status that renders an icon instead of a painted span. */
const STATUS_ICONS: Partial<Record<SessionVisualStatus, string>> = {
  attention: "megaphone",
  error: "alert-circle",
  retry: "rotate-cw",
};

export interface StatusBadgeOptions {
  /** Session visual state to paint. */
  status: SessionVisualStatus;
  /** Working animation variant; painted as a data attribute consumed by CSS. */
  workingAnimation: WorkingAnimation;
  /**
   * Glyph rendered when status is idle. Only native session chrome passes one
   * (message-square) so an open OpenCode tab stays recognizable at rest.
   */
  idleGlyph?: string;
}

/**
 * Renders the canonical session status badge used by agent-panel rows, native
 * tab/view-header chrome, assistant-turn meta, and island subagent rows.
 * Referenced by SessionRow, SessionView, message-meta, and session-island-controller.
 */
export function renderStatusBadge(container: HTMLElement, options: StatusBadgeOptions): HTMLElement {
  const badge = container.createDiv({ cls: "opencode-status-badge" });
  paintStatusBadge(badge, options);
  return badge;
}

/**
 * Idempotently repaints a badge element in place; referenced wherever a mounted
 * badge survives across status changes (row updates, chrome redecoration).
 */
export function paintStatusBadge(badge: HTMLElement, options: StatusBadgeOptions): void {
  const signature = `${options.status}:${options.workingAnimation}`;
  if (badge.dataset.statusSignature === signature) return;
  badge.empty();
  badge.className = `opencode-status-badge opencode-status-badge--${options.status}`;
  badge.dataset.status = options.status;
  badge.dataset.workingAnimation = options.workingAnimation;
  badge.dataset.statusSignature = signature;
  const icon = STATUS_ICONS[options.status] ?? (options.status === "idle" ? options.idleGlyph : undefined);
  if (icon) setIcon(badge, icon);
  if (options.status === "working" || options.status === "done") badge.createSpan();
}
