import { setIcon } from "obsidian";
import type { FolderCollapseDisplay } from "../../../settings";

/** Adds state classes and the optional trailing chevron shared by folder row components. */
export function renderFolderCollapseState(
  container: HTMLElement,
  collapsed: boolean,
  collapseDisplay: FolderCollapseDisplay,
): HTMLElement | undefined {
  container.addClass(`opencode-agent-panel__folder-row--${collapseDisplay}`, collapsed ? "is-collapsed" : "is-expanded");
  if (collapseDisplay !== "chevron") return undefined;
  const indicator = container.createDiv({
    cls: "opencode-agent-panel__collapse-indicator",
    attr: { "aria-hidden": "true" },
  });
  setIcon(indicator, collapsed ? "chevron-right" : "chevron-down");
  return indicator;
}

/** Adds the native trailing action shared by session-creation scopes. */
export function renderNewSessionAction(container: HTMLElement): HTMLButtonElement {
  const action = container.createEl("button", {
    cls: "clickable-icon opencode-agent-panel__new-session-action",
    attr: { type: "button", "aria-label": "New session", title: "New session" },
  });
  setIcon(action, "plus");
  return action;
}
