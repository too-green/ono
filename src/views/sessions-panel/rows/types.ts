import type { SessionVisualStatus, WorkingAnimation } from "../../../session-state";
import type { FolderCollapseDisplay } from "../../../settings";

/** Session data available to every sessions-panel session-row implementation. */
export interface SessionsPanelSession {
  id: string;
  title: string;
  directory: string;
  createdAt?: number;
  updatedAt?: number;
  status: SessionVisualStatus;
  muted: boolean;
  requiresAttention: boolean;
}

/** Worktree data available to every sessions-panel worktree-row implementation. */
export interface SessionsPanelWorktree {
  id: string;
  name: string;
  path: string;
  sessions: SessionsPanelSession[];
}

/** Project data available to every sessions-panel project-row implementation. */
export interface SessionsPanelProject {
  id: string;
  name: string;
  openedDirectories: string[];
  worktrees: SessionsPanelWorktree[];
}

/** Stable elements returned by every row component for panel-owned interactions. */
export interface SessionsPanelRowHandle {
  itemEl: HTMLElement;
  rowEl: HTMLElement;
}

/** Stable elements returned by collapsible project and worktree rows. */
export interface SessionsPanelFolderRowHandle extends SessionsPanelRowHandle {
  childrenEl?: HTMLElement;
  newSessionButtonEl?: HTMLButtonElement;
}

/** Stable elements and updates exposed by a session-row layout. */
export interface SessionsPanelSessionRowHandle extends SessionsPanelRowHandle {
  titleEl: HTMLElement;
  /** Updates all mutable row presentation while retaining the mounted row shell. */
  updatePresentation?(session: SessionsPanelSession, active: boolean, workingAnimation: WorkingAnimation): void;
  /** Updates active selection without exposing the component's styling structure. */
  updateActive(active: boolean): void;
  /** Repaints status without requiring the panel to know the component's DOM structure. */
  updateStatus(status: SessionVisualStatus, workingAnimation: WorkingAnimation): void;
}

/** Visual inputs consumed by a project-row component. */
export interface ProjectRowProps {
  project: SessionsPanelProject;
  collapsed: boolean;
  collapseDisplay: FolderCollapseDisplay;
  showNewSessionAction: boolean;
}

/** Visual inputs consumed by a worktree-row component. */
export interface WorktreeRowProps {
  worktree: SessionsPanelWorktree;
  collapsed: boolean;
  collapseDisplay: FolderCollapseDisplay;
}

/** Visual inputs consumed by a session-row component. */
export interface SessionRowProps {
  session: SessionsPanelSession;
  active: boolean;
  workingAnimation: WorkingAnimation;
}

/** Replaceable renderer contract for project grouping rows. */
export interface SessionsPanelProjectRowComponent {
  /** Creates one project row and returns the elements used by SessionsPanelView. */
  render(container: HTMLElement, props: ProjectRowProps): SessionsPanelFolderRowHandle;
}

/** Replaceable renderer contract for worktree grouping rows. */
export interface SessionsPanelWorktreeRowComponent {
  /** Creates one worktree row and returns the elements used by SessionsPanelView. */
  render(container: HTMLElement, props: WorktreeRowProps): SessionsPanelFolderRowHandle;
}

/** Replaceable renderer contract for leaf session rows. */
export interface SessionsPanelSessionRowComponent {
  /** Creates one session row and returns the elements used by SessionsPanelView. */
  render(container: HTMLElement, props: SessionRowProps): SessionsPanelSessionRowHandle;
}

/** Complete replaceable component set used to render the sessions-panel tree. */
export interface SessionsPanelRowComponents {
  project: SessionsPanelProjectRowComponent;
  worktree: SessionsPanelWorktreeRowComponent;
  session: SessionsPanelSessionRowComponent;
}
