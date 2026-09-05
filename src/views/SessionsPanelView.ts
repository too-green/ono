import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type OpenCodePlugin from "../../main";
import { DELETE_CURRENT_FILE_COMMANDS, RENAME_CURRENT_FILE_COMMANDS, matchesObsidianCommandHotkey } from "../obsidian-hotkeys";
import type { OpenCodeEventSubscription } from "../services/opencode-events";
import { logServiceError } from "../services/opencode-http";
import type { JsonObject, OpenCodeEvent, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from "../services/opencode-types";
import { normalizeWorkingAnimation, visualStatusForSession, type SessionVisualStatus } from "../session-state";
import { hashRenderState } from "./session/render-signature";
import {
  SESSIONS_PANEL_SESSION_SORT_LABELS,
  normalizeSessionsPanelSessionSort,
  normalizeFolderCollapseDisplay,
  type SessionsPanelSessionSort,
} from "../settings";
import {
  createDefaultSessionsPanelRowComponents,
  worktreeStatePresentation,
  type SessionsPanelProject,
  type SessionsPanelRowComponents,
  type SessionsPanelSession,
  type SessionsPanelSessionRowHandle,
  type SessionsPanelWorktree,
} from "./sessions-panel/rows";
import { sortSessionsPanelSessions } from "./sessions-panel/session-sort";

/** Legacy stable value: existing installs persist workspace leaves under this view type string. */
export const VIEW_TYPE_OPENCODE_SESSIONS_PANEL = "opencode-agent-panel";
const SESSION_DROP_EXPAND_DELAY_MS = 1_200;
const SESSION_DRAG_MIME = "application/x-opencode-session-id";

type SessionDropTargetState = "valid" | "invalid" | "noop";

interface SessionsPanelSessionDrag {
  sessionId: string;
  sourceDirectory: string;
  sourceContainerDirectory: string;
  projectId: string;
}

interface OpenCodeProjectMeta {
  id: string;
  name: string;
  git: boolean;
  worktree?: string;
  sandboxes: string[];
}

interface OpenedDirectoryContext {
  directory: string;
  project?: JsonObject;
}

interface SessionsPanelVisibleRow {
  key: string;
  kind: "project" | "worktree" | "session";
  element: HTMLElement;
  session?: SessionsPanelSession;
  directory?: string;
}

interface SessionsPanelTreeReconcileContext {
  nextRows: Map<string, SessionsPanelVisibleRow>;
  previousSessionHandles: Map<string, SessionsPanelSessionRowHandle>;
  preservedRowElements: Map<string, HTMLElement>;
  preservedSessionIds: Set<string>;
}

export class SessionsPanelView extends ItemView {
  private collapsed = new Set<string>();
  private activeSessionId?: string;
  private highlightedKey?: string;
  private eventSubscriptions: OpenCodeEventSubscription[] = [];
  private eventSubscriptionDirectoriesKey = "";
  private visibleRows: SessionsPanelVisibleRow[] = [];
  private rowParentKey = new Map<string, string | undefined>();
  private loading = false;
  private refreshQueued = false;
  private refreshTimer?: number;
  private lastRenderedTreeSignature = "";
  private lastTree: SessionsPanelProject[] = [];
  private sessionAncestorMap = new Map<string, string[]>();
  private statusUnsubscribe?: () => void;
  private requestAttentionSessionIds = new Set<string>();
  private sessionParentIds = new Map<string, string>();
  private sessionListCache = new Map<string, OpenCodeSession[]>();
  private permissionRequestCache = new Map<string, OpenCodePermissionRequest[]>();
  private questionRequestCache = new Map<string, OpenCodeQuestionRequest[]>();
  private transientLoadFailure = false;
  private refreshRetryDelay = 1_000;
  private opened = false;
  private readonly rowComponents: SessionsPanelRowComponents;
  private readonly sessionRowHandles = new Map<string, SessionsPanelSessionRowHandle>();
  private movingSessionIds = new Set<string>();
  private sessionDrag?: SessionsPanelSessionDrag;
  private sessionDropTargetKey?: string;
  private sessionDropTargetState?: SessionDropTargetState;
  private sessionDropExpandTimer?: number;
  private sessionDropDepth = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
    rowComponents: Partial<SessionsPanelRowComponents> = {},
  ) {
    super(leaf);
    this.rowComponents = { ...createDefaultSessionsPanelRowComponents(), ...rowComponents };
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_SESSIONS_PANEL;
  }

  /** Returns the display label shown in Obsidian sidebars and tabs. */
  getDisplayText(): string {
    return "OpenCode sessions";
  }

  /** Returns the Lucide icon used by the sidebar tab and ribbon command. */
  getIcon(): string {
    return "bot";
  }

  /** Builds the panel shell and loads read-only OpenCode data when opened. */
  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.addClass("opencode-sidebar-panel");
    this.contentEl.addClass("opencode-sidebar-panel--sessions");
    this.contentEl.tabIndex = 0;
    this.contentEl.addEventListener("keydown", this.handleKeydown);
    this.syncEventSubscriptions(this.plugin.getOpenedDirectories());
    // Consume the plugin-wide status store so rows repaint without independent event reconciliation.
    this.statusUnsubscribe = this.plugin.sessionStatuses?.subscribe((sessionId) => this.paintSessionStatus(sessionId));
    // Capture the active session before the async refresh — by the time refresh
    // resolves the panel itself may be the active leaf, making getActiveSessionId
    // return undefined and wiping the reveal.
    const activeSessionId = this.plugin.getActiveSessionId();
    await this.refresh();
    this.setActiveSession(activeSessionId);
  }

  /** Clears the panel when Obsidian closes the view. */
  async onClose(): Promise<void> {
    this.opened = false;
    this.refreshQueued = false;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = undefined;
    this.clearSessionDragState();
    this.contentEl.removeEventListener("keydown", this.handleKeydown);
    this.closeEventSubscriptions();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.contentEl.removeClass("opencode-sidebar-panel", "opencode-sidebar-panel--sessions");
    this.contentEl.removeAttribute("tabindex");
    this.contentEl.empty();
  }

  /** Subscribes to sidebar-relevant OpenCode events so token streaming does not blink the tree. */
  private syncEventSubscriptions(directories: string[]): void {
    if (!this.opened) return;
    const key = [...directories].sort().join("\n");
    if (key === this.eventSubscriptionDirectoriesKey && this.eventSubscriptions.length > 0) return;
    this.closeEventSubscriptions();
    this.eventSubscriptionDirectoriesKey = key;
    this.eventSubscriptions = directories.map((directory) =>
      this.plugin.requireOpenCodeService().subscribeToEvents(
        {
          onOpen: () => this.scheduleRefresh(0),
          onError: () => this.scheduleRefresh(0),
          onEvent: (event) => {
            if (event.type === "permission.asked" && event.properties) {
              this.plugin.routePermissionRequest(event.properties as OpenCodePermissionRequest, directory);
              return;
            }
            if (event.type === "permission.replied" && event.properties) {
              this.plugin.settleSessionRequest(this.readString(event.properties, ["requestID", "requestId", "id"]));
            }
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
      type === "session.moved" ||
      type === "session.next.moved" ||
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
    if (!this.opened) return;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh({ showLoading: false });
    }, delay);
  }

  /** Reloads projects, sessions, and statuses using only OpenCode GET endpoints. */
  async refresh(options: { showLoading?: boolean } = {}): Promise<void> {
    if (!this.opened) return;
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
      if (!this.opened) return;
      const openedDirectories = this.plugin.getOpenedDirectories();
      this.syncEventSubscriptions(openedDirectories);
      // Capture the store revision/generation before the GETs so events landing mid-flight are
      // preserved on apply and responses from a replaced server or removed directory are dropped.
      const statusStore = this.plugin.sessionStatuses;
      const statusBaseline = statusStore?.revision() ?? 0;
      const statusGeneration = statusStore?.generation() ?? 0;
      const [projects, openedContexts, sessionGroups, statusResults, permissionGroups, questionGroups] = await Promise.all([
        openedDirectories[0] ? service.listProjects(openedDirectories[0]).catch(logServiceError([], "listProjects")) : Promise.resolve([]),
        Promise.all(
          openedDirectories.map(async (directory): Promise<OpenedDirectoryContext> => ({
            directory,
            project: await this.plugin.directoryContexts.getProject(directory).catch(logServiceError(undefined, "getCurrentProject")),
          })),
        ),
        Promise.all(openedDirectories.map((directory) => this.listSessions(directory))),
        Promise.all(openedDirectories.map(async (directory) => {
          try {
            return await service.getSessionStatus(directory);
          } catch (error) {
            return logServiceError(undefined, "getSessionStatus")(error);
          }
        })),
        Promise.all(openedDirectories.map((directory) => this.listPermissionRequests(directory))),
        Promise.all(openedDirectories.map((directory) => this.listQuestionRequests(directory))),
      ]);
      if (!this.opened) return;
      const sessionDirectoryById = new Map<string, string>();
      sessionGroups.forEach((sessionsForDirectory, index) => {
        const directory = openedDirectories[index];
        if (!directory) return;
        sessionsForDirectory.forEach((session) => sessionDirectoryById.set(session.id, directory));
      });
      const sessions = this.uniqueSessions(sessionGroups.flat()).filter((session) => !this.isArchived(session));
      this.plugin.cacheSessionHierarchy(sessions, true);
      permissionGroups.forEach((requests, index) => {
        const directory = openedDirectories[index];
        for (const request of requests) this.plugin.routePermissionRequest(request, directory);
      });
      this.sessionParentIds = new Map(
        sessions.flatMap((session) => {
          const parentId = this.readString(session, ["parentID", "parentId"]);
          return parentId ? [[session.id, parentId] as const] : [];
        }),
      );
      // Reconcile only each directory's own response scope; failed GETs resolve to
      // undefined so the shared cache survives sync failures untouched.
      if (statusStore && statusStore.generation() === statusGeneration) {
        statusResults.forEach((statuses, index) => {
          const directory = openedDirectories[index];
          if (!directory || !statuses || typeof statuses !== "object" || Array.isArray(statuses)) return;
          statusStore.applySnapshot(directory, statuses as JsonObject, statusBaseline);
        });
      }
      const requestOwnerIds = new Set<string>();
      for (const request of [...permissionGroups.flat().filter((item) => !this.plugin.shouldSuppressPermissionRequest(item.id)), ...questionGroups.flat()]) {
        const sessionId = this.readString(request, ["sessionID", "sessionId"]);
        if (sessionId) requestOwnerIds.add(sessionId);
      }
      if (this.transientLoadFailure) this.requestAttentionSessionIds.forEach((sessionId) => requestOwnerIds.add(sessionId));
      this.propagateRequestAttentionToAncestors(requestOwnerIds, sessions);
      const tree = await this.buildProjectTree(
        [...(Array.isArray(projects) ? projects : []), ...openedContexts.flatMap((context) => (context.project ? [context.project] : []))],
        sessions,
        openedContexts,
        sessionDirectoryById,
        requestOwnerIds,
      );
      if (!this.opened) return;
      const nextRequestAttentionIds = this.collectRequestAttentionIds(tree);
      if (this.transientLoadFailure) this.requestAttentionSessionIds.forEach((sessionId) => nextRequestAttentionIds.add(sessionId));
      this.requestAttentionSessionIds = nextRequestAttentionIds;
      const treeSignature = JSON.stringify([this.plugin.settings.folderCollapseDisplay, this.plugin.settings.sessionsPanelSessionSort, tree]);
      if (treeSignature === this.lastRenderedTreeSignature && this.contentEl.querySelector(".opencode-sessions-panel__tree")) return;
      this.lastRenderedTreeSignature = treeSignature;
      this.renderTree(tree);
    } catch (error) {
      if (this.opened) {
        this.lastRenderedTreeSignature = "";
        this.renderDisconnected(error);
      }
    } finally {
      this.loading = false;
      if (!this.opened) {
        this.refreshQueued = false;
        return;
      }
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
    openedContexts: OpenedDirectoryContext[],
    sessionDirectoryById: Map<string, string>,
    requestOwnerIds: Set<string>,
  ): Promise<SessionsPanelProject[]> {
    const sessionsByProject = new Map<string, Map<string, OpenCodeSession[]>>();
    const knownProjects = new Map<string, OpenCodeProjectMeta>();
    const openedByProject = new Map<string, Set<string>>();

    for (const project of projects) {
      const id = this.readString(project, ["id", "ID", "projectID"]);
      if (!id) continue;
      const existing = knownProjects.get(id);
      const worktree = this.readString(project, ["worktree", "directory", "path"]);
      const sandboxes = this.readStringArray(project, "sandboxes");
      knownProjects.set(id, {
        id,
        git: this.readString(project, ["vcs"]) === "git" || existing?.git === true,
        worktree: worktree ?? existing?.worktree,
        name: this.readString(project, ["name", "title"]) ?? existing?.name ?? (worktree ? this.basename(worktree) : id),
        sandboxes: sandboxes.length > 0 ? sandboxes : existing?.sandboxes ?? [],
      });
    }

    for (const context of openedContexts) {
      const project = this.effectiveProjectForOpenedDirectory(context, knownProjects);
      const worktree = this.effectiveWorktreeForOpenedDirectory(context, knownProjects.get(project.id));
      const worktrees = sessionsByProject.get(project.id) ?? new Map<string, OpenCodeSession[]>();
      worktrees.set(worktree.id, worktrees.get(worktree.id) ?? []);
      sessionsByProject.set(project.id, worktrees);
      openedByProject.set(project.id, (openedByProject.get(project.id) ?? new Set()).add(context.directory));
      if (!knownProjects.has(project.id)) knownProjects.set(project.id, { id: project.id, name: project.name, git: false, worktree: worktree.path, sandboxes: [] });
    }

    for (const session of sessions) {
      const project = this.effectiveProjectForSession(session, knownProjects);
      const worktree = this.effectiveWorktreeForSession(session, knownProjects.get(project.id), sessionDirectoryById.get(session.id));
      const worktrees = sessionsByProject.get(project.id) ?? new Map<string, OpenCodeSession[]>();
      worktrees.set(worktree.id, [...(worktrees.get(worktree.id) ?? []), session]);
      sessionsByProject.set(project.id, worktrees);
      if (!knownProjects.has(project.id)) knownProjects.set(project.id, { id: project.id, name: project.name, git: false, worktree: worktree.path, sandboxes: [] });
    }

    const entries = [...sessionsByProject.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Promise.all(
      entries.map(async ([projectId, worktreeMap]) => {
        const meta = knownProjects.get(projectId);
        const rootDirectory = meta?.worktree ?? "";
        return {
          id: projectId,
          name: meta?.name ?? projectId,
          git: meta?.git === true && rootDirectory.length > 0,
          rootDirectory,
          openedDirectories: [...(openedByProject.get(projectId) ?? new Set())],
          managedWorktreeDirectories: meta?.sandboxes ?? [],
          worktrees: await Promise.all(
            [...worktreeMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(async ([worktreeId, worktreeSessions]) => {
              const startup = this.plugin.getWorktreeStatus?.(worktreeId);
              return {
                id: worktreeId,
                name: this.basename(worktreeId),
                path: worktreeId,
                primary: this.pathKey(worktreeId) === this.pathKey(rootDirectory),
                startupState: startup?.state,
                startupMessage: startup?.message,
                sessions: await this.buildSessionNodes(worktreeSessions, requestOwnerIds),
              };
            }),
          ),
        };
      }),
    );
  }

  /** Builds visible top-level session rows and excludes child/subagent sessions. */
  private async buildSessionNodes(sessions: OpenCodeSession[], requestOwnerIds: Set<string>): Promise<SessionsPanelSession[]> {
    const roots = sessions.filter((session) => !this.readString(session, ["parentID", "parentId"]));
    return roots.map((session) => this.buildSessionNode(session, requestOwnerIds));
  }

  /** Builds one top-level session row from the list snapshot without fetching descendants. */
  private buildSessionNode(session: OpenCodeSession, requestOwnerIds: Set<string>): SessionsPanelSession {
    const id = session.id;
    const requiresAttention = requestOwnerIds.has(id);

    return {
      id,
      title: this.sessionTitle(session),
      directory: this.effectiveDirectoryForSession(session),
      createdAt: this.sessionTime(session, "created"),
      updatedAt: this.sessionTime(session, "updated"),
      status: this.visualStatusFor(id, requiresAttention),
      muted: this.plugin.getSessionNotificationState(session).muted,
      requiresAttention,
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
      return logServiceError(fallback, "listPermissionRequests")(error);
    });
    this.permissionRequestCache.set(directory, requests);
    return requests;
  }

  /** Lists questions with the last successful directory snapshot as a transient-failure fallback. */
  private async listQuestionRequests(directory: string): Promise<OpenCodeQuestionRequest[]> {
    const fallback = this.questionRequestCache.get(directory) ?? [];
    const requests = await this.plugin.requireOpenCodeService().listQuestionRequests(directory).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listQuestionRequests")(error);
    });
    this.questionRequestCache.set(directory, requests);
    return requests;
  }

  /** Lists sessions with the last successful directory snapshot as a transient-failure fallback. */
  private async listSessions(directory: string): Promise<OpenCodeSession[]> {
    const fallback = this.sessionListCache.get(directory) ?? [];
    const sessions = await this.plugin.requireOpenCodeService().listSessions({ directory, limit: 100 }).catch((error) => {
      this.transientLoadFailure = true;
      return logServiceError(fallback, "listSessions")(error);
    });
    this.sessionListCache.set(directory, sessions);
    return sessions;
  }

  /** Collects owner and ancestor ids whose rows must retain attention over live status events. */
  private collectRequestAttentionIds(projects: SessionsPanelProject[]): Set<string> {
    const ids = new Set<string>();
    projects.forEach((project) => project.worktrees.forEach((worktree) => worktree.sessions.forEach((session) => {
      if (session.requiresAttention) ids.add(session.id);
    })));
    return ids;
  }

  /** Renders a centered loading state that matches Obsidian empty-state styling. */
  private renderLoading(): void {
    this.clearTreeState();
    this.cancelInlineRename(this.contentEl);
    this.contentEl.empty();
    this.renderHeader();
    const state = this.contentEl.createDiv({ cls: "opencode-sessions-panel__state" });
    state.createDiv({ cls: "opencode-sessions-panel__spinner" });
    state.createDiv({ text: "Loading OpenCode sessions…", cls: "opencode-sessions-panel__state-text" });
  }

  /** Renders the disconnected state specified for missing or stopped OpenCode servers. */
  private renderDisconnected(error: unknown): void {
    this.clearTreeState();
    this.cancelInlineRename(this.contentEl);
    this.contentEl.empty();
    this.renderHeader();
    const state = this.contentEl.createDiv({ cls: "opencode-sessions-panel__state" });
    state.createDiv({ text: "opencode server not running.", cls: "opencode-sessions-panel__state-title" });
    state.createDiv({ text: "Start it with `opencode serve` in a terminal.", cls: "opencode-sessions-panel__state-text" });
    const retry = state.createEl("button", { text: "Retry connection", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.refresh());
    if (error instanceof Error) state.createDiv({ text: error.message, cls: "opencode-sessions-panel__error-detail" });
  }

  /** Renders the full project tree using Obsidian's native nav/tree class vocabulary. */
  private renderTree(projects: SessionsPanelProject[]): void {
    this.lastTree = projects;
    this.sessionAncestorMap = this.buildSessionAncestorMap(projects);
    const currentNav = this.contentEl.querySelector<HTMLElement>(":scope > .opencode-sessions-panel__tree");
    const previousScrollTop = currentNav?.scrollTop ?? 0;
    const previousHighlightedKey = this.highlightedKey;
    const previousHighlightIndex = this.visibleRows.findIndex((row) => row.key === previousHighlightedKey);
    const previousSessionHandles = new Map(this.sessionRowHandles);
    this.visibleRows = [];
    this.rowParentKey.clear();
    this.sessionRowHandles.clear();
    const staging = document.createElement("div");
    this.renderHeader(staging);

    const nav = staging.createDiv({ cls: "nav-files-container node-insert-event opencode-sidebar-panel__content opencode-sessions-panel__tree" });
    const root = nav.createDiv({ cls: "tree-item nav-folder opencode-sessions-panel__root" });

    if (projects.length === 0) {
      this.renderEmptyTree(nav);
      root.remove();
    } else {
      for (const project of projects) this.renderProject(root, project);
    }

    const nextRows = new Map(this.visibleRows.map((row) => [row.key, row]));
    const nextSessionHandles = new Map(this.sessionRowHandles);
    const context: SessionsPanelTreeReconcileContext = {
      nextRows,
      previousSessionHandles,
      preservedRowElements: new Map(),
      preservedSessionIds: new Set(),
    };
    const nextHeader = staging.querySelector<HTMLElement>(":scope > .opencode-sessions-panel__header")!;
    const currentHeader = this.contentEl.querySelector<HTMLElement>(":scope > .opencode-sessions-panel__header");
    let committedHeader = nextHeader;
    if (currentHeader && currentHeader.dataset.renderSignature === nextHeader.dataset.renderSignature) committedHeader = currentHeader;
    else if (currentHeader) currentHeader.replaceWith(nextHeader);
    else this.contentEl.prepend(nextHeader);

    let committedNav: HTMLElement = nav;
    if (currentNav) {
      const currentRoot = currentNav.querySelector<HTMLElement>(":scope > .opencode-sessions-panel__root");
      const nextRoot = nav.querySelector<HTMLElement>(":scope > .opencode-sessions-panel__root");
      if (currentRoot && nextRoot) {
        this.reconcileTreeContainer(currentRoot, nextRoot, context);
        currentRoot.className = nextRoot.className;
        for (const child of Array.from(currentNav.children)) {
          if (child !== currentRoot) child.remove();
        }
      } else {
        this.cancelInlineRename(currentNav);
        currentNav.replaceChildren(...Array.from(nav.childNodes));
      }
      currentNav.className = nav.className;
      committedNav = currentNav;
    } else {
      this.contentEl.appendChild(nav);
    }
    for (const child of Array.from(this.contentEl.children)) {
      if (child !== committedHeader && child !== committedNav) child.remove();
    }

    this.visibleRows = this.visibleRows.map((row) => ({
      ...row,
      element: context.preservedRowElements.get(row.key) ?? row.element,
    }));
    this.sessionRowHandles.clear();
    for (const row of this.visibleRows) {
      const sessionId = row.session?.id;
      if (!sessionId) continue;
      const handle = context.preservedSessionIds.has(sessionId)
        ? previousSessionHandles.get(sessionId)
        : nextSessionHandles.get(sessionId);
      if (handle) this.sessionRowHandles.set(sessionId, handle);
    }

    committedNav.scrollTop = previousScrollTop;
    if (!this.visibleRows.some((row) => row.key === previousHighlightedKey)) {
      const fallbackIndex = previousHighlightIndex < 0 ? 0 : Math.min(previousHighlightIndex, this.visibleRows.length - 1);
      this.highlightedKey = this.visibleRows[fallbackIndex]?.key;
      this.applyHighlight();
      return;
    }
    this.highlightedKey = previousHighlightedKey;
  }

  /** Reconciles keyed project, worktree, and session items without replacing the scroll owner. */
  private reconcileTreeContainer(current: HTMLElement, next: HTMLElement, context: SessionsPanelTreeReconcileContext): void {
    const currentItems = new Map(
      Array.from(current.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.opencodeTreeKey)
        .map((item) => [item.dataset.opencodeTreeKey!, item]),
    );
    const desired = Array.from(next.children, (nextItem) => {
      if (!(nextItem instanceof HTMLElement)) return nextItem;
      const key = nextItem.dataset.opencodeTreeKey;
      const currentItem = key ? currentItems.get(key) : undefined;
      if (!key || !currentItem) return nextItem;
      if (currentItem.dataset.opencodeTreeKind !== nextItem.dataset.opencodeTreeKind) {
        this.cancelInlineRename(currentItem);
        return nextItem;
      }
      const kind = nextItem.dataset.opencodeTreeKind;
      if (kind === "session") {
        const nextRow = context.nextRows.get(key);
        const sessionId = nextRow?.session?.id;
        const handle = sessionId ? context.previousSessionHandles.get(sessionId) : undefined;
        const sameSignature = currentItem.dataset.opencodeTreeSignature === nextItem.dataset.opencodeTreeSignature;
        if (!sameSignature && nextRow?.session && handle?.updatePresentation) {
          handle.updatePresentation(nextRow.session, this.activeSessionId === nextRow.session.id, normalizeWorkingAnimation(this.plugin.settings.workingAnimation));
          currentItem.dataset.opencodeTreeSignature = nextItem.dataset.opencodeTreeSignature;
        } else if (!sameSignature) {
          this.cancelInlineRename(currentItem);
          return nextItem;
        }
        this.recordPreservedTreeItem(key, currentItem, context, sessionId);
        return currentItem;
      }
      if (currentItem.dataset.opencodeTreeSignature !== nextItem.dataset.opencodeTreeSignature) {
        this.cancelInlineRename(currentItem);
        return nextItem;
      }
      const childrenSelector = `[data-opencode-children-key="${CSS.escape(key)}"]`;
      const currentChildren = currentItem.querySelector<HTMLElement>(childrenSelector);
      const nextChildren = nextItem.querySelector<HTMLElement>(childrenSelector);
      if (currentChildren && nextChildren) this.reconcileTreeContainer(currentChildren, nextChildren, context);
      else if (currentChildren) currentChildren.remove();
      else if (nextChildren) currentItem.appendChild(nextChildren);
      this.recordPreservedTreeItem(key, currentItem, context);
      return currentItem;
    });
    const retained = new Set(desired.filter((item) => item.parentElement === current));
    for (const item of Array.from(current.children)) {
      if (retained.has(item)) continue;
      this.cancelInlineRename(item as HTMLElement);
      item.remove();
    }
    let cursor = current.firstChild;
    for (const item of desired) {
      if (item === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      current.insertBefore(item, cursor);
    }
  }

  /** Cancels an inline session rename before an unavoidable keyed branch replacement. */
  private cancelInlineRename(container: HTMLElement): void {
    const input = container.querySelector<HTMLInputElement>(".opencode-sessions-panel__rename-input");
    if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  /** Records the mounted row element and handle retained for one keyed tree item. */
  private recordPreservedTreeItem(
    key: string,
    item: HTMLElement,
    context: SessionsPanelTreeReconcileContext,
    sessionId?: string,
  ): void {
    const row = item.querySelector<HTMLElement>(`[data-opencode-row-key="${CSS.escape(key)}"]`);
    if (row) context.preservedRowElements.set(key, row);
    if (sessionId) context.preservedSessionIds.add(sessionId);
  }

  /** Renders the panel header with native clickable-icon affordances. */
  private renderHeader(container = this.contentEl): void {
    const sortValue = normalizeSessionsPanelSessionSort(this.plugin.settings.sessionsPanelSessionSort);
    const header = container.createDiv({ cls: "opencode-sidebar-panel__header opencode-sessions-panel__header" });
    header.dataset.renderSignature = hashRenderState(JSON.stringify(sortValue));
    header.createDiv({ text: "OpenCode sessions", cls: "opencode-sessions-panel__title" });
    const actions = header.createDiv({ cls: "opencode-sessions-panel__actions" });
    const openDirectory = actions.createEl("button", { attr: { "aria-label": "Open directory in OpenCode" }, cls: "clickable-icon" });
    setIcon(openDirectory, "folder-plus");
    openDirectory.addEventListener("click", () => void this.plugin.openDirectoryWithPicker());
    const sort = actions.createEl("button", {
      attr: {
        "aria-label": `Sort sessions: ${SESSIONS_PANEL_SESSION_SORT_LABELS[sortValue]}`,
        title: `Sort sessions: ${SESSIONS_PANEL_SESSION_SORT_LABELS[sortValue]}`,
      },
      cls: "clickable-icon",
    });
    setIcon(sort, "arrow-up-down");
    sort.addEventListener("click", (event) => this.showSessionSortMenu(event));
    const refresh = actions.createEl("button", { attr: { "aria-label": "Refresh OpenCode sessions" }, cls: "clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  /** Opens the header menu containing every supported session sort order. */
  private showSessionSortMenu(event: MouseEvent): void {
    const current = normalizeSessionsPanelSessionSort(this.plugin.settings.sessionsPanelSessionSort);
    const menu = new Menu();
    const options = Object.entries(SESSIONS_PANEL_SESSION_SORT_LABELS) as Array<[SessionsPanelSessionSort, string]>;
    options.forEach(([value, label], index) => {
      if (index === 2 || index === 4) menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setChecked(value === current)
          .onClick(() => void this.setSessionSort(value)),
      );
    });
    menu.showAtMouseEvent(event);
  }

  /** Persists a sort selection and immediately reorders the cached session tree. */
  private async setSessionSort(sort: SessionsPanelSessionSort): Promise<void> {
    if (sort === normalizeSessionsPanelSessionSort(this.plugin.settings.sessionsPanelSessionSort)) return;
    this.plugin.settings.sessionsPanelSessionSort = sort;
    this.lastRenderedTreeSignature = "";
    this.rerenderTree();
    await this.plugin.saveSettings();
  }

  /** Renders an empty connected tree when OpenCode has no sessions yet. */
  private renderEmptyTree(container: HTMLElement): void {
    const state = container.createDiv({ cls: "opencode-sessions-panel__state" });
    state.createDiv({ text: "No directories opened yet.", cls: "opencode-sessions-panel__state-title" });
    state.createDiv({ text: "Open a directory to let the OpenCode server resolve its project/worktree.", cls: "opencode-sessions-panel__state-text" });
    const open = state.createEl("button", { text: "Open directory…", cls: "mod-cta" });
    open.addEventListener("click", () => void this.plugin.openDirectoryWithPicker());
  }

  /** Renders one project branch with a create action when it represents one worktree. */
  private renderProject(container: HTMLElement, project: SessionsPanelProject, parentKey?: string): void {
    const key = `project:${project.id}`;
    this.rowParentKey.set(key, parentKey);
    const collapsed = this.collapsed.has(key);
    const onlyWorktree = project.worktrees.length === 1 ? project.worktrees[0] : undefined;
    const showWorktreeRows = project.worktrees.length > 1 || onlyWorktree?.primary === false;
    const creationDirectory = showWorktreeRows ? undefined : onlyWorktree?.path;
    const row = this.rowComponents.project.render(container, {
      project,
      collapsed,
      collapseDisplay: normalizeFolderCollapseDisplay(this.plugin.settings.folderCollapseDisplay),
      showNewSessionAction: creationDirectory !== undefined,
    });
    this.annotateTreeItem(row.itemEl, key, "project", [project.id, project.name, project.openedDirectories, collapsed, this.plugin.settings.folderCollapseDisplay, creationDirectory]);
    this.annotateTreeChildren(row.childrenEl, key);
    this.registerRow(key, "project", row.rowEl, undefined, creationDirectory);
    if (creationDirectory && row.newSessionButtonEl) this.bindNewSessionAction(row.newSessionButtonEl, creationDirectory);
    row.rowEl.addEventListener("click", () => this.toggleCollapsed(key));
    row.rowEl.addEventListener("contextmenu", (event) => this.showProjectMenu(event, project));
    if (creationDirectory) this.bindSessionDropTarget(row.itemEl, key, project.id, creationDirectory);

    if (collapsed || !row.childrenEl) return;
    if (showWorktreeRows) {
      for (const worktree of project.worktrees) this.renderWorktree(row.childrenEl, project, worktree, key);
      return;
    }

    const worktree = project.worktrees[0];
    if (!worktree) return;
    for (const session of this.sessionsForDisplay(worktree.sessions)) this.renderSession(row.childrenEl, session, key);
  }

  /** Renders the optional worktree/directory level when a project has multiple roots. */
  private renderWorktree(container: HTMLElement, project: SessionsPanelProject, worktree: SessionsPanelWorktree, parentKey?: string): void {
    const key = `worktree:${worktree.id}`;
    this.rowParentKey.set(key, parentKey);
    const collapsed = this.collapsed.has(key);
    const row = this.rowComponents.worktree.render(container, {
      worktree,
      collapsed,
      collapseDisplay: normalizeFolderCollapseDisplay(this.plugin.settings.folderCollapseDisplay),
    });
    this.annotateTreeItem(row.itemEl, key, "worktree", [worktree.id, worktree.name, worktree.path, worktree.primary, worktree.startupState, worktree.startupMessage, collapsed, this.plugin.settings.folderCollapseDisplay]);
    this.annotateTreeChildren(row.childrenEl, key);
    this.registerRow(key, "worktree", row.rowEl, undefined, worktree.path);
    if (row.newSessionButtonEl) this.bindNewSessionAction(row.newSessionButtonEl, worktree.path);
    row.rowEl.addEventListener("click", () => this.toggleCollapsed(key));
    row.rowEl.addEventListener("contextmenu", (event) => this.showWorktreeMenu(event, project, worktree));
    this.bindSessionDropTarget(row.itemEl, key, project.id, worktree.path);

    if (collapsed || !row.childrenEl) return;
    for (const session of this.sessionsForDisplay(worktree.sessions)) this.renderSession(row.childrenEl, session, key);
  }

  /** Returns one grouping's sessions in the user-selected display order. */
  private sessionsForDisplay(sessions: SessionsPanelSession[]): SessionsPanelSession[] {
    return sortSessionsPanelSessions(sessions, normalizeSessionsPanelSessionSort(this.plugin.settings.sessionsPanelSessionSort));
  }

  /** Renders one top-level session row with left status and right notification slots. */
  private renderSession(container: HTMLElement, session: SessionsPanelSession, parentKey?: string): void {
    const key = `session:${session.id}`;
    this.rowParentKey.set(key, parentKey);
    const row = this.rowComponents.session.render(container, {
      session,
      active: this.activeSessionId === session.id,
      workingAnimation: normalizeWorkingAnimation(this.plugin.settings.workingAnimation),
    });
    this.annotateTreeItem(row.itemEl, key, "session", [session, this.activeSessionId === session.id, this.plugin.settings.workingAnimation]);
    row.rowEl.dataset.sessionId = session.id;
    this.sessionRowHandles.set(session.id, row);
    this.registerRow(key, "session", row.rowEl, session);
    this.bindSessionDragSource(row.rowEl, session.id);
    row.rowEl.addEventListener("click", () => {
      const current = this.visibleRows.find((candidate) => candidate.session?.id === session.id)?.session;
      if (current) this.selectSession(current);
    });
    row.rowEl.addEventListener("contextmenu", (event) => {
      const current = this.visibleRows.find((candidate) => candidate.session?.id === session.id)?.session;
      if (current) this.showSessionMenu(event, current);
    });
  }

  /** Makes one session row draggable while resolving current tree state at drag time. */
  private bindSessionDragSource(row: HTMLElement, sessionId: string): void {
    row.draggable = true;
    if (this.sessionDrag?.sessionId === sessionId) {
      row.addClass("opencode-sessions-panel__session--dragging");
      row.setAttribute("aria-grabbed", "true");
    }
    row.addEventListener("dragstart", (event) => this.handleSessionDragStart(row, sessionId, event));
    row.addEventListener("dragend", () => this.clearSessionDragState());
  }

  /** Starts a session move drag and publishes its ID through the native data transfer. */
  private handleSessionDragStart(row: HTMLElement, sessionId: string, event: DragEvent): void {
    if (event.target instanceof HTMLInputElement || this.movingSessionIds.has(sessionId)) {
      event.preventDefault();
      return;
    }
    const session = this.visibleRows.find((candidate) => candidate.session?.id === sessionId)?.session;
    const location = this.locationForSession(sessionId);
    if (!session || !location) {
      event.preventDefault();
      return;
    }
    this.sessionDrag = {
      sessionId,
      sourceDirectory: session.directory,
      sourceContainerDirectory: location.directory,
      projectId: location.projectId,
    };
    row.addClass("opencode-sessions-panel__session--dragging");
    row.setAttribute("aria-grabbed", "true");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
    }
  }

  /** Binds one project/worktree shell as a move destination for session drags. */
  private bindSessionDropTarget(item: HTMLElement, key: string, projectId: string, directory: string): void {
    if (this.sessionDropTargetKey === key && this.sessionDropTargetState) this.paintSessionDropTarget(item, this.sessionDropTargetState);
    item.addEventListener("dragenter", (event) => this.handleSessionDragEnter(item, key, projectId, directory, event));
    item.addEventListener("dragover", (event) => this.handleSessionDragOver(item, key, projectId, directory, event));
    item.addEventListener("dragleave", (event) => this.handleSessionDragLeave(item, key, event));
    item.addEventListener("drop", (event) => this.handleSessionDrop(key, projectId, directory, event));
  }

  /** Tracks nested drag entries so Chromium child crossings do not clear folder feedback. */
  private handleSessionDragEnter(item: HTMLElement, key: string, projectId: string, directory: string, event: DragEvent): void {
    if (!this.updateSessionDropTarget(item, key, projectId, directory, event)) return;
    this.sessionDropDepth += 1;
  }

  /** Keeps destination feedback active while the native drag remains over a folder. */
  private handleSessionDragOver(item: HTMLElement, key: string, projectId: string, directory: string, event: DragEvent): void {
    this.updateSessionDropTarget(item, key, projectId, directory, event);
  }

  /** Shows valid/error feedback and schedules file-explorer-style hover expansion. */
  private updateSessionDropTarget(item: HTMLElement, key: string, projectId: string, directory: string, event: DragEvent): boolean {
    if (!this.sessionDrag || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes(SESSION_DRAG_MIME)) return false;
    event.preventDefault();
    event.stopPropagation();
    const state = this.sessionDropState(projectId, directory);
    if (event.dataTransfer) event.dataTransfer.dropEffect = state === "valid" ? "move" : "none";
    if (this.sessionDropTargetKey !== key) {
      this.clearSessionDropTarget();
      this.sessionDropTargetKey = key;
    }
    this.sessionDropTargetState = state;
    this.paintSessionDropTarget(item, state);
    if (state === "valid" && this.collapsed.has(key) && this.sessionDropExpandTimer === undefined) {
      this.sessionDropExpandTimer = window.setTimeout(() => {
        this.sessionDropExpandTimer = undefined;
        if (!this.sessionDrag || this.sessionDropTargetKey !== key || !this.collapsed.delete(key)) return;
        this.rerenderTree();
      }, SESSION_DROP_EXPAND_DELAY_MS);
    }
    return true;
  }

  /** Clears destination feedback once the pointer exits the complete folder rectangle. */
  private handleSessionDragLeave(item: HTMLElement, key: string, event: DragEvent): void {
    event.stopPropagation();
    if (this.sessionDropTargetKey !== key) return;
    this.sessionDropDepth = Math.max(0, this.sessionDropDepth - 1);
    if (this.sessionDropDepth === 0) this.clearSessionDropTarget();
  }

  /** Moves only the session binding when a valid same-project destination is dropped. */
  private handleSessionDrop(key: string, projectId: string, directory: string, event: DragEvent): void {
    if (!this.sessionDrag) return;
    if (!event.dataTransfer || event.dataTransfer.getData(SESSION_DRAG_MIME) !== this.sessionDrag.sessionId) {
      this.clearSessionDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const drag = this.sessionDrag;
    const valid = this.sessionDropTargetKey === key && this.sessionDropState(projectId, directory) === "valid";
    const active = valid && this.isWorkingSession(drag.sessionId);
    this.clearSessionDragState();
    if (active) {
      new Notice("Abort the session before moving it.");
      return;
    }
    if (valid) void this.moveSessionAfterDrop(drag, directory);
  }

  /** Executes one validated move and surfaces endpoint failures without changing files. */
  private async moveSessionAfterDrop(drag: SessionsPanelSessionDrag, directory: string): Promise<void> {
    if (this.movingSessionIds.has(drag.sessionId)) return;
    this.movingSessionIds.add(drag.sessionId);
    try {
      await this.plugin.moveSessionToDirectory(drag.sessionId, drag.sourceDirectory, directory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to move OpenCode session.");
    } finally {
      this.movingSessionIds.delete(drag.sessionId);
    }
  }

  /** Classifies a folder as a valid destination, another project, or the current directory. */
  private sessionDropState(projectId: string, directory: string): SessionDropTargetState {
    if (!this.sessionDrag || this.pathKey(directory) === this.pathKey(this.sessionDrag.sourceContainerDirectory)) return "noop";
    return projectId === this.sessionDrag.projectId ? "valid" : "invalid";
  }

  /** Finds the rendered project and folder containing a session without inferring either from its path. */
  private locationForSession(sessionId: string): { projectId: string; directory: string } | undefined {
    for (const project of this.lastTree) {
      const worktree = project.worktrees.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
      if (worktree) return { projectId: project.id, directory: worktree.path };
    }
    return undefined;
  }

  /** Returns whether the latest panel status requires aborting before a move. */
  private isWorkingSession(sessionId: string): boolean {
    for (const project of this.lastTree) {
      for (const worktree of project.worktrees) {
        const status = worktree.sessions.find((session) => session.id === sessionId)?.status;
        if (status) return status === "working" || status === "retry";
      }
    }
    return false;
  }

  /** Applies semantic accent or error feedback to a complete destination section. */
  private paintSessionDropTarget(item: HTMLElement, state: SessionDropTargetState): void {
    item.removeClass("opencode-sessions-panel__folder--drop-target", "opencode-sessions-panel__folder--drop-invalid");
    if (state === "valid") item.addClass("opencode-sessions-panel__folder--drop-target");
    if (state === "invalid") item.addClass("opencode-sessions-panel__folder--drop-invalid");
  }

  /** Clears the active destination and any pending hover expansion. */
  private clearSessionDropTarget(): void {
    if (this.sessionDropExpandTimer !== undefined) window.clearTimeout(this.sessionDropExpandTimer);
    this.sessionDropExpandTimer = undefined;
    this.sessionDropTargetKey = undefined;
    this.sessionDropTargetState = undefined;
    this.sessionDropDepth = 0;
    this.contentEl.querySelectorAll(".opencode-sessions-panel__folder--drop-target, .opencode-sessions-panel__folder--drop-invalid")
      .forEach((item) => item.removeClass("opencode-sessions-panel__folder--drop-target", "opencode-sessions-panel__folder--drop-invalid"));
  }

  /** Resets drag source, destination, and accessibility state after drop or cancellation. */
  private clearSessionDragState(): void {
    this.clearSessionDropTarget();
    this.sessionDrag = undefined;
    this.contentEl.querySelectorAll(".opencode-sessions-panel__session--dragging").forEach((row) => {
      row.removeClass("opencode-sessions-panel__session--dragging");
      row.removeAttribute("aria-grabbed");
    });
  }

  /** Annotates one item shell for keyed reconciliation independently of descendant state. */
  private annotateTreeItem(item: HTMLElement, key: string, kind: SessionsPanelVisibleRow["kind"], state: unknown): void {
    item.dataset.opencodeTreeKey = key;
    item.dataset.opencodeTreeKind = kind;
    item.dataset.opencodeTreeSignature = hashRenderState(JSON.stringify(state));
  }

  /** Marks a custom or default folder child container for nested keyed reconciliation. */
  private annotateTreeChildren(children: HTMLElement | undefined, key: string): void {
    if (children) children.dataset.opencodeChildrenKey = key;
  }

  /** Binds a row component's creation action to the panel-owned draft workflow. */
  private bindNewSessionAction(action: HTMLButtonElement, directory: string): void {
    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.createNewSession(directory);
    });
  }

  /** Applies panel-local overlays from events the shared store does not own (attention requests). */
  private applyLiveSessionEvent(event: OpenCodeEvent): void {
    const properties = event.properties;
    if (!properties) return;
    if (event.type === "question.asked") {
      const sessionId = this.readString(properties, ["sessionID", "sessionId"]);
      if (sessionId) this.applyLiveRequestAttention(sessionId);
    }
  }

  /** Applies one centrally surfaced permission request to its owner and known ancestor rows. */
  ingestPermissionRequest(request: OpenCodePermissionRequest): void {
    this.applyLiveRequestAttention(request.sessionID);
    this.scheduleRefresh();
  }

  /** Paints an asked request's owner and every known ancestor without waiting for GET snapshots. */
  private applyLiveRequestAttention(ownerSessionId: string): void {
    const visited = new Set<string>();
    let sessionId: string | undefined = ownerSessionId;
    while (sessionId && !visited.has(sessionId)) {
      visited.add(sessionId);
      this.requestAttentionSessionIds.add(sessionId);
      this.sessionRowHandles.get(sessionId)?.updateStatus("attention", normalizeWorkingAnimation(this.plugin.settings.workingAnimation));
      sessionId = this.sessionParentIds.get(sessionId);
    }
  }

  /** Repaints one visible session row's status without waiting for a full sidebar refresh; referenced by the store listener. */
  private paintSessionStatus(sessionId: string): void {
    const visualStatus = this.visualStatusFor(sessionId);
    for (const project of this.lastTree) {
      for (const worktree of project.worktrees) {
        const session = worktree.sessions.find((candidate) => candidate.id === sessionId);
        if (session) session.status = visualStatus;
      }
    }
    this.sessionRowHandles.get(sessionId)?.updateStatus(visualStatus, normalizeWorkingAnimation(this.plugin.settings.workingAnimation));
  }

  /** Selects a session row and opens its read-only Obsidian session tab. */
  private selectSession(session: SessionsPanelSession): void {
    this.activeSessionId = session.id;
    this.highlightedKey = `session:${session.id}`;
    this.renderActiveOnly();
    void this.plugin.openSessionTab(session.id, session.title);
  }

  /**
   * Mirrors the focused session tab into the panel; referenced by OpenCodePlugin's
   * active-leaf-change handler and the "Open sessions panel" command so the panel
   * behaves like Obsidian's "Reveal current file in navigation" instead of just
   * "Show file explorer". Expands collapsed project/worktree ancestors so the row is revealed,
   * then applies is-active and the keyboard highlight.
   */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
    if (!sessionId) {
      this.renderActiveOnly();
      return;
    }
    const key = `session:${sessionId}`;
    const ancestors = this.sessionAncestorMap.get(sessionId) ?? [];
    const needsExpand = ancestors.some((ancestorKey) => this.collapsed.has(ancestorKey));
    if (needsExpand) {
      for (const ancestorKey of ancestors) this.collapsed.delete(ancestorKey);
      this.highlightedKey = key;
      this.rerenderTree();
      this.applyHighlight();
      return;
    }
    // Only move the keyboard highlight when the row is actually visible so an
    // unknown/draft session id does not strand focus on a non-existent row.
    if (this.visibleRows.some((row) => row.key === key)) this.highlightedKey = key;
    this.renderActiveOnly();
  }

  /**
   * Builds a session-id → ancestor collapse-key map from the full tree structure,
   * independent of collapsed state so setActiveSession can expand ancestors of
   * sessions that are currently hidden inside collapsed project/worktree nodes.
   */
  private buildSessionAncestorMap(projects: SessionsPanelProject[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const project of projects) {
      const projectKey = `project:${project.id}`;
      const multiWorktree = project.worktrees.length > 1;
      for (const worktree of project.worktrees) {
        const baseAncestors = multiWorktree ? [projectKey, `worktree:${worktree.id}`] : [projectKey];
        for (const session of worktree.sessions) map.set(session.id, baseAncestors);
      }
    }
    return map;
  }

  /**
   * Moves DOM focus onto the panel container so the focus-gated keydown handler
   * receives arrow-key navigation immediately; referenced by the OpenCodePlugin
   * "Open sessions panel" command to mirror Obsidian's "Reveal current file in navigation".
   */
  focusContent(): void {
    this.contentEl.focus();
  }

  /** Re-renders the cached tree for local-only state changes like collapse/expand. */
  private rerenderTree(): void {
    if (this.lastTree.length > 0) this.renderTree(this.lastTree);
  }

  /** Clears cached tree/row state so keyboard nav cannot resurrect stale data on loading/disconnected screens. */
  private clearTreeState(): void {
    this.lastTree = [];
    this.visibleRows = [];
    this.rowParentKey.clear();
    this.sessionAncestorMap.clear();
    this.sessionRowHandles.clear();
  }

  /** Toggles a tree branch and re-renders locally without a server round-trip. */
  private toggleCollapsed(key: string, rerender = true): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else {
      let ancestor = this.highlightedKey ? this.rowParentKey.get(this.highlightedKey) : undefined;
      while (ancestor) {
        if (ancestor === key) {
          this.highlightedKey = key;
          break;
        }
        ancestor = this.rowParentKey.get(ancestor);
      }
      this.collapsed.add(key);
    }
    if (rerender) this.rerenderTree();
  }

  /** Refreshes the row state after a local-only active selection changes. */
  private renderActiveOnly(): void {
    this.sessionRowHandles.forEach((row) => row.updateActive(false));
    this.contentEl.querySelectorAll(".opencode-sessions-panel__row-highlighted").forEach((row) => row.removeClass("opencode-sessions-panel__row-highlighted"));
    if (!this.activeSessionId) return;
    this.sessionRowHandles.get(this.activeSessionId)?.updateActive(true);
    this.applyHighlight();
  }

  /** Registers a visible tree row for keyboard navigation and highlight management. */
  private registerRow(key: string, kind: "project" | "worktree" | "session", element: HTMLElement, session?: SessionsPanelSession, directory?: string): void {
    this.visibleRows.push({ key, kind, element, session, directory });
    element.dataset.opencodeRowKey = key;
    if (!this.highlightedKey) this.highlightedKey = key;
    if (this.highlightedKey === key) element.addClass("opencode-sessions-panel__row-highlighted");
  }

  /** Handles focus-gated tree keyboard navigation modeled after Obsidian's file explorer. */
  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const rename = (event.key === "Enter" && unmodified) || matchesObsidianCommandHotkey(this.app, RENAME_CURRENT_FILE_COMMANDS, event);
    const archive = ((event.key === "Backspace" || event.key === "Delete") && unmodified) || matchesObsidianCommandHotkey(this.app, DELETE_CURRENT_FILE_COMMANDS, event);
    if (row?.session && rename) {
      event.preventDefault();
      event.stopPropagation();
      this.beginInlineRename(row.session);
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
      void this.plugin.toggleSessionAutoApprove(row.session.id, row.session.directory);
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Enter"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowUp") this.moveHighlight(-1);
    if (event.key === "ArrowDown") this.moveHighlight(1);
    if (event.key === "ArrowLeft") this.collapseHighlighted();
    if (event.key === "ArrowRight") this.expandHighlighted();
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
    this.contentEl.querySelectorAll(".opencode-sessions-panel__row-highlighted").forEach((row) => row.removeClass("opencode-sessions-panel__row-highlighted"));
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    row?.element.addClass("opencode-sessions-panel__row-highlighted");
    row?.element.scrollIntoView({ block: "nearest" });
  }

  /** Collapses the highlighted branch, or moves from a session row to its parent. */
  private collapseHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row) return;
    // File-explorer parity: pressing Left on a leaf collapses and focuses its parent.
    if (row.kind === "session") {
      const parentKey = this.rowParentKey.get(row.key);
      if (!parentKey) return;
      this.collapsed.add(parentKey);
      this.highlightedKey = parentKey;
      this.rerenderTree();
      return;
    }
    this.collapsed.add(row.key);
    this.rerenderTree();
  }

  /** Expands a highlighted container or opens a highlighted session. */
  private expandHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row) return;
    if (row.kind === "project" || row.kind === "worktree") {
      this.collapsed.delete(row.key);
      this.rerenderTree();
      return;
    }
    if (row.kind === "session" && row.session) this.openHighlightedSession(row.session);
  }

  /** Opens a highlighted session or creates a draft for the highlighted folder. */
  private activateHighlighted(): void {
    const row = this.visibleRows.find((candidate) => candidate.key === this.highlightedKey);
    if (!row) return;
    if ((row.kind === "project" || row.kind === "worktree") && row.directory) void this.createNewSession(row.directory);
    if (row.kind === "session" && row.session) {
      this.openHighlightedSession(row.session);
    }
  }

  /** Opens one keyboard-highlighted session and mirrors its active state in the panel. */
  private openHighlightedSession(session: SessionsPanelSession): void {
    this.activeSessionId = session.id;
    this.renderActiveOnly();
    void this.plugin.openSessionTab(session.id, session.title);
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

  /** Converts the canonical store status plus shared error/attention overlays into the panel's visual states. */
  private visualStatusFor(sessionId: string, requiresAttention = this.requestAttentionSessionIds.has(sessionId)): SessionVisualStatus {
    if (requiresAttention) return "attention";
    if (this.plugin.sessionStatuses?.hasSessionError(sessionId)) return "error";
    const type = this.plugin.sessionStatuses?.statusFor(sessionId)?.type;
    return visualStatusForSession(type, this.plugin.isSessionUnread(sessionId));
  }

  /** Extracts a session title with useful fallbacks for incomplete API payloads. */
  private sessionTitle(session: OpenCodeSession): string {
    return this.readString(session, ["title", "name", "summary"]) ?? session.id;
  }

  /** Reads one finite epoch-millisecond session timestamp from OpenCode metadata. */
  private sessionTime(session: OpenCodeSession, key: "created" | "updated"): number | undefined {
    const value = this.readObject(session, "time")?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

  /** Opens the native project menu for project-wide close and worktree discovery/creation. */
  private showProjectMenu(event: MouseEvent, project: SessionsPanelProject): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Refresh").setIcon("refresh-cw").onClick(() => void this.refresh()));
    menu.addItem((item) => item.setTitle(`Project: ${project.name}`).setDisabled(true));
    if (project.git) {
      menu.addSeparator();
      const opened = new Set(project.openedDirectories.map((directory) => this.pathKey(directory)));
      const unopened = project.managedWorktreeDirectories.filter((directory) => !opened.has(this.pathKey(directory)));
      const creating = this.plugin.isWorktreeOperationInProgress?.(project.rootDirectory) === true;
      menu.addItem((item) => item
        .setTitle("Open existing worktree...")
        .setIcon("folder-open")
        .setDisabled(unopened.length === 0)
        .onClick(() => void this.plugin.openExistingWorktree(project.rootDirectory)));
      menu.addItem((item) => item
        .setTitle("Create worktree...")
        .setIcon("git-branch-plus")
        .setDisabled(creating)
        .onClick(() => void this.plugin.requestWorktreeCreate(project.rootDirectory)));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("Close project")
      .setIcon("x")
      .onClick(() => void this.plugin.removeOpenedDirectories(project.openedDirectories)));
    menu.showAtMouseEvent(event);
  }

  /** Opens close/reset/remove actions for one visible worktree directory row. */
  private showWorktreeMenu(event: MouseEvent, project: SessionsPanelProject, worktree: SessionsPanelWorktree): void {
    event.preventDefault();
    const menu = new Menu();
    if (worktree.startupState) {
      const presentation = worktreeStatePresentation(worktree.startupState);
      menu.addItem((item) => item
        .setTitle(presentation.label)
        .setIcon(presentation.icon)
        .setDisabled(true));
      menu.addSeparator();
    }
    menu.addItem((item) => item
      .setTitle("Close directory")
      .setIcon("x")
      .onClick(() => void this.plugin.removeOpenedDirectory(worktree.path)));
    if (project.git && !worktree.primary) {
      const busy = this.plugin.isWorktreeOperationInProgress?.(worktree.path) === true ||
        worktree.startupState === "pending" || worktree.sessions.some((session) => session.status === "working" || session.status === "retry");
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle("Reset worktree...")
        .setIcon("rotate-ccw")
        .setDisabled(busy)
        .onClick(() => void this.plugin.requestWorktreeReset(project.rootDirectory, worktree.path)));
      menu.addItem((item) => item
        .setTitle("Remove worktree...")
        .setIcon("trash-2")
        .setDisabled(busy)
        .onClick(() => void this.plugin.requestWorktreeRemove(project.rootDirectory, worktree.path)));
    }
    menu.showAtMouseEvent(event);
  }

  /** Opens the session action menu for a sidebar row. */
  private showSessionMenu(event: MouseEvent, session: SessionsPanelSession): void {
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
    menu.addItem((item) => item.setTitle("Rename session").setIcon("pencil").onClick(() => this.beginInlineRename(session)));
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
  private beginInlineRename(session: SessionsPanelSession): void {
    const title = this.sessionRowHandles.get(session.id)?.titleEl;
    if (!title || title.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "opencode-sessions-panel__rename-input";
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
    input.addEventListener("blur", () => void finish(input.isConnected));
  }

  /** Toggles local notification muting for a root row; subagent sessions are not panel rows. */
  private async toggleSessionMute(session: SessionsPanelSession): Promise<void> {
    session.muted = !session.muted;
    await this.plugin.rememberSessionMute(session.id, session.muted, false);
    await this.refresh({ showLoading: false });
  }

  /** Forks a sidebar session from its latest turn and opens the new session tab. */
  private async forkSession(session: SessionsPanelSession): Promise<void> {
    try {
      await this.plugin.forkSessionAndOpen(session.id, session.directory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to fork OpenCode session.");
    }
  }

  /** Copies a session id from the context menu; referenced by showSessionMenu for testing workflows. */
  private async copySessionId(sessionId: string): Promise<void> {
    await navigator.clipboard.writeText(sessionId);
    new Notice(`Copied session ID: ${sessionId}`);
  }

}
