import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type OpenCodePlugin from "../../main";
import { DELETE_CURRENT_FILE_COMMANDS, RENAME_CURRENT_FILE_COMMANDS, matchesObsidianCommandHotkey } from "../obsidian-hotkeys";
import type { OpenCodeEventSubscription } from "../services/opencode-events";
import { logServiceError } from "../services/opencode-http";
import type { JsonObject, OpenCodeEvent, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from "../services/opencode-types";
import { isActiveSessionStatus, normalizeWorkingAnimation, visualStatusForSession, type SessionVisualStatus } from "../session-state";

export const VIEW_TYPE_OPENCODE_AGENT_PANEL = "opencode-agent-panel";

interface AgentPanelProject {
  id: string;
  name: string;
  openedDirectories: string[];
  worktrees: AgentPanelWorktree[];
}

interface AgentPanelWorktree {
  id: string;
  name: string;
  path: string;
  sessions: AgentPanelSession[];
}

interface AgentPanelSession {
  id: string;
  title: string;
  directory: string;
  status: SessionVisualStatus;
  muted: boolean;
  requiresAttention: boolean;
  children: AgentPanelSession[];
}

interface OpenCodeProjectMeta {
  id: string;
  name: string;
  worktree?: string;
  sandboxes: string[];
}

interface OpenedDirectoryContext {
  directory: string;
  project?: JsonObject;
}

interface AgentPanelVisibleRow {
  key: string;
  kind: "project" | "worktree" | "session" | "new-session";
  element: HTMLElement;
  session?: AgentPanelSession;
  directory?: string;
}

export class AgentPanelView extends ItemView {
  private collapsed = new Set<string>();
  private activeSessionId?: string;
  private highlightedKey?: string;
  private eventSubscriptions: OpenCodeEventSubscription[] = [];
  private eventSubscriptionDirectoriesKey = "";
  private visibleRows: AgentPanelVisibleRow[] = [];
  private loading = false;
  private refreshQueued = false;
  private refreshTimer?: number;
  private lastRenderedTreeSignature = "";
  private lastKnownSessionStatuses = new Map<string, string>();
  private requestAttentionSessionIds = new Set<string>();
  private sessionParentIds = new Map<string, string>();
  private sessionChildrenCache = new Map<string, OpenCodeSession[]>();
  private sessionListCache = new Map<string, OpenCodeSession[]>();
  private permissionRequestCache = new Map<string, OpenCodePermissionRequest[]>();
  private questionRequestCache = new Map<string, OpenCodeQuestionRequest[]>();
  private transientLoadFailure = false;
  private refreshRetryDelay = 1_000;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(leaf);
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_AGENT_PANEL;
  }

  /** Returns the display label shown in Obsidian sidebars and tabs. */
  getDisplayText(): string {
    return "OpenCode agents";
  }

  /** Returns the Lucide icon used by the sidebar tab and ribbon command. */
  getIcon(): string {
    return "bot";
  }

  /** Builds the panel shell and loads read-only OpenCode data when opened. */
  async onOpen(): Promise<void> {
    this.contentEl.addClass("opencode-sidebar-panel");
    this.contentEl.addClass("opencode-sidebar-panel--agents");
    this.contentEl.tabIndex = 0;
    this.contentEl.addEventListener("keydown", this.handleKeydown);
    this.syncEventSubscriptions(this.plugin.getOpenedDirectories());
    await this.refresh();
  }

  /** Clears the panel when Obsidian closes the view. */
  async onClose(): Promise<void> {
    this.contentEl.removeEventListener("keydown", this.handleKeydown);
    this.closeEventSubscriptions();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.contentEl.empty();
  }

  /** Subscribes to sidebar-relevant OpenCode events so token streaming does not blink the tree. */
  private syncEventSubscriptions(directories: string[]): void {
    const key = [...directories].sort().join("\n");
    if (key === this.eventSubscriptionDirectoriesKey && this.eventSubscriptions.length > 0) return;
    this.closeEventSubscriptions();
    this.eventSubscriptionDirectoriesKey = key;
    this.eventSubscriptions = directories.map((directory) =>
      this.plugin.requireOpenCodeService().subscribeToEvents(
        {
          onEvent: (event) => {
            this.applyLiveSessionEvent(event);
            if (this.shouldRefreshForEvent(event.type)) this.scheduleRefresh();
          },
        },
        directory,
      ),
    );
  }

  /** Closes all directory-scoped event streams owned by this panel. */
  private closeEventSubscriptions(): void {
    for (const subscription of this.eventSubscriptions) subscription.close();
    this.eventSubscriptions = [];
  }

  /** Returns true for events that can change project/session rows or their status badges. */
  private shouldRefreshForEvent(type: string): boolean {
    return (
      type === "session.created" ||
      type === "session.updated" ||
      type === "session.deleted" ||
      type === "session.status" ||
      type === "session.idle" ||
      type === "session.error" ||
      type === "permission.asked" ||
      type === "permission.replied" ||
      type === "question.asked" ||
      type === "question.replied" ||
      type === "question.rejected" ||
      type === "project.updated"
    );
  }

  /** Debounces event-driven reloads to avoid rendering every streaming event individually. */
  private scheduleRefresh(delay = 250): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh({ showLoading: false });
    }, delay);
  }

  /** Reloads projects, sessions, and statuses using only OpenCode GET endpoints. */
  async refresh(options: { showLoading?: boolean } = {}): Promise<void> {
    if (this.loading) {
      this.refreshQueued = true;
      return;
    }
    this.loading = true;
    this.transientLoadFailure = false;
    if (options.showLoading !== false || !this.contentEl.hasChildNodes()) this.renderLoading();

    try {
      const service = this.plugin.requireOpenCodeService();
      await service.health();
      const openedDirectories = this.plugin.getOpenedDirectories();
      this.syncEventSubscriptions(openedDirectories);
      const [projects, openedContexts, sessionGroups, statuses, permissionGroups, questionGroups] = await Promise.all([
        openedDirectories[0] ? service.listProjects(openedDirectories[0]).catch(logServiceError([], "listProjects", openedDirectories[0])) : Promise.resolve([]),
        Promise.all(
          openedDirectories.map(async (directory): Promise<OpenedDirectoryContext> => ({
            directory,
            project: await service.getCurrentProject(directory).catch(logServiceError(undefined, "getCurrentProject", directory)),
          })),
        ),
        Promise.all(openedDirectories.map((directory) => this.listSessions(directory))),
        service.getSessionStatus().catch(logServiceError(undefined, "getSessionStatus")),
        Promise.all(openedDirectories.map((directory) => this.listPermissionRequests(directory))),
        Promise.all(openedDirectories.map((directory) => this.listQuestionRequests(directory))),
      ]);
      const sessionDirectoryById = new Map<string, string>();
      sessionGroups.forEach((sessionsForDirectory, index) => {
        const directory = openedDirectories[index];
        if (!directory) return;
        sessionsForDirectory.forEach((session) => sessionDirectoryById.set(session.id, directory));
      });
      const sessions = this.uniqueSessions(sessionGroups.flat()).filter((session) => !this.isArchived(session));
      this.sessionParentIds = new Map(
        sessions.flatMap((session) => {
          const parentId = this.readString(session, ["parentID", "parentId"]);
          return parentId ? [[session.id, parentId] as const] : [];
        }),
      );
      const statusSnapshot = statuses && typeof statuses === "object" && !Array.isArray(statuses) ? (statuses as JsonObject) : {};
      const requestOwnerIds = new Set<string>();
      for (const request of [...permissionGroups.flat(), ...questionGroups.flat()]) {
        const sessionId = this.readString(request, ["sessionID", "sessionId"]);
        if (sessionId) requestOwnerIds.add(sessionId);
      }
      if (this.transientLoadFailure) this.requestAttentionSessionIds.forEach((sessionId) => requestOwnerIds.add(sessionId));
      this.propagateRequestAttentionToAncestors(requestOwnerIds, sessions);
      if (statuses) this.reconcileSessionStatusSnapshot(statusSnapshot);
      const tree = await this.buildProjectTree(
        [...(Array.isArray(projects) ? projects : []), ...openedContexts.flatMap((context) => (context.project ? [context.project] : []))],
        sessions,
        statusSnapshot,
        openedContexts,
        sessionDirectoryById,
        requestOwnerIds,
      );
      const nextRequestAttentionIds = this.collectRequestAttentionIds(tree);
      if (this.transientLoadFailure) this.requestAttentionSessionIds.forEach((sessionId) => nextRequestAttentionIds.add(sessionId));
      this.requestAttentionSessionIds = nextRequestAttentionIds;
      const treeSignature = JSON.stringify(tree);
      if (treeSignature === this.lastRenderedTreeSignature) return;
      this.lastRenderedTreeSignature = treeSignature;
      this.renderTree(tree);
    } catch (error) {
      this.lastRenderedTreeSignature = "";
      this.renderDisconnected(error);
    } finally {
      this.loading = false;
      if (this.transientLoadFailure) {
        this.scheduleRefresh(this.refreshRetryDelay);
        this.refreshRetryDelay = Math.min(this.refreshRetryDelay * 2, 30_000);
      } else {
        this.refreshRetryDelay = 1_000;
      }
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh({ showLoading: false });
      }
    }
  }

  /** Builds the project/session tree that the sidebar renderer consumes. */
  private async buildProjectTree(
    projects: JsonObject[],
    sessions: OpenCodeSession[],
    statuses: JsonObject,
    openedContexts: OpenedDirectoryContext[],
    sessionDirectoryById: Map<string, string>,
    requestOwnerIds: Set<string>,
  ): Promise<AgentPanelProject[]> {
    const sessionsByProject = new Map<string, Map<string, OpenCodeSession[]>>();
    const knownProjects = new Map<string, OpenCodeProjectMeta>();
    const openedByProject = new Map<string, Set<string>>();

    for (const project of projects) {
      const id = this.readString(project, ["id", "ID", "projectID"]);
      if (!id) continue;
      const worktree = this.readString(project, ["worktree", "directory", "path"]);
      knownProjects.set(id, {
        id,
        worktree,
        name: this.readString(project, ["name", "title"]) ?? (worktree ? this.basename(worktree) : id),
        sandboxes: this.readStringArray(project, "sandboxes"),
      });
    }

    for (const context of openedContexts) {
      const project = this.effectiveProjectForOpenedDirectory(context, knownProjects);
      const worktree = this.effectiveWorktreeForOpenedDirectory(context, knownProjects.get(project.id));
      const worktrees = sessionsByProject.get(project.id) ?? new Map<string, OpenCodeSession[]>();
      worktrees.set(worktree.id, worktrees.get(worktree.id) ?? []);
      sessionsByProject.set(project.id, worktrees);
      openedByProject.set(project.id, (openedByProject.get(project.id) ?? new Set()).add(context.directory));
      if (!knownProjects.has(project.id)) knownProjects.set(project.id, { id: project.id, name: project.name, worktree: worktree.path, sandboxes: [] });
    }

    for (const session of sessions) {
      const project = this.effectiveProjectForSession(session, knownProjects);
      const worktree = this.effectiveWorktreeForSession(session, knownProjects.get(project.id), sessionDirectoryById.get(session.id));
      const worktrees = sessionsByProject.get(project.id) ?? new Map<string, OpenCodeSession[]>();
      worktrees.set(worktree.id, [...(worktrees.get(worktree.id) ?? []), session]);
      sessionsByProject.set(project.id, worktrees);
      if (!knownProjects.has(project.id)) knownProjects.set(project.id, { id: project.id, name: project.name, worktree: worktree.path, sandboxes: [] });
    }

    const entries = [...sessionsByProject.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Promise.all(
      entries.map(async ([projectId, worktreeMap]) => ({
        id: projectId,
        name: knownProjects.get(projectId)?.name ?? projectId,
        openedDirectories: [...(openedByProject.get(projectId) ?? new Set())],
        worktrees: await Promise.all(
          [...worktreeMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(async ([worktreeId, worktreeSessions]) => ({
            id: worktreeId,
            name: this.basename(worktreeId),
            path: worktreeId,
            sessions: await this.buildSessionNodes(worktreeSessions, statuses, requestOwnerIds),
          })),
        ),
      })),
    );
  }

  /** Recursively hydrates session children for a project branch. */
  private async buildSessionNodes(sessions: OpenCodeSession[], statuses: JsonObject, requestOwnerIds: Set<string>): Promise<AgentPanelSession[]> {
    const roots = sessions.filter((session) => !this.readString(session, ["parentID", "parentId"]));
    const sortedRoots = roots.length > 0 ? roots : sessions;
    return Promise.all(sortedRoots.sort((a, b) => this.sessionTitle(a).localeCompare(this.sessionTitle(b))).map((session) => this.buildSessionNode(session, statuses, requestOwnerIds)));
  }

  /** Hydrates a single session node and its OpenCode child sessions. */
  private async buildSessionNode(session: OpenCodeSession, statuses: JsonObject, requestOwnerIds: Set<string>): Promise<AgentPanelSession> {
    const service = this.plugin.requireOpenCodeService();
    const id = session.id;
    const directory = this.effectiveDirectoryForSession(session);
    const fallback = this.sessionChildrenCache.get(id) ?? [];
    const children = await service.listSessionChildren(id, directory).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listSessionChildren", id)(error);
    });
    this.sessionChildrenCache.set(id, children);
    children.forEach((child) => this.sessionParentIds.set(child.id, id));
    const childNodes = await Promise.all(children.filter((child) => !this.isArchived(child)).map((child) => this.buildSessionNode(child, statuses, requestOwnerIds)));
    const requiresAttention = requestOwnerIds.has(id) || childNodes.some((child) => child.requiresAttention);

    return {
      id,
      title: this.sessionTitle(session),
      directory,
      status: this.visualStatusFor(id, statuses, requiresAttention),
      muted: this.plugin.settings.sessionMute[id] === true,
      requiresAttention,
      children: childNodes,
    };
  }

  /** Adds every known ancestor of a request owner so parent rows retain attention during child-fetch failures. */
  private propagateRequestAttentionToAncestors(requestOwnerIds: Set<string>, sessions: OpenCodeSession[]): void {
    const parentById = new Map(sessions.map((session) => [session.id, this.readString(session, ["parentID", "parentId"])]));
    for (const ownerId of [...requestOwnerIds]) {
      const visited = new Set<string>();
      let parentId = parentById.get(ownerId);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        requestOwnerIds.add(parentId);
        parentId = parentById.get(parentId);
      }
    }
  }

  /** Lists permissions with the last successful directory snapshot as a transient-failure fallback. */
  private async listPermissionRequests(directory: string): Promise<OpenCodePermissionRequest[]> {
    const fallback = this.permissionRequestCache.get(directory) ?? [];
    const requests = await this.plugin.requireOpenCodeService().listPermissionRequests(directory).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listPermissionRequests", directory)(error);
    });
    this.permissionRequestCache.set(directory, requests);
    return requests;
  }

  /** Lists questions with the last successful directory snapshot as a transient-failure fallback. */
  private async listQuestionRequests(directory: string): Promise<OpenCodeQuestionRequest[]> {
    const fallback = this.questionRequestCache.get(directory) ?? [];
    const requests = await this.plugin.requireOpenCodeService().listQuestionRequests(directory).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listQuestionRequests", directory)(error);
    });
    this.questionRequestCache.set(directory, requests);
    return requests;
  }

  /** Lists sessions with the last successful directory snapshot as a transient-failure fallback. */
  private async listSessions(directory: string): Promise<OpenCodeSession[]> {
    const fallback = this.sessionListCache.get(directory) ?? [];
    const sessions = await this.plugin.requireOpenCodeService().listSessions({ directory, limit: 100 }).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listSessions", directory)(error);
    });
    this.sessionListCache.set(directory, sessions);
    return sessions;
  }

  /** Collects owner and ancestor ids whose rows must retain attention over live status events. */
  private collectRequestAttentionIds(projects: AgentPanelProject[]): Set<string> {
    const ids = new Set<string>();
    const collect = (session: AgentPanelSession): void => {
      if (session.requiresAttention) ids.add(session.id);
      session.children.forEach(collect);
    };
    projects.forEach((project) => project.worktrees.forEach((worktree) => worktree.sessions.forEach(collect)));
    return ids;
  }

  /** Renders a centered loading state that matches Obsidian empty-state styling. */
  private renderLoading(): void {
    this.contentEl.empty();
    this.renderHeader();
    const state = this.contentEl.createDiv({ cls: "opencode-agent-panel__state" });
    state.createDiv({ cls: "opencode-agent-panel__spinner" });
    state.createDiv({ text: "Loading OpenCode sessions…", cls: "opencode-agent-panel__state-text" });
  }

  /** Renders the disconnected state specified for missing or stopped OpenCode servers. */
  private renderDisconnected(error: unknown): void {
    this.contentEl.empty();
    this.renderHeader();
    const state = this.contentEl.createDiv({ cls: "opencode-agent-panel__state" });
    state.createDiv({ text: "opencode server not running.", cls: "opencode-agent-panel__state-title" });
    state.createDiv({ text: "Start it with `opencode serve` in a terminal.", cls: "opencode-agent-panel__state-text" });
    const retry = state.createEl("button", { text: "Retry connection", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.refresh());
    if (error instanceof Error) state.createDiv({ text: error.message, cls: "opencode-agent-panel__error-detail" });
  }

  /** Renders the full project tree using Obsidian's native nav/tree class vocabulary. */
  private renderTree(projects: AgentPanelProject[]): void {
    this.contentEl.empty();
    this.visibleRows = [];
    this.renderHeader();

    const nav = this.contentEl.createDiv({ cls: "nav-files-container node-insert-event opencode-sidebar-panel__content opencode-agent-panel__tree" });
    const root = nav.createDiv({ cls: "tree-item nav-folder opencode-agent-panel__root" });

    if (projects.length === 0) {
      this.renderEmptyTree(nav);
      return;
    }

    for (const project of projects) this.renderProject(root, project);
    if (!this.visibleRows.some((row) => row.key === this.highlightedKey)) {
      this.highlightedKey = this.visibleRows[0]?.key;
      this.applyHighlight();
    }
  }

  /** Renders the panel header with native clickable-icon affordances. */
  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: "opencode-sidebar-panel__header opencode-agent-panel__header" });
    header.createDiv({ text: "OpenCode", cls: "opencode-agent-panel__title" });
    const actions = header.createDiv({ cls: "opencode-agent-panel__actions" });
    const openDirectory = actions.createEl("button", { attr: { "aria-label": "Open directory in OpenCode" }, cls: "clickable-icon" });
    setIcon(openDirectory, "folder-plus");
    openDirectory.addEventListener("click", () => void this.plugin.openDirectoryWithPicker());
    const refresh = actions.createEl("button", { attr: { "aria-label": "Refresh OpenCode sessions" }, cls: "clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  /** Renders an empty connected tree when OpenCode has no sessions yet. */
  private renderEmptyTree(container: HTMLElement): void {
    const state = container.createDiv({ cls: "opencode-agent-panel__state" });
    state.createDiv({ text: "No directories opened yet.", cls: "opencode-agent-panel__state-title" });
    state.createDiv({ text: "Open a directory to let the OpenCode server resolve its project/worktree.", cls: "opencode-agent-panel__state-text" });
    const open = state.createEl("button", { text: "Open directory…", cls: "mod-cta" });
    open.addEventListener("click", () => void this.plugin.openDirectoryWithPicker());
  }

  /** Renders one project branch and its passive new-session placeholder. */
  private renderProject(container: HTMLElement, project: AgentPanelProject): void {
    const key = `project:${project.id}`;
    const collapsed = this.collapsed.has(key);
    const item = container.createDiv({ cls: "tree-item nav-folder opencode-agent-panel__project" });
    const title = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable" });
    this.registerRow(key, "project", title);
    this.renderCollapseIcon(title, collapsed);
    const avatar = title.createDiv({ text: this.initials(project.name), cls: "opencode-agent-panel__project-avatar" });
    avatar.style.setProperty("--opencode-project-avatar-color", this.projectColor(project.id));
    title.createDiv({ text: project.name, cls: "tree-item-inner nav-folder-title-content" });
    title.addEventListener("click", () => this.toggleCollapsed(key));
    title.addEventListener("contextmenu", (event) => this.showProjectMenu(event, project));

    if (collapsed) return;
    const children = item.createDiv({ cls: "tree-item-children nav-folder-children" });
    if (project.worktrees.length > 1) {
      for (const worktree of project.worktrees) this.renderWorktree(children, worktree);
      return;
    }

    const worktree = project.worktrees[0];
    if (!worktree) return;
    for (const session of worktree.sessions) this.renderSession(children, session, 0);
    this.renderNewSessionPlaceholder(children, project.id, worktree.path);
  }

  /** Renders the optional worktree/directory level when a project has multiple roots. */
  private renderWorktree(container: HTMLElement, worktree: AgentPanelWorktree): void {
    const key = `worktree:${worktree.id}`;
    const collapsed = this.collapsed.has(key);
    const item = container.createDiv({ cls: "tree-item nav-folder opencode-agent-panel__worktree" });
    const title = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable" });
    this.registerRow(key, "worktree", title);
    this.renderCollapseIcon(title, collapsed);
    const icon = title.createDiv({ cls: "opencode-agent-panel__worktree-icon" });
    setIcon(icon, "git-branch");
    title.createDiv({ text: worktree.name, cls: "tree-item-inner nav-folder-title-content" });
    title.title = worktree.path;
    title.addEventListener("click", () => this.toggleCollapsed(key));

    if (collapsed) return;
    const children = item.createDiv({ cls: "tree-item-children nav-folder-children" });
    for (const session of worktree.sessions) this.renderSession(children, session, 0);
    this.renderNewSessionPlaceholder(children, worktree.id, worktree.path);
  }

  /** Renders a recursive session branch with left status and right notification slots. */
  private renderSession(container: HTMLElement, session: AgentPanelSession, depth: number): void {
    const key = `session:${session.id}`;
    const collapsed = this.collapsed.has(key);
    const item = container.createDiv({ cls: "tree-item nav-file opencode-agent-panel__session" });
    item.style.setProperty("--opencode-depth", String(depth));

    const title = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable", attr: { "data-session-id": session.id } });
    this.registerRow(key, "session", title, session);
    if (this.activeSessionId === session.id) title.addClass("is-active");
    this.renderCollapseIcon(title, collapsed, session.children.length === 0);
    this.renderStatusIndicator(title, session.status);
    title.createDiv({ text: session.title, cls: "tree-item-inner nav-file-title-content" });
    this.renderNotificationIndicator(title, session.muted);
    title.addEventListener("click", () => this.selectSession(session));
    title.addEventListener("contextmenu", (event) => this.showSessionMenu(event, session, title));

    if (session.children.length === 0 || collapsed) return;
    const children = item.createDiv({ cls: "tree-item-children nav-folder-children" });
    for (const child of session.children) this.renderSession(children, child, depth + 1);
  }

  /** Renders the client-only new-session draft entry for a project directory. */
  private renderNewSessionPlaceholder(container: HTMLElement, projectId: string, directory: string): void {
    const key = `new-session:${projectId}:${directory}`;
    const row = container.createDiv({ cls: "tree-item nav-file opencode-agent-panel__new-session" });
    const title = row.createDiv({ cls: "tree-item-self nav-file-title is-clickable" });
    this.registerRow(key, "new-session", title, undefined, directory);
    title.createDiv({ cls: "tree-item-icon collapse-icon" });
    const plus = title.createDiv({ cls: "opencode-agent-panel__placeholder-icon" });
    setIcon(plus, "plus");
    title.createDiv({ text: "new session", cls: "tree-item-inner nav-file-title-content" });
    title.title = "Create an empty OpenCode session and focus its composer.";
    title.addEventListener("click", () => void this.createNewSession(directory));
  }

  /** Renders the native disclosure slot for folders and sessions with children. */
  private renderCollapseIcon(container: HTMLElement, collapsed: boolean, hidden = false): void {
    const icon = container.createDiv({ cls: "tree-item-icon collapse-icon" });
    if (hidden) return;
    setIcon(icon, collapsed ? "chevron-right" : "chevron-down");
  }

  /** Renders the left session status indicator according to the plugin spec. */
  private renderStatusIndicator(container: HTMLElement, status: SessionVisualStatus): void {
    const slot = container.createDiv({ cls: `opencode-agent-panel__status opencode-agent-panel__status--${status}` });
    this.paintStatusIndicator(slot, status);
  }

  /** Repaints an existing session row status slot from a live event or full tree render. */
  private paintStatusIndicator(slot: HTMLElement, status: SessionVisualStatus): void {
    slot.empty();
    slot.className = `opencode-agent-panel__status opencode-agent-panel__status--${status}`;
    const animation = normalizeWorkingAnimation(this.plugin.settings.workingAnimation);
    slot.dataset.workingAnimation = animation;
    if (status === "attention") setIcon(slot, "megaphone");
    if (status === "error") setIcon(slot, "alert-circle");
    if (status === "retry") setIcon(slot, "rotate-cw");
    if (status === "done") slot.createSpan();
    if (status === "working") {
      if (animation === "W3") {
        slot.createSpan();
        slot.createSpan();
        slot.createSpan();
      } else {
        slot.createSpan();
      }
    }
  }

  /** Applies a status event immediately so visible rows do not wait for a full sidebar refresh. */
  private applyLiveSessionEvent(event: OpenCodeEvent): void {
    const properties = event.properties;
    if (!properties) return;
    if (event.type === "permission.asked" || event.type === "question.asked") {
      const sessionId = this.readString(properties, ["sessionID", "sessionId"]);
      if (sessionId) this.applyLiveRequestAttention(sessionId);
      return;
    }
    if (event.type === "session.status") {
      const sessionId = this.readString(properties, ["sessionID", "sessionId"]);
      const status = this.readObject(properties, "status");
      const type = status ? this.readString(status, ["type", "status", "state"]) ?? "idle" : "idle";
      if (sessionId) this.applyLiveSessionStatus(sessionId, type);
      return;
    }
    if (event.type === "session.idle" || event.type === "session.error") {
      const sessionId = this.readString(properties, ["sessionID", "sessionId"]);
      if (sessionId) this.applyLiveSessionStatus(sessionId, "idle");
    }
  }

  /** Paints an asked request's owner and every known ancestor without waiting for GET snapshots. */
  private applyLiveRequestAttention(ownerSessionId: string): void {
    const visited = new Set<string>();
    let sessionId: string | undefined = ownerSessionId;
    while (sessionId && !visited.has(sessionId)) {
      visited.add(sessionId);
      this.requestAttentionSessionIds.add(sessionId);
      const row = this.contentEl.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
      const slot = row?.querySelector<HTMLElement>(".opencode-agent-panel__status");
      if (slot) this.paintStatusIndicator(slot, "attention");
      sessionId = this.sessionParentIds.get(sessionId);
    }
  }

  /** Updates one row from another view's live status event; referenced by OpenCodePlugin.notifySessionStatusChanged. */
  applyLiveSessionStatus(sessionId: string, type: string): void {
    const previous = this.lastKnownSessionStatuses.get(sessionId);
    this.markCompletedSessionUnread(sessionId, previous, type);
    if (type === "idle") this.lastKnownSessionStatuses.delete(sessionId);
    else this.lastKnownSessionStatuses.set(sessionId, type);
    const row = this.contentEl.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
    const slot = row?.querySelector<HTMLElement>(".opencode-agent-panel__status");
    if (slot) this.paintStatusIndicator(slot, this.visualStatusFor(sessionId, {}));
  }

  /** Renders the right muted-notification indicator slot. */
  private renderNotificationIndicator(container: HTMLElement, muted: boolean): void {
    const slot = container.createDiv({ cls: "opencode-agent-panel__notification" });
    if (!muted) return;
    setIcon(slot, "bell-off");
  }

  /** Selects a session row and opens its read-only Obsidian session tab. */
  private selectSession(session: AgentPanelSession): void {
    this.activeSessionId = session.id;
    this.highlightedKey = `session:${session.id}`;
    if (session.children.length > 0) this.toggleCollapsed(`session:${session.id}`, false);
    else this.renderActiveOnly();
    void this.plugin.openSessionTab(session.id, session.title);
  }

  /** Toggles a tree branch and refreshes DOM from the current server snapshot. */
  private toggleCollapsed(key: string, refresh = true): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    if (refresh) void this.refresh();
  }

  /** Refreshes the row state after a local-only active selection changes. */
  private renderActiveOnly(): void {
    this.contentEl.querySelectorAll(".opencode-agent-panel__session .tree-item-self").forEach((row) => row.removeClass("is-active"));
    this.contentEl.querySelectorAll(".opencode-agent-panel__row-highlighted").forEach((row) => row.removeClass("opencode-agent-panel__row-highlighted"));
    if (!this.activeSessionId) return;
    const active = this.contentEl.querySelector(`[data-session-id="${CSS.escape(this.activeSessionId)}"]`);
    active?.addClass("is-active");
    this.applyHighlight();
  }

  /** Registers a visible tree row for keyboard navigation and highlight management. */
  private registerRow(key: string, kind: "project" | "worktree" | "session" | "new-session", element: HTMLElement, session?: AgentPanelSession, directory?: string): void {
    this.visibleRows.push({ key, kind, element, session, directory });
    element.dataset.opencodeRowKey = key;
    if (!this.highlightedKey) this.highlightedKey = key;
    if (this.highlightedKey === key) element.addClass("opencode-agent-panel__row-highlighted");
  }

  /** Handles focus-gated tree keyboard navigation modeled after Obsidian's file explorer. */
  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const rename = (event.key === "Enter" && unmodified) || matchesObsidianCommandHotkey(this.app, RENAME_CURRENT_FILE_COMMANDS, event);
    const archive = ((event.key === "Backspace" || event.key === "Delete") && unmodified) || matchesObsidianCommandHotkey(this.app, DELETE_CURRENT_FILE_COMMANDS, event);
    if (row?.session && rename) {
      event.preventDefault();
      event.stopPropagation();
      this.beginInlineRename(row.session, row.element);
      return;
    }
    if (row?.session && archive) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void this.plugin.requestSessionArchive(row.session.id, row.session.directory);
      return;
    }
    if (row?.session && unmodified && event.key.toLowerCase() === "f") {
      event.preventDefault();
      void this.forkSession(row.session);
      return;
    }
    if (row?.session && unmodified && event.key.toLowerCase() === "m") {
      event.preventDefault();
      void this.toggleSessionMute(row.session);
      return;
    }
    if (row?.session && unmodified && event.key.toLowerCase() === "p") {
      event.preventDefault();
      void this.plugin.rememberSessionAutoApprove(row.session.id, this.plugin.settings.sessionAutoApprove[row.session.id] !== true);
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Enter"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowUp") this.moveHighlight(-1);
    if (event.key === "ArrowDown") this.moveHighlight(1);
    if (event.key === "ArrowLeft") this.collapseHighlighted();
    if (event.key === "ArrowRight") this.expandOrSelectHighlighted();
    if (event.key === " ") this.activateHighlighted();
  };

  /** Moves the keyboard highlight up or down in the current visible row list. */
  private moveHighlight(delta: number): void {
    if (this.visibleRows.length === 0) return;
    const current = Math.max(0, this.visibleRows.findIndex((row) => row.key === this.highlightedKey));
    const next = Math.min(this.visibleRows.length - 1, Math.max(0, current + delta));
    this.highlightedKey = this.visibleRows[next]?.key;
    this.applyHighlight();
  }

  /** Applies the current keyboard highlight using native-ish selected-row styling. */
  private applyHighlight(): void {
    this.contentEl.querySelectorAll(".opencode-agent-panel__row-highlighted").forEach((row) => row.removeClass("opencode-agent-panel__row-highlighted"));
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    row?.element.addClass("opencode-agent-panel__row-highlighted");
    row?.element.scrollIntoView({ block: "nearest" });
  }

  /** Collapses the highlighted branch, or moves from a leaf to its nearest branch later. */
  private collapseHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row || row.kind === "session" || row.kind === "new-session") return;
    this.collapsed.add(row.key);
    void this.refresh();
  }

  /** Expands a branch or activates a highlighted leaf session. */
  private expandOrSelectHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row) return;
    if (row.kind === "project" || row.kind === "worktree") {
      this.collapsed.delete(row.key);
      void this.refresh();
      return;
    }
    this.activateHighlighted();
  }

  /** Activates the currently highlighted row. */
  private activateHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row) return;
    if (row.kind === "project" || row.kind === "worktree") this.toggleCollapsed(row.key);
    if (row.kind === "session" && row.session) {
      this.activeSessionId = row.session.id;
      this.renderActiveOnly();
      void this.plugin.openSessionTab(row.session.id, row.session.title);
    }
    if (row.kind === "new-session" && row.directory) void this.createNewSession(row.directory);
  }

  /** Opens a local draft tab without creating a server-side OpenCode session. */
  private async createNewSession(directory: string): Promise<void> {
    await this.plugin.openNewSessionTab(directory);
  }

  /** Deduplicates directory-scoped session batches; referenced by refresh before tree construction. */
  private uniqueSessions(sessions: OpenCodeSession[]): OpenCodeSession[] {
    const map = new Map<string, OpenCodeSession>();
    for (const session of sessions) map.set(session.id, session);
    return [...map.values()];
  }

  /** Detects archived sessions from OpenCode time metadata; referenced by refresh filtering. */
  private isArchived(session: OpenCodeSession): boolean {
    const time = this.readObject(session, "time");
    return typeof time?.archived === "number";
  }

  /** Converts raw OpenCode status payloads into the panel's visual states. */
  private visualStatusFor(sessionId: string, statuses: JsonObject, requiresAttention = this.requestAttentionSessionIds.has(sessionId)): SessionVisualStatus {
    if (requiresAttention) return "attention";
    const status = statuses[sessionId];
    const type = status && typeof status === "object" && !Array.isArray(status) ? this.readString(status as JsonObject, ["type", "status", "state"]) : this.lastKnownSessionStatuses.get(sessionId);
    return visualStatusForSession(type, this.plugin.settings.sessionUnread[sessionId] === true);
  }

  /** Reconciles busy-to-idle transitions so completed turns remain visible as unread. */
  private reconcileSessionStatusSnapshot(statuses: JsonObject): void {
    const next = new Map<string, string>();
    for (const [sessionId, value] of Object.entries(statuses)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const type = this.readString(value as JsonObject, ["type", "status", "state"]) ?? "idle";
      next.set(sessionId, type);
      this.markCompletedSessionUnread(sessionId, this.lastKnownSessionStatuses.get(sessionId), type);
    }
    for (const [sessionId, previous] of this.lastKnownSessionStatuses) {
      if (next.has(sessionId)) continue;
      if (isActiveSessionStatus(previous)) next.set(sessionId, previous);
      else this.markCompletedSessionUnread(sessionId, previous, "idle");
    }
    this.lastKnownSessionStatuses = next;
  }

  /** Marks a session unread only when a previously active run has settled. */
  private markCompletedSessionUnread(sessionId: string, previous: string | undefined, next: string): void {
    const settled = next === "idle" || next === "done" || next === "complete" || next === "completed";
    if (!isActiveSessionStatus(previous) || !settled || this.plugin.settings.sessionUnread[sessionId] === true) return;
    void this.plugin.rememberSessionUnread(sessionId, true);
  }

  /** Extracts a session title with useful fallbacks for incomplete API payloads. */
  private sessionTitle(session: OpenCodeSession): string {
    return this.readString(session, ["title", "name", "summary"]) ?? session.id;
  }

  /** Resolves the sidebar project using OpenCode's git-project/global-project split; referenced by buildProjectTree. */
  private effectiveProjectForSession(session: OpenCodeSession, knownProjects: Map<string, OpenCodeProjectMeta>): { id: string; name: string } {
    const projectId = this.readString(session, ["projectID", "projectId"]);
    const project = this.readObject(session, "project");
    const nestedProjectId = project ? this.readString(project, ["id", "projectID", "projectId"]) : undefined;
    const id = projectId ?? nestedProjectId;
    const directory = this.effectiveDirectoryForSession(session);
    const metadata = id ? knownProjects.get(id) : undefined;

    if (!id || id === "global") return { id: `cwd:${directory}`, name: this.basename(directory) };

    const matched = this.matchKnownProjectDirectory(directory, knownProjects);
    const nestedName = project ? this.readString(project, ["name", "title"]) : undefined;
    const displayPath = metadata?.worktree ?? matched?.worktree ?? directory;
    return { id, name: metadata?.name ?? nestedName ?? this.basename(displayPath) ?? id };
  }

  /** Resolves an explicitly opened directory into a sidebar project before any sessions exist. */
  private effectiveProjectForOpenedDirectory(context: OpenedDirectoryContext, knownProjects: Map<string, OpenCodeProjectMeta>): { id: string; name: string } {
    const project = context.project;
    const id = project ? this.readString(project, ["id", "projectID", "projectId"]) : undefined;
    const worktree = project ? this.readString(project, ["worktree", "directory", "path"]) : undefined;
    const metadata = id ? knownProjects.get(id) : undefined;

    if (!id || id === "global") return { id: `cwd:${context.directory}`, name: this.basename(context.directory) };
    return { id, name: metadata?.name ?? (project ? this.readString(project, ["name", "title"]) : undefined) ?? this.basename(worktree ?? context.directory) ?? id };
  }

  /** Extracts the visible worktree bucket; opened directory wins so linked worktrees stay visually separate. */
  private effectiveWorktreeForSession(session: OpenCodeSession, projectMeta?: OpenCodeProjectMeta, openedDirectory?: string): { id: string; path: string } {
    const project = this.readObject(session, "project");
    const worktree = project ? this.readString(project, ["worktree", "directory", "path"]) : undefined;
    const directory = this.effectiveDirectoryForSession(session);
    const projectId = this.readString(session, ["projectID", "projectId"]) ?? (project ? this.readString(project, ["id", "projectID", "projectId"]) : undefined);

    if (projectId === "global") return { id: directory, path: directory };
    if (openedDirectory) return { id: openedDirectory, path: openedDirectory };

    const subpath = this.readString(session, ["path", "subpath"]);
    const inferredWorktree = subpath ? this.worktreeFromSessionPath(directory, subpath) : undefined;
    const resolved = inferredWorktree ?? worktree ?? projectMeta?.worktree ?? directory;
    return { id: resolved, path: resolved };
  }

  /** Resolves the visible worktree bucket for an explicitly opened directory with no sessions yet. */
  private effectiveWorktreeForOpenedDirectory(context: OpenedDirectoryContext, projectMeta?: OpenCodeProjectMeta): { id: string; path: string } {
    const project = context.project;
    const id = project ? this.readString(project, ["id", "projectID", "projectId"]) : undefined;
    if (!id || id === "global") return { id: context.directory, path: context.directory };

    return { id: context.directory, path: context.directory };
  }

  /** Matches session directories against known project roots/sandboxes, mirroring OpenCode's projectForSession helper. */
  private matchKnownProjectDirectory(directory: string, knownProjects: Map<string, OpenCodeProjectMeta>): OpenCodeProjectMeta | undefined {
    const key = this.pathKey(directory);
    for (const project of knownProjects.values()) {
      if (project.worktree && this.pathKey(project.worktree) === key) return project;
      const sandbox = project.sandboxes.find((item) => this.pathKey(item) === key);
      if (sandbox) return project;
    }
    return undefined;
  }

  /** Gets the most useful CWD-like path from an OpenCode session payload. */
  private effectiveDirectoryForSession(session: OpenCodeSession): string {
    return this.readString(session, ["directory", "cwd", "path"]) ?? "OpenCode";
  }

  /** Reconstructs the git worktree root from OpenCode's exact session directory and relative session path. */
  private worktreeFromSessionPath(directory: string, subpath: string): string | undefined {
    const cleanSubpath = subpath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!cleanSubpath || cleanSubpath === ".") return directory;

    const cleanDirectory = directory.replace(/\\/g, "/").replace(/\/+$/g, "");
    const suffix = `/${cleanSubpath}`;
    if (!this.pathKey(cleanDirectory).endsWith(this.pathKey(suffix))) return undefined;

    const root = cleanDirectory.slice(0, cleanDirectory.length - suffix.length);
    return root || "/";
  }

  /** Reads a nested object field from a loosely typed OpenCode object. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    return undefined;
  }

  /** Reads the first string-like value from a loosely typed OpenCode object. */
  private readString(source: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }

  /** Reads a string array from loosely typed OpenCode project metadata. */
  private readStringArray(source: JsonObject, key: string): string[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  /** Normalizes paths for directory comparisons, equivalent to OpenCode's pathKey usage for our needs. */
  private pathKey(value: string): string {
    return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** Returns a display basename for absolute paths while preserving non-path identifiers. */
  private basename(value: string): string {
    const normalized = value.replace(/\/$/, "");
    return normalized.split("/").filter(Boolean).pop() ?? normalized;
  }

  /** Opens a native Obsidian context menu for future project-scoped actions. */
  private showProjectMenu(event: MouseEvent, project: AgentPanelProject): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Refresh").setIcon("refresh-cw").onClick(() => void this.refresh()));
    menu.addItem((item) => item.setTitle(`Project: ${project.name}`).setDisabled(true));
    for (const directory of project.openedDirectories) {
      menu.addItem((item) =>
        item
          .setTitle(project.openedDirectories.length === 1 ? "Close directory" : `Close ${this.basename(directory)}`)
          .setIcon("x")
          .onClick(() => void this.plugin.removeOpenedDirectory(directory)),
      );
    }
    menu.addItem((item) => item.setTitle("Set icon…").setIcon("image").setDisabled(true));
    menu.showAtMouseEvent(event);
  }

  /** Opens the session action menu for a sidebar row. */
  private showSessionMenu(event: MouseEvent, session: AgentPanelSession, row: HTMLElement): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(session.id)
        .setIcon("copy")
        .onClick(() => void this.copySessionId(session.id)),
    );
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Open session").setIcon("message-square").onClick(() => void this.plugin.openSessionTab(session.id, session.title)));
    menu.addItem((item) => item.setTitle("Rename session").setIcon("pencil").onClick(() => this.beginInlineRename(session, row)));
    menu.addItem((item) => item.setTitle("Fork this session").setIcon("git-fork").onClick(() => void this.forkSession(session)));
    menu.addItem((item) =>
      item
        .setTitle(session.muted ? "Unmute session" : "Mute session")
        .setIcon(session.muted ? "bell" : "bell-off")
        .onClick(() => void this.toggleSessionMute(session)),
    );
    menu.addItem((item) => item.setTitle("Archive session").setIcon("archive").onClick(() => void this.plugin.requestSessionArchive(session.id, session.directory)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(session.title).setDisabled(true));
    menu.showAtMouseEvent(event);
  }

  /** Replaces a session row title with the file-explorer-style inline rename field. */
  private beginInlineRename(session: AgentPanelSession, row: HTMLElement): void {
    const title = row.querySelector<HTMLElement>(".nav-file-title-content");
    if (!title || title.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "opencode-agent-panel__rename-input";
    input.type = "text";
    input.value = session.title;
    title.replaceChildren(input);
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.focus();
    input.select();

    let settled = false;
    const finish = async (save: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (!save || !next || next === session.title) {
        title.setText(session.title);
        return;
      }
      input.disabled = true;
      try {
        await this.plugin.renameSession(session.id, next, session.directory);
        session.title = next;
        if (title.isConnected) title.setText(next);
      } catch (error) {
        if (title.isConnected) title.setText(session.title);
        new Notice(error instanceof Error ? error.message : "Unable to rename OpenCode session.");
      }
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  /** Toggles local notification muting from the row context menu. */
  private async toggleSessionMute(session: AgentPanelSession): Promise<void> {
    session.muted = !session.muted;
    await this.plugin.rememberSessionMute(session.id, session.muted);
    await this.refresh({ showLoading: false });
  }

  /** Forks a sidebar session from its latest turn and opens the new session tab. */
  private async forkSession(session: AgentPanelSession): Promise<void> {
    try {
      const forked = await this.plugin.requireOpenCodeService().forkSession(session.id, session.directory);
      await this.plugin.refreshAgentPanels({ showLoading: false });
      await this.plugin.openSessionTab(forked.id, forked.title);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to fork OpenCode session.");
    }
  }

  /** Copies a session id from the context menu; referenced by showSessionMenu for testing workflows. */
  private async copySessionId(sessionId: string): Promise<void> {
    await navigator.clipboard.writeText(sessionId);
    new Notice(`Copied session ID: ${sessionId}`);
  }

  /** Generates a short project-avatar label using native sidebar proportions. */
  private initials(name: string): string {
    return name
      .split(/[\s/_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "OC";
  }

  /** Picks a stable Obsidian theme token for a project fallback avatar. */
  private projectColor(projectId: string): string {
    const tokens = ["--color-blue", "--color-green", "--color-yellow", "--color-orange", "--color-purple", "--color-cyan", "--color-pink"];
    const hash = [...projectId].reduce((total, char) => total + char.charCodeAt(0), 0);
    return `var(${tokens[hash % tokens.length]})`;
  }
}
