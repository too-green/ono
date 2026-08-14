import { setIcon } from "obsidian";
import type { SessionVisualStatus, WorkingAnimation } from "../../../session-state";
import type { AgentPanelSessionRowComponent, AgentPanelSessionRowHandle, SessionRowProps } from "./types";

/** Default compact Obsidian-native session row used by AgentPanelView. */
export class SessionRow implements AgentPanelSessionRowComponent {
  /** Renders one session row and exposes stable title/status operations to the panel. */
  render(container: HTMLElement, props: SessionRowProps): AgentPanelSessionRowHandle {
    const itemEl = container.createDiv({ cls: "tree-item nav-file opencode-agent-panel__session" });
    const rowEl = itemEl.createDiv({ cls: "tree-item-self nav-file-title is-clickable" });
    if (props.active) rowEl.addClass("is-active");

    const statusEl = rowEl.createDiv({ cls: "tree-item-icon" });
    this.paintStatus(statusEl, props.session.status, props.workingAnimation);
    const titleEl = rowEl.createDiv({ text: props.session.title, cls: "tree-item-inner nav-file-title-content" });

    if (props.session.muted) {
      const notification = rowEl.createDiv({ cls: "opencode-agent-panel__notification" });
      setIcon(notification, "bell-off");
    }
    this.renderModifiedTime(rowEl, props.session.updatedAt ?? props.session.createdAt);

    return {
      itemEl,
      rowEl,
      titleEl,
      updateActive: (active) => rowEl.classList.toggle("is-active", active),
      updateStatus: (status, workingAnimation) => this.paintStatus(statusEl, status, workingAnimation),
    };
  }

  /** Paints the status slot owned by this session-row layout. */
  private paintStatus(slot: HTMLElement, status: SessionVisualStatus, workingAnimation: WorkingAnimation): void {
    slot.empty();
    slot.className = `tree-item-icon opencode-agent-panel__status opencode-agent-panel__status--${status}`;
    slot.dataset.workingAnimation = workingAnimation;
    if (status === "attention") setIcon(slot, "megaphone");
    if (status === "error") setIcon(slot, "alert-circle");
    if (status === "retry") setIcon(slot, "rotate-cw");
    if (status === "done" || status === "working") slot.createSpan();
  }

  /** Adds a compact relative modified timestamp at the row's trailing edge. */
  private renderModifiedTime(container: HTMLElement, timestamp: number | undefined): void {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return;
    container.createEl("time", {
      text: relativeModifiedTime(timestamp),
      cls: "opencode-agent-panel__session-modified",
      attr: {
        datetime: date.toISOString(),
        title: `Modified ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`,
      },
    });
  }
}

/** Formats an epoch-millisecond timestamp for compact display in a narrow sidebar. */
export function relativeModifiedTime(timestamp: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}
