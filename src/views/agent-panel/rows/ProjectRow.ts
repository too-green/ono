import { renderFolderCollapseState, renderNewSessionAction } from "./row-primitives";
import type { AgentPanelFolderRowHandle, AgentPanelProjectRowComponent, ProjectRowProps } from "./types";

/** Default Obsidian-native project grouping row used by AgentPanelView. */
export class ProjectRow implements AgentPanelProjectRowComponent {
  /** Renders the project shell while leaving navigation and actions panel-owned. */
  render(container: HTMLElement, props: ProjectRowProps): AgentPanelFolderRowHandle {
    const itemEl = container.createDiv({ cls: "tree-item nav-folder opencode-agent-panel__project" });
    const rowEl = itemEl.createDiv({ cls: "tree-item-self nav-folder-title is-clickable" });
    rowEl.setAttribute("aria-expanded", String(!props.collapsed));

    const avatar = rowEl.createDiv({ text: this.initials(props.project.name), cls: "tree-item-icon opencode-agent-panel__project-avatar" });
    // Per-project identity has no equivalent single Obsidian token; the value still resolves to a built-in color variable.
    avatar.style.setProperty("--opencode-project-avatar-color", this.projectColor(props.project.id));
    rowEl.createDiv({ text: props.project.name, cls: "tree-item-inner nav-folder-title-content" });
    renderFolderCollapseState(rowEl, props.collapsed, props.collapseDisplay);

    const newSessionButtonEl = props.showNewSessionAction ? renderNewSessionAction(rowEl) : undefined;
    const childrenEl = props.collapsed ? undefined : itemEl.createDiv({ cls: "tree-item-children nav-folder-children" });
    return { itemEl, rowEl, childrenEl, newSessionButtonEl };
  }

  /** Generates a short project identity label for the default project-row layout. */
  private initials(name: string): string {
    return name
      .split(/[\s/_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "OC";
  }

  /** Picks a stable built-in Obsidian color token for the default project avatar. */
  private projectColor(projectId: string): string {
    const tokens = ["--color-blue", "--color-green", "--color-yellow", "--color-orange", "--color-purple", "--color-cyan", "--color-pink"];
    const hash = [...projectId].reduce((total, char) => total + char.charCodeAt(0), 0);
    return `var(${tokens[hash % tokens.length]})`;
  }
}
