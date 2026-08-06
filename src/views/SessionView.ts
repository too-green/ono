import { ItemView, Menu, Notice, WorkspaceLeaf, type ViewStateResult, setIcon } from "obsidian";
import type OpenCodePlugin from "../../main";
import type { DiffPanelContext } from "./DiffPanelView";
import { DELETE_CURRENT_FILE_COMMANDS, RENAME_CURRENT_FILE_COMMANDS, matchesObsidianCommandHotkey } from "../obsidian-hotkeys";
import { diffFilesFromUnifiedPatch, type DiffFileSummary } from "../diff-utils";
import { confirmSessionRewind } from "../session-actions";
import { logServiceError } from "../services/opencode-http";
import type { JsonObject, OpenCodeMessageBundle, OpenCodeMessagePage } from "../services/opencode-types";
import { isActiveSessionStatus, normalizeWorkingAnimation, visualStatusForSession, type SessionVisualStatus } from "../session-state";
import * as jsonHelpers from "./session/json-helpers";
import * as messageHelpers from "./session/message-helpers";
import { SessionViewModel } from "./session/session-view-model";
import { ScrollController } from "./session/scroll-controller";
import { RequestDocksController } from "./session/request-docks";
import { SlashMenuController } from "./session/composer/slash-menu";
import { ModelVariantsController } from "./session/composer/model-variants";
import { ComposerController } from "./session/composer/composer-controller";
import type { DomEventRegistrar } from "./session/dom-registrar";
import { MarkdownPatcher } from "./session/streaming/markdown-patcher";
import { StreamController } from "./session/streaming/stream-controller";
import { TimelineRenderer } from "./session/streaming/timeline-renderer";

export const VIEW_TYPE_OPENCODE_SESSION = "opencode-session";

const INITIAL_MESSAGE_LIMIT = 30;
const OLDER_MESSAGE_LIMIT = 100;

interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
  draftId?: string;
  draftDirectory?: string;
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
  private stream!: StreamController;
  private sessionBindingVersion = 0;
  private canonicalRequestVersion = 0;
  private loadingSessionId?: string;
  private nativeTitleEl?: HTMLElement;

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
      onNearTop: () => {
        void this.loadOlderMessages();
      },
      onUnreadChange: (unread) => this.setSessionUnread(unread),
    });
    this.markdownPatcher = new MarkdownPatcher({
      contentEl: this.contentEl,
      component: this,
      getSessionId: () => this.model.sessionId,
      shouldFollowLatest: () => this.scroll.shouldFollowLatest(),
      scrollToBottom: (smooth) => this.scroll.scrollToBottom(smooth),
      updateJumpButton: () => this.scroll.updateJumpButton(),
    });
    this.timeline = new TimelineRenderer({
      app: this.app,
      component: this,
      contentEl: this.contentEl,
      model: this.model,
      getShowReasoningBlocks: () => this.plugin.settings.showReasoningBlocks,
      getGroupContextTools: () => this.plugin.settings.groupContextTools,
      getBindingVersion: () => this.sessionBindingVersion,
      isCurrentBinding: (sessionId, bindingVersion) => this.isCurrentSessionBinding(sessionId, bindingVersion),
      getRevertMessageId: () => this.revertMessageId(),
      requestShellRender: async () => {
        if (this.model.currentSession) await this.renderSession(this.model.currentSession, this.model.loadedMessages, { initialLoad: false });
      },
      shouldFollowLatest: () => this.scroll.shouldFollowLatest(),
      markProgrammaticScroll: (durationMs) => this.scroll.markProgrammaticScroll(durationMs),
      scrollToBottom: (smooth) => this.scroll.scrollToBottom(smooth),
      updateJumpButton: () => this.scroll.updateJumpButton(),
      onFork: (messageId) => void this.forkCurrentSession(messageId),
      onRewind: (bundle) => void this.requestMessageRewind(bundle),
      onRedo: () => void this.redoSessionRewind(),
    });
    this.stream = new StreamController({
      model: this.model,
      subscribeToEvents: (handlers, directory) => this.plugin.requireOpenCodeService().subscribeToEvents(handlers, directory),
      findStreamingPartTarget: (messageId, partId, type) => this.markdownPatcher.findPartTarget(messageId, partId, type),
      queueStreamingMarkdownPatch: (key, element, markdown) => this.markdownPatcher.queue(key, element, markdown),
      shouldFollowLatest: () => this.scroll.shouldFollowLatest(),
      extendFollowLatest: (durationMs) => this.scroll.extendFollowLatest(durationMs),
      scrollToBottom: (smooth) => this.scroll.scrollToBottom(smooth),
      updateJumpButton: () => this.scroll.updateJumpButton(),
      onSessionUpdated: (session) => this.applySessionUpdate(session),
      onSessionDiff: (diffs) => {
        this.model.revertDiffFiles = diffs;
      },
      onStatusChange: (status) => this.applySessionStatus(status, true),
      onPermissionAsked: (request) => this.docks.ingestPermissionAsked(request),
      onPermissionReplied: (requestId) => this.docks.ingestPermissionReplied(requestId),
      onQuestionAsked: (request) => this.docks.ingestQuestionAsked(request),
      onQuestionSettled: (requestId) => this.docks.ingestQuestionReplied(requestId),
      requestTimelineRender: () => this.timeline.renderStreaming(),
      requestDiffPanelRefresh: (force) => this.plugin.updateDiffPanelContext(this.diffPanelContext(), force ? { force: true } : undefined),
      requestComposerProgressRefresh: () => this.composer.updateProgressBar(),
      requestCanonicalSync: () => this.syncCanonicalMessages(),
    });
    this.docks = new RequestDocksController({
      plugin: this.plugin,
      model: this.model,
      onChanged: () => this.onRequestDocksChanged(),
    });
    this.slash = new SlashMenuController({
      model: this.model,
      onResizeInput: (textarea) => this.composer.resizeComposerInput(textarea),
      onScheduleDraftSave: () => this.composer.scheduleDraftSave(),
    });
    this.variants = new ModelVariantsController({
      plugin: this.plugin,
      model: this.model,
      requestRefresh: () => this.composer.refresh(),
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
      mountDocks: (container) => this.docks.mount(container),
      isComposerBlocked: () => this.docks.isComposerBlocked(),
      shouldAutoApprove: () => this.docks.shouldAutoApprove(),
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
        return this.workingTabIcon();
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
    this.registerDomEvent(window, "keydown", this.handleNativeSessionHotkeys, { capture: true });
    // Body-attached popovers (slash menu, model menu) survive tab switches because they live outside `contentEl`.
    // Hide them when this leaf loses focus so they don't float over a different session's view.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf !== this.leaf) {
        this.slash.hide();
        this.variants.hideModelMenu();
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
    this.markdownPatcher.dispose();
    this.nativeTitleEl?.removeEventListener("click", this.handleNativeTitleClick);
    this.nativeTitleEl = undefined;
    this.docks.dispose();
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
      await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true });
    } catch (error) {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion)) this.renderError(error);
    } finally {
      if (this.isCurrentSessionBinding(sessionId, bindingVersion) && this.loadingSessionId === sessionId) this.loadingSessionId = undefined;
    }
  }

  /** Clears cursor/page state when the view is rebound to another session. */
  private resetTimelineState(options: { preserveSubmission?: boolean } = {}): void {
    const submittingPrompt = options.preserveSubmission === true && this.model.submittingPrompt;
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
    this.model.loadingOlder = false;
    this.model.pendingPermissions = [];
    this.model.pendingQuestions = [];
    this.model.queuedMessageIds.clear();
    this.model.pendingQueuedUserMessages = 0;
    this.scroll.clearJumpButtonReference();
    if (!submittingPrompt) this.scroll.disableFollowLatest();
  }

  /** Returns whether an async load still belongs to the session currently bound to this view. */
  private isCurrentSessionBinding(sessionId: string, bindingVersion: number): boolean {
    return this.model.sessionId === sessionId && this.sessionBindingVersion === bindingVersion;
  }

  /** Returns the active session identity for the right-sidebar diff panel and plugin focus listener. */
  diffPanelContext(): DiffPanelContext {
    return { sessionId: this.model.sessionId, sessionTitle: this.model.sessionTitle, sessionDirectory: this.model.sessionDirectory };
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
      await this.plugin.updateDiffPanelContext(this.diffPanelContext());
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
    const [agents, models, commands, config, permissions, questions, statuses] = await Promise.all([
      service.listAgents(directory),
      service.listModels(directory).catch(logServiceError([], "listModels", directory)),
      service.listCommands(directory).catch(logServiceError([], "listCommands", directory)),
      service.getConfig().catch(logServiceError({}, "getConfig", directory)),
      service.listPermissionRequests(directory).catch(logServiceError([], "listPermissionRequests", directory)),
      service.listQuestionRequests(directory).catch(logServiceError([], "listQuestionRequests", directory)),
      service.getSessionStatus().catch(logServiceError({}, "getSessionStatus", directory)),
    ]);
    if (!isCurrentRequest()) return undefined;

    this.model.availableAgents = agents;
    this.model.availableModels = models;
    this.model.availableCommands = commands;
    this.model.serverConfig = config;
    this.model.pendingPermissions = permissions.filter((item) => item.sessionID === sessionId);
    this.model.pendingQuestions = questions.filter((item) => item.sessionID === sessionId);
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
    await this.docks.autoApprovePending();
    return isCurrentRequest() ? session : undefined;
  }

  /** Hydrates canonical session identity and chrome state without rebuilding the shell. */
  private applyCanonicalSession(session: JsonObject): void {
    this.model.currentSession = session;
    this.model.revertDiffFiles = this.revertDiffFilesFromSession(session);
    this.model.sessionTitle = this.sessionTitleFromSession(session);
    this.model.sessionDirectory = this.sessionDirectoryFromSession(session);
    this.stream.subscribe(this.model.sessionDirectory);
    this.model.selectedAgent = this.variants.resolveAgentForSession(session);
    this.model.selectedModel = this.variants.resolveModelForSession(session, this.model.selectedAgent);
    this.model.renderedSessionId = this.model.sessionId;
    this.contentEl.querySelector<HTMLElement>(".opencode-session-view__title")?.setText(this.model.sessionTitle);
    this.refreshLeafTitle();
    this.composer.updateInsetSoon();
  }

  /** Applies streamed session identity updates through the same chrome boundary as canonical refreshes. */
  private applySessionUpdate(session: JsonObject): void {
    this.canonicalRequestVersion += 1;
    this.applyCanonicalSession(session);
    void this.plugin.updateDiffPanelContext(this.diffPanelContext());
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

    if (fromEvent && nextType === "idle") {
      this.model.queuedMessageIds.clear();
      this.model.pendingQueuedUserMessages = 0;
      this.stream.scheduleCanonicalSync(120);
      this.scroll.releaseFollowLatestAfterIdle();
    }
    if (wasBusy && !isBusy && this.model.sessionId) this.setSessionUnread(true);
    if (this.model.sessionId) this.plugin.notifySessionStatusChanged(this.model.sessionId, nextType);
    this.refreshSessionStateIndicator();
    if (wasBusy !== isBusy) void this.composer.refresh();
  }

  /** Returns the visual state shared by the session tab and its in-view indicator. */
  private sessionVisualStatus(): SessionVisualStatus {
    if (this.model.pendingPermissions.length > 0 || this.model.pendingQuestions.length > 0) return "attention";
    return visualStatusForSession(this.model.sessionStatusType, this.model.sessionId ? this.plugin.settings.sessionUnread[this.model.sessionId] === true : false);
  }

  /** Selects a tab icon that also exposes the configured working animation to CSS. */
  private workingTabIcon(): string {
    switch (normalizeWorkingAnimation(this.plugin.settings.workingAnimation)) {
      case "W1":
        return "circle-dot";
      case "W2":
        return "loader-circle";
      case "W4":
        return "sparkles";
      default:
        return "ellipsis";
    }
  }

  /** Updates the tab/header icon and the mounted in-view state indicator after status changes. */
  private refreshSessionStateIndicator(): void {
    const status = this.sessionVisualStatus();
    const animation = normalizeWorkingAnimation(this.plugin.settings.workingAnimation);
    this.contentEl.dataset.sessionState = status;
    this.contentEl.dataset.workingAnimation = animation;
    const indicator = this.contentEl.querySelector<HTMLElement>(".opencode-session-view__state-indicator");
    if (indicator) this.paintSessionStateIndicator(indicator, status, animation);
    this.refreshLeafTitle();
  }

  /** Paints one session state indicator without rebuilding the surrounding session view. */
  private paintSessionStateIndicator(container: HTMLElement, status: SessionVisualStatus, animation: string): void {
    container.empty();
    container.className = `opencode-session-view__state-indicator opencode-session-view__state-indicator--${status}`;
    container.dataset.workingAnimation = animation;
    if (status === "attention") setIcon(container, "megaphone");
    if (status === "error") setIcon(container, "alert-circle");
    if (status === "retry") setIcon(container, "rotate-cw");
    if (status === "done") container.createSpan();
    if (status === "working") {
      if (animation === "W2") container.createSpan({ cls: "opencode-session-view__state-spinner" });
      else if (animation === "W3") {
        container.createSpan();
        container.createSpan();
        container.createSpan();
      } else container.createSpan();
    }
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
      const header = shell.createDiv({ cls: "opencode-session-view__header" });
      const titleWrap = header.createDiv({ cls: "opencode-session-view__title-wrap" });
      titleWrap.createDiv({ text: "New session", cls: "opencode-session-view__title" });
      titleWrap.createDiv({ text: directory, cls: "opencode-session-view__subtitle" });
      const body = shell.createDiv({ cls: "opencode-session-view__draft-body" });
      body.createDiv({ text: "What would you like to work on?", cls: "opencode-session-view__draft-title" });
      this.composer.mount(shell, {}, true);
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

  /** Renders session chrome and the currently loaded page window using Obsidian's MarkdownRenderer. */
  private async renderSession(session: JsonObject, messages: OpenCodeMessageBundle[], options: { initialLoad: boolean }): Promise<void> {
    const sessionId = this.model.sessionId;
    const bindingVersion = this.sessionBindingVersion;
    const previousTop = this.contentEl.scrollTop;
    const wasAtBottom = this.scroll.shouldFollowLatest();
    const composerState = this.composer.captureDomState();
    this.composer.persistDraft();
    if (wasAtBottom) this.scroll.markProgrammaticScroll(1600);
    this.slash.hide();
    this.variants.hideModelMenu();
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "opencode-session-view__shell" });
    this.renderHeader(shell, session);

    const timeline = shell.createDiv({ cls: "opencode-session-view__timeline" });
    const visibleMessageCount = await this.timeline.renderInto(timeline, messages);

    if (!sessionId || !this.isCurrentSessionBinding(sessionId, bindingVersion) || !shell.isConnected) return;

    this.composer.mount(shell, session, options.initialLoad && visibleMessageCount === 0);
    this.composer.restoreDomState(composerState);
    this.scroll.renderJumpToBottomButton();
    this.scroll.bindScrollListener();
    await this.scroll.restoreScrollAfterRender(options.initialLoad, previousTop, wasAtBottom);
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
      this.refreshSessionStateIndicator();
      void this.plugin.refreshAgentPanels({ showLoading: false });
    });
  }

  /** Renders the fixed session header with refresh and copy-id actions. */
  private renderHeader(container: HTMLElement, session: JsonObject): void {
    const header = container.createDiv({ cls: "opencode-session-view__header" });
    const titleWrap = header.createDiv({ cls: "opencode-session-view__title-wrap" });
    const titleLine = titleWrap.createDiv({ cls: "opencode-session-view__title-line" });
    const indicator = titleLine.createDiv({ cls: "opencode-session-view__state-indicator" });
    this.paintSessionStateIndicator(indicator, this.sessionVisualStatus(), normalizeWorkingAnimation(this.plugin.settings.workingAnimation));
    const title = titleLine.createDiv({ text: this.sessionTitleFromSession(session), cls: "opencode-session-view__title" });
    title.title = "Rename session";
    title.addEventListener("click", () => this.beginInlineTitleRename(title));
    titleWrap.createDiv({ text: this.model.sessionId ?? "", cls: "opencode-session-view__subtitle" });

    const actions = header.createDiv({ cls: "opencode-session-view__actions" });
    const copy = actions.createEl("button", { attr: { "aria-label": "Copy session ID" }, cls: "clickable-icon" });
    setIcon(copy, "copy");
    copy.addEventListener("click", () => void this.copySessionId());
    const refresh = actions.createEl("button", { attr: { "aria-label": "Refresh session" }, cls: "clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  /** Refreshes indicator, composer disabled state, composer inset, and scroll after the docks controller re-renders. */
  private onRequestDocksChanged(): void {
    this.refreshSessionStateIndicator();
    this.composer.onDocksChanged();
    if (this.scroll.isNearBottom()) this.scroll.scrollToBottom(false);
  }

  /** Toggles client-side auto-approval and immediately clears existing permission docks when enabled. */
  private async toggleAutoApprove(): Promise<void> {
    const key = this.model.composerStorageKey;
    if (!key) return;
    const enabled = !this.docks.shouldAutoApprove();
    await this.plugin.rememberSessionAutoApprove(key, enabled);
    if (enabled) await this.docks.autoApprovePending();
    await this.composer.refresh();
  }

  /** Toggles local notification muting for the current session/draft. */
  private async toggleMute(): Promise<void> {
    const key = this.model.composerStorageKey;
    if (!key) return;
    await this.plugin.rememberSessionMute(key, !this.isSessionMuted());
    await this.composer.refresh();
  }

  /** Forks the current session and opens the resulting session tab. */
  private async forkCurrentSession(messageId?: string): Promise<void> {
    if (!this.model.sessionId) return;
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
    await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true }).catch((error) => console.warn("[opencode-plugin:rewind] diff panel refresh failed", error));
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
    await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true }).catch((error) => console.warn("[opencode-plugin:rewind] diff panel refresh failed", error));
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
    if (target?.closest(".view-header-title-input, .opencode-session-view__title-input, .modal")) return;
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
    await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true });
  }

  /** Extracts the user-facing session title used by the Obsidian tab and in-view header. */
  private sessionTitleFromSession(session: JsonObject): string {
    return jsonHelpers.readString(session, ["title", "name", "slug"]) ?? this.model.sessionId ?? "OpenCode session";
  }

  /** Applies a renamed title to this open view; referenced by OpenCodePlugin.renameSession and session events. */
  applySessionTitle(title: string): void {
    this.model.sessionTitle = title;
    if (this.model.currentSession) this.model.currentSession.title = title;
    const mountedTitle = this.contentEl.querySelector<HTMLElement>(".opencode-session-view__title");
    if (mountedTitle) mountedTitle.setText(title);
    this.refreshLeafTitle();
    void this.plugin.updateDiffPanelContext(this.diffPanelContext());
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
    this.beginInlineTitleRename(this.nativeTitleEl, true);
  };

  /** Replaces a title handle with an inline editor that saves on Enter/blur and cancels on Escape. */
  private beginInlineTitleRename(container: HTMLElement, native = false): void {
    if (!this.model.sessionId || container.querySelector("input")) return;
    const original = this.getDisplayText();
    const input = document.createElement("input");
    input.type = "text";
    input.className = native ? "view-header-title-input" : "opencode-session-view__title-input";
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

  /** Applies status data attributes to the native view header icon for CSS animation. */
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

  /** Copies the active session id to clipboard for debugging and API testing. */
  private async copySessionId(): Promise<void> {
    if (!this.model.sessionId) return;
    await navigator.clipboard.writeText(this.model.sessionId);
    new Notice(`Copied session ID: ${this.model.sessionId}`);
  }

}
