import { ItemView, Menu, Notice, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type OpenCodePlugin from "../../main";
import { DELETE_CURRENT_FILE_COMMANDS, RENAME_CURRENT_FILE_COMMANDS, matchesObsidianCommandHotkey } from "../obsidian-hotkeys";
import { diffFilesFromUnifiedPatch, type DiffFileSummary } from "../diff-utils";
import { confirmSessionRewind } from "../session-actions";
import { logServiceError } from "../services/opencode-http";
import type {
  JsonObject,
  OpenCodeMessageBundle,
  OpenCodeMessagePage,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
  OpenCodeSession,
} from "../services/opencode-types";
import { isActiveSessionStatus, normalizeWorkingAnimation, visualStatusForSession, type SessionVisualStatus } from "../session-state";
import * as jsonHelpers from "./session/json-helpers";
import * as messageHelpers from "./session/message-helpers";
import { SessionViewModel } from "./session/session-view-model";
import { ScrollController } from "./session/scroll-controller";
import { RequestDocksController } from "./session/request-docks";
import { reconcilePendingRequests } from "./session/request-state";
import { SlashMenuController } from "./session/composer/slash-menu";
import { ModelVariantsController } from "./session/composer/model-variants";
import { ComposerController } from "./session/composer/composer-controller";
import type { DomEventRegistrar } from "./session/dom-registrar";
import { MarkdownPatcher } from "./session/streaming/markdown-patcher";
import { StreamController } from "./session/streaming/stream-controller";
import { TimelineRenderer } from "./session/streaming/timeline-renderer";
import { SessionIslandController } from "./session/session-island-controller";
import { getIdeOrDefault } from "../utils/ide-launcher";

export const VIEW_TYPE_OPENCODE_SESSION = "opencode-session";

const INITIAL_MESSAGE_LIMIT = 30;
const OLDER_MESSAGE_LIMIT = 100;

interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
  draftId?: string;
  draftDirectory?: string;
}

interface VaultWithConfig {
  getConfig?: (key: string) => unknown;
}

