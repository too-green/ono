import { setIcon } from "obsidian";
import { renderFolderCollapseState, renderNewSessionAction } from "./row-primitives";
import type { SessionsPanelFolderRowHandle, SessionsPanelWorktreeRowComponent, WorktreeRowProps, WorktreeState } from "./types";

/** Returns consistent labels and icons for worktree row and menu status indicators. */
export function worktreeStatePresentation(state: WorktreeState): { label: string; icon: string; operation: boolean } {
  switch (state) {
    case "pending": return { label: "Worktree startup pending", icon: "loader-2", operation: false };
    case "failed": return { label: "Worktree startup failed", icon: "alert-circle", operation: false };
    case "removing": return { label: "Removing worktree...", icon: "loader-2", operation: true };
    case "resetting": return { label: "Resetting worktree...", icon: "loader-2", operation: true };
  }
}

/** Default Obsidian-native worktree grouping row used by SessionsPanelView. */
export class WorktreeRow implements SessionsPanelWorktreeRowComponent {
  /** Renders the worktree shell while leaving navigation and actions panel-owned. */
  render(container: HTMLElement, props: WorktreeRowProps): SessionsPanelFolderRowHandle {
    const itemEl = container.createDiv({ cls: "tree-item nav-folder opencode-sessions-panel__worktree" });
    const rowEl = itemEl.createDiv({ cls: "tree-item-self nav-folder-title is-clickable" });
    rowEl.setAttribute("aria-expanded", String(!props.collapsed));

    const icon = rowEl.createDiv({ cls: "tree-item-icon opencode-sessions-panel__worktree-icon" });
    setIcon(icon, "git-branch");
    rowEl.createDiv({ text: props.worktree.name, cls: "tree-item-inner nav-folder-title-content" });
    if (props.worktree.startupState) {
      const presentation = worktreeStatePresentation(props.worktree.startupState);
      const state = rowEl.createSpan({
        cls: `opencode-sessions-panel__worktree-state ${props.worktree.startupState === "failed" ? "is-failed" : "is-pending"}${presentation.operation ? " is-operation" : ""}`,
        attr: {
          "aria-label": presentation.label,
          title: props.worktree.startupMessage ?? presentation.label,
        },
      });
      setIcon(state, presentation.icon);
      if (presentation.operation) state.createSpan({ text: presentation.label, cls: "opencode-sessions-panel__worktree-state-label" });
    }
    renderFolderCollapseState(rowEl, props.collapsed, props.collapseDisplay);
    rowEl.title = props.worktree.path;

    const newSessionButtonEl = renderNewSessionAction(rowEl);
    const childrenEl = props.collapsed ? undefined : itemEl.createDiv({ cls: "tree-item-children nav-folder-children" });
    return { itemEl, rowEl, childrenEl, newSessionButtonEl };
  }
}
