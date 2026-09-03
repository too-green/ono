import { setIcon } from "obsidian";
import { renderFolderCollapseState, renderNewSessionAction } from "./row-primitives";
import type { SessionsPanelFolderRowHandle, SessionsPanelWorktreeRowComponent, WorktreeRowProps } from "./types";

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
    renderFolderCollapseState(rowEl, props.collapsed, props.collapseDisplay);
    rowEl.title = props.worktree.path;

    const newSessionButtonEl = renderNewSessionAction(rowEl);
    const childrenEl = props.collapsed ? undefined : itemEl.createDiv({ cls: "tree-item-children nav-folder-children" });
    return { itemEl, rowEl, childrenEl, newSessionButtonEl };
  }
}