/** Renders one OpenCode session in an Obsidian tab; opened from AgentPanelView session rows. */
export class SessionView extends ItemView {
  private model = new SessionViewModel();
  private scroll!: ScrollController;
  private docks!: RequestDocksController;
  private slash!: SlashMenuController;
  private variants!: ModelVariantsController;
  private composer!: ComposerController;
  private markdownPatcher!: MarkdownPatcher;
  private timeline!: TimelineRenderer;
  private island!: SessionIslandController;
  private stream!: StreamController;
  private sessionBindingVersion = 0;
  private canonicalRequestVersion = 0;
  private loadingSessionId?: string;
  private nativeTitleEl?: HTMLElement;
  private descendantChildrenCache = new Map<string, OpenCodeSession[]>();
  private descendantDiscoveryIncomplete = false;
  private descendantDiscoveryRetryDelay = 1_000;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(leaf);
    this.scroll = new ScrollController({
      plugin: this.plugin,
      contentEl: this.contentEl,
      model: this.model,
      register: this.makeRegistrar(),
      isActive: () => this.app.workspace.activeLeaf === this.leaf,
      onNearTop: () => {
        void this.loadOlderMessages();
      },
      onUnreadChange: (unread) => this.setSessionUnread(unread),
    });
    this.markdownPatcher = new MarkdownPatcher({
      contentEl: this.contentEl,
      component: this,
      getSessionId: () => this.model.sessionId,
      captureFollowLatest: () => this.scroll.captureFollowLatest(),
      restoreFollowLatest: (anchor) => this.scroll.restoreFollowLatest(anchor),
      updateJumpButton: () => this.scroll.updateJumpButton(),
    });
    this.timeline = new TimelineRenderer({
      app: this.app,
      component: this,
      contentEl: this.contentEl,
      model: this.model,
      getShowReasoningBlocks: () => this.plugin.settings.showReasoningBlocks,
      getGroupContextTools: () => this.plugin.settings.groupContextTools,
      getCustomToolDisplays: () => this.plugin.settings.customToolDisplays,
      getBindingVersion: () => this.sessionBindingVersion,
      isCurrentBinding: (sessionId, bindingVersion) => this.isCurrentSessionBinding(sessionId, bindingVersion),
      getRevertMessageId: () => this.revertMessageId(),
      requestShellRender: async () => {
        if (this.model.currentSession) await this.renderSession(this.model.currentSession, this.model.loadedMessages, { initialLoad: false });
      },
      captureFollowLatest: () => this.scroll.captureFollowLatest(),
      restoreFollowLatest: (anchor) => this.scroll.restoreFollowLatest(anchor),
      updateJumpButton: () => this.scroll.updateJumpButton(),
      onFork: (messageId) => void this.forkCurrentSession(messageId),
      onRewind: (bundle) => void this.requestMessageRewind(bundle),
      onRedo: () => void this.redoSessionRewind(),
      onOpenSession: (sessionId, title) => this.plugin.openSessionTab(sessionId, title),
    });
    this.island = new SessionIslandController({
      plugin: this.plugin,
      component: this,
      model: this.model,
      getRevertMessageId: () => this.revertMessageId(),
      isActive: () => this.app.workspace.activeLeaf === this.leaf,
      isSessionMuted: () => this.isSessionMuted(),
      shouldAutoApprove: () => this.docks.shouldAutoApprove(),
      isAutoApproveInherited: () => this.docks.isAutoApproveInherited(),
      onPromptActivated: () => this.composer.onPromptActivated(),
    });
    this.registerInterval(window.setInterval(() => this.timeline.refreshActiveTurnDuration(), 1_000));
    this.stream = new StreamController({
      model: this.model,
      subscribeToEvents: (handlers, directory) => this.plugin.requireOpenCodeService().subscribeToEvents(handlers, directory),
      findStreamingPartTarget: (messageId, partId, type) => this.markdownPatcher.findPartTarget(messageId, partId, type),
      queueStreamingMarkdownPatch: (key, element, markdown) => this.markdownPatcher.queue(key, element, markdown),
      extendFollowLatest: (durationMs) => this.scroll.extendFollowLatest(durationMs),
      onSessionUpdated: (session) => this.applySessionUpdate(session),
      onSessionDiff: (diffs) => {
        this.model.revertDiffFiles = diffs;
      },
      onTodosUpdated: (todos) => this.island.applyTodos(todos),
      onMessageChanged: (message) => this.island.reconcileMessages([message]),
      onMessageRemoved: (messageId) => this.island.removeMessage(messageId),
      onStreamOpen: (reconnected) => {
        if (reconnected) this.island.recoverAfterReconnect();
      },
      onStatusChange: (status) => this.applySessionStatus(status, true),
      onDescendantsChanged: () => this.island.refreshState(),
      onPermissionAsked: (request) => this.plugin.routePermissionRequest(request, this.model.sessionDirectory),
      onPermissionReplied: (requestId) => this.plugin.settleSessionRequest(requestId),
      onQuestionAsked: (request) => this.plugin.routeQuestionRequest(request),
      onQuestionSettled: (requestId) => this.plugin.settleSessionRequest(requestId),
      requestTimelineRender: () => this.timeline.renderStreaming(),
      requestComposerProgressRefresh: () => {
        this.composer.updateProgressBar();
        this.island.refreshChrome();
      },
      requestCanonicalSync: () => this.syncCanonicalMessages(),
    });
    this.docks = new RequestDocksController({
      plugin: this.plugin,
      model: this.model,
      onChanged: () => this.onRequestDocksChanged(),
      requestCanonicalSync: () => this.stream.scheduleCanonicalSync(0),
    });
    this.slash = new SlashMenuController({
      model: this.model,
      onResizeInput: (textarea) => this.composer.resizeComposerInput(textarea),
      onScheduleDraftSave: () => this.composer.scheduleDraftSave(),
    });
    this.variants = new ModelVariantsController({
      plugin: this.plugin,
      model: this.model,
      requestRefresh: async () => {
        await this.composer.refresh();
        this.island.refreshChrome();
      },
    });
    this.composer = new ComposerController({
      plugin: this.plugin,
      contentEl: this.contentEl,
      model: this.model,
      register: this.makeRegistrar(),
      // Slash surface
      onSlashUpdate: (textarea) => this.slash.update(textarea),
      onSlashKeydown: (event, textarea) => this.slash.handleKeydown(event, textarea),
      onBeforeRemount: () => {
        this.slash.hide();
        this.variants.hideModelMenu();
      },
      // Variants surface
      renderAgentLabel: (container, session) => this.variants.renderAgentLabel(container, session),
      renderModelPill: (container) => this.variants.renderModelPill(container),
      renderThinkingPill: (container) => this.variants.renderThinkingPill(container),
      // Docks surface
      isComposerBlocked: () => this.docks.isComposerBlocked(),
      shouldAutoApprove: () => this.docks.shouldAutoApprove(),
      isAutoApproveInherited: () => this.docks.isAutoApproveInherited(),
      // Scroll surface
      enableFollowLatest: () => this.scroll.enableFollowLatest(),
      disableFollowLatest: () => this.scroll.disableFollowLatest(),
      scrollToBottom: (smooth) => this.scroll.scrollToBottom(smooth),
      // Shell orchestration
      isSessionMuted: () => this.isSessionMuted(),
      onToggleMute: () => void this.toggleMute(),
      onToggleAutoApprove: () => void this.toggleAutoApprove(),
      requestDraftPromotion: (sessionId, sessionTitle) => this.promoteDraftView(sessionId, sessionTitle),
      executeBuiltinCommand: (command, sessionId, directory) => this.executeBuiltinCommand(command, sessionId, directory),
    });
  }

  /** Returns a `DomEventRegistrar` view of this `ItemView`; Obsidian cleans up registrations on close. */
  private makeRegistrar(): DomEventRegistrar {
    return { registerDomEvent: this.registerDomEvent.bind(this) };
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_SESSION;
  }

  /** Returns the tab title for this OpenCode session. */
  getDisplayText(): string {
    return this.model.sessionTitle ?? this.model.sessionId ?? (this.model.draftId ? "New session" : "OpenCode session");
  }

  /** Returns the Lucide icon used by the session tab. */
  getIcon(): string {
    switch (this.sessionVisualStatus()) {
      case "working":
        return "circle";
      case "attention":
        return "megaphone";
      case "error":
        return "alert-circle";
      case "retry":
        return "rotate-cw";
      case "done":
        return "circle";
      default:
        return "message-square";
    }
  }

  /** Adds the canonical session actions to both the native title-bar and tab-header menus. */
  onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
    super.onPaneMenu(menu, source);
    if (!this.model.sessionId) return;
    const qualifier = source === "more-options" ? " current session" : " session";
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(`Rename${qualifier}`)
        .setIcon("pencil")
        .onClick(() => void this.plugin.requestSessionRename(this.model.sessionId!, this.getDisplayText(), this.model.sessionDirectory)),
    );
    menu.addItem((item) => item.setTitle("Fork this session").setIcon("git-fork").onClick(() => void this.forkCurrentSession()));
    menu.addItem((item) =>
      item
        .setTitle(`${this.isSessionMuted() ? "Unmute" : "Mute"}${qualifier}`)
        .setIcon(this.isSessionMuted() ? "bell" : "bell-off")
        .onClick(() => void this.toggleMute()),
    );
    menu.addItem((item) =>
      item
        .setTitle(`Archive${qualifier}`)
        .setIcon("archive")
        .onClick(() => void this.plugin.requestSessionArchive(this.model.sessionId!, this.model.sessionDirectory)),
    );
    // Open the session's project folder in the IDE configured in plugin settings.
    const directory = this.getSessionDirectory();
    if (directory) {
      const ide = getIdeOrDefault(this.plugin.settings.openIde);
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(`Open project in ${ide.label}`)
          .setIcon(ide.icon)
          .onClick(() => void this.plugin.openProjectInIde(directory, ide.id)),
      );
    }
  }

  /** Returns the active session directory, or the draft directory before promotion. */
  getSessionDirectory(): string | undefined {
    return this.model.sessionDirectory ?? this.model.draftDirectory;
  }

  /** Restores persisted view state when Obsidian reopens this custom tab. */
  getState(): Record<string, unknown> {
    return {
      sessionId: this.model.sessionId,
      sessionTitle: this.model.sessionTitle,
      draftId: this.model.draftId,
      draftDirectory: this.model.draftDirectory,
    };
  }

  /** Applies a new session id and reloads the view; referenced by OpenCodePlugin.openSessionTab. */
  async setState(state: SessionViewState, _result: ViewStateResult): Promise<void> {
    const sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
    const sessionTitle = typeof state.sessionTitle === "string" ? state.sessionTitle : undefined;
    const draftId = typeof state.draftId === "string" ? state.draftId : undefined;
    const draftDirectory = typeof state.draftDirectory === "string" ? state.draftDirectory : undefined;
    if (sessionId === this.model.sessionId && draftId === this.model.draftId && draftDirectory === this.model.draftDirectory) {
      if (sessionTitle && sessionTitle !== this.model.sessionTitle) this.applySessionTitle(sessionTitle);
      else this.refreshLeafTitle();
      await this.refresh();
      return;
    }
    const preserveSubmission = !this.model.sessionId && !!this.model.draftId && !!sessionId && this.model.submittingPrompt;
    if (!preserveSubmission) this.composer.persistDraft();
    this.slash.hide();
    this.variants.hideModelMenu();
    this.stream.disconnect();
    this.sessionBindingVersion += 1;
    this.loadingSessionId = undefined;
    this.model.sessionId = sessionId;
    this.model.sessionTitle = sessionTitle;
    this.model.draftId = draftId;
    this.model.draftDirectory = draftDirectory;
    this.refreshLeafTitle();
    await this.refresh({ preserveSubmission });
  }

  /** Initializes live refresh for the session tab. */
  async onOpen(): Promise<void> {
    this.contentEl.addClass("opencode-session-view");
    this.containerEl.addClass("opencode-session-view-container");
    this.syncReadableLineLength();
    this.registerDomEvent(window, "keydown", this.handleNativeSessionHotkeys, { capture: true });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncReadableLineLength()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.syncReadableLineLength()));
    // Body-attached popovers (slash menu, model menu) survive tab switches because they live outside `contentEl`.
    // Hide them when this leaf loses focus so they don't float over a different session's view.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf !== this.leaf) {
        this.slash.hide();
        this.variants.hideModelMenu();
      } else {
        this.island.activate();
      }
    }));
    await this.refresh();
  }

  /** Releases event streams and timers when the tab closes. */
  async onClose(): Promise<void> {
    this.composer.persistDraft();
    this.sessionBindingVersion += 1;
    this.loadingSessionId = undefined;
    this.stream.dispose();
    // Persist while the in-flow composer is still mounted so removing it cannot shift the measured scroll position.
    this.scroll.dispose();
    this.variants.dispose();
    this.slash.dispose();
    this.composer.dispose();
    this.island.dispose();
    this.markdownPatcher.dispose();
    this.nativeTitleEl?.removeEventListener("click", this.handleNativeTitleClick);
    this.nativeTitleEl = undefined;
    this.docks.dispose();
    this.clearSessionHeaderDecoration();
    this.contentEl.removeClass("opencode-session-view");
    this.contentEl.removeClass("is-readable-line-width");
    this.containerEl.removeClass("opencode-session-view-container");
    this.contentEl.empty();
  }

  /** Mirrors Obsidian's editor line-length setting onto this custom session view. */
  private syncReadableLineLength(): void {
    // Obsidian does not expose this editor toggle in its public API, so mirror the same config used by MarkdownView.
    const vault = this.app.vault as typeof this.app.vault & VaultWithConfig;
    this.contentEl.toggleClass("is-readable-line-width", vault.getConfig?.("readableLineLength") === true);
  }

  /** Reloads session data; initial/manual loads rebuild the shell, while active-session refreshes reconcile incrementally. */
  async refresh(options: { preserveSubmission?: boolean } = {}): Promise<void> {
    if (!this.model.sessionId) {
      this.resetTimelineState(options);
      if (this.model.draftId && this.model.draftDirectory) await this.renderDraftSession();
      else this.renderEmpty();
      return;
    }

    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (this.loadingSessionId === sessionId) return;
    const initialLoad = this.model.renderedSessionId !== sessionId;
    if (initialLoad) this.resetTimelineState(options);
    this.loadingSessionId = sessionId;
    if (initialLoad) this.renderLoading();
    try {
      const session = await this.fetchCanonicalSession(sessionId, bindingVersion, initialLoad);
      if (!session) return;

      if (initialLoad) {
        await this.renderSession(session, this.model.loadedMessages, { initialLoad });
      } else if (!this.contentEl.querySelector(".opencode-session-view__shell")) {
        await this.renderSession(session, this.model.loadedMessages, { initialLoad: false });
      } else {
        this.docks.refresh();
        await this.timeline.reconcileAppendOnly(this.model.loadedMessages);
      }
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) this.renderError(error);
    } finally {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion) && this.loadingSessionId === sessionId) this.loadingSessionId = undefined;
    }
  }

  /** Clears cursor/page state when the view is rebound to another session. */
  private resetTimelineState(options: { preserveSubmission?: boolean } = {}): void {
    const submittingPrompt = options.preserveSubmission === true && this.model.submittingPrompt;
    this.island.unbind();
    this.model.loadedMessages = [];
    this.model.olderCursor = undefined;
    this.model.historyComplete = true;
    this.model.renderedSessionId = undefined;
    this.model.currentSession = undefined;
    this.model.sessionDirectory = undefined;
    this.model.revertDiffFiles = [];
    this.model.rewindInFlight = false;
    this.model.submittingPrompt = submittingPrompt;
    this.model.sessionStatusType = "idle";
    this.model.sessionBusy = false;
    this.model.activeTurnStartedAt = undefined;
    this.model.activeTurnCompletedAt = undefined;
    this.model.loadingOlder = false;
    this.model.pendingPermissions = [];
    this.model.pendingQuestions = [];
    this.model.unscopedPendingPermissions = [];
    this.model.unscopedPendingQuestions = [];
    this.model.descendantSessions.clear();
    this.model.pendingRequestRevision = 0;
    this.model.pendingRequestRevisionById.clear();
    this.descendantChildrenCache.clear();
    this.descendantDiscoveryIncomplete = false;
    this.descendantDiscoveryRetryDelay = 1_000;
    this.model.queuedMessageIds.clear();
    this.model.pendingQueuedUserMessages = 0;
    this.timeline.clearDisclosureState();
    this.scroll.clearJumpButtonReference();
    if (!submittingPrompt) this.scroll.disableFollowLatest();
  }

  /** Returns whether an async load still belongs to the session currently bound to this view. */
  private isCurrentSessionBinding(sessionId: string, bindingVersion: number): boolean {
    return this.model.sessionId === sessionId && this.sessionBindingVersion === bindingVersion;
  }

  /** Fetches canonical session data after idle and reconciles only the timeline tail. */
  private async syncCanonicalMessages(): Promise<void> {
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (!sessionId || !this.contentEl.querySelector(".opencode-session-view__timeline")) {
      await this.refresh();
      return;
    }
    if (this.loadingSessionId === sessionId) {
      this.stream.scheduleCanonicalSync(200);
      return;
    }
    try {
      if (!await this.fetchCanonicalSession(sessionId, bindingVersion, false)) return;
      this.docks.refresh();
      await this.timeline.reconcileAppendOnly(this.model.loadedMessages);
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) console.warn("[opencode-plugin:session-stream] canonical sync failed", error);
    }
  }

  /** Fetches and applies the canonical v1 session snapshot shared by refresh and idle sync. */
  private async fetchCanonicalSession(sessionId: string, bindingVersion: number, replaceMessages: boolean): Promise<JsonObject | undefined> {
    const requestVersion = ++this.canonicalRequestVersion;
    const isCurrentRequest = (): boolean => requestVersion === this.canonicalRequestVersion && this.isCurrentSessionBinding(sessionId, bindingVersion);
    const service = this.plugin.requireOpenCodeService();
    const previousRewindMessageId = this.revertMessageId();
    const [session, page] = await Promise.all([
      service.getSession(sessionId),
      service.listMessagePage(sessionId, { limit: INITIAL_MESSAGE_LIMIT }),
    ]);
    if (!isCurrentRequest()) return undefined;
    const rewindMessageId = this.revertMessageId(session);
    const effectivePage = await this.loadMessageWindow(page, rewindMessageId, sessionId);
    if (!isCurrentRequest()) return undefined;
    const directory = this.sessionDirectoryFromSession(session);
    const pendingRequestRevision = this.model.pendingRequestRevision;
    this.descendantDiscoveryIncomplete = false;
    const permissionFallback = [...this.model.pendingPermissions, ...this.model.unscopedPendingPermissions];
    const questionFallback = [...this.model.pendingQuestions, ...this.model.unscopedPendingQuestions];
    const [agents, models, commands, config, permissions, questions, statuses, descendants] = await Promise.all([
      service.listAgents(directory),
      service.listModels(directory).catch(logServiceError([], "listModels", directory)),
      service.listCommands(directory).catch(logServiceError([], "listCommands", directory)),
      service.getConfig().catch(logServiceError({}, "getConfig", directory)),
      service.listPermissionRequests(directory).catch(logServiceError(permissionFallback, "listPermissionRequests", directory)),
      service.listQuestionRequests(directory).catch(logServiceError(questionFallback, "listQuestionRequests", directory)),
      service.getSessionStatus().catch(logServiceError({}, "getSessionStatus", directory)),
      this.loadSessionDescendants(sessionId, directory).catch(logServiceError([], "listSessionDescendants", sessionId)),
    ]);
    if (!isCurrentRequest()) return undefined;

    this.model.availableAgents = agents;
    this.model.availableModels = models;
    this.model.availableCommands = commands;
    this.model.serverConfig = config;
    this.plugin.cacheSessionHierarchy([session as OpenCodeSession, ...descendants], true);
    await this.plugin.hydrateSessionAutoApproveState(sessionId, directory);
    if (!isCurrentRequest()) return undefined;
    this.model.descendantSessions = new Map(descendants.map((item) => [item.id, {
      title: jsonHelpers.readString(item, ["title", "name", "slug"]) ?? item.id,
      directory: this.sessionDirectoryFromSession(item) ?? directory,
      statusType: jsonHelpers.readString(jsonHelpers.readObject(statuses, item.id) ?? {}, ["type", "status", "state"]) ?? "idle",
    }]));
    this.docks.reconcileRequestScope();
    const visibleSessionIds = new Set([sessionId, ...this.model.descendantSessions.keys()]);
    const visiblePermissions = permissions.filter((item) => visibleSessionIds.has(item.sessionID));
    for (const permission of visiblePermissions) this.plugin.routePermissionRequest(permission, directory);
    this.model.pendingPermissions = reconcilePendingRequests(
      visiblePermissions,
      this.model.pendingPermissions,
      pendingRequestRevision,
      this.model.pendingRequestRevision,
      this.model.pendingRequestRevisionById,
    );
    this.model.pendingQuestions = reconcilePendingRequests(
      questions.filter((item) => visibleSessionIds.has(item.sessionID)),
      this.model.pendingQuestions,
      pendingRequestRevision,
      this.model.pendingRequestRevision,
      this.model.pendingRequestRevisionById,
    );
    if (replaceMessages || previousRewindMessageId !== rewindMessageId) {
      this.model.loadedMessages = effectivePage.messages;
      this.model.olderCursor = effectivePage.olderCursor;
    } else {
      this.model.loadedMessages = this.mergeMessages(this.model.loadedMessages, effectivePage.messages);
      if (!this.model.olderCursor) this.model.olderCursor = effectivePage.olderCursor;
    }
    this.model.historyComplete = effectivePage.complete && !this.model.olderCursor;
    this.applyCanonicalSession(session);
    this.applySessionStatusSnapshot(statuses);
    if (this.descendantDiscoveryIncomplete) {
      this.stream.scheduleCanonicalSync(this.descendantDiscoveryRetryDelay);
      this.descendantDiscoveryRetryDelay = Math.min(this.descendantDiscoveryRetryDelay * 2, 30_000);
    } else {
      this.descendantDiscoveryRetryDelay = 1_000;
    }
    return isCurrentRequest() ? session : undefined;
  }

  /** Loads the full descendant tree used by canonical request routing in this session view. */
  private async loadSessionDescendants(sessionId: string, directory: string | undefined, visited = new Set<string>()): Promise<OpenCodeSession[]> {
    if (visited.has(sessionId)) return [];
    visited.add(sessionId);
    const fallback = this.descendantChildrenCache.get(sessionId) ?? [];
    const children = await this.plugin.requireOpenCodeService().listSessionChildren(sessionId, directory).catch((error) => {
      this.descendantDiscoveryIncomplete = true;
      return logServiceError(fallback, "listSessionChildren", sessionId)(error);
    });
    this.descendantChildrenCache.set(sessionId, children);
    const nested = await Promise.all(children.map((child) => this.loadSessionDescendants(child.id, child.directory ?? directory, visited)));
    return [...children, ...nested.flat()];
  }

  /** Hydrates canonical session identity and chrome state without rebuilding the shell. */
  private applyCanonicalSession(session: JsonObject): void {
    this.plugin.cacheSessionHierarchy([session as OpenCodeSession]);
    this.model.currentSession = session;
    this.model.revertDiffFiles = this.revertDiffFilesFromSession(session);
    this.model.sessionTitle = this.sessionTitleFromSession(session);
    this.model.sessionDirectory = this.sessionDirectoryFromSession(session);
    this.stream.subscribe(this.model.sessionDirectory);
    this.model.selectedAgent = this.variants.resolveAgentForSession(session);
    this.model.selectedModel = this.variants.resolveModelForSession(session, this.model.selectedAgent);
    this.model.renderedSessionId = this.model.sessionId;
    if (this.model.sessionId) this.island.bind(this.model.sessionId, this.model.sessionDirectory, this.model.loadedMessages);
    this.refreshLeafTitle();
    this.composer.updateInsetSoon();
  }

  /** Applies streamed session identity updates through the same chrome boundary as canonical refreshes. */
  private applySessionUpdate(session: JsonObject): void {
    this.canonicalRequestVersion += 1;
    this.applyCanonicalSession(session);
  }

  /** Applies the current session's status from the global v1 status snapshot. */
  private applySessionStatusSnapshot(snapshot: JsonObject): void {
    const status = this.model.sessionId ? jsonHelpers.readObject(snapshot, this.model.sessionId) : undefined;
    if (status || !isActiveSessionStatus(this.model.sessionStatusType)) this.applySessionStatus(status);
  }

  /** Reconciles busy, retry, and idle status events with composer and unread state. */
  private applySessionStatus(status: JsonObject | undefined, fromEvent = false): void {
    const previousType = this.model.sessionStatusType;
    const nextType = jsonHelpers.readString(status ?? {}, ["type", "status", "state"]) ?? "idle";
    const wasBusy = isActiveSessionStatus(previousType);
    const isBusy = isActiveSessionStatus(nextType);
    this.model.sessionStatusType = nextType;
    this.model.sessionBusy = isBusy;
    if (!wasBusy && isBusy) {
      this.model.activeTurnStartedAt = Date.now();
      this.model.activeTurnCompletedAt = undefined;
    }
    if (wasBusy && !isBusy) this.model.activeTurnCompletedAt = Date.now();

    if (fromEvent && nextType === "idle") {
      this.model.queuedMessageIds.clear();
      this.model.pendingQueuedUserMessages = 0;
      this.stream.scheduleCanonicalSync(120);
      this.scroll.releaseFollowLatestAfterIdle();
    }
    if (wasBusy && !isBusy && this.model.sessionId) this.setSessionUnread(true);
    if (this.model.sessionId) this.plugin.notifySessionStatusChanged(this.model.sessionId, nextType);
    this.refreshSessionStateChrome();
    if (wasBusy !== isBusy) void this.timeline.renderStreaming().catch((error) => console.warn("[opencode-plugin:session-status] timeline render failed", error));
    if (wasBusy !== isBusy) this.composer.onSessionStatusChanged();
  }

  /** Returns the visual state shared by the native session tab and view header. */
  private sessionVisualStatus(): SessionVisualStatus {
    if (this.model.pendingPermissions.length > 0 || this.model.pendingQuestions.length > 0) return "attention";
    return visualStatusForSession(this.model.sessionStatusType, this.model.sessionId ? this.plugin.settings.sessionUnread[this.model.sessionId] === true : false);
  }

  /** Updates the native tab and view-header status treatment after status changes. */
  private refreshSessionStateChrome(): void {
    const status = this.sessionVisualStatus();
    this.contentEl.dataset.sessionState = status;
    this.contentEl.dataset.workingAnimation = normalizeWorkingAnimation(this.plugin.settings.workingAnimation);
    this.refreshLeafTitle();
  }

  /** Renders a placeholder when no session id is bound to this view. */
  private renderEmpty(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ text: "No OpenCode session selected.", cls: "opencode-session-view__state-title" });
  }

  /** Renders a client-only new-session draft without creating a server database record. */
  private async renderDraftSession(): Promise<void> {
    const directory = this.model.draftDirectory;
    const draftId = this.model.draftId;
    const bindingVersion = this.sessionBindingVersion;
    if (!directory) return;
    try {
      this.composer.persistDraft();
      const service = this.plugin.requireOpenCodeService();
      const [agents, models, commands, config] = await Promise.all([
        service.listAgents(directory),
        service.listModels(directory).catch(logServiceError([], "listModels", directory)),
        service.listCommands(directory).catch(logServiceError([], "listCommands", directory)),
        service.getConfig().catch(logServiceError({}, "getConfig", directory)),
      ]);
      if (this.sessionBindingVersion !== bindingVersion || this.model.draftId !== draftId || this.model.sessionId) return;
      this.model.availableAgents = agents;
      this.model.availableModels = models;
      this.model.availableCommands = commands;
      this.model.serverConfig = config;
      this.model.selectedAgent = this.variants.resolveAgentForSession({});
      this.model.selectedModel = this.variants.resolveModelForSession({}, this.model.selectedAgent);
      this.model.sessionDirectory = directory;
      this.stream.subscribe(directory);
      this.contentEl.empty();
      const shell = this.contentEl.createDiv({ cls: "opencode-session-view__shell opencode-session-view__shell--draft" });
      const body = shell.createDiv({ cls: "opencode-session-view__draft-body" });
      body.createDiv({ text: "What would you like to work on?", cls: "opencode-session-view__draft-title" });
      const bottomDock = shell.createDiv({ cls: "opencode-session-view__bottom-dock" });
      this.docks.mount(bottomDock);
      const promptPanel = this.island.mount(bottomDock);
      this.composer.mount(promptPanel, {}, true);
      this.refreshLeafTitle();
    } catch (error) {
      if (this.sessionBindingVersion === bindingVersion && this.model.draftId === draftId && !this.model.sessionId) this.renderError(error);
    }
  }

  /** Renders a lightweight loading state while messages are fetched. */
  private renderLoading(): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ cls: "opencode-session-view__spinner" });
    state.createDiv({ text: "Loading OpenCode session…", cls: "opencode-session-view__state-text" });
  }

  /** Renders connection or payload errors with a retry button. */
  private renderError(error: unknown): void {
    this.contentEl.empty();
    const state = this.contentEl.createDiv({ cls: "opencode-session-view__state" });
    state.createDiv({ text: "Unable to load OpenCode session.", cls: "opencode-session-view__state-title" });
    state.createDiv({ text: error instanceof Error ? error.message : "Unknown error", cls: "opencode-session-view__state-text" });
    const retry = state.createEl("button", { text: "Retry", cls: "mod-cta" });
    retry.addEventListener("click", () => void this.refresh());
  }

  /** Renders the currently loaded timeline page and composer using Obsidian's MarkdownRenderer. */
  private async renderSession(session: JsonObject, messages: OpenCodeMessageBundle[], options: { initialLoad: boolean }): Promise<void> {
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    const previousTop = this.contentEl.scrollTop;
    const followAnchor = this.scroll.captureFollowLatest();
    const interactionGeneration = this.scroll.captureInteractionGeneration();
    const wasAtBottom = !!followAnchor;
    if (wasAtBottom) this.scroll.markProgrammaticScroll(1600);
    const shell = document.createElement("div");
    shell.classList.add("opencode-session-view__shell");

    const timeline = shell.createDiv({ cls: "opencode-session-view__timeline" });
    const visibleMessageCount = await this.timeline.renderInto(timeline, messages);

    if (!sessionId || !this.isCurrentSessionBinding(sessionId, bindingVersion)) return;

    const composerState = this.composer.captureDomState();
    this.composer.persistDraft();
    this.slash.hide();
    this.variants.hideModelMenu();
    this.contentEl.dataset.workingAnimation = normalizeWorkingAnimation(this.plugin.settings.workingAnimation);
    this.contentEl.replaceChildren(shell);
    this.refreshSessionStateChrome();
    const bottomDock = shell.createDiv({ cls: "opencode-session-view__bottom-dock" });
    this.docks.mount(bottomDock);
    const promptPanel = this.island.mount(bottomDock);
    this.composer.mount(promptPanel, session, options.initialLoad && visibleMessageCount === 0);
    this.composer.restoreDomState(composerState);
    this.scroll.renderJumpToBottomButton();
    this.scroll.bindScrollListener();
    await this.scroll.restoreScrollAfterRender(options.initialLoad, previousTop, followAnchor, interactionGeneration);
  }

  /** Loads the previous cursor page and prepends it while preserving the top visible message anchor. */
  private async loadOlderMessages(): Promise<void> {
    if (!this.model.sessionId || this.model.loadingOlder || this.model.historyComplete || !this.model.olderCursor) return;
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    const olderCursor = this.model.olderCursor;
    const anchor = this.scroll.capturePrependAnchor();
    this.model.loadingOlder = true;
    try {
      const page = await this.plugin.requireOpenCodeService().listMessagePage(sessionId, { limit: OLDER_MESSAGE_LIMIT, cursor: olderCursor });
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
      this.model.loadedMessages = this.mergeMessages(page.messages, this.model.loadedMessages);
      this.model.olderCursor = page.olderCursor;
      this.model.historyComplete = page.complete && !this.model.olderCursor;
      this.model.loadingOlder = false;
      const session = await this.plugin.requireOpenCodeService().getSession(sessionId);
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
      this.applyCanonicalSession(session);
      await this.renderSession(session, this.model.loadedMessages, { initialLoad: false });
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
      await this.scroll.restorePrependAnchor(anchor);
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) new Notice(error instanceof Error ? error.message : "Unable to load earlier OpenCode messages.");
    } finally {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) this.model.loadingOlder = false;
    }
  }

  /** Follows opaque v1 cursors until a rewound timeline includes a visible message before its boundary. */
  private async loadMessageWindow(firstPage: OpenCodeMessagePage, boundary?: string, sessionId = this.model.sessionId): Promise<OpenCodeMessagePage> {
    if (!sessionId) return firstPage;
    const service = this.plugin.requireOpenCodeService();
    const pages = [firstPage];
    let page = firstPage;
    const seenCursors = new Set<string>();
    while (
      boundary &&
      !pages.some((candidate) => candidate.messages.some((message) => messageHelpers.messageId(message) < boundary)) &&
      page.olderCursor &&
      !seenCursors.has(page.olderCursor)
    ) {
      const cursor = page.olderCursor;
      seenCursors.add(cursor);
      page = await service.listMessagePage(sessionId, { limit: OLDER_MESSAGE_LIMIT, cursor });
      pages.push(page);
    }
    return {
      messages: pages.reduce((messages, candidate) => this.mergeMessages(messages, candidate.messages), [] as OpenCodeMessageBundle[]),
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
      complete: page.complete,
    };
  }

  /** Merges message pages by message id; referenced by refresh and loadOlderMessages. */
  private mergeMessages(left: OpenCodeMessageBundle[], right: OpenCodeMessageBundle[]): OpenCodeMessageBundle[] {
    const merged = new Map<string, OpenCodeMessageBundle>();
    for (const message of [...left, ...right]) merged.set(messageHelpers.messageId(message), message);
    return [...merged.values()].sort((a, b) => messageHelpers.messageTime(a) - messageHelpers.messageTime(b));
  }

  /** Reads the active v1 rewind marker from a session response or current session state. */
  private revertMessageId(session: JsonObject | undefined = this.model.currentSession): string | undefined {
    const revert = session ? jsonHelpers.readObject(session, "revert") : undefined;
    return revert ? jsonHelpers.readString(revert, ["messageID", "messageId"]) : undefined;
  }

  /** Parses the aggregate affected-file patch retained with a v1 rewind marker. */
  private revertDiffFilesFromSession(session: JsonObject): DiffFileSummary[] {
    const revert = jsonHelpers.readObject(session, "revert");
    return diffFilesFromUnifiedPatch(revert ? jsonHelpers.readString(revert, ["diff"]) : undefined);
  }

  /** Persists the current session's unread completion marker and refreshes visible sidebar rows. */
  private setSessionUnread(unread: boolean): void {
    if (!this.model.sessionId || (this.plugin.settings.sessionUnread[this.model.sessionId] === true) === unread) return;
    void this.plugin.rememberSessionUnread(this.model.sessionId, unread).then(() => {
      this.refreshSessionStateChrome();
      void this.plugin.refreshAgentPanels({ showLoading: false });
    });
  }

  /** Refreshes native status chrome, composer state, and scroll after the docks controller re-renders. */
  private onRequestDocksChanged(): void {
    this.refreshSessionStateChrome();
    this.composer.onDocksChanged();
    if (this.scroll.isNearBottom()) this.scroll.scrollToBottom(false);
  }

  /** Receives a globally routed permission request and surfaces it when its owner is in this view's tree. */
  ingestPermissionRequest(request: OpenCodePermissionRequest): void {
    this.docks.ingestPermissionAsked(request);
  }

  /** Receives a globally routed question request and surfaces it when its owner is in this view's tree. */
  ingestQuestionRequest(request: OpenCodeQuestionRequest): void {
    this.docks.ingestQuestionAsked(request);
  }

  /** Removes a globally settled request from this view; referenced by OpenCodePlugin. */
  settleSessionRequest(requestId: string): void {
    this.docks.ingestPermissionReplied(requestId);
  }

  /** Re-renders this view's request controls after shared response state changes. */
  refreshSessionRequestDocks(): void {
    this.docks.refresh();
  }

  /** Toggles client-side auto-approval and immediately clears existing permission docks when enabled. */
  private async toggleAutoApprove(): Promise<void> {
    const key = this.model.composerStorageKey;
    if (!key) return;
    await this.plugin.toggleSessionAutoApprove(key, this.model.sessionDirectory ?? this.model.draftDirectory);
  }

  /** Toggles local notification muting for the current session/draft. */
  private async toggleMute(): Promise<void> {
    const key = this.model.composerStorageKey;
    if (!key) return;
    await this.plugin.rememberSessionMute(key, !this.isSessionMuted());
    await this.composer.refresh();
    this.island.refreshChrome();
  }

  /** Forks the current session and opens the resulting session tab. */
  private async forkCurrentSession(messageId?: string): Promise<void> {
    if (!this.model.sessionId || this.model.sessionBusy) return;
    try {
      const forked = await this.plugin.requireOpenCodeService().forkSession(this.model.sessionId, this.model.sessionDirectory, messageId);
      await this.plugin.refreshAgentPanels({ showLoading: false });
      await this.plugin.openSessionTab(forked.id, forked.title);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to fork OpenCode session.");
    }
  }

  /** Stages a rewind before confirmation and clears it again if the user cancels. */
  private async requestMessageRewind(bundle: OpenCodeMessageBundle): Promise<void> {
    if (this.model.rewindInFlight || this.model.submittingPrompt) return;
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (!sessionId) return;
    const messageId = messageHelpers.messageId(bundle);
    const preview = this.rewindMessagePreview(bundle);
    this.model.rewindInFlight = true;
    try {
      if (!await this.stageSessionRewind(messageId)) return;
      const confirmed = await confirmSessionRewind(this.app, preview);
      if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return;
      // v1 commits by retaining the staged revert marker; it has no separate commit endpoint.
      if (!confirmed) {
        try {
          await this.cancelStagedRewind();
        } catch (error) {
          await this.refresh();
          if (this.revertMessageId()) {
            const detail = error instanceof Error ? error.message : "Unknown error";
            new Notice(`Unable to cancel the staged session rewind. The rewind remains staged; use Redo to retry. ${detail}`);
          }
        }
      }
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) new Notice(error instanceof Error ? error.message : "Unable to rewind OpenCode session.");
    } finally {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) {
        this.model.rewindInFlight = false;
        this.stream.scheduleCanonicalSync(100);
      }
    }
  }

  /** Applies the v1 revert marker, refreshes affected files, and re-renders from the new head. */
  private async stageSessionRewind(messageId: string): Promise<boolean> {
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (!sessionId) return false;
    const service = this.plugin.requireOpenCodeService();
    const directory = this.model.sessionDirectory;
    if (this.model.sessionBusy) await service.abortSession(sessionId, directory).catch(() => false);
    if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return false;
    const session = await service.revertSession(sessionId, { messageID: messageId }, directory);
    if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return false;
    const rewindMessageId = this.revertMessageId(session);
    if (!rewindMessageId) throw new Error("OpenCode did not create a rewind boundary for this message.");
    this.model.currentSession = session;
    this.model.sessionDirectory = this.sessionDirectoryFromSession(session) ?? directory;
    this.model.revertDiffFiles = this.revertDiffFilesFromSession(session);
    await this.timeline.renderStreaming().catch((error) => console.warn("[opencode-plugin:rewind] timeline render failed", error));
    if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return false;
    this.island.reconcileMessages(this.model.loadedMessages);
    return this.isCurrentSessionBinding(sessionId, bindingVersion);
  }

  /** Restores every message and file hidden by the current v1 rewind marker. */
  private async clearSessionRewind(): Promise<boolean> {
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (!sessionId) return false;
    const session = await this.plugin.requireOpenCodeService().unrevertSession(sessionId, this.model.sessionDirectory);
    if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return false;
    this.model.currentSession = session;
    this.model.revertDiffFiles = [];
    await this.timeline.renderStreaming().catch((error) => console.warn("[opencode-plugin:rewind] timeline render failed", error));
    if (!this.isCurrentSessionBinding(sessionId, bindingVersion)) return false;
    this.island.reconcileMessages(this.model.loadedMessages);
    return this.isCurrentSessionBinding(sessionId, bindingVersion);
  }

  /** Retries v1 unrevert so dismissing the confirmation does not leave a transient staged rollback behind. */
  private async cancelStagedRewind(): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!await this.clearSessionRewind()) return;
        return;
      } catch (error) {
        failure = error;
        if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw failure;
  }

  /** Handles the boundary redo action without allowing concurrent rewind mutations. */
  private async redoSessionRewind(): Promise<void> {
    if (this.model.rewindInFlight) return;
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    if (!sessionId) return;
    this.model.rewindInFlight = true;
    try {
      const nextMessageId = this.nextRewoundUserMessageId();
      if (nextMessageId) await this.stageSessionRewind(nextMessageId);
      else await this.clearSessionRewind();
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) new Notice(error instanceof Error ? error.message : "Unable to restore rewound messages.");
    } finally {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) {
        this.model.rewindInFlight = false;
        this.stream.scheduleCanonicalSync(100);
      }
    }
  }

  /** Builds the bounded user-message preview shown by the rewind confirmation. */
  private rewindMessagePreview(bundle: OpenCodeMessageBundle): string {
    const text = messageHelpers.userMessageText(bundle).replace(/\s+/g, " ").trim();
    const fallback = messageHelpers.imageAttachments(bundle).map((attachment) => attachment.name).join(", ") || "User message";
    const preview = text || fallback;
    return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
  }

  /** Finds the latest user message before the current boundary for the `/undo` command. */
  private previousUserMessageId(): string | undefined {
    const boundary = this.revertMessageId();
    const messages = [...this.model.loadedMessages].sort((left, right) => messageHelpers.messageTime(left) - messageHelpers.messageTime(right));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const messageId = messageHelpers.messageId(message);
      if (messageHelpers.messageRole(message) === "user" && (!boundary || messageId < boundary)) return messageId;
    }
    return undefined;
  }

  /** Finds the next hidden user turn so redo advances one boundary at a time before fully unreverting. */
  private nextRewoundUserMessageId(): string | undefined {
    const boundary = this.revertMessageId();
    if (!boundary) return undefined;
    const messages = [...this.model.loadedMessages].sort((left, right) => messageHelpers.messageTime(left) - messageHelpers.messageTime(right));
    for (const message of messages) {
      const messageId = messageHelpers.messageId(message);
      if (messageHelpers.messageRole(message) === "user" && messageId > boundary) return messageId;
    }
    return undefined;
  }

  /** Applies the user's current native rename/delete-file hotkeys to the active session view. */
  private handleNativeSessionHotkeys = (event: KeyboardEvent): void => {
    if (!this.model.sessionId || this.app.workspace.activeLeaf !== this.leaf || event.repeat) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest(".view-header-title-input, .modal")) return;
    if (matchesObsidianCommandHotkey(this.app, RENAME_CURRENT_FILE_COMMANDS, event)) {
      event.preventDefault();
      event.stopPropagation();
      void this.plugin.requestSessionRename(this.model.sessionId, this.getDisplayText(), this.model.sessionDirectory);
      return;
    }
    if (matchesObsidianCommandHotkey(this.app, DELETE_CURRENT_FILE_COMMANDS, event)) {
      event.preventDefault();
      event.stopPropagation();
      void this.plugin.requestSessionArchive(this.model.sessionId, this.model.sessionDirectory);
    }
  };

  /** Executes a built-in functional command by calling the corresponding v1 session API endpoint. Referenced by ComposerController.sendPrompt. */
  private async executeBuiltinCommand(command: string, sessionId: string, directory?: string): Promise<void> {
    const service = this.plugin.requireOpenCodeService();
    switch (command) {
      case "compact":
        await service.summarizeSession(sessionId, directory);
        break;
      case "undo": {
        const messageId = this.previousUserMessageId();
        if (!messageId) {
          new Notice("No user message is available to rewind.");
          break;
        }
        if (this.model.rewindInFlight) break;
        const bindingVersion = this.sessionBindingVersion;
        this.model.rewindInFlight = true;
        try {
          await this.stageSessionRewind(messageId);
        } finally {
          if (this.isCurrentSessionBinding(sessionId, bindingVersion)) {
            this.model.rewindInFlight = false;
            this.stream.scheduleCanonicalSync(100);
          }
        }
        break;
      }
      case "redo":
        await this.redoSessionRewind();
        break;
      case "share":
        await service.shareSession(sessionId, directory);
        break;
      case "unshare":
        await service.unshareSession(sessionId, directory);
        break;
      case "fork": {
        const forked = await service.forkSession(sessionId, directory);
        new Notice(`Forked session: ${forked.title ?? forked.id}`);
        break;
      }
    }
  }

  /** Returns true when the current session/draft is locally muted. */
  private isSessionMuted(): boolean {
    const key = this.model.composerStorageKey;
    return !!key && this.plugin.settings.sessionMute[key] === true;
  }

  /** Promotes this Obsidian draft leaf to a normal server-backed session leaf. */
  private async promoteDraftView(sessionId: string, sessionTitle?: string): Promise<void> {
    await this.leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { sessionId, sessionTitle }, active: true });
  }

  /** Extracts the user-facing session title used by the native Obsidian tab and view header. */
  private sessionTitleFromSession(session: JsonObject): string {
    return jsonHelpers.readString(session, ["title", "name", "slug"]) ?? this.model.sessionId ?? "OpenCode session";
  }

  /** Applies a renamed title to this open view; referenced by OpenCodePlugin.renameSession and session events. */
  applySessionTitle(title: string): void {
    this.model.sessionTitle = title;
    if (this.model.currentSession) this.model.currentSession.title = title;
    this.refreshLeafTitle();
  }

  /** Re-renders the mounted Session Island after its context/todo display settings change. */
  refreshSessionIsland(): void {
    this.island.refreshDisplay();
  }

  /** Re-renders effective/inherited auto-accept chrome after a policy mutation. */
  refreshSessionAutoApproveState(): void {
    this.docks.refresh();
    void this.composer.refresh();
    this.island.refreshChrome();
  }

  /** Returns whether the active Session Island has more than one present tab. */
  canCycleSessionIslandTabs(): boolean {
    return this.island.canCycleTabs();
  }

  /** Selects the next present Session Island tab; referenced by the plugin command. */
  cycleSessionIslandTab(): void {
    this.island.cycleTab();
  }

  /** Reads the workspace directory used for directory-scoped agent and prompt APIs. */
  private sessionDirectoryFromSession(session: JsonObject): string | undefined {
    return jsonHelpers.readString(session, ["directory", "cwd"]);
  }

  /** Requests Obsidian to re-read getDisplayText after the async session title loads. */
  private refreshLeafTitle(): void {
    const title = this.getDisplayText();
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    const parent = this.leaf.parent as unknown as { updateHeader?: () => void };
    leaf.updateHeader?.();
    parent.updateHeader?.();
    this.containerEl.closest(".workspace-leaf")?.querySelector(".view-header-title")?.replaceChildren(title);
    this.app.workspace.trigger("layout-change");
    this.decorateSessionHeader();
    this.bindNativeTitleRename();
  }

  /** Binds click-to-rename to Obsidian's native view header title without duplicate listeners. */
  private bindNativeTitleRename(): void {
    const title = this.containerEl.closest(".workspace-leaf")?.querySelector<HTMLElement>(".view-header-title") ?? undefined;
    if (title === this.nativeTitleEl) return;
    this.nativeTitleEl?.removeEventListener("click", this.handleNativeTitleClick);
    this.nativeTitleEl = title;
    this.nativeTitleEl?.addEventListener("click", this.handleNativeTitleClick);
  }

  /** Starts inline rename when the native Obsidian title is clicked. */
  private handleNativeTitleClick = (event: MouseEvent): void => {
    if (!this.nativeTitleEl || event.target instanceof HTMLInputElement) return;
    this.beginInlineTitleRename(this.nativeTitleEl);
  };

  /** Replaces a title handle with an inline editor that saves on Enter/blur and cancels on Escape. */
  private beginInlineTitleRename(container: HTMLElement): void {
    if (!this.model.sessionId || container.querySelector("input")) return;
    const original = this.getDisplayText();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "view-header-title-input";
    input.value = original;
    container.replaceChildren(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async (save: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (!save || !next || next === original) {
        this.applySessionTitle(original);
        return;
      }
      input.disabled = true;
      try {
        await this.plugin.renameSession(this.model.sessionId!, next, this.model.sessionDirectory);
      } catch (error) {
        this.applySessionTitle(original);
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

  /** Applies the current status to native tab and view-header icons. */
  private decorateSessionHeader(): void {
    const status = this.sessionVisualStatus();
    const animation = normalizeWorkingAnimation(this.plugin.settings.workingAnimation);
    const headerIcon = this.containerEl.querySelector<HTMLElement>(".view-header-icon");
    if (headerIcon) {
      headerIcon.dataset.opencodeSessionState = status;
      headerIcon.dataset.workingAnimation = animation;
    }
    const leaf = this.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement | null };
    const tabIcon = leaf.tabHeaderEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
    if (tabIcon) {
      tabIcon.dataset.opencodeSessionState = status;
      tabIcon.dataset.workingAnimation = animation;
    }
  }

  /** Removes plugin status attributes from native chrome before Obsidian reuses the leaf. */
  private clearSessionHeaderDecoration(): void {
    const headerIcon = this.containerEl.querySelector<HTMLElement>(".view-header-icon");
    headerIcon?.removeAttribute("data-opencode-session-state");
    headerIcon?.removeAttribute("data-working-animation");
    const leaf = this.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement | null };
    const tabIcon = leaf.tabHeaderEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
    tabIcon?.removeAttribute("data-opencode-session-state");
    tabIcon?.removeAttribute("data-working-animation");
  }

}
