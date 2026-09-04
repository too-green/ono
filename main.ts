import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_OPENCODE_SETTINGS,
  OPENCODE_DATA_SCHEMA_VERSION,
  OpenCodeSettingTab,
  normalizeSessionsPanelSessionSort,
  normalizeContextBarSettings,
  normalizeDebugLogging,
  normalizeFolderCollapseDisplay,
  normalizeNotificationMode,
  normalizeOpenIde,
  normalizeRetryActionLastShown,
  normalizeRetryActionSuppressed,
  normalizeServerBaseUrl,
  normalizeServerUsername,
  normalizeSessionIslandContextLabel,
  normalizePersistedSessionStates,
  normalizeTodoStatusCharacter,
  type ComposerAttachment,
  type OpenCodePluginData,
  type OpenCodePluginSettings,
  type PersistedSessionState,
} from "./src/settings";
import { OpenCodeService, type OpenCodeServerConfig } from "./src/services/opencode-service";
import type { OpenCodeEventSubscription } from "./src/services/opencode-events";
import type { JsonObject, OpenCodeEvent, OpenCodeHealth, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from "./src/services/opencode-types";
import { SessionNotificationService, isElementVisibleInFocusedWindow, type SessionNotificationTestKind } from "./src/services/session-notifications";
import { confirmSessionArchive, requestRetryAction, requestSessionTitle, type SessionArchiveNode } from "./src/session-actions";
import { SessionsPanelView, VIEW_TYPE_OPENCODE_SESSIONS_PANEL } from "./src/views/SessionsPanelView";
import { SessionView, VIEW_TYPE_OPENCODE_SESSION } from "./src/views/SessionView";
import { loadFolderSuggestions, NewSessionFolderModal } from "./src/views/NewSessionFolderModal";
import { isActiveSessionStatus, normalizeWorkingAnimation } from "./src/session-state";
import { PermissionCoordinator } from "./src/permission-coordinator";
import type { SessionAutoApproveState } from "./src/session-auto-approve";
import { SessionHierarchy } from "./src/session-hierarchy";
import { muteOverrideForState, resolveSessionNotificationState } from "./src/session-notification-state";
import { getIdeOrDefault, launchIde } from "./src/utils/ide-launcher";
import { nextAvailableForkTitle } from "./src/session-fork";
import { logServiceError, OpenCodeHttpError } from "./src/services/opencode-http";
import { logger } from "./src/logger";
import { eligibleRetryActionKey, safeRetryActionLink, type SessionRetryAction } from "./src/session-retry-action";
import { DirectoryContextStore } from "./src/services/directory-context-store";
import { WorktreeManagementService } from "./src/services/worktree-management-service";
import { confirmWorktreeAction, ExistingWorktreeModal, requestWorktreeCreation } from "./src/views/WorktreeModals";

export const LEGACY_DIFF_PANEL_VIEW_TYPE = "opencode-diff-panel";

export default class OpenCodePlugin extends Plugin {
  settings: OpenCodePluginSettings = DEFAULT_OPENCODE_SETTINGS;
  opencode?: OpenCodeService;
  readonly directoryContexts = new DirectoryContextStore(() => this.requireOpenCodeService());
  readonly worktrees = new WorktreeManagementService(() => this.requireOpenCodeService());
  private archivingSessionIds = new Set<string>();
  private notificationService?: SessionNotificationService;
  private notificationEventSubscriptions = new Map<string, OpenCodeEventSubscription>();
  private worktreeEventSubscription?: OpenCodeEventSubscription;
  private worktreeStatuses = new Map<string, { state: "pending" | "failed"; message?: string }>();
  private worktreeStatusTimers = new Map<string, number>();
  private earlyReadyWorktreeKeys = new Set<string>();
  private pendingWorktreeCreateCount = 0;
  private worktreeOperationKeys = new Set<string>();
  private worktreeOperationStates = new Map<string, "removing" | "resetting">();
  private debugLoggingSaveQueue: Promise<void> = Promise.resolve();
  private settingsSaveQueue: Promise<void> = Promise.resolve();
  private sessionStatePruneQueue: Promise<void> = Promise.resolve();
  private sessionStatePruneTimer?: number;
  private pendingDraftPrune = false;
  private retryActionModalOpen = false;
  private layoutReady = false;
  private unloading = false;
  private forgottenSessionIds = new Set<string>();
  private retiredDraftIds = new Set<string>();
  private sessionState: Pick<OpenCodePluginData, "sessions" | "drafts"> = { sessions: {}, drafts: {} };
  private readonly sessionHierarchy = new SessionHierarchy({
    getSession: (sessionId, directory) => this.requireOpenCodeService().getSession(sessionId, directory),
  });
  private permissionCoordinator = new PermissionCoordinator({
    getSettings: () => this.sessionAutoApproveOverrides(),
    getService: () => this.requireOpenCodeService(),
    hierarchy: this.sessionHierarchy,
    onSurface: (request, directory) => this.surfacePermissionRequest(request, directory),
    onSettled: (requestId) => {
      this.notificationService?.settleRequest(requestId);
      this.removeSettledRequestFromViews(requestId);
    },
    onRespondingChanged: () => this.refreshSessionRequestDocks(),
    onError: (error) => new Notice(error instanceof Error ? error.message : "Unable to auto-approve permission request."),
  });

  /** Initializes plugin settings and the OpenCode API service used by future UI views. */
  async onload(): Promise<void> {
    this.layoutReady = false;
    this.unloading = false;
    await this.loadSettings();
    this.opencode = new OpenCodeService(this.settings.server);
    this.worktreeEventSubscription = this.opencode.subscribeToGlobalEvents({
      onEvent: (event, directory) => this.handleWorktreeEvent(event, directory),
    });
    logger.setDebugEnabled(this.settings.debugLogging);
    logger.debug("lifecycle", "loading", { count: this.settings.openedDirectories.length });
    this.notificationService = new SessionNotificationService({
      getPreferences: () => ({
        mode: this.settings.notificationMode,
        attention: this.settings.notifyOnAttention,
        errors: this.settings.notifyOnSessionError,
        turnComplete: this.settings.notifyOnTurnComplete,
      }),
      isSessionMuted: (session) => this.getSessionNotificationState(session).muted,
      isSessionVisible: (sessionId) => this.isSessionVisibleInFocusedWindow(sessionId),
      getSession: (sessionId, directory) => this.sessionHierarchy.getSession(sessionId, directory),
      getSessionLineage: (sessionId, directory) => this.sessionHierarchy.lineage(sessionId, directory),
      openSession: (sessionId, title) => this.openSessionTab(sessionId, title),
    });
    this.syncNotificationEventSubscriptions();

    this.registerView(VIEW_TYPE_OPENCODE_SESSIONS_PANEL, (leaf) => new SessionsPanelView(leaf, this));
    this.registerView(VIEW_TYPE_OPENCODE_SESSION, (leaf) => new SessionView(leaf, this));
    this.addSettingTab(new OpenCodeSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.app.workspace.detachLeavesOfType(LEGACY_DIFF_PANEL_VIEW_TYPE);
      this.scheduleSessionStatePrune(0, true);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.syncSessionsPanelToActiveSessionLeaf(leaf);
      }),
    );

    this.addRibbonIcon("bot", "OpenCode sessions", () => {
      void this.activateSessionsPanel();
    });

    // Legacy stable command id: Obsidian persists user hotkeys under this id, so it stays
    // unchanged even though the command name and view now say "sessions panel".
    this.addCommand({
      id: "opencode-open-agent-panel",
      name: "Open sessions panel",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "A" }],
      callback: () => void this.activateSessionsPanel(),
    });

    this.addCommand({
      id: "opencode-open-directory",
      name: "Open new directory",
      callback: () => void this.openDirectoryWithPicker(),
    });

    this.addCommand({
      id: "opencode-check-connection",
      name: "Check OpenCode server connection",
      callback: () => this.checkConnection(),
    });

    this.addCommand({
      id: "opencode-cycle-active-session-island-tab",
      name: "Cycle active session island tab",
      checkCallback: (checking) => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof SessionView) || !view.canCycleSessionIslandTabs()) return false;
        if (!checking) view.cycleSessionIslandTab();
        return true;
      },
    });

    this.addCommand({
      id: "opencode-cycle-favorite-model",
      name: "Cycle favorite model-variant pairs",
      checkCallback: (checking) => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof SessionView)) return false;
        if (!checking) view.cycleFavoriteModel();
        return true;
      },
    });

    this.addCommand({
      id: "opencode-cycle-agent-mode",
      name: "Cycle agent mode",
      checkCallback: (checking) => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof SessionView)) return false;
        if (!checking) view.cycleAgentMode();
        return true;
      },
    });

    this.addCommand({
      id: "opencode-new-session-in-current-folder",
      name: "Create new session in current session's folder",
      checkCallback: (checking) => {
        const directory = this.getActiveSessionDirectory();
        if (!directory) return false;
        if (!checking) void this.openNewSessionTab(directory);
        return true;
      },
    });

    this.addCommand({
      id: "opencode-new-session-in-opened-folder",
      name: "Create new session in an opened folder",
      callback: () => void this.openNewSessionFolderModal(),
    });

    this.addCommand({
      id: "opencode-archive-current-session",
      name: "Archive current session",
      checkCallback: (checking) => {
        const sessionId = this.getActiveSessionId();
        if (!sessionId) return false;
        if (!checking) void this.requestSessionArchive(sessionId, this.getActiveSessionDirectory());
        return true;
      },
    });

    this.addCommand({
      id: "opencode-open-project-in-ide",
      name: "Open current project in IDE",
      checkCallback: (checking) => {
        const directory = this.getActiveSessionDirectory();
        if (!directory) return false;
        if (!checking) void this.openProjectInIde(directory, this.settings.openIde);
        return true;
      },
    });
    logger.debug("lifecycle", "loaded");
  }

  /** Detaches plugin-owned views before releasing service resources during unload or reload. */
  onunload(): void {
    logger.debug("lifecycle", "unloading");
    this.unloading = true;
    if (this.sessionStatePruneTimer !== undefined) window.clearTimeout(this.sessionStatePruneTimer);
    this.sessionStatePruneTimer = undefined;
    logger.setDebugEnabled(false);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OPENCODE_SESSION);
    this.app.workspace.detachLeavesOfType(LEGACY_DIFF_PANEL_VIEW_TYPE);
    this.closeNotificationEventSubscriptions();
    this.worktreeEventSubscription?.close();
    this.worktreeEventSubscription = undefined;
    this.worktreeOperationStates?.clear();
    for (const timer of this.worktreeStatusTimers?.values() ?? []) window.clearTimeout(timer);
    this.worktreeStatusTimers?.clear();
    this.notificationService?.dispose();
    this.directoryContexts?.clear();
    this.opencode?.dispose();
  }

  /** Returns the initialized OpenCode API service for registered plugin views. */
  requireOpenCodeService(): OpenCodeService {
    if (!this.opencode) throw new Error("OpenCode service has not been initialized.");
    return this.opencode;
  }

  /** Keeps one plugin-level event subscriber per opened directory for background notifications. */
  private syncNotificationEventSubscriptions(): void {
    const directories = new Set(this.settings.openedDirectories);
    for (const [directory, subscription] of this.notificationEventSubscriptions) {
      if (directories.has(directory)) continue;
      subscription.close();
      this.notificationEventSubscriptions.delete(directory);
    }
    for (const directory of directories) {
      if (this.notificationEventSubscriptions.has(directory)) continue;
      const subscription = this.requireOpenCodeService().subscribeToEvents({
        onOpen: () => {
          this.directoryContexts?.invalidate(directory);
          this.reconcileSessionStateAfterReconnect();
        },
        onEvent: (event) => this.handleNotificationEvent(event, directory),
      }, directory);
      this.notificationEventSubscriptions.set(directory, subscription);
    }
  }

  /** Closes every plugin-level event subscriber during unload or service replacement. */
  private closeNotificationEventSubscriptions(): void {
    for (const subscription of this.notificationEventSubscriptions.values()) subscription.close();
    this.notificationEventSubscriptions.clear();
  }

  /** Centrally routes request and lifecycle events needed even when no plugin view is mounted. */
  private handleNotificationEvent(event: OpenCodeEvent, directory: string): void {
    this.directoryContexts?.handleEvent(directory, event);
    const properties = event.properties;
    const info = properties?.info;
    const session = info && typeof info === "object" && !Array.isArray(info) ? info as JsonObject : undefined;
    const sessionId = session ? this.readEventString(session, ["id"]) : properties ? this.readEventString(properties, ["sessionID", "sessionId"]) : undefined;
    const time = session?.time;
    const archived = time && typeof time === "object" && !Array.isArray(time) && typeof (time as JsonObject).archived === "number";
    if (sessionId && (event.type === "session.deleted" || (event.type === "session.updated" && archived))) {
      void this.forgetSessionState([sessionId]).catch((error) => logger.warn("settings", "session lifecycle cleanup failed", { error }));
    }
    if (event.type === "permission.asked" && properties) {
      this.routePermissionRequest(properties as OpenCodePermissionRequest, directory);
    } else if (event.type === "question.asked" && properties) {
      this.routeQuestionRequest(properties as OpenCodeQuestionRequest, directory);
    } else if (
      (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") &&
      properties
    ) {
      this.settleSessionRequest(this.readEventString(properties, ["requestID", "requestId", "id"]));
    }
    this.notificationService?.handleSessionEvent(event, directory);
  }

  /** Reads one non-empty string from a loosely typed event payload. */
  private readEventString(properties: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = properties[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  }

  /** Returns user-opened absolute directories; referenced by the sessions panel refresh loop. */
  getOpenedDirectories(): string[] {
    return [...this.settings.openedDirectories];
  }

  /** Returns transient worktree startup state for sessions-panel row rendering. */
  getWorktreeStatus(directory: string): { state: "pending" | "failed" | "removing" | "resetting"; message?: string } | undefined {
    const operation = this.worktreeOperationStates.get(this.pathKey(directory));
    if (operation) return { state: operation };
    return this.worktreeStatuses.get(this.pathKey(directory));
  }

  /** Returns whether one worktree or project currently has a mutation in flight. */
  isWorktreeOperationInProgress(directory: string): boolean {
    return this.worktreeOperationKeys.has(this.pathKey(directory));
  }

  /** Opens a server-discovered worktree that is not already present in the sessions panel. */
  async openExistingWorktree(projectDirectory: string): Promise<void> {
    try {
      const opened = new Set(this.getOpenedDirectories().map((directory) => this.pathKey(directory)));
      const directories = (await this.worktrees.list(projectDirectory)).filter((directory) => !opened.has(this.pathKey(directory)));
      if (directories.length === 0) {
        new Notice("No unopened OpenCode-managed worktrees were found.");
        return;
      }
      new ExistingWorktreeModal(this.app, directories, (directory) => void this.addOpenedDirectory(directory)).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to list existing worktrees.");
    }
  }

  /** Prompts for optional creation settings and opens the server-created worktree in the panel. */
  async requestWorktreeCreate(projectDirectory: string): Promise<void> {
    const operationKey = this.pathKey(projectDirectory);
    if (!this.beginWorktreeOperation(operationKey)) return;
    let createStarted = false;
    let createdName: string | undefined;
    let creationDuration: string | undefined;
    let panelRefreshScheduled = false;
    try {
      const input = await requestWorktreeCreation(this.app);
      if (!input) return;
      createStarted = true;
      this.pendingWorktreeCreateCount += 1;
      const requestStartedAt = Date.now();
      const created = await this.worktrees.create(projectDirectory, input);
      creationDuration = this.formatElapsedDuration(Date.now() - requestStartedAt);
      createdName = created.name;
      const key = this.pathKey(created.directory);
      const ready = this.earlyReadyWorktreeKeys.delete(key);
      if (!ready && !this.worktreeStatuses.has(key)) this.markWorktreePending(created.directory);
      await this.addOpenedDirectory(created.directory, { notice: false, showLoading: false, backgroundRefresh: true });
      panelRefreshScheduled = true;
      const status = this.worktreeStatuses.get(key);
      const startupSuffix = status?.state === "failed"
        ? ` Startup failed: ${status.message ?? "Unknown startup error."}`
        : status?.state === "pending" ? " OpenCode startup is continuing in the background." : "";
      new Notice(`Created worktree ${created.name} in ${creationDuration}.${startupSuffix}`, 5_000);
    } catch (error) {
      const message = this.openCodeErrorMessage(error, "Unable to create worktree.");
      const created = createdName
        ? `Created worktree ${createdName}${creationDuration ? ` in ${creationDuration}` : ""}, but could not open it in the sessions panel: ${message}`
        : message;
      new Notice(created, 5_000);
    } finally {
      if (createStarted) this.pendingWorktreeCreateCount -= 1;
      this.finishWorktreeOperation(operationKey, { refresh: !panelRefreshScheduled });
    }
  }

  /** Removes a worktree after active-session checks and destructive confirmation. */
  async requestWorktreeRemove(projectDirectory: string, worktreeDirectory: string): Promise<void> {
    const operationKey = this.pathKey(worktreeDirectory);
    if (!this.beginWorktreeOperation(operationKey)) return;
    try {
      let sessions = await this.loadWorktreeSessions(worktreeDirectory);
      if (sessions.active) {
        new Notice("Stop all running sessions in this worktree before removing it.");
        return;
      }
      if (!(await confirmWorktreeAction(this.app, "remove", worktreeDirectory))) return;
      sessions = await this.loadWorktreeSessions(worktreeDirectory);
      if (sessions.active) {
        new Notice("A session started while removal was being confirmed. Stop it and try again.");
        return;
      }
      this.markWorktreeOperation(operationKey, "removing");
      if (!(await this.worktrees.remove(projectDirectory, worktreeDirectory))) throw new Error("OpenCode did not remove the worktree.");
      const sessionIds = new Set(sessions.items.map((session) => session.id));
      await this.forgetSessionState(sessionIds);
      this.closeSessionTabsForDirectory(worktreeDirectory);
      this.clearWorktreeStatus(operationKey);
      await this.removeOpenedDirectories([worktreeDirectory]);
      new Notice(`Removed worktree ${this.basename(worktreeDirectory)}.`);
    } catch (error) {
      new Notice(this.openCodeErrorMessage(error, "Unable to remove worktree."));
    } finally {
      this.finishWorktreeOperation(operationKey);
    }
  }

  /** Resets a worktree, archives its stale sessions, and closes their tabs after confirmation. */
  async requestWorktreeReset(projectDirectory: string, worktreeDirectory: string): Promise<void> {
    const operationKey = this.pathKey(worktreeDirectory);
    if (!this.beginWorktreeOperation(operationKey)) return;
    try {
      let sessions = await this.loadWorktreeSessions(worktreeDirectory);
      if (sessions.active) {
        new Notice("Stop all running sessions in this worktree before resetting it.");
        return;
      }
      if (!(await confirmWorktreeAction(this.app, "reset", worktreeDirectory))) return;
      sessions = await this.loadWorktreeSessions(worktreeDirectory);
      if (sessions.active) {
        new Notice("A session started while reset was being confirmed. Stop it and try again.");
        return;
      }
      this.markWorktreeOperation(operationKey, "resetting");
      if (!(await this.worktrees.reset(projectDirectory, worktreeDirectory))) throw new Error("OpenCode did not reset the worktree.");
      const archivedIds = await this.archiveWorktreeSessions(sessions.items, worktreeDirectory);
      await this.forgetSessionState(archivedIds);
      this.closeSessionTabsForDirectory(worktreeDirectory);
      this.clearWorktreeStatus(operationKey);
      this.directoryContexts.invalidate(worktreeDirectory);
      await this.refreshSessionsPanels({ showLoading: false });
      new Notice(`Reset worktree ${this.basename(worktreeDirectory)}.`);
    } catch (error) {
      new Notice(this.openCodeErrorMessage(error, "Unable to reset worktree."));
    } finally {
      this.finishWorktreeOperation(operationKey);
    }
  }

  /** Opens a native desktop directory chooser, then persists and displays the selected directory. */
  async openDirectoryWithPicker(): Promise<void> {
    const directory = await this.pickDirectory();
    if (!directory) return;
    await this.addOpenedDirectory(directory);
  }

  /** Opens an OpenCode session in a main Obsidian tab; referenced by SessionsPanelView. */
  async openSessionTab(sessionId: string, sessionTitle?: string): Promise<void> {
    await this.ensureSessionAutoApproveDefault(sessionId);
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).find((leaf) => this.sessionIdFromLeaf(leaf) === sessionId);
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { sessionId, sessionTitle }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Opens a client-only draft tab; the server session is created only on its first send. */
  async openNewSessionTab(directory: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    const draftId = crypto.randomUUID();
    await this.ensureSessionAutoApproveDefault(`draft:${draftId}`);
    await leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { draftId, draftDirectory: directory }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Enriches opened folders with git/project metadata, then opens the new-session folder picker. */
  private async openNewSessionFolderModal(): Promise<void> {
    const suggestions = await loadFolderSuggestions(this);
    new NewSessionFolderModal(this.app, suggestions, (directory) => void this.openNewSessionTab(directory)).open();
  }

  /** Forks through v1 and repairs duplicate sibling ordinals without overriding unique server-generated titles. */
  async forkSession(sessionId: string, directory?: string, messageId?: string): Promise<OpenCodeSession> {
    const service = this.requireOpenCodeService();
    const existingPromise = service.listSessions({ directory, limit: 1_000 }).catch(logServiceError([], "listSessionsForForkTitle"));
    const [forked, existing] = await Promise.all([service.forkSession(sessionId, directory, messageId), existingPromise]);
    if (!forked.title) return forked;
    const title = nextAvailableForkTitle(forked.title, existing);
    if (title === forked.title) return forked;
    return service.updateSession(forked.id, { title }, directory).catch(logServiceError(forked, "normalizeForkTitle"));
  }

  /** Forks a session and opens the result in a new session tab; shared by every fork trigger. */
  async forkSessionAndOpen(sessionId: string, directory?: string, messageId?: string): Promise<OpenCodeSession> {
    const forked = await this.forkSession(sessionId, directory, messageId);
    await this.openSessionTab(forked.id, forked.title);
    await this.refreshSessionsPanels({ showLoading: false }).catch((error) => logger.warn("sessions-panel", "refresh after fork failed", { error }));
    return forked;
  }

  /** Launches the configured IDE for a project directory; surfaces failures via Notice. */
  async openProjectInIde(directory: string, ideId: string | undefined): Promise<void> {
    const ide = getIdeOrDefault(ideId);
    try {
      await launchIde(ide, directory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : `Unable to open project in ${ide.label}.`);
    }
  }

  /** Prompts for a title and applies the v1 session rename; referenced by menu-based rename entry points. */
  async requestSessionRename(sessionId: string, currentTitle: string, directory?: string): Promise<void> {
    const title = await requestSessionTitle(this.app, currentTitle);
    if (!title || title === currentTitle.trim()) return;
    try {
      await this.renameSession(sessionId, title, directory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to rename OpenCode session.");
    }
  }

  /** Renames one session through v1 PATCH and synchronizes all open session handles. */
  async renameSession(sessionId: string, title: string, directory?: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Session name cannot be empty.");
    const updated = await this.requireOpenCodeService().updateSession(sessionId, { title: trimmed }, directory);
    const resolvedTitle = updated.title?.trim() || trimmed;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView && leaf.view.getState().sessionId === sessionId) leaf.view.applySessionTitle(resolvedTitle);
    }
    await this.refreshSessionsPanels({ showLoading: false });
  }

  /** Moves one session directory without transferring files; referenced by sessions-panel drag-and-drop. */
  async moveSessionToDirectory(sessionId: string, sourceDirectory: string, destinationDirectory: string): Promise<void> {
    const service = this.requireOpenCodeService();
    try {
      const statuses = await service.getSessionStatus();
      const status = statuses[sessionId];
      const type = status && typeof status === "object" && !Array.isArray(status) ? (status as JsonObject).type : undefined;
      if (isActiveSessionStatus(typeof type === "string" ? type : undefined)) throw new Error("Abort the session before moving it.");
      await service.moveSession({
        sessionID: sessionId,
        destination: { directory: destinationDirectory },
        moveChanges: false,
      });
    } catch (error) {
      throw new Error(this.openCodeErrorMessage(error, "Unable to move OpenCode session."));
    }

    void service.sendPromptAsync(sessionId, {
      noReply: true,
      parts: [{
        type: "text",
        text: `<system-reminder>The user has changed the current working directory to "${destinationDirectory}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`,
        synthetic: true,
      }],
    }, destinationDirectory).catch((error) => logger.debug("session", "move reminder failed", { error }));

    this.directoryContexts.invalidate(sourceDirectory);
    this.directoryContexts.invalidate(destinationDirectory);
    await Promise.allSettled([
      this.refreshSessionsPanels({ showLoading: false }),
      this.refreshSessionViews(),
    ]);
  }

  /** Confirms and archives a target plus every descendant through v1 PATCH calls. */
  async requestSessionArchive(sessionId: string, directory?: string): Promise<void> {
    if (this.archivingSessionIds.has(sessionId)) return;
    this.archivingSessionIds.add(sessionId);
    const archivedIds = new Set<string>();
    try {
      const tree = await this.loadSessionArchiveTree(sessionId, directory);
      const targets = this.flattenArchiveTargets(tree);
      if (targets.length === 0) return;
      if (this.settings.archiveConfirmation && !(await confirmSessionArchive(this.app, tree))) return;

      const archivedAt = Date.now();
      for (const target of targets) {
        await this.requireOpenCodeService().archiveSession(target.id, archivedAt, target.directory);
        archivedIds.add(target.id);
      }
      await this.refreshSessionsPanels({ showLoading: false });
      new Notice(targets.length === 1 ? `Archived ${tree.title}.` : `Archived ${tree.title} and ${targets.length - 1} descendant sessions.`);
    } catch (error) {
      if (archivedIds.size > 0) await this.refreshSessionsPanels({ showLoading: false });
      const message = error instanceof Error ? error.message : "Unable to archive OpenCode session.";
      new Notice(archivedIds.size > 0 ? `Archived ${archivedIds.size} descendant sessions before archival stopped: ${message}` : message);
    } finally {
      try {
        await this.forgetSessionState(archivedIds);
      } catch (error) {
        logger.warn("settings", "archived session cleanup failed", { error });
      }
      this.closeSessionTabs(archivedIds);
      this.archivingSessionIds.delete(sessionId);
    }
  }

  /** Detaches session tabs whose sessions were archived; referenced by requestSessionArchive. */
  private closeSessionTabs(sessionIds: ReadonlySet<string>): void {
    if (sessionIds.size === 0) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (sessionIds.has(this.sessionIdFromLeaf(leaf) ?? "")) void leaf.detach();
    }
  }

  /** Detaches server-session and draft tabs bound to a removed or reset worktree. */
  private closeSessionTabsForDirectory(directory: string): void {
    const key = this.pathKey(directory);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView && this.pathKey(leaf.view.getSessionDirectory() ?? "") === key) void leaf.detach();
    }
  }

  /** Tracks asynchronous worktree startup events emitted on the server-wide v1 stream. */
  private handleWorktreeEvent(event: OpenCodeEvent, directory?: string): void {
    if (!directory || (event.type !== "worktree.ready" && event.type !== "worktree.failed")) return;
    const key = this.pathKey(directory);
    const opened = this.settings.openedDirectories.some((item) => this.pathKey(item) === key);
    const tracked = opened || this.worktreeStatuses.has(key);
    if (!tracked && this.pendingWorktreeCreateCount === 0) return;
    if (event.type === "worktree.ready") {
      if (!tracked) {
        this.earlyReadyWorktreeKeys.add(key);
        while (this.earlyReadyWorktreeKeys.size > 100) {
          const oldest = this.earlyReadyWorktreeKeys.values().next().value;
          if (oldest) this.earlyReadyWorktreeKeys.delete(oldest);
        }
        return;
      }
      this.clearWorktreeStatus(key);
      new Notice(`Worktree ${this.basename(directory)} is ready.`);
    } else {
      const message = typeof event.properties?.message === "string" ? event.properties.message : "Worktree startup failed.";
      this.clearWorktreeStatus(key);
      this.worktreeStatuses.set(key, { state: "failed", message });
      if (tracked) new Notice(message);
    }
    this.directoryContexts.invalidate(directory);
    void this.refreshSessionsPanels({ showLoading: false }).catch((error) => logger.warn("sessions-panel", "worktree event refresh failed", { error }));
  }

  /** Claims a worktree mutation key so duplicate menu actions cannot overlap. */
  private beginWorktreeOperation(key: string): boolean {
    if (this.worktreeOperationKeys.has(key)) {
      new Notice("A worktree operation is already in progress.");
      return false;
    }
    this.worktreeOperationKeys.add(key);
    return true;
  }

  /** Releases a worktree mutation key and refreshes menu-derived panel state. */
  private finishWorktreeOperation(key: string, options: { refresh?: boolean } = {}): void {
    this.worktreeOperationKeys.delete(key);
    this.worktreeOperationStates?.delete(key);
    if (options.refresh === false) return;
    void this.refreshSessionsPanels({ showLoading: false }).catch((error) => logger.warn("sessions-panel", "worktree operation refresh failed", { error }));
  }

  /** Exposes a destructive operation on the worktree row while the server request is active. */
  private markWorktreeOperation(key: string, state: "removing" | "resetting"): void {
    this.worktreeOperationStates.set(key, state);
    void this.refreshSessionsPanels({ showLoading: false }).catch((error) => logger.warn("sessions-panel", "worktree operation state refresh failed", { error }));
  }

  /** Starts a bounded pending state so a missed ready event cannot disable worktree actions forever. */
  private markWorktreePending(directory: string): void {
    const key = this.pathKey(directory);
    this.clearWorktreeStatus(key);
    this.worktreeStatuses.set(key, { state: "pending" });
    const timer = window.setTimeout(() => {
      if (this.worktreeStatuses.get(key)?.state !== "pending") return;
      this.worktreeStatusTimers.delete(key);
      this.worktreeStatuses.set(key, { state: "failed", message: "OpenCode did not report worktree startup completion." });
      void this.refreshSessionsPanels({ showLoading: false }).catch((error) => logger.warn("sessions-panel", "worktree startup timeout refresh failed", { error }));
    }, 120_000);
    this.worktreeStatusTimers.set(key, timer);
  }

  /** Clears one startup state and its timeout. */
  private clearWorktreeStatus(key: string): void {
    this.worktreeStatuses?.delete(key);
    const timer = this.worktreeStatusTimers?.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    this.worktreeStatusTimers?.delete(key);
  }

  /** Loads all sessions and their current activity state before a destructive worktree action. */
  private async loadWorktreeSessions(directory: string): Promise<{ items: OpenCodeSession[]; active: boolean }> {
    const service = this.requireOpenCodeService();
    const [projectSessions, statuses] = await Promise.all([
      service.listSessions({ directory, scope: "project", limit: 1_000 }),
      service.getSessionStatus(),
    ]);
    const items = projectSessions.filter((session) => this.isWithinDirectory(directory, session.directory));
    const active = items.some((session) => {
      const status = statuses[session.id];
      if (!status || typeof status !== "object" || Array.isArray(status)) return false;
      const type = (status as JsonObject).type;
      return isActiveSessionStatus(typeof type === "string" ? type : undefined);
    });
    return { items, active };
  }

  /** Returns whether a session directory is the worktree root or one of its descendants. */
  private isWithinDirectory(root: string, candidate: string | undefined): boolean {
    if (!candidate) return false;
    const rootKey = this.pathKey(root);
    const candidateKey = this.pathKey(candidate);
    const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
    return candidateKey === rootKey || candidateKey.startsWith(prefix);
  }

  /** Extracts an actionable OpenCode API error message without exposing arbitrary response text. */
  private openCodeErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof OpenCodeHttpError) {
      try {
        const body = JSON.parse(error.responseText) as { data?: { message?: unknown } };
        if (typeof body.data?.message === "string" && body.data.message.trim()) return body.data.message;
      } catch {
        return error.message || fallback;
      }
    }
    return error instanceof Error && error.message ? error.message : fallback;
  }

  /** Formats worktree request latency compactly for the five-second completion notice. */
  private formatElapsedDuration(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
    const seconds = milliseconds / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }

  /** Archives every unarchived v1 session after reset and reports IDs successfully updated. */
  private async archiveWorktreeSessions(sessions: OpenCodeSession[], directory: string): Promise<Set<string>> {
    const archivedIds = new Set<string>();
    const archivedAt = Date.now();
    for (const session of sessions) {
      if (typeof session.time?.archived === "number") {
        archivedIds.add(session.id);
        continue;
      }
      try {
        await this.requireOpenCodeService().archiveSession(session.id, archivedAt, session.directory ?? directory);
        archivedIds.add(session.id);
      } catch (error) {
        logger.warn("worktree", "session archival after reset failed", { error });
      }
    }
    return archivedIds;
  }

  /** Pushes the focused session tab into every open sessions panel so its row is revealed. */
  private syncSessionsPanelToActiveSessionLeaf(leaf: WorkspaceLeaf | null): void {
    const sessionId = this.sessionIdFromLeaf(leaf);
    if (!sessionId) return;
    for (const panelLeaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL)) {
      if (panelLeaf.view instanceof SessionsPanelView) panelLeaf.view.setActiveSession(sessionId);
    }
  }

  /** Returns the session id of the currently focused session tab, if any; referenced by SessionsPanelView.onOpen. */
  getActiveSessionId(): string | undefined {
    return this.sessionIdFromLeaf(this.app.workspace.activeLeaf);
  }

  /** Returns the working directory of the focused session tab; referenced by the open-in-IDE command/menu. */
  getActiveSessionDirectory(): string | undefined {
    const view = this.app.workspace.activeLeaf?.view;
    return view instanceof SessionView ? view.getSessionDirectory() : undefined;
  }

  /** Extracts the session id from a leaf when it is an OpenCode session view. */
  private sessionIdFromLeaf(leaf: WorkspaceLeaf | null | undefined): string | undefined {
    if (!leaf) return undefined;
    const state = leaf.getViewState();
    if (state.type !== VIEW_TYPE_OPENCODE_SESSION) return undefined;
    const sessionId = state.state?.sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  }

  /** Returns whether any leaf for a session is visibly rendered in the focused Obsidian window. */
  private isSessionVisibleInFocusedWindow(sessionId: string): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).some((leaf) =>
      this.sessionIdFromLeaf(leaf) === sessionId && isElementVisibleInFocusedWindow(leaf.view.containerEl));
  }

  /** Persists a directory exactly like OpenCode's UI-local opened-project list. */
  async addOpenedDirectory(directory: string, options: { notice?: boolean; showLoading?: boolean; backgroundRefresh?: boolean } = {}): Promise<void> {
    const normalized = this.normalizeDirectory(directory);
    const existing = this.settings.openedDirectories.filter((item) => this.pathKey(item) !== this.pathKey(normalized));
    this.settings.openedDirectories = [normalized, ...existing];
    await this.saveSettings();
    this.syncNotificationEventSubscriptions();
    if (options.notice !== false) new Notice(`Opened ${normalized} in OpenCode sessions panel.`);
    const refresh = this.refreshSessionsPanels({ showLoading: options.showLoading });
    if (options.backgroundRefresh) {
      void refresh.catch((error) => logger.warn("sessions-panel", "background directory refresh failed", { error }));
      return;
    }
    await refresh;
  }

  /** Removes a previously opened directory from the panel's local workspace list. */
  async removeOpenedDirectory(directory: string): Promise<void> {
    await this.removeOpenedDirectories([directory]);
  }

  /** Removes several local directory registrations in one save and panel refresh. */
  async removeOpenedDirectories(directories: Iterable<string>): Promise<void> {
    const items = [...directories];
    const targets = new Set(items.map((directory) => this.pathKey(directory)));
    this.settings.openedDirectories = this.settings.openedDirectories.filter((item) => !targets.has(this.pathKey(item)));
    for (const directory of items) {
      this.directoryContexts?.invalidate(directory);
      this.clearWorktreeStatus(this.pathKey(directory));
    }
    await this.saveSettings();
    this.syncNotificationEventSubscriptions();
    await this.refreshSessionsPanels();
  }

  /** Loads persisted settings, falling back to localhost:4096 for external OpenCode servers. */
  private async loadSettings(): Promise<void> {
    const rawData = await this.loadData() as unknown;
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) && (rawData as Record<string, unknown>).schemaVersion === OPENCODE_DATA_SCHEMA_VERSION
      ? rawData as Partial<OpenCodePluginData>
      : undefined;
    const preferences = data?.preferences && typeof data.preferences === "object" ? data.preferences : {};
    // One-time migration: the sessions sort choice persisted under the legacy agent-panel
    // key moves to the sessions-panel key; deleting the old key keeps the next save from
    // reserializing the stale duplicate.
    const legacyPreferences = preferences as Record<string, unknown>;
    if (legacyPreferences.sessionsPanelSessionSort === undefined && legacyPreferences.agentPanelSessionSort !== undefined) {
      legacyPreferences.sessionsPanelSessionSort = legacyPreferences.agentPanelSessionSort;
    }
    delete legacyPreferences.agentPanelSessionSort;
    this.settings = Object.assign({}, DEFAULT_OPENCODE_SETTINGS, preferences);
    this.sessionState = {
      sessions: normalizePersistedSessionStates(data?.sessions),
      drafts: normalizePersistedSessionStates(data?.drafts),
    };
    this.settings.openedDirectories = Array.isArray(this.settings.openedDirectories) ? this.settings.openedDirectories : [];
    this.settings.groupContextTools = this.settings.groupContextTools === true;
    this.settings.showReasoningBlocks = this.settings.showReasoningBlocks !== false;
    this.settings.sessionIslandContextLabel = normalizeSessionIslandContextLabel(this.settings.sessionIslandContextLabel);
    this.settings.todoInProgressStatusCharacter = normalizeTodoStatusCharacter(this.settings.todoInProgressStatusCharacter);
    this.settings.openIde = normalizeOpenIde(this.settings.openIde);
    this.settings.archiveConfirmation = this.settings.archiveConfirmation !== false;
    this.settings.defaultSessionAutoApprove = this.settings.defaultSessionAutoApprove === true;
    this.settings.notificationMode = normalizeNotificationMode(this.settings.notificationMode);
    this.settings.notifyOnAttention = this.settings.notifyOnAttention !== false;
    this.settings.notifyOnSessionError = this.settings.notifyOnSessionError !== false;
    this.settings.notifyOnTurnComplete = this.settings.notifyOnTurnComplete !== false;
    this.settings.retryActionLastShown = normalizeRetryActionLastShown(this.settings.retryActionLastShown);
    this.settings.retryActionSuppressed = normalizeRetryActionSuppressed(this.settings.retryActionSuppressed);
    this.settings.workingAnimation = normalizeWorkingAnimation(this.settings.workingAnimation);
    this.settings.folderCollapseDisplay = normalizeFolderCollapseDisplay(this.settings.folderCollapseDisplay);
    this.settings.sessionsPanelSessionSort = normalizeSessionsPanelSessionSort(this.settings.sessionsPanelSessionSort);
    this.settings.contextBar = normalizeContextBarSettings(this.settings.contextBar);
    this.settings.debugLogging = normalizeDebugLogging(this.settings.debugLogging);
    this.settings.customToolDisplays = Array.isArray(this.settings.customToolDisplays)
      ? this.settings.customToolDisplays.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as unknown as Record<string, unknown>;
        return [{
          tool: typeof value.tool === "string" ? value.tool.trim().toLowerCase() : "",
          icon: typeof value.icon === "string" && value.icon.trim() ? value.icon.trim() : "wrench",
          displayArgument: typeof value.displayArgument === "string" ? value.displayArgument.trim() : "",
        }];
      })
      : [];

    // --- Server connection: URL and username persist in plugin data; the password resolves from a named secret. ---
    const persistedServer = (this.settings.server && typeof this.settings.server === "object" ? this.settings.server : {}) as Partial<OpenCodeServerConfig>;
    const passwordSecretName = normalizeServerUsername(persistedServer.passwordSecretName);
    this.settings.server = {
      baseUrl: normalizeServerBaseUrl(persistedServer.baseUrl),
      username: normalizeServerUsername(persistedServer.username),
      passwordSecretName,
      password: this.resolveServerPassword(passwordSecretName),
    };
    if (!data) await this.saveSettings();
  }

  /** Writes plugin settings to Obsidian's plugin data file without the resolved password; referenced by settings mutations. */
  async saveSettings(): Promise<void> {
    const { password: _password, ...server } = this.settings.server;
    const data = JSON.parse(JSON.stringify({
      schemaVersion: OPENCODE_DATA_SCHEMA_VERSION,
      preferences: { ...this.settings, server },
      sessions: this.sessionState.sessions,
      drafts: this.sessionState.drafts,
    })) as OpenCodePluginData;
    const save = (this.settingsSaveQueue ?? Promise.resolve()).then(() => this.saveData(data));
    this.settingsSaveQueue = save.catch(() => undefined);
    await save;
  }

  /** Applies settings-tab server changes, resolves the named secret, and reconnects the service and views. */
  async applyServerConfig(baseUrl: string, username: string | undefined, passwordSecretName: string | undefined): Promise<void> {
    const secretName = normalizeServerUsername(passwordSecretName);
    const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl);
    if (this.settings.server.baseUrl !== normalizedBaseUrl) {
      if (this.sessionState) this.sessionState.sessions = {};
      this.forgottenSessionIds?.clear();
    }
    this.settings.server = {
      baseUrl: normalizedBaseUrl,
      username: normalizeServerUsername(username),
      passwordSecretName: secretName,
      password: this.resolveServerPassword(secretName),
    };
    await this.saveSettings();
    this.directoryContexts?.clear();
    this.worktreeStatuses?.clear();
    this.worktreeOperationStates?.clear();
    this.earlyReadyWorktreeKeys?.clear();
    for (const timer of this.worktreeStatusTimers?.values() ?? []) window.clearTimeout(timer);
    this.worktreeStatusTimers?.clear();
    if (this.opencode) this.opencode.updateConfig(this.settings.server);
    else {
      this.opencode = new OpenCodeService(this.settings.server);
      this.worktreeEventSubscription?.close();
      this.worktreeEventSubscription = this.opencode.subscribeToGlobalEvents({
        onEvent: (event, directory) => this.handleWorktreeEvent(event, directory),
      });
    }
    await this.refreshSessionsPanels();
    await this.refreshSessionViews();
  }

  /** Probes drafted server values without applying them; referenced by the settings-tab test button. */
  async testServerConnection(baseUrl: string, username: string | undefined, passwordSecretName: string | undefined): Promise<OpenCodeHealth> {
    const probe = new OpenCodeService({
      baseUrl: normalizeServerBaseUrl(baseUrl),
      username: normalizeServerUsername(username),
      password: this.resolveServerPassword(normalizeServerUsername(passwordSecretName)),
    });
    try {
      return await probe.health();
    } finally {
      probe.dispose();
    }
  }

  /** Resolves the configured secret name to its stored value through Obsidian's secret storage. */
  private resolveServerPassword(passwordSecretName: string | undefined): string | undefined {
    if (!passwordSecretName) return undefined;
    const secret = this.app.secretStorage?.getSecret(passwordSecretName);
    return typeof secret === "string" && secret ? secret : undefined;
  }

  /** Persists and immediately applies verbose developer-console diagnostics from the settings tab. */
  async setDebugLogging(enabled: boolean): Promise<void> {
    const update = (this.debugLoggingSaveQueue ?? Promise.resolve()).then(async () => {
      const previous = this.settings.debugLogging;
      this.settings.debugLogging = enabled;
      try {
        await this.saveSettings();
      } catch (error) {
        this.settings.debugLogging = previous;
        throw error;
      }
      logger.setDebugEnabled(enabled);
      logger.debug("lifecycle", "debug logging enabled");
    });
    this.debugLoggingSaveQueue = update.catch(() => undefined);
    await update;
  }

  /** Requests renderer notification permission from an explicit settings interaction. */
  async requestSystemNotificationPermission(): Promise<boolean> {
    return await this.notificationService?.requestSystemPermission() ?? false;
  }

  /** Sends one event-specific dummy notification through the selected delivery mode. */
  async sendTestNotification(kind: SessionNotificationTestKind): Promise<void> {
    await this.notificationService?.sendTestNotification(kind);
  }

  /** Shows one allowlisted usage-limit action at most once per 24 hours across every session tab. */
  async maybeShowRetryAction(action: SessionRetryAction): Promise<void> {
    const now = Date.now();
    const key = eligibleRetryActionKey(action, this.settings.retryActionLastShown, this.settings.retryActionSuppressed, now);
    if (!key || this.retryActionModalOpen || document.querySelector(".modal-container")) return;
    this.settings.retryActionLastShown[key] = now;
    this.retryActionModalOpen = true;
    void this.saveSettings().catch((error) => logger.warn("settings", "retry action cooldown save failed", { error }));
    const link = safeRetryActionLink(action);
    try {
      const decision = await requestRetryAction(this.app, action, !!link);
      if (decision === "suppress") {
        this.settings.retryActionSuppressed[key] = true;
        await this.saveSettings().catch((error) => logger.warn("settings", "retry action suppression save failed", { error }));
      } else if (decision === "open" && link) {
        window.open(link, "_blank", "noopener,noreferrer");
      }
    } finally {
      this.retryActionModalOpen = false;
    }
  }

  /** Clears persisted retry-action cooldown and suppression choices from plugin settings. */
  async resetRetryActionPrompts(): Promise<void> {
    this.settings.retryActionLastShown = {};
    this.settings.retryActionSuppressed = {};
    await this.saveSettings();
    new Notice("OpenCode usage-limit prompts reset.");
  }

  /** Refreshes every open session after display settings change. */
  async refreshSessionViews(): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).map(async (leaf) => {
        if (leaf.view instanceof SessionView) await leaf.view.refresh();
      }),
    );
  }

  /** Re-renders mounted Session Island labels and todo content after display settings change. */
  refreshSessionIslands(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.refreshSessionIsland();
    }
  }

  /** Loads the target and all descendants because v1 archival only updates one session per PATCH. */
  private async loadSessionArchiveTree(sessionId: string, directory?: string): Promise<SessionArchiveNode> {
    const session = await this.requireOpenCodeService().getSession(sessionId, directory);
    return this.loadSessionArchiveNode(session, directory, new Set());
  }

  /** Recursively builds the archive confirmation tree while guarding against malformed cycles. */
  private async loadSessionArchiveNode(session: OpenCodeSession, fallbackDirectory: string | undefined, visited: Set<string>): Promise<SessionArchiveNode> {
    if (visited.has(session.id)) throw new Error(`OpenCode returned a cyclic session tree at ${session.id}.`);
    visited.add(session.id);
    const directory = session.directory ?? fallbackDirectory;
    const children = await this.requireOpenCodeService().listSessionChildren(session.id, directory);
    return {
      id: session.id,
      title: session.title?.trim() || session.id,
      directory,
      archived: typeof session.time?.archived === "number",
      children: await Promise.all(children.map((child) => this.loadSessionArchiveNode(child, directory, visited))),
    };
  }

  /** Flattens descendants before their parent so a partial failure never hides reachable children. */
  private flattenArchiveTargets(tree: SessionArchiveNode): SessionArchiveNode[] {
    return [...tree.children.flatMap((child) => this.flattenArchiveTargets(child)), ...(tree.archived ? [] : [tree])];
  }

  /** Resolves a storage key to its server-session or client-draft state collection. */
  private sessionStateAddress(sessionId: string): { states: Record<string, PersistedSessionState>; id: string } {
    if (sessionId.startsWith("draft:")) return { states: this.sessionState.drafts, id: sessionId.slice("draft:".length) };
    return { states: this.sessionState.sessions, id: sessionId };
  }

  /** Returns persisted local state for a server session or client-only draft. */
  private readSessionState(sessionId: string): PersistedSessionState | undefined {
    const { states, id } = this.sessionStateAddress(sessionId);
    return states[id];
  }

  /** Mutates, compacts, and persists one server-session or client-draft record. */
  private async mutateSessionState(sessionId: string, mutate: (state: PersistedSessionState) => void): Promise<void> {
    const draftId = sessionId.startsWith("draft:") ? sessionId.slice("draft:".length) : undefined;
    if (draftId ? this.retiredDraftIds?.has(draftId) : this.forgottenSessionIds?.has(sessionId)) return;
    const { states, id } = this.sessionStateAddress(sessionId);
    const existing = states[id];
    const state: PersistedSessionState = {
      ...existing,
      composer: existing?.composer ? { ...existing.composer } : undefined,
    };
    mutate(state);
    if (state.composer && Object.keys(state.composer).length === 0) delete state.composer;
    if (Object.keys(state).length === 0) delete states[id];
    else states[id] = state;
    await this.saveSettings();
  }

  /** Builds the explicit boolean override map consumed by permission inheritance. */
  private sessionAutoApproveOverrides(): Record<string, boolean> {
    const overrides: Record<string, boolean> = {};
    for (const [sessionId, state] of Object.entries(this.sessionState.sessions)) {
      if (typeof state.autoApprove === "boolean") overrides[sessionId] = state.autoApprove;
    }
    for (const [draftId, state] of Object.entries(this.sessionState.drafts)) {
      if (typeof state.autoApprove === "boolean") overrides[`draft:${draftId}`] = state.autoApprove;
    }
    return overrides;
  }

  /** Removes all local state owned by archived or deleted server sessions. */
  async forgetSessionState(sessionIds: Iterable<string>): Promise<void> {
    let changed = false;
    const forgottenSessionIds = this.forgottenSessionIds ??= new Set<string>();
    for (const sessionId of sessionIds) {
      forgottenSessionIds.add(sessionId);
      if (!Object.prototype.hasOwnProperty.call(this.sessionState.sessions, sessionId)) continue;
      delete this.sessionState.sessions[sessionId];
      changed = true;
    }
    if (changed) await this.saveSettings();
  }

  /** Removes an abandoned client-only draft after its tab closes. */
  async discardSessionDraft(draftId: string): Promise<void> {
    (this.retiredDraftIds ??= new Set<string>()).add(draftId);
    if (!Object.prototype.hasOwnProperty.call(this.sessionState.drafts, draftId)) return;
    delete this.sessionState.drafts[draftId];
    await this.saveSettings();
  }

  /** Returns whether view closure is caused by plugin unload rather than an abandoned tab. */
  isUnloadingSessionViews(): boolean {
    return this.unloading;
  }

  /** Returns whether a live server session may still persist unsent composer state. */
  shouldPersistSessionState(sessionId: string): boolean {
    return !this.forgottenSessionIds?.has(sessionId);
  }

  /** Schedules server-session reconciliation after any directory stream reconnects. */
  reconcileSessionStateAfterReconnect(): void {
    if (this.layoutReady) this.scheduleSessionStatePrune();
  }

  /** Debounces canonical cleanup after layout readiness and SSE reconnects. */
  private scheduleSessionStatePrune(delay = 250, includeDrafts = false): void {
    this.pendingDraftPrune ||= includeDrafts;
    if (this.sessionStatePruneTimer !== undefined) window.clearTimeout(this.sessionStatePruneTimer);
    this.sessionStatePruneTimer = window.setTimeout(() => {
      this.sessionStatePruneTimer = undefined;
      const pruneDrafts = this.pendingDraftPrune;
      this.pendingDraftPrune = false;
      this.sessionStatePruneQueue = (this.sessionStatePruneQueue ?? Promise.resolve())
        .then(() => this.pruneStaleSessionState(pruneDrafts))
        .catch((error) => logger.warn("settings", "session state cleanup failed", { error }));
    }, delay);
  }

  /** Reconciles persisted records against canonical sessions and optionally restored draft tabs. */
  private async pruneStaleSessionState(includeDrafts = true): Promise<void> {
    let changed = false;
    if (includeDrafts) {
      const activeDraftIds = new Set(this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION).flatMap((leaf) => {
        const draftId = leaf.getViewState().state?.draftId;
        return typeof draftId === "string" ? [draftId] : [];
      }));
      for (const draftId of Object.keys(this.sessionState.drafts)) {
        if (activeDraftIds.has(draftId)) continue;
        (this.retiredDraftIds ??= new Set<string>()).add(draftId);
        delete this.sessionState.drafts[draftId];
        changed = true;
      }
    }

    const sessionIds = Object.keys(this.sessionState.sessions);
    for (let index = 0; index < sessionIds.length; index += 20) {
      const staleIds = await Promise.all(sessionIds.slice(index, index + 20).map(async (sessionId) => {
        try {
          const session = await this.requireOpenCodeService().getSession(sessionId);
          return typeof session.time?.archived === "number" ? sessionId : undefined;
        } catch (error) {
          return error instanceof OpenCodeHttpError && error.status === 404 ? sessionId : undefined;
        }
      }));
      for (const sessionId of staleIds) {
        if (!sessionId) continue;
        (this.forgottenSessionIds ??= new Set<string>()).add(sessionId);
        delete this.sessionState.sessions[sessionId];
        changed = true;
      }
    }
    if (changed) await this.saveSettings();
  }

  /** Persists the unsent composer text for a session; referenced by SessionView input events. */
  async rememberSessionDraft(sessionId: string, draft: string): Promise<void> {
    await this.mutateSessionState(sessionId, (state) => {
      const composer = { ...state.composer };
      if (draft.trim()) composer.text = draft;
      else delete composer.text;
      state.composer = Object.keys(composer).length > 0 ? composer : undefined;
    });
  }

  /** Returns unsent composer text for a server session or client-only draft. */
  getSessionDraft(sessionId: string): string {
    return this.readSessionState(sessionId)?.composer?.text ?? "";
  }

  /** Returns persisted composer attachments for a server session or client-only draft. */
  getSessionAttachedFiles(sessionId: string): ComposerAttachment[] {
    return this.readSessionState(sessionId)?.composer?.attachments ?? [];
  }

  /** Removes composer text and attachments together after a successful submission. */
  async clearSessionComposer(sessionId: string): Promise<void> {
    await this.mutateSessionState(sessionId, (state) => {
      delete state.composer;
    });
  }

  /** Persists one explicit auto-approve override; `undefined` restores ancestry inheritance. */
  async rememberSessionAutoApprove(sessionId: string, enabled: boolean | undefined): Promise<void> {
    await this.mutateSessionState(sessionId, (state) => {
      state.autoApprove = enabled ?? "inherit";
    });
    this.refreshSessionAutoApproveControls();
    await this.permissionCoordinator.reconcile();
  }

  /** Applies the configured auto-accept default once when a session or draft first opens in the plugin. */
  async ensureSessionAutoApproveDefault(sessionId: string): Promise<void> {
    if (this.readSessionState(sessionId)?.autoApprove !== undefined) return;
    await this.mutateSessionState(sessionId, (state) => {
      state.autoApprove = this.settings.defaultSessionAutoApprove;
    });
    this.refreshSessionAutoApproveControls();
    await this.permissionCoordinator.reconcile();
  }

  /** Toggles the effective session policy while removing overrides that equal the inherited value. */
  async toggleSessionAutoApprove(sessionId: string, directory?: string): Promise<void> {
    await this.rememberSessionAutoApprove(sessionId, await this.permissionCoordinator.overrideForToggle(sessionId, directory));
  }

  /** Returns the effective cached policy used by mounted session controls and request docks. */
  getSessionAutoApproveState(sessionId: string | undefined): SessionAutoApproveState {
    return this.permissionCoordinator.getState(sessionId);
  }

  /** Hydrates missing ancestors before mounted controls read the synchronous effective policy. */
  async hydrateSessionAutoApproveState(sessionId: string, directory?: string): Promise<SessionAutoApproveState> {
    return this.permissionCoordinator.hydrateState(sessionId, directory);
  }

  /** Caches canonical session ancestry for inherited permission and notification policies. */
  cacheSessionHierarchy(sessions: OpenCodeSession[], authoritative = false): void {
    this.permissionCoordinator.cacheSessionHierarchy(sessions, authoritative);
  }

  /** Persists one sparse per-session notification override from a session surface. */
  async rememberSessionMute(sessionId: string, muted: boolean, isSubagent: boolean): Promise<void> {
    const override = muteOverrideForState(muted, isSubagent);
    await this.mutateSessionState(sessionId, (state) => {
      if (override === undefined) delete state.muted;
      else state.muted = override;
    });
  }

  /** Returns the effective root-enabled/subagent-muted state for canonical session metadata. */
  getSessionNotificationState(session: OpenCodeSession): ReturnType<typeof resolveSessionNotificationState> {
    const override = this.readSessionState(session.id)?.muted;
    return resolveSessionNotificationState(override === undefined ? {} : { [session.id]: override }, session);
  }

  /** Returns a sparse local mute override for a server session or client-only draft. */
  getSessionMuteOverride(sessionId: string): boolean | undefined {
    return this.readSessionState(sessionId)?.muted;
  }

  /** Persists whether a session has completed activity the user has not read yet. */
  async rememberSessionUnread(sessionId: string, unread: boolean): Promise<void> {
    await this.mutateSessionState(sessionId, (state) => {
      if (unread) state.unread = true;
      else delete state.unread;
    });
  }

  /** Returns whether a session has completed activity the user has not read. */
  isSessionUnread(sessionId: string): boolean {
    return this.sessionState.sessions[sessionId]?.unread === true;
  }

  /** Persists selected file paths and pasted images for an unsent composer draft. */
  async rememberSessionAttachedFiles(sessionId: string, files: ComposerAttachment[]): Promise<void> {
    await this.mutateSessionState(sessionId, (state) => {
      const composer = { ...state.composer };
      if (files.length > 0) composer.attachments = [...files];
      else delete composer.attachments;
      state.composer = Object.keys(composer).length > 0 ? composer : undefined;
    });
  }

  /** Toggles a model (+optional variant) in the global favorites list; referenced by ModelSelectionMenu. */
  async toggleFavoriteModel(ref: { providerID: string; modelID: string; variant?: string }): Promise<void> {
    const key = (r: { providerID: string; modelID: string; variant?: string }) => `${r.providerID}/${r.modelID}/${r.variant ?? ""}`;
    const idx = this.settings.favoriteModels.findIndex((f) => key(f) === key(ref));
    if (idx >= 0) this.settings.favoriteModels.splice(idx, 1);
    else this.settings.favoriteModels.push(ref);
    await this.saveSettings();
  }

  /** Persists a new order for the favorites list; referenced by ModelSelectionMenu drag-and-drop. */
  async reorderFavoriteModels(favorites: Array<{ providerID: string; modelID: string; variant?: string }>): Promise<void> {
    // Mutate in place so an open ModelSelectionMenu sharing the array reference sees the new order
    this.settings.favoriteModels.splice(0, this.settings.favoriteModels.length, ...favorites);
    await this.saveSettings();
  }

  /** Moves local composer state from a draft key to its newly created server session. */
  async promoteSessionDraft(draftKey: string, sessionId: string): Promise<void> {
    const draftId = draftKey.startsWith("draft:") ? draftKey.slice("draft:".length) : draftKey;
    (this.retiredDraftIds ??= new Set<string>()).add(draftId);
    const draft = this.sessionState.drafts[draftId];
    if (!draft) return;
    const existing = this.sessionState.sessions[sessionId];
    this.sessionState.sessions[sessionId] = {
      ...existing,
      ...draft,
      composer: existing?.composer || draft.composer ? { ...existing?.composer, ...draft.composer } : undefined,
    };
    delete this.sessionState.drafts[draftId];
    await this.saveSettings();
    if (draft.autoApprove !== undefined) {
      this.refreshSessionAutoApproveControls();
      await this.permissionCoordinator.reconcile();
    }
  }

  /** Opens or focuses the OpenCode sessions panel and reveals the focused session's row. */
  private async activateSessionsPanel(): Promise<void> {
    // Capture the focused session before revealing the panel can change the active leaf.
    const activeSessionId = this.getActiveSessionId();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_OPENCODE_SESSIONS_PANEL, active: true });
    }

    if (leaf) this.app.workspace.revealLeaf(leaf);

    if (leaf?.view instanceof SessionsPanelView) {
      if (activeSessionId) leaf.view.setActiveSession(activeSessionId);
      // Focus the panel container so arrow-key navigation works immediately, mirroring
      // Obsidian's "Reveal current file in navigation" rather than "Show file explorer".
      leaf.view.focusContent();
    }
  }

  /** Refreshes every visible sessions panel after local or server-side session changes. */
  async refreshSessionsPanels(options?: { showLoading?: boolean }): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL).map(async (leaf) => {
        if (leaf.view instanceof SessionsPanelView) await leaf.view.refresh(options);
      }),
    );
  }

  /** Pushes one live session status into visible sessions panels without waiting for their full refresh. */
  notifySessionStatusChanged(sessionId: string, statusType: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL)) {
      if (leaf.view instanceof SessionsPanelView) leaf.view.applyLiveSessionStatus(sessionId, statusType);
    }
  }

  /** Resolves one permission centrally, auto-approving inherited policies before any view surfaces it. */
  routePermissionRequest(request: OpenCodePermissionRequest, directory?: string): void {
    this.permissionCoordinator.route(request, directory);
  }

  /** Returns true while a permission is being resolved, auto-replied, or already settled. */
  shouldSuppressPermissionRequest(requestId: string): boolean {
    return this.permissionCoordinator.shouldSuppress(requestId);
  }

  /** Routes one non-auto-approved permission to every visible ancestor/owner surface. */
  private surfacePermissionRequest(request: OpenCodePermissionRequest, directory?: string): void {
    // One owner-session notification is emitted per request ID; parent-vs-child click routing remains a product decision.
    this.notificationService?.notifyPermission(request, directory);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.ingestPermissionRequest(request);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSIONS_PANEL)) {
      if (leaf.view instanceof SessionsPanelView) leaf.view.ingestPermissionRequest(request);
    }
  }

  /** Routes one question request to every open session view that contains its owning session. */
  routeQuestionRequest(request: OpenCodeQuestionRequest, directory?: string): void {
    this.notificationService?.notifyQuestion(request, directory);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.ingestQuestionRequest(request);
    }
  }

  /** Claims one request response globally so parent and child controls cannot submit concurrently. */
  beginSessionRequestResponse(requestId: string): boolean {
    return this.permissionCoordinator.beginResponse(requestId);
  }

  /** Releases a failed request response and re-enables every visible copy of its controls. */
  finishSessionRequestResponse(requestId: string): void {
    this.permissionCoordinator.finishResponse(requestId);
  }

  /** Returns whether either a parent or child view is currently responding to one request. */
  isSessionRequestResponding(requestId: string): boolean {
    return this.permissionCoordinator.isResponding(requestId);
  }

  /** Removes a settled request from every visible parent and child view. */
  settleSessionRequest(requestId: string | undefined): void {
    this.permissionCoordinator.settle(requestId);
  }

  /** Removes a settled request from every visible parent and child session view. */
  private removeSettledRequestFromViews(requestId: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.settleSessionRequest(requestId);
    }
  }

  /** Re-renders request controls across all open session views after shared response state changes. */
  private refreshSessionRequestDocks(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.refreshSessionRequestDocks();
    }
  }

  /** Refreshes effective/inherited toggle chrome across every open session view. */
  private refreshSessionAutoApproveControls(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODE_SESSION)) {
      if (leaf.view instanceof SessionView) leaf.view.refreshSessionAutoApproveState();
    }
  }

  /** Shows Electron's native open-directory dialog; referenced by the open-directory command and panel button. */
  private async pickDirectory(): Promise<string | undefined> {
    try {
      const electron = require("electron") as {
        remote?: { dialog?: { showOpenDialog: (options: object) => Promise<{ canceled: boolean; filePaths: string[] }> } };
      };
      const dialog = electron.remote?.dialog;
      if (!dialog) throw new Error("Electron remote dialog is unavailable.");
      const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      return result.canceled ? undefined : result.filePaths[0];
    } catch (error) {
      new Notice(`Unable to open directory picker: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  }

  /** Normalizes user-selected directory strings for stable persistence and comparison. */
  private normalizeDirectory(directory: string): string {
    return directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory;
  }

  /** Mirrors OpenCode's pathKey behavior for opened-directory deduplication. */
  private pathKey(directory: string): string {
    return this.normalizeDirectory(directory).toLowerCase();
  }

  /** Returns the final path segment for concise worktree notices. */
  private basename(directory: string): string {
    const normalized = this.normalizeDirectory(directory);
    return normalized.split("/").filter(Boolean).pop() ?? normalized;
  }

  /** Performs a read-only health check command for early manual testing. */
  private async checkConnection(): Promise<void> {
    if (!this.opencode) return;
    try {
      const health = await this.opencode.health();
      new Notice(`OpenCode server ${health.healthy ? "healthy" : "unhealthy"}: ${health.version}`);
    } catch (error) {
      new Notice(`OpenCode server connection failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
