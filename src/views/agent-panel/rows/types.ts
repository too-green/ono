import type { SessionVisualStatus, WorkingAnimation } from "../../../session-state";
import type { FolderCollapseDisplay } from "../../../settings";

/** Session data available to every agents-panel session-row implementation. */
export interface AgentPanelSession {
  id: string;
  title: string;
  directory: string;
  createdAt?: number;
  updatedAt?: number;
  status: SessionVisualStatus;
  muted: boolean;
  requiresAttention: boolean;
}

/** Worktree data available to every agents-panel worktree-row implementation. */
export interface AgentPanelWorktree {
  id: string;
  name: string;
  path: string;
  sessions: AgentPanelSession[];
}

/** Project data available to every agents-panel project-row implementation. */
export interface AgentPanelProject {
  id: string;
  name: string;
  openedDirectories: string[];
  worktrees: AgentPanelWorktree[];
}

/** Stable elements returned by every row component for panel-owned interactions. */
export interface AgentPanelRowHandle {
  itemEl: HTMLElement;
  rowEl: HTMLElement;
}

/** Stable elements returned by collapsible project and worktree rows. */
export interface AgentPanelFolderRowHandle extends AgentPanelRowHandle {
  childrenEl?: HTMLElement;
  newSessionButtonEl?: HTMLButtonElement;
}

/** Stable elements and updates exposed by a session-row layout. */
export interface AgentPanelSessionRowHandle extends AgentPanelRowHandle {
  titleEl: HTMLElement;
  /** Updates all mutable row presentation while retaining the mounted row shell. */
  updatePresentation?(session: AgentPanelSession, active: boolean, workingAnimation: WorkingAnimation): void;
  /** Updates active selection without exposing the component's styling structure. */
  updateActive(active: boolean): void;
  /** Repaints status without requiring the panel to know the component's DOM structure. */
  updateStatus(status: SessionVisualStatus, workingAnimation: WorkingAnimation): void;
}

/** Visual inputs consumed by a project-row component. */
export interface ProjectRowProps {
  project: AgentPanelProject;
  collapsed: boolean;
  collapseDisplay: FolderCollapseDisplay;
  showNewSessionAction: boolean;
}

/** Visual inputs consumed by a worktree-row component. */
export interface WorktreeRowProps {
  worktree: AgentPanelWorktree;
  collapsed: boolean;
  collapseDisplay: FolderCollapseDisplay;
}

/** Visual inputs consumed by a session-row component. */
export interface SessionRowProps {
  session: AgentPanelSession;
  active: boolean;
  workingAnimation: WorkingAnimation;
}

/** Replaceable renderer contract for project grouping rows. */
export interface AgentPanelProjectRowComponent {
  /** Creates one project row and returns the elements used by AgentPanelView. */
  render(container: HTMLElement, props: ProjectRowProps): AgentPanelFolderRowHandle;
}

/** Replaceable renderer contract for worktree grouping rows. */
export interface AgentPanelWorktreeRowComponent {
  /** Creates one worktree row and returns the elements used by AgentPanelView. */
  render(container: HTMLElement, props: WorktreeRowProps): AgentPanelFolderRowHandle;
}

/** Replaceable renderer contract for leaf session rows. */
export interface AgentPanelSessionRowComponent {
  /** Creates one session row and returns the elements used by AgentPanelView. */
  render(container: HTMLElement, props: SessionRowProps): AgentPanelSessionRowHandle;
}

/** Complete replaceable component set used to render the agents-panel tree. */
export interface AgentPanelRowComponents {
  project: AgentPanelProjectRowComponent;
  worktree: AgentPanelWorktreeRowComponent;
  session: AgentPanelSessionRowComponent;
}
