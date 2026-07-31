import { ItemView, MarkdownRenderer, Menu, Modal, Notice, Platform, WorkspaceLeaf, type ViewStateResult, setIcon } from "obsidian";
import { pathToFileURL } from "url";
import type OpenCodePlugin from "../../main";
import type { DiffPanelContext } from "./DiffPanelView";
import { ModelSelectionMenu, type ModelEntry } from "./ModelSelectionMenu";
import type { OpenCodeEventSubscription } from "../services/opencode-events";
import { logServiceError } from "../services/opencode-http";
import type { JsonObject, OpenCodeEvent, OpenCodeMessageBundle, OpenCodeModelRef, OpenCodePermissionReply, OpenCodePermissionRequest, OpenCodeQuestionAnswer, OpenCodeQuestionRequest } from "../services/opencode-types";
import { isActiveSessionStatus, normalizeWorkingAnimation, visualStatusForSession, type SessionVisualStatus } from "../session-state";
import { setProviderIcon } from "../utils/provider-icons";

export const VIEW_TYPE_OPENCODE_SESSION = "opencode-session";

const CONTEXT_TOOLS = new Set(["read", "read_file", "glob", "grep", "list"]);
const PRIMARY_ARG_KEYS = ["description", "query", "path", "filePath", "filepath", "pattern", "name", "command"];
const INITIAL_MESSAGE_LIMIT = 30;
const OLDER_MESSAGE_LIMIT = 100;
const LOAD_OLDER_THRESHOLD_PX = 320;
const BOTTOM_THRESHOLD_PX = 220;
type MessageRenderKind = "none" | "user" | "assistant-text" | "assistant-compact" | "assistant-mixed";

/** All possible built-in functional slash commands. Visibility is filtered per-session by visibleBuiltinCommands(). */
const ALL_BUILTIN_COMMANDS: { name: string; description: string }[] = [
  { name: "compact", description: "Compact session context into a summary" },
  { name: "undo", description: "Undo the last message pair" },
  { name: "redo", description: "Redo the last undone message pair" },
  { name: "fork", description: "Fork the session from the latest message" },
  { name: "share", description: "Share the session" },
  { name: "unshare", description: "Unshare the session" },
];

interface ImageAttachment {
  url: string;
  name: string;
  mime?: string;
}

interface MessageRenderOptions {
  showAssistantMeta: boolean;
  assistantTurnText: string;
}

interface ComposerDomState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
}

interface AppliedPartDelta {
  messageId: string;
  partId: string;
  field: string;
  part: JsonObject;
}

interface StreamingMarkdownPatch {
  element: HTMLElement;
  markdown: string;
  frame?: number;
  inFlight: boolean;
  pending: boolean;
}

interface ElectronOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface ElectronDialogBridge {
  showOpenDialog(options: { properties: string[] }): Promise<ElectronOpenDialogResult>;
  showOpenDialog(window: unknown, options: { properties: string[] }): Promise<ElectronOpenDialogResult>;
}

interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
  draftId?: string;
  draftDirectory?: string;
}

/** Renders one OpenCode session in an Obsidian tab; opened from AgentPanelView session rows. */
export class SessionView extends ItemView {
  private sessionId?: string;
  private sessionTitle?: string;
  private sessionDirectory?: string;
  private draftId?: string;
  private draftDirectory?: string;
  private loading = false;
  private loadingOlder = false;
  private loadedMessages: OpenCodeMessageBundle[] = [];
  private currentSession?: JsonObject;
  private olderCursor?: string;
  private historyComplete = true;
  private renderedSessionId?: string;
  private jumpButton?: HTMLButtonElement;
  private scrollBound = false;
  private refreshTimer?: number;
  private streamingRenderFrame?: number;
  private streamingRenderInFlight = false;
  private streamingRenderPending = false;
  private followLatest = false;
  private followLatestFrame?: number;
  private followLatestUntil = 0;
  private followLatestReleaseTimer?: number;
  private programmaticScrollUntil = 0;
  private scrollSaveTimer?: number;
  private draftSaveTimer?: number;
  private eventSubscription?: OpenCodeEventSubscription;
  private eventSubscriptionDirectory?: string;
  private streamingMarkdownPatches = new Map<string, StreamingMarkdownPatch>();
  private composerTextarea?: HTMLTextAreaElement;
  private selectedAgent?: string;
  private selectedModel?: OpenCodeModelRef;
  private availableAgents: JsonObject[] = [];
  private availableModels: JsonObject[] = [];
  private modelMenuInstance: ModelSelectionMenu | null = null;
  private availableCommands: JsonObject[] = [];
  private serverConfig: JsonObject | undefined;
  private pendingPermissions: OpenCodePermissionRequest[] = [];
  private pendingQuestions: OpenCodeQuestionRequest[] = [];
  private respondingRequestIds = new Set<string>();
  private requestDockEl?: HTMLElement;
  private composerEl?: HTMLElement;
  private composerSlashMenuEl?: HTMLElement;
  private slashMenuHighlight = -1;
  private slashMenuRows: HTMLElement[] = [];
  private slashMenuOutsideClick?: (event: MouseEvent) => void;
  private queuedMessageIds = new Set<string>();
  private pendingQueuedUserMessages = 0;
  private submittingPrompt = false;
  private sessionBusy = false;
  private sessionStatusType = "idle";
  private abortingSession = false;
  private pendingInterruptConfirm = false;
  private interruptConfirmTimer?: number;
  private historyIndex = -1;
  private composerProgressBarEl?: HTMLElement;
  private composerProgressTrackEl?: HTMLElement;
  private composerProgressFillEl?: HTMLElement;
  private readonly composerProgressMarkers: HTMLElement[] = [];

  /** Checkpoint tuples: (bar-fraction, absolute-context, color?). Color defaults to accent. Context optional on last tuple (defaults to model limit). */
  private static readonly PROGRESS_CHECKPOINTS: readonly { fraction: number; context?: number; color?: string }[] = [
    { fraction: 0.5, context: 100_000 },
    { fraction: 0.75, context: 250_000, color: "var(--color-yellow)" },
    { fraction: 1.0, color: "var(--color-red)" },
  ];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenCodePlugin,
  ) {
    super(leaf);
  }

  /** Returns the stable Obsidian view type used by plugin registration. */
  getViewType(): string {
    return VIEW_TYPE_OPENCODE_SESSION;
  }

  /** Returns the tab title for this OpenCode session. */
  getDisplayText(): string {
    return this.sessionTitle ?? this.sessionId ?? (this.draftId ? "New session" : "OpenCode session");
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

  /** Restores persisted view state when Obsidian reopens this custom tab. */
  getState(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      sessionTitle: this.sessionTitle,
      draftId: this.draftId,
      draftDirectory: this.draftDirectory,
    };
  }

  /** Applies a new session id and reloads the view; referenced by OpenCodePlugin.openSessionTab. */
  async setState(state: SessionViewState, _result: ViewStateResult): Promise<void> {
    this.persistComposerDraft();
    this.sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
    this.sessionTitle = typeof state.sessionTitle === "string" ? state.sessionTitle : undefined;
    this.draftId = typeof state.draftId === "string" ? state.draftId : undefined;
    this.draftDirectory = typeof state.draftDirectory === "string" ? state.draftDirectory : undefined;
    this.refreshLeafTitle();
    await this.refresh();
  }

  /** Initializes live refresh for the session tab. */
  async onOpen(): Promise<void> {
    this.contentEl.addClass("opencode-session-view");
    this.containerEl.addClass("opencode-session-view-container");
    this.registerDomEvent(window, "keydown", this.handleGlobalComposerSend, { capture: true });
    await this.refresh();
  }

  /** Releases event streams and timers when the tab closes. */
  async onClose(): Promise<void> {
    this.modelMenuInstance?.close();
    this.modelMenuInstance = null;
    this.hideSlashMenu();
    this.eventSubscription?.close();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.streamingRenderFrame !== undefined) window.cancelAnimationFrame(this.streamingRenderFrame);
    if (this.followLatestFrame !== undefined) window.cancelAnimationFrame(this.followLatestFrame);
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.cancelStreamingMarkdownPatches();
    if (this.scrollSaveTimer) window.clearTimeout(this.scrollSaveTimer);
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
    this.streamingRenderFrame = undefined;
    this.streamingRenderPending = false;
    this.followLatestFrame = undefined;
    this.followLatestReleaseTimer = undefined;
    this.persistComposerDraft();
    this.persistScrollState();
  }

  /** Reloads session data; initial/manual loads rebuild the shell, while active-session refreshes reconcile incrementally. */
  async refresh(): Promise<void> {
    if (this.loading) return;
    if (!this.sessionId) {
      this.resetTimelineState();
      if (this.draftId && this.draftDirectory) await this.renderDraftSession();
      else this.renderEmpty();
      return;
    }

    const initialLoad = this.renderedSessionId !== this.sessionId;
    if (initialLoad) this.resetTimelineState();
    this.loading = true;
    if (initialLoad) this.renderLoading();
    try {
      const service = this.plugin.requireOpenCodeService();
      const [session, page] = await Promise.all([
        service.getSession(this.sessionId),
        service.listMessagePage(this.sessionId, { limit: INITIAL_MESSAGE_LIMIT, order: "desc" }),
      ]);
      this.loadedMessages = this.mergeMessages(this.loadedMessages, page.messages);
      if (!this.olderCursor) this.olderCursor = page.olderCursor;
      this.historyComplete = page.complete && !this.olderCursor;
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
      this.availableAgents = agents;
      this.availableModels = models;
      this.availableCommands = commands;
      this.serverConfig = config;
      this.pendingPermissions = permissions.filter((item) => item.sessionID === this.sessionId);
      this.pendingQuestions = questions.filter((item) => item.sessionID === this.sessionId);
      await this.autoApprovePendingPermissions();
      this.currentSession = session;
      this.applySessionStatusSnapshot(statuses);

      if (initialLoad) {
        await this.renderSession(session, this.loadedMessages, { initialLoad });
      } else if (!this.contentEl.querySelector(".opencode-session-view__shell")) {
        await this.renderSession(session, this.loadedMessages, { initialLoad: false });
      } else {
        this.applySessionChromeState(session);
        this.refreshRequestDocks();
        await this.reconcileTimelineAppendOnly(this.loadedMessages);
      }
      await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true });
    } catch (error) {
      this.renderError(error);
    } finally {
      this.loading = false;
    }
  }

  /** Clears cursor/page state when the view is rebound to another session. */
  private resetTimelineState(): void {
    this.loadedMessages = [];
    this.olderCursor = undefined;
    this.historyComplete = true;
    this.renderedSessionId = undefined;
    this.currentSession = undefined;
    this.sessionStatusType = "idle";
    this.jumpButton = undefined;
    if (!this.submittingPrompt) this.disableFollowLatest();
  }

  /** Returns the active session identity for the right-sidebar diff panel and plugin focus listener. */
  diffPanelContext(): DiffPanelContext {
    return { sessionId: this.sessionId, sessionTitle: this.sessionTitle, sessionDirectory: this.sessionDirectory };
  }

  /** Subscribes to OpenCode events for this session's directory-scoped instance. */
  private subscribeToServerEvents(directory: string | undefined): void {
    if (this.eventSubscriptionDirectory === directory && this.eventSubscription) return;
    this.eventSubscription?.close();
    this.eventSubscriptionDirectory = directory;
    this.eventSubscription = this.plugin.requireOpenCodeService().subscribeToEvents({
      onEvent: (event) => {
        if (!this.eventReferencesCurrentSession(event.properties)) return;
        this.applyStreamingEvent(event);
      },
    }, directory);
  }

  /** Reconciles OpenCode message/part/session events into the mounted timeline during generation. */
  private applyStreamingEvent(event: OpenCodeEvent): void {
    const properties = event.properties;
    if (!properties) return;
    console.debug("[opencode-plugin:session-stream] applying", { sessionId: this.sessionId, type: event.type, properties });
    if (this.followLatest && (event.type.startsWith("message.") || event.type === "session.updated" || event.type === "session.status")) this.extendFollowLatest(1600);
    if (event.type === "message.updated") {
      const info = this.readObject(properties, "info");
      if (info) this.upsertStreamingMessage(info);
      this.scheduleStreamingRender();
      return;
    }
    if (event.type === "message.part.updated") {
      const part = this.readObject(properties, "part");
      if (part) this.upsertStreamingPart(part);
      this.scheduleStreamingRender();
      return;
    }
    if (event.type === "message.part.delta") {
      const applied = this.applyPartDelta(properties);
      if (applied && this.patchStreamingPart(applied)) return;
      this.scheduleStreamingRender();
      return;
    }
    if (event.type === "session.updated") {
      const info = this.readObject(properties, "info");
      if (info) {
        this.currentSession = info;
        this.sessionTitle = this.sessionTitleFromSession(info);
        this.sessionDirectory = this.sessionDirectoryFromSession(info);
        this.refreshLeafTitle();
      }
      this.scheduleStreamingRender();
      return;
    }
    if (event.type === "session.diff") {
      void this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true });
      return;
    }
    if (event.type === "session.status") {
      const status = this.readObject(properties, "status");
      if (status) this.applySessionStatus(status, true);
      return;
    }
    if (event.type === "permission.asked") {
      const request = properties as OpenCodePermissionRequest;
      if (this.shouldAutoApprovePermissions()) {
        void this.autoReplyPermission(request);
        return;
      }
      this.upsertPendingPermission(request);
      this.refreshRequestDocks();
      return;
    }
    if (event.type === "permission.replied") {
      this.removePendingRequest(this.readString(properties, ["requestID", "requestId", "id"]));
      this.refreshRequestDocks();
      return;
    }
    if (event.type === "question.asked") {
      this.upsertPendingQuestion(properties as OpenCodeQuestionRequest);
      this.refreshRequestDocks();
      return;
    }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      this.removePendingRequest(this.readString(properties, ["requestID", "requestId", "id"]));
      this.refreshRequestDocks();
    }
  }

  /** Adds or replaces one pending permission request from the event stream. */
  private upsertPendingPermission(request: OpenCodePermissionRequest): void {
    if (!request.id || request.sessionID !== this.sessionId) return;
    const index = this.pendingPermissions.findIndex((item) => item.id === request.id);
    if (index >= 0) this.pendingPermissions[index] = request;
    else this.pendingPermissions.push(request);
  }

  /** Adds or replaces one pending question request from the event stream. */
  private upsertPendingQuestion(request: OpenCodeQuestionRequest): void {
    if (!request.id || request.sessionID !== this.sessionId) return;
    const index = this.pendingQuestions.findIndex((item) => item.id === request.id);
    if (index >= 0) this.pendingQuestions[index] = request;
    else this.pendingQuestions.push(request);
  }

  /** Removes any settled permission/question request by id. */
  private removePendingRequest(requestId: string | undefined): void {
    if (!requestId) return;
    this.pendingPermissions = this.pendingPermissions.filter((item) => item.id !== requestId);
    this.pendingQuestions = this.pendingQuestions.filter((item) => item.id !== requestId);
    this.respondingRequestIds.delete(requestId);
  }

  /** Inserts or replaces one streamed message while preserving already received parts. */
  private upsertStreamingMessage(info: JsonObject): void {
    const id = this.readString(info, ["id", "messageID", "messageId"]);
    if (!id) return;
    const role = this.readString(info, ["role"]);
    const index = this.loadedMessages.findIndex((bundle) => this.messageId(bundle) === id);
    const isNew = index < 0;
    if (index >= 0) this.loadedMessages[index] = { ...this.loadedMessages[index], info };
    else this.loadedMessages.push({ info, parts: [] });
    // Mark newly-arrived user messages as queued when they were sent during an active turn.
    if (isNew && role === "user" && this.pendingQueuedUserMessages > 0) {
      this.pendingQueuedUserMessages -= 1;
      this.queuedMessageIds.add(id);
    }
    this.loadedMessages.sort((left, right) => this.messageTime(left) - this.messageTime(right));
  }

  /** Inserts or replaces a full streamed part in its parent message bundle. */
  private upsertStreamingPart(part: JsonObject): void {
    const messageId = this.readString(part, ["messageID", "messageId"]);
    const partId = this.readString(part, ["id", "partID", "partId"]);
    if (!messageId || !partId) return;
    const bundle = this.loadedMessages.find((item) => this.messageId(item) === messageId);
    if (!bundle) {
      this.loadedMessages.push({ info: { id: messageId, sessionID: this.sessionId, role: "assistant", time: { created: Date.now() } }, parts: [part] });
      this.loadedMessages.sort((left, right) => this.messageTime(left) - this.messageTime(right));
      return;
    }
    const index = bundle.parts.findIndex((item) => this.readString(item, ["id", "partID", "partId"]) === partId);
    if (index >= 0) bundle.parts[index] = part;
    else bundle.parts.push(part);
  }

  /** Appends one text/reasoning field delta to an existing streamed part. */
  private applyPartDelta(properties: JsonObject): AppliedPartDelta | undefined {
    const messageId = this.readString(properties, ["messageID", "messageId"]);
    const partId = this.readString(properties, ["partID", "partId"]);
    const field = this.readString(properties, ["field"]);
    const delta = this.readString(properties, ["delta"]);
    if (!messageId || !partId || !field || delta === undefined) return undefined;
    const bundle = this.loadedMessages.find((item) => this.messageId(item) === messageId);
    const part = bundle?.parts.find((item) => this.readString(item, ["id", "partID", "partId"]) === partId);
    if (!part) return undefined;
    const current = typeof part[field] === "string" ? part[field] : "";
    part[field] = `${current}${delta}`;
    return { messageId, partId, field, part };
  }

  /** Applies token deltas directly to the mounted active part, avoiding full-timeline re-render per token. */
  private patchStreamingPart(delta: AppliedPartDelta): boolean {
    if (delta.field !== "text") return false;
    const type = this.readString(delta.part, ["type"]);
    if (type !== "text" && type !== "reasoning") return false;

    const target = this.findStreamingPartTarget(delta.messageId, delta.partId, type);
    if (!target) return false;

    const wasAtBottom = this.shouldFollowLatest();
    this.queueStreamingMarkdownPatch(`${delta.messageId}:${delta.partId}:${delta.field}`, target, this.readString(delta.part, ["text"]) ?? "");
    if (wasAtBottom) this.scrollToBottom(false);
    this.updateJumpButton();
    return true;
  }

  /** Queues Markdown rendering for one streamed part without stacking concurrent renders. */
  private queueStreamingMarkdownPatch(key: string, element: HTMLElement, markdown: string): void {
    const existing = this.streamingMarkdownPatches.get(key);
    const patch: StreamingMarkdownPatch = existing ?? { element, markdown, inFlight: false, pending: false };
    patch.element = element;
    patch.markdown = markdown;
    patch.pending = true;
    this.streamingMarkdownPatches.set(key, patch);

    if (patch.frame !== undefined || patch.inFlight) return;
    patch.frame = window.requestAnimationFrame(() => {
      patch.frame = undefined;
      void this.flushStreamingMarkdownPatch(key, patch);
    });
  }

  /** Renders the latest markdown for one active part and follows up if newer deltas arrived mid-render. */
  private async flushStreamingMarkdownPatch(key: string, patch: StreamingMarkdownPatch): Promise<void> {
    if (!patch.pending || !patch.element.isConnected) {
      this.streamingMarkdownPatches.delete(key);
      return;
    }

    const markdown = patch.markdown;
    const element = patch.element;
    const wasAtBottom = this.shouldFollowLatest();
    patch.pending = false;
    patch.inFlight = true;
    try {
      const scratch = document.createElement("div");
      scratch.addClass("markdown-rendered");
      await MarkdownRenderer.renderMarkdown(markdown, scratch, `opencode-session/${this.sessionId ?? "session"}.md`, this);
      if (!element.isConnected || this.streamingMarkdownPatches.get(key) !== patch) return;
      if (patch.pending && patch.markdown !== markdown) return;
      element.empty();
      while (scratch.firstChild) element.appendChild(scratch.firstChild);
      if (wasAtBottom) this.scrollToBottom(false);
      this.updateJumpButton();
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] markdown patch failed", error);
    } finally {
      patch.inFlight = false;
      if (patch.pending && patch.element.isConnected) this.queueStreamingMarkdownPatch(key, patch.element, patch.markdown);
      else if (!patch.pending) this.streamingMarkdownPatches.delete(key);
    }
  }

  /** Cancels queued active-part Markdown patches when the session view closes. */
  private cancelStreamingMarkdownPatches(): void {
    for (const patch of this.streamingMarkdownPatches.values()) {
      if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
    }
    this.streamingMarkdownPatches.clear();
  }

  /** Finds the current DOM node that owns a streamed text or reasoning part. */
  private findStreamingPartTarget(messageId: string, partId: string, type: string): HTMLElement | undefined {
    const row = this.contentEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!row) return undefined;
    const selector = type === "reasoning" ? ".opencode-session-view__reasoning-body" : ".opencode-session-view__assistant-markdown";
    return row.querySelector<HTMLElement>(`${selector}[data-part-id="${CSS.escape(partId)}"][data-stream-field="text"]`) ?? undefined;
  }

  /** Queues a frame-bounded streaming render without postponing every token delta. */
  private scheduleStreamingRender(): void {
    this.streamingRenderPending = true;
    if (this.streamingRenderFrame !== undefined || this.streamingRenderInFlight) return;
    this.streamingRenderFrame = window.requestAnimationFrame(() => {
      this.streamingRenderFrame = undefined;
      void this.flushStreamingRender();
    });
  }

  /** Applies the latest accumulated stream state, then schedules a follow-up if deltas arrived mid-render. */
  private async flushStreamingRender(): Promise<void> {
    if (!this.streamingRenderPending || !this.currentSession || !this.sessionId) {
      this.streamingRenderPending = false;
      return;
    }

    this.streamingRenderPending = false;
    this.streamingRenderInFlight = true;
    try {
      console.debug("[opencode-plugin:session-stream] render", { sessionId: this.sessionId, messages: this.loadedMessages.length });
      await this.renderStreamingTimeline();
      await this.plugin.updateDiffPanelContext(this.diffPanelContext());
      this.updateContextProgressBar();
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] render failed", error);
    } finally {
      this.streamingRenderInFlight = false;
      if (this.streamingRenderPending) this.scheduleStreamingRender();
    }
  }

  /** Re-renders only the timeline into a detached node, then swaps it to avoid shell blinking. */
  private async renderStreamingTimeline(): Promise<void> {
    const current = this.contentEl.querySelector<HTMLElement>(".opencode-session-view__timeline");
    if (!current) {
      if (this.currentSession) await this.renderSession(this.currentSession, this.loadedMessages, { initialLoad: false });
      return;
    }
    const wasAtBottom = this.shouldFollowLatest();
    if (wasAtBottom) this.programmaticScrollUntil = Date.now() + 1200;
    const next = document.createElement("div");
    next.addClass("opencode-session-view__timeline");
    this.renderHistoryBoundary(next);
    const sorted = [...this.loadedMessages].sort((a, b) => this.messageTime(a) - this.messageTime(b));
    const visibleMessages = sorted.filter((message) => this.messageRenderKind(message) !== "none");
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const row = next.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": this.messageId(message) } });
      await this.renderMessage(row, message, this.messageRenderOptions(visibleMessages, index));
    }
    if (visibleMessages.length === 0) next.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
    current.replaceWith(next);
    if (wasAtBottom) this.scrollToBottom(false);
    this.updateJumpButton();
  }

  /** Debounces a canonical idle sync that appends new messages without rebuilding the shell. */
  private scheduleCanonicalSync(delayMs = 500): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.syncCanonicalMessages();
    }, delayMs);
  }

  /** Fetches canonical session data after idle and reconciles only the timeline tail. */
  private async syncCanonicalMessages(): Promise<void> {
    if (!this.sessionId || this.loading || !this.contentEl.querySelector(".opencode-session-view__timeline")) {
      await this.refresh();
      return;
    }

    try {
      const service = this.plugin.requireOpenCodeService();
      const [session, page] = await Promise.all([
        service.getSession(this.sessionId),
        service.listMessagePage(this.sessionId, { limit: INITIAL_MESSAGE_LIMIT, order: "desc" }),
      ]);
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

      this.availableAgents = agents;
      this.availableModels = models;
      this.availableCommands = commands;
      this.serverConfig = config;
      this.pendingPermissions = permissions.filter((item) => item.sessionID === this.sessionId);
      this.pendingQuestions = questions.filter((item) => item.sessionID === this.sessionId);
      await this.autoApprovePendingPermissions();
      this.currentSession = session;
      this.applySessionStatusSnapshot(statuses);
      this.applySessionChromeState(session);
      this.loadedMessages = this.mergeMessages(this.loadedMessages, page.messages);
      if (!this.olderCursor) this.olderCursor = page.olderCursor;
      this.historyComplete = page.complete && !this.olderCursor;
      this.refreshRequestDocks();
      await this.reconcileTimelineAppendOnly(this.loadedMessages);
      await this.plugin.updateDiffPanelContext(this.diffPanelContext());
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] canonical sync failed", error);
    }
  }

  /** Applies session chrome state without rebuilding the shell. */
  private applySessionChromeState(session: JsonObject): void {
    this.sessionTitle = this.sessionTitleFromSession(session);
    this.sessionDirectory = this.readString(session, ["directory", "cwd"]);
    this.subscribeToServerEvents(this.sessionDirectory);
    this.selectedAgent = this.composerAgentFromState(session);
    this.selectedModel = this.composerModelFromState(session, this.selectedAgent);
    this.renderedSessionId = this.sessionId;
    this.refreshLeafTitle();
    this.updateComposerInsetSoon();
  }

  /** Appends only new canonical messages after the currently mounted tail, preserving already-rendered rows. */
  private async reconcileTimelineAppendOnly(messages: OpenCodeMessageBundle[]): Promise<void> {
    const timeline = this.contentEl.querySelector<HTMLElement>(".opencode-session-view__timeline");
    if (!timeline) {
      if (this.currentSession) await this.renderSession(this.currentSession, this.loadedMessages, { initialLoad: false });
      return;
    }

    const sorted = [...messages].sort((a, b) => this.messageTime(a) - this.messageTime(b));
    const visibleMessages = sorted.filter((message) => this.messageRenderKind(message) !== "none");
    if (visibleMessages.length === 0) {
      timeline.empty();
      this.renderHistoryBoundary(timeline);
      timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
      return;
    }

    const renderedIds = Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId).filter((id): id is string => !!id);
    const lastRenderedIndex = this.latestMessageIndex(visibleMessages, renderedIds);
    if (lastRenderedIndex === -1) {
      await this.renderStreamingTimeline();
      return;
    }

    const wasAtBottom = this.shouldFollowLatest();
    if (wasAtBottom) this.programmaticScrollUntil = Date.now() + 1200;
    const previousBundle = visibleMessages[lastRenderedIndex];
    if (previousBundle) {
      const previousRow = timeline.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(this.messageId(previousBundle))}"]`);
      if (previousRow && this.messageRole(previousBundle) === "assistant" && !this.isCompactionMessage(previousBundle)) {
        const hasMeta = !!previousRow.querySelector(".opencode-session-view__message-meta--assistant");
        const shouldHaveMeta = this.latestVisibleAssistantIndex(visibleMessages, lastRenderedIndex) === lastRenderedIndex;
        if (shouldHaveMeta && !hasMeta) {
          const options = this.messageRenderOptions(visibleMessages, lastRenderedIndex);
          this.renderMessageMeta(previousRow, previousBundle, "assistant", options.assistantTurnText);
        }
      }
    }

    for (let index = lastRenderedIndex + 1; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": this.messageId(message) } });
      await this.renderMessage(row, message, this.messageRenderOptions(visibleMessages, index));
    }

    const empty = timeline.querySelector(".opencode-session-view__empty");
    if (visibleMessages.length > 0) empty?.remove();
    if (wasAtBottom) this.scrollToBottom(false);
    this.updateJumpButton();
  }

  /** Finds the highest visible canonical index that is already rendered in the DOM. */
  private latestMessageIndex(messages: OpenCodeMessageBundle[], renderedIds: string[]): number {
    let index = -1;
    for (const id of renderedIds) {
      const messageIndex = messages.findIndex((message) => this.messageId(message) === id);
      if (messageIndex > index) index = messageIndex;
    }
    return index;
  }

  /** Finds the last rendered assistant turn whose meta row may need to be promoted to turn-final status. */
  private latestVisibleAssistantIndex(messages: OpenCodeMessageBundle[], endIndex: number): number {
    for (let index = endIndex; index >= 0; index -= 1) {
      if (this.messageRole(messages[index]) === "assistant" && !this.isCompactionMessage(messages[index])) return index;
    }
    return -1;
  }

  /** Checks common event payload fields for the active session id. */
  private eventReferencesCurrentSession(properties: JsonObject | undefined): boolean {
    if (!this.sessionId || !properties) return false;
    if (properties.sessionID === this.sessionId || properties.sessionId === this.sessionId) return true;
    const info = this.readObject(properties, "info");
    if (info?.sessionID === this.sessionId || info?.sessionId === this.sessionId || info?.id === this.sessionId) return true;
    const part = this.readObject(properties, "part");
    return part?.sessionID === this.sessionId || part?.sessionId === this.sessionId;
  }

  /** Applies the current session's status from the global v1 status snapshot. */
  private applySessionStatusSnapshot(snapshot: JsonObject): void {
    const status = this.sessionId ? this.readObject(snapshot, this.sessionId) : undefined;
    if (status || !isActiveSessionStatus(this.sessionStatusType)) this.applySessionStatus(status);
  }

  /** Reconciles busy, retry, and idle status events with composer and unread state. */
  private applySessionStatus(status: JsonObject | undefined, fromEvent = false): void {
    const previousType = this.sessionStatusType;
    const nextType = this.readString(status ?? {}, ["type", "status", "state"]) ?? "idle";
    const wasBusy = isActiveSessionStatus(previousType);
    const isBusy = isActiveSessionStatus(nextType);
    this.sessionStatusType = nextType;
    this.sessionBusy = isBusy;

    if (fromEvent && nextType === "idle") {
      this.queuedMessageIds.clear();
      this.pendingQueuedUserMessages = 0;
      this.scheduleCanonicalSync(120);
      this.releaseFollowLatestAfterIdle();
    }
    if (wasBusy && !isBusy && this.sessionId) this.setSessionUnread(true);
    if (this.sessionId) this.plugin.notifySessionStatusChanged(this.sessionId, nextType);
    this.refreshSessionStateIndicator();
    if (wasBusy !== isBusy) void this.refreshComposerOnly();
  }

  /** Returns the visual state shared by the session tab and its in-view indicator. */
  private sessionVisualStatus(): SessionVisualStatus {
    if (this.pendingPermissions.length > 0 || this.pendingQuestions.length > 0) return "attention";
    return visualStatusForSession(this.sessionStatusType, this.sessionId ? this.plugin.settings.sessionUnread[this.sessionId] === true : false);
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
    if (!this.draftDirectory) return;
    try {
      this.persistComposerDraft();
      const service = this.plugin.requireOpenCodeService();
      const [agents, models, commands, config] = await Promise.all([
        service.listAgents(this.draftDirectory),
        service.listModels(this.draftDirectory).catch(logServiceError([], "listModels", this.draftDirectory)),
        service.listCommands(this.draftDirectory).catch(logServiceError([], "listCommands", this.draftDirectory)),
        service.getConfig().catch(logServiceError({}, "getConfig", this.draftDirectory)),
      ]);
      this.availableAgents = agents;
      this.availableModels = models;
      this.availableCommands = commands;
      this.serverConfig = config;
      this.selectedAgent = this.composerAgentFromState({});
      this.selectedModel = this.composerModelFromState({}, this.selectedAgent);
      this.sessionDirectory = this.draftDirectory;
      this.subscribeToServerEvents(this.draftDirectory);
      this.contentEl.empty();
      const shell = this.contentEl.createDiv({ cls: "opencode-session-view__shell opencode-session-view__shell--draft" });
      const header = shell.createDiv({ cls: "opencode-session-view__header" });
      const titleWrap = header.createDiv({ cls: "opencode-session-view__title-wrap" });
      titleWrap.createDiv({ text: "New session", cls: "opencode-session-view__title" });
      titleWrap.createDiv({ text: this.draftDirectory, cls: "opencode-session-view__subtitle" });
      const body = shell.createDiv({ cls: "opencode-session-view__draft-body" });
      body.createDiv({ text: "What would you like to work on?", cls: "opencode-session-view__draft-title" });
      this.renderComposer(shell, {}, true);
      this.refreshLeafTitle();
    } catch (error) {
      this.renderError(error);
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
    const previousTop = this.contentEl.scrollTop;
    const wasAtBottom = this.shouldFollowLatest();
    const composerState = this.captureComposerDomState();
    this.persistComposerDraft();
    if (wasAtBottom) this.programmaticScrollUntil = Date.now() + 1600;
    this.contentEl.empty();
    this.sessionTitle = this.sessionTitleFromSession(session);
    this.sessionDirectory = this.readString(session, ["directory", "cwd"]);
    this.subscribeToServerEvents(this.sessionDirectory);
    this.selectedAgent = this.composerAgentFromState(session);
    this.selectedModel = this.composerModelFromState(session, this.selectedAgent);
    this.renderedSessionId = this.sessionId;
    this.refreshLeafTitle();
    const shell = this.contentEl.createDiv({ cls: "opencode-session-view__shell" });
    this.renderHeader(shell, session);

    const timeline = shell.createDiv({ cls: "opencode-session-view__timeline" });
    this.renderHistoryBoundary(timeline);
    const sorted = [...messages].sort((a, b) => this.messageTime(a) - this.messageTime(b));
    const visibleMessages = sorted.filter((message) => this.messageRenderKind(message) !== "none");
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": this.messageId(message) } });
      await this.renderMessage(row, message, this.messageRenderOptions(visibleMessages, index));
    }

    if (visibleMessages.length === 0) timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
    this.renderComposer(shell, session, options.initialLoad && visibleMessages.length === 0);
    this.restoreComposerDomState(composerState);
    this.renderJumpToBottomButton();
    this.bindScrollListener();
    await this.restoreScrollAfterRender(options.initialLoad, previousTop, wasAtBottom);
  }

  /** Renders the lazy-history status row at the top of the loaded timeline window. */
  private renderHistoryBoundary(container: HTMLElement): void {
    const boundary = container.createDiv({ cls: "opencode-session-view__history-boundary" });
    if (this.loadingOlder) {
      boundary.createSpan({ cls: "opencode-session-view__history-spinner" });
      boundary.createSpan({ text: "Loading earlier messages…" });
      return;
    }
    boundary.setText(this.historyComplete ? "Beginning of loaded session" : "Scroll up to load earlier messages");
  }

  /** Adds the floating jump-to-latest action; referenced by renderSession and updateJumpButton. */
  private renderJumpToBottomButton(): void {
    const button = this.contentEl.createEl("button", { attr: { "aria-label": "Jump to latest" }, cls: "opencode-session-view__jump-bottom" });
    setIcon(button, "arrow-down-to-line");
    button.addEventListener("click", () => this.scrollToBottom(true));
    this.jumpButton = button;
    this.updateJumpButton();
  }

  /** Registers one scroll listener on the Obsidian view root for pagination, state persistence, and jump button visibility. */
  private bindScrollListener(): void {
    if (this.scrollBound) return;
    this.scrollBound = true;
    this.registerDomEvent(this.contentEl, "scroll", () => {
      this.updateJumpButton();
      this.scheduleScrollStateSave();
      if (Date.now() > this.programmaticScrollUntil) this.markSessionReadIfAtBottom();
      if (this.followLatest && !this.isNearBottom() && Date.now() > this.programmaticScrollUntil) this.disableFollowLatest();
      if (this.contentEl.scrollTop < LOAD_OLDER_THRESHOLD_PX) void this.loadOlderMessages();
    });
    this.registerDomEvent(this.contentEl, "wheel", () => {
      if (this.followLatest && Date.now() > this.programmaticScrollUntil) this.disableFollowLatest();
    });
  }

  /** Restores bottom/default/current scroll after async markdown rendering settles. */
  private async restoreScrollAfterRender(initialLoad: boolean, previousTop: number, wasAtBottom: boolean): Promise<void> {
    await this.nextFrame();
    if (this.followLatest) {
      this.scrollToBottom(false);
    } else if (initialLoad) {
      const saved = this.sessionId ? this.plugin.settings.sessionScroll[this.sessionId] : undefined;
      if (saved && !saved.atBottom) this.contentEl.scrollTop = saved.top;
      else this.scrollToBottom(false);
    } else if (wasAtBottom) {
      this.scrollToBottom(false);
    } else {
      this.contentEl.scrollTop = previousTop;
    }
    this.updateJumpButton();
  }

  /** Loads the previous cursor page and prepends it while preserving the top visible message anchor. */
  private async loadOlderMessages(): Promise<void> {
    if (!this.sessionId || this.loadingOlder || this.historyComplete || !this.olderCursor) return;
    const anchor = this.capturePrependAnchor();
    this.loadingOlder = true;
    try {
      const page = await this.plugin.requireOpenCodeService().listMessagePage(this.sessionId, { limit: OLDER_MESSAGE_LIMIT, cursor: this.olderCursor });
      this.loadedMessages = this.mergeMessages(page.messages, this.loadedMessages);
      this.olderCursor = page.olderCursor;
      this.historyComplete = page.complete && !this.olderCursor;
      this.loadingOlder = false;
      const session = await this.plugin.requireOpenCodeService().getSession(this.sessionId);
      await this.renderSession(session, this.loadedMessages, { initialLoad: false });
      await this.restorePrependAnchor(anchor);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to load earlier OpenCode messages.");
    } finally {
      this.loadingOlder = false;
    }
  }

  /** Captures the first visible timeline row before older messages are prepended. */
  private capturePrependAnchor(): { id: string; offset: number } | undefined {
    const view = this.contentEl.getBoundingClientRect();
    const visible = Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-message-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    const id = visible?.element.dataset.messageId;
    return id ? { id, offset: visible.rect.top - view.top } : undefined;
  }

  /** Re-applies a captured row offset after markdown/layout work from a prepend has settled. */
  private async restorePrependAnchor(anchor: { id: string; offset: number } | undefined): Promise<void> {
    if (!anchor) return;
    for (let frame = 0; frame < 30; frame += 1) {
      await this.nextFrame();
      const element = this.contentEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
      if (!element) continue;
      const delta = element.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) <= 0.5) return;
      this.contentEl.scrollTop += delta;
    }
  }

  /** Merges message pages by message id; referenced by refresh and loadOlderMessages. */
  private mergeMessages(left: OpenCodeMessageBundle[], right: OpenCodeMessageBundle[]): OpenCodeMessageBundle[] {
    const merged = new Map<string, OpenCodeMessageBundle>();
    for (const message of [...left, ...right]) merged.set(this.messageId(message), message);
    return [...merged.values()].sort((a, b) => this.messageTime(a) - this.messageTime(b));
  }

  /** Reads a stable message id for data attributes and pagination merging. */
  private messageId(bundle: OpenCodeMessageBundle): string {
    return this.readString(bundle.info, ["id", "messageID", "messageId"]) ?? String(this.messageTime(bundle));
  }

  /** Returns true when the timeline is close enough to bottom to auto-follow streaming updates. */
  private isNearBottom(): boolean {
    return this.contentEl.scrollHeight - this.contentEl.scrollTop - this.contentEl.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  /** Returns true when timeline renders should keep the latest turn visible above the sticky composer. */
  private shouldFollowLatest(): boolean {
    return this.followLatest || this.isNearBottom();
  }

  /** Enables chat-style auto-follow after the user sends a prompt; referenced by send and streaming renders. */
  private enableFollowLatest(): void {
    this.followLatest = true;
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = undefined;
    this.extendFollowLatest(8000);
  }

  /** Extends the multi-frame bottom alignment window used while a run is active. */
  private extendFollowLatest(durationMs = 1200): void {
    if (!this.followLatest) return;
    this.followLatestUntil = Math.max(this.followLatestUntil, Date.now() + durationMs);
    this.runFollowLatestPump();
  }

  /** Re-applies bottom alignment across frames so late Markdown/layout passes cannot restore stale scroll. */
  private runFollowLatestPump(): void {
    if (!this.followLatest || this.followLatestFrame !== undefined) return;
    this.followLatestFrame = window.requestAnimationFrame(() => {
      this.followLatestFrame = undefined;
      if (!this.followLatest || !this.contentEl.isConnected) return;
      this.alignToBottom();
      if (Date.now() < this.followLatestUntil) this.runFollowLatestPump();
    });
  }

  /** Stops explicit auto-follow when the run settles or the user manually scrolls away. */
  private disableFollowLatest(): void {
    this.followLatest = false;
    this.followLatestUntil = 0;
    if (this.followLatestFrame !== undefined) window.cancelAnimationFrame(this.followLatestFrame);
    this.followLatestFrame = undefined;
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = undefined;
  }

  /** Keeps auto-follow through the final idle refresh, then returns to normal near-bottom anchoring. */
  private releaseFollowLatestAfterIdle(): void {
    if (!this.followLatest) return;
    this.extendFollowLatest(2200);
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = window.setTimeout(() => {
      this.followLatestReleaseTimer = undefined;
      this.followLatest = false;
      this.followLatestUntil = 0;
    }, 2000);
  }

  /** Scrolls the session view to the latest loaded message. */
  private scrollToBottom(smooth: boolean): void {
    if (smooth) this.contentEl.scrollTo({ top: this.contentEl.scrollHeight, behavior: "smooth" });
    else this.alignToBottom();
    if (!smooth && this.followLatest) this.extendFollowLatest(600);
    window.setTimeout(() => this.updateJumpButton(), smooth ? 220 : 0);
  }

  /** Sets the scroll container to its maximum scrollTop and marks resulting scroll events as programmatic. */
  private alignToBottom(): void {
    this.programmaticScrollUntil = Date.now() + 600;
    this.contentEl.scrollTop = Math.max(0, this.contentEl.scrollHeight - this.contentEl.clientHeight);
  }

  /** Shows the subdued jump button only while the user is reading away from latest. */
  private updateJumpButton(): void {
    this.jumpButton?.toggleClass("is-visible", !this.isNearBottom());
  }

  /** Debounces scroll-state persistence so normal scrolling does not thrash plugin data writes. */
  private scheduleScrollStateSave(): void {
    if (this.scrollSaveTimer) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => {
      this.scrollSaveTimer = undefined;
      this.persistScrollState();
    }, 600);
  }

  /** Persists the current per-session scroll position through the plugin settings store. */
  private persistScrollState(): void {
    if (!this.sessionId) return;
    void this.plugin.rememberSessionScroll(this.sessionId, { top: this.contentEl.scrollTop, atBottom: this.isNearBottom() });
  }

  /** Persists the current session's unread completion marker and refreshes visible sidebar rows. */
  private setSessionUnread(unread: boolean): void {
    if (!this.sessionId || (this.plugin.settings.sessionUnread[this.sessionId] === true) === unread) return;
    void this.plugin.rememberSessionUnread(this.sessionId, unread).then(() => {
      this.refreshSessionStateIndicator();
      void this.plugin.refreshAgentPanels({ showLoading: false });
    });
  }

  /** Clears a completed-turn marker only after the user reaches the latest session content. */
  private markSessionReadIfAtBottom(): void {
    if (this.isNearBottom() && this.sessionId && this.plugin.settings.sessionUnread[this.sessionId] === true) this.setSessionUnread(false);
  }

  /** Waits for one animation frame so MarkdownRenderer-created DOM can affect layout. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  /** Classifies visible message content so compact assistant API calls can be separated without padding every part row. */
  private messageRenderKind(bundle: OpenCodeMessageBundle): MessageRenderKind {
    if (this.isCompactionMessage(bundle)) return "assistant-text";
    const role = this.messageRole(bundle);
    if (role !== "assistant") return this.userMessageText(bundle).trim() || this.imageAttachments(bundle).length > 0 ? "user" : "none";

    const hasText = bundle.parts.some((part) => {
      if (this.readString(part, ["type"]) !== "text") return false;
      if (part.synthetic === true || part.ignored === true) return false;
      return !!this.readString(part, ["text"]);
    });
    const hasCompact = bundle.parts.some((part) => this.isCompactAssistantPart(part));
    if (hasText && hasCompact) return "assistant-mixed";
    if (hasText) return "assistant-text";
    if (hasCompact) return "assistant-compact";
    return "none";
  }

  /** Returns true for visible non-prose assistant parts such as reasoning and tool calls. */
  private isCompactAssistantPart(part: JsonObject): boolean {
    const type = this.readString(part, ["type"]);
    if (type === "tool") return true;
    if (type === "reasoning") return this.plugin.settings.showReasoningBlocks && !!this.readString(part, ["text"]);
    return false;
  }

  /** Renders the fixed session header with refresh and copy-id actions. */
  private renderHeader(container: HTMLElement, session: JsonObject): void {
    const header = container.createDiv({ cls: "opencode-session-view__header" });
    const titleWrap = header.createDiv({ cls: "opencode-session-view__title-wrap" });
    const titleLine = titleWrap.createDiv({ cls: "opencode-session-view__title-line" });
    const indicator = titleLine.createDiv({ cls: "opencode-session-view__state-indicator" });
    this.paintSessionStateIndicator(indicator, this.sessionVisualStatus(), normalizeWorkingAnimation(this.plugin.settings.workingAnimation));
    titleLine.createDiv({ text: this.sessionTitleFromSession(session), cls: "opencode-session-view__title" });
    titleWrap.createDiv({ text: this.sessionId ?? "", cls: "opencode-session-view__subtitle" });

    const actions = header.createDiv({ cls: "opencode-session-view__actions" });
    const copy = actions.createEl("button", { attr: { "aria-label": "Copy session ID" }, cls: "clickable-icon" });
    setIcon(copy, "copy");
    copy.addEventListener("click", () => void this.copySessionId());
    const refresh = actions.createEl("button", { attr: { "aria-label": "Refresh session" }, cls: "clickable-icon" });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());
  }

  /** Renders the bottom composer cluster used to send prompts from a session tab. */
  private renderComposer(container: HTMLElement, session: JsonObject, shouldFocus: boolean): void {
    const composerKey = this.composerStorageKey();
    if (!composerKey) return;
    const composer = container.createDiv({ cls: "opencode-session-view__composer" });
    this.composerEl = composer;
    this.requestDockEl = composer.createDiv({ cls: "opencode-session-view__request-docks" });
    this.renderRequestDocks(this.requestDockEl);
    this.renderAttachmentChips(composer, composerKey);
    const inputRow = composer.createDiv({ cls: "opencode-session-view__composer-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "opencode-session-view__composer-input",
      attr: { placeholder: "type message, @ to include files, / for commands", rows: "1" },
    });
    textarea.value = this.plugin.settings.sessionDrafts[composerKey] ?? "";
    textarea.disabled = this.isComposerBlocked();
    this.composerTextarea = textarea;
    this.resizeComposerInput(textarea);

    textarea.addEventListener("input", () => {
      this.historyIndex = -1;
      this.resizeComposerInput(textarea);
      this.updateSlashMenu(textarea);
      this.updateComposerInsetSoon();
      this.scheduleDraftSave();
    });
    textarea.addEventListener("keydown", (event) => this.handleComposerKeydown(event), { capture: true });
    if (shouldFocus) window.setTimeout(() => textarea.focus(), 0);

    const controls = composer.createDiv({ cls: "opencode-session-view__composer-controls" });
    const left = controls.createDiv({ cls: "opencode-session-view__composer-left" });
    const attach = left.createSpan({ cls: "opencode-session-view__composer-icon", attr: { role: "button", tabindex: "0", "aria-label": "Attach files" } });
    attach.title = "Attach files";
    setIcon(attach, "paperclip");
    attach.addEventListener("click", () => void this.pickComposerFiles());
    const labels = left.createDiv({ cls: "opencode-session-view__composer-labels" });
    this.renderAgentLabel(labels, session);
    this.renderModelPill(labels);
    this.renderThinkingPill(labels);

    const right = controls.createDiv({ cls: "opencode-session-view__composer-right" });
    this.renderQueuedBadge(right);
    this.renderTogglePill(right, "", this.isSessionMuted() ? "bell-off" : "bell", this.isSessionMuted(), () => void this.toggleMute(), "Mute notifications for this session");
    this.renderTogglePill(right, "", "shield-check", this.shouldAutoApprovePermissions(), () => void this.toggleAutoApprove(), "Auto-allow permission requests once");
    this.renderSendButton(right, textarea);
    let prevEmpty = textarea.value.trim().length === 0;
    textarea.addEventListener("input", () => {
      this.historyIndex = -1;
      this.resizeComposerInput(textarea);
      this.updateSlashMenu(textarea);
      this.updateComposerInsetSoon();
      this.scheduleDraftSave();
      // When the agent is streaming, the send button flips between stop and send modes based on emptiness.
      const currEmpty = textarea.value.trim().length === 0;
      if (this.sessionBusy && currEmpty !== prevEmpty) {
        prevEmpty = currEmpty;
        this.pendingInterruptConfirm = false;
        if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
        this.interruptConfirmTimer = undefined;
        void this.refreshComposerOnly();
      }
    });
    this.updateSlashMenu(textarea);
    this.updateComposerInsetSoon();
    this.renderContextProgressBar(composer);
  }

  /** Renders the context-length progress bar pinned to the composer's bottom border. */
  private renderContextProgressBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "opencode-session-view__composer-progress" });
    const track = bar.createDiv({ cls: "opencode-session-view__composer-progress-track" });
    // Fill acts as a mask: it covers the unfilled portion of the gradient track with the border color.
    this.composerProgressFillEl = track.createDiv({ cls: "opencode-session-view__composer-progress-fill" });
    this.composerProgressTrackEl = track;
    this.composerProgressBarEl = bar;
    this.composerProgressMarkers.length = 0;
    // One marker per checkpoint (section boundary, excluding the implicit 0-origin).
    for (let i = 0; i < SessionView.PROGRESS_CHECKPOINTS.length; i++) {
      const marker = track.createDiv({ cls: "opencode-session-view__composer-progress-marker" });
      marker.createSpan({ cls: "opencode-session-view__composer-progress-marker-label" });
      this.composerProgressMarkers.push(marker);
    }
    this.updateContextProgressBar();
  }

  /** Updates the progress bar width from the latest assistant tokens vs the selected model's context limit. */
  private updateContextProgressBar(): void {
    const bar = this.composerProgressBarEl;
    const track = this.composerProgressTrackEl;
    const fill = this.composerProgressFillEl;
    if (!bar?.isConnected) return;
    const limit = this.currentModelContextLimit();
    const used = this.currentContextLength();
    const hasAssistant = this.loadedMessages.some((bundle) => this.readString(bundle.info, ["role"]) === "assistant");
    const isEmpty = !hasAssistant || limit === 0 || used === 0;

    // Compute piecewise-linear sections from checkpoints, adjusted for the model's limit.
    const sections = this.computeProgressSections(limit);

    // Set the multi-color gradient on the track.
    if (track) track.style.background = this.sectionsToGradient(sections);

    // Piecewise-linear interpolation: map used tokens to bar fraction.
    const visualFrac = !isEmpty && limit > 0 ? this.contextToBarFraction(used, sections) : 0;

    // Position the mask to hide the unfilled portion.
    if (fill) fill.style.left = `${(visualFrac * 100).toFixed(2)}%`;

    bar.toggleClass("is-empty", isEmpty);

    // Tooltip shows true linear percentage.
    const actualPct = !isEmpty && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    bar.title = limit > 0 && !isEmpty ? `${this.formatCompactNumber(used)}/${this.formatCompactNumber(limit)} tokens (${Math.round(actualPct)}%)` : "";

    // Markers sit at section end-points with absolute token labels.
    for (let i = 0; i < this.composerProgressMarkers.length; i++) {
      const marker = this.composerProgressMarkers[i];
      const label = marker.querySelector(".opencode-session-view__composer-progress-marker-label") as HTMLElement | null;
      if (!isEmpty && i < sections.length) {
        marker.style.left = `${(sections[i].endFraction * 100).toFixed(2)}%`;
        marker.style.visibility = "visible";
        if (label) label.setText(this.formatCompactNumber(sections[i].endContext));
      } else {
        marker.style.visibility = "hidden";
        if (label) label.setText("");
      }
    }
  }

  /** Computes effective progress sections from checkpoints, adjusting for the model's context limit. */
  private computeProgressSections(limit: number): { startFraction: number; endFraction: number; startContext: number; endContext: number; color: string }[] {
    const accent = "var(--interactive-accent)";
    const checkpoints = SessionView.PROGRESS_CHECKPOINTS;
    const sections: { startFraction: number; endFraction: number; startContext: number; endContext: number; color: string }[] = [];
    let prevFraction = 0;
    let prevContext = 0;

    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      const isLast = i === checkpoints.length - 1;
      const context = cp.context ?? limit;
      const color = cp.color ?? accent;

      // Non-last checkpoint exceeds model limit: extend this section to the end and stop.
      if (!isLast && limit > 0 && context > limit) {
        sections.push({ startFraction: prevFraction, endFraction: 1.0, startContext: prevContext, endContext: limit, color });
        return sections;
      }

      sections.push({ startFraction: prevFraction, endFraction: cp.fraction, startContext: prevContext, endContext: context, color });
      prevFraction = cp.fraction;
      prevContext = context;
    }

    // Ensure the last section always reaches fraction 1.0 and the model limit.
    const last = sections[sections.length - 1];
    if (last && limit > 0) {
      last.endFraction = 1.0;
      last.endContext = limit;
    }

    return sections;
  }

  /** Maps an absolute token count to a bar fraction via piecewise-linear interpolation across sections. */
  private contextToBarFraction(used: number, sections: { startFraction: number; endFraction: number; startContext: number; endContext: number; color: string }[]): number {
    if (used <= 0) return 0;
    for (const section of sections) {
      if (used <= section.endContext) {
        const contextRange = section.endContext - section.startContext;
        if (contextRange <= 0) return section.endFraction;
        const t = (used - section.startContext) / contextRange;
        return section.startFraction + t * (section.endFraction - section.startFraction);
      }
    }
    return 1.0;
  }

  /** Builds a CSS linear-gradient string with hard color stops at each section boundary. */
  private sectionsToGradient(sections: { startFraction: number; endFraction: number; color: string }[]): string {
    const stops: string[] = [];
    for (const section of sections) {
      stops.push(`${section.color} ${(section.startFraction * 100).toFixed(2)}%`);
      stops.push(`${section.color} ${(section.endFraction * 100).toFixed(2)}%`);
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }

  /** Formats a number compactly with at most one decimal place, stripping trailing .0. */
  private formatCompactNumber(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return this.trimDecimal(value / 1_000_000_000) + "B";
    if (abs >= 100_000_000) return this.trimDecimal(value / 1_000_000) + "M";
    if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
    return this.trimDecimal(value);
  }

  /** Returns a string with at most one decimal place, stripping trailing .0. */
  private trimDecimal(value: number): string {
    const fixed = value.toFixed(1);
    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  }

  /** Returns total tokens (input + output + reasoning + cache read + cache write) from the latest assistant message, or 0. */
  private currentContextLength(): number {
    for (let i = this.loadedMessages.length - 1; i >= 0; i -= 1) {
      const bundle = this.loadedMessages[i];
      if (this.readString(bundle.info, ["role"]) !== "assistant") continue;
      const tokens = this.readObject(bundle.info, "tokens");
      if (!tokens) continue;
      const input = this.readNumber(tokens, ["input"]) ?? 0;
      const output = this.readNumber(tokens, ["output"]) ?? 0;
      const reasoning = this.readNumber(tokens, ["reasoning"]) ?? 0;
      const cache = this.readObject(tokens, "cache");
      const cacheRead = cache ? this.readNumber(cache, ["read"]) ?? 0 : 0;
      const cacheWrite = cache ? this.readNumber(cache, ["write"]) ?? 0 : 0;
      const total = input + output + reasoning + cacheRead + cacheWrite;
      if (total > 0) return total;
    }
    return 0;
  }

  /** Returns the selected model's configured context-window limit, or 0 if unavailable. */
  private currentModelContextLimit(): number {
    if (!this.selectedModel) return 0;
    const info = this.availableModels.find((item) => this.sameModel(this.modelRefFromInfo(item), this.selectedModel));
    const limit = info ? this.readObject(info, "limit") : undefined;
    return limit ? this.readNumber(limit, ["context"]) ?? 0 : 0;
  }

  /** Repaints permission/question docks without touching the composer input or timeline. */
  private refreshRequestDocks(): void {
    this.refreshSessionStateIndicator();
    if (!this.requestDockEl?.isConnected) return;
    this.requestDockEl.empty();
    this.renderRequestDocks(this.requestDockEl);
    if (this.composerTextarea?.isConnected) this.composerTextarea.disabled = this.isComposerBlocked();
    this.updateComposerInsetSoon();
    if (this.isNearBottom()) this.scrollToBottom(false);
  }

  /** Measures the sticky composer height after layout and exposes it as timeline bottom inset. */
  private updateComposerInsetSoon(): void {
    window.requestAnimationFrame(() => this.updateComposerInset());
  }

  /** Updates the CSS custom property that prevents latest messages from hiding behind the composer. */
  private updateComposerInset(): void {
    if (!this.composerEl?.isConnected) {
      this.contentEl.style.removeProperty("--opencode-composer-height");
      return;
    }
    const height = Math.ceil(this.composerEl.getBoundingClientRect().height);
    if (height > 0) this.contentEl.style.setProperty("--opencode-composer-height", `${height}px`);
  }

  /** Renders pending permission and question requests above the composer textarea. */
  private renderRequestDocks(container: HTMLElement): void {
    container.toggleClass("is-empty", this.pendingPermissions.length === 0 && this.pendingQuestions.length === 0);
    for (const request of this.pendingPermissions) this.renderPermissionDock(container, request);
    for (const request of this.pendingQuestions) this.renderQuestionDock(container, request);
  }

  /** Renders one permission decision prompt with deny, always, and once actions. */
  private renderPermissionDock(container: HTMLElement, request: OpenCodePermissionRequest): void {
    const dock = container.createDiv({ cls: "opencode-session-view__request-dock opencode-session-view__request-dock--permission" });
    const header = dock.createDiv({ cls: "opencode-session-view__request-header" });
    const title = header.createDiv({ cls: "opencode-session-view__request-title" });
    title.createSpan({ text: "Permission required" });
    title.createSpan({ text: request.permission, cls: "opencode-session-view__request-badge" });
    const summary = dock.createDiv({ cls: "opencode-session-view__request-summary" });
    const patterns = Array.isArray(request.patterns) ? request.patterns : [];
    if (patterns.length === 0) summary.setText("OpenCode wants to run a protected action.");
    for (const pattern of patterns) summary.createEl("code", { text: pattern });

    const actions = dock.createDiv({ cls: "opencode-session-view__request-actions" });
    const responding = this.respondingRequestIds.has(request.id);
    this.renderRequestButton(actions, "Deny", "", responding, () => void this.replyPermission(request, "reject"));
    this.renderRequestButton(actions, "Allow always", "", responding, () => void this.replyPermission(request, "always"));
    this.renderRequestButton(actions, "Allow once", "mod-cta", responding, () => void this.replyPermission(request, "once"));
  }

  /** Sends a permission reply and removes the dock optimistically on success. */
  private async replyPermission(request: OpenCodePermissionRequest, reply: OpenCodePermissionReply): Promise<void> {
    if (this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    this.refreshRequestDocks();
    try {
      await this.plugin.requireOpenCodeService().replyPermission(request.id, reply, this.sessionDirectory ?? this.draftDirectory);
      this.removePendingRequest(request.id);
      this.refreshRequestDocks();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refreshRequestDocks();
      new Notice(error instanceof Error ? error.message : "Unable to reply to permission request.");
    }
  }

  /** Renders one question request, supporting single-select, multi-select, and custom answers. */
  private renderQuestionDock(container: HTMLElement, request: OpenCodeQuestionRequest): void {
    const dock = container.createDiv({ cls: "opencode-session-view__request-dock opencode-session-view__request-dock--question" });
    const header = dock.createDiv({ cls: "opencode-session-view__request-header" });
    header.createDiv({ text: "Question from OpenCode", cls: "opencode-session-view__request-title" });
    const form = dock.createDiv({ cls: "opencode-session-view__question-form" });
    const answerControls: Array<() => string[]> = [];

    request.questions.forEach((question, index) => {
      const block = form.createDiv({ cls: "opencode-session-view__question-block" });
      block.createDiv({ text: question.header || `Question ${index + 1}`, cls: "opencode-session-view__question-header" });
      block.createDiv({ text: question.question, cls: "opencode-session-view__question-text" });
      const options = block.createDiv({ cls: "opencode-session-view__question-options" });
      const inputs: HTMLInputElement[] = [];
      for (const option of question.options ?? []) {
        const label = options.createEl("label", { cls: "opencode-session-view__question-option" });
        const input = label.createEl("input", { type: question.multiple ? "checkbox" : "radio", attr: { name: `${request.id}-${index}` } });
        input.value = option.label;
        inputs.push(input);
        const text = label.createSpan({ cls: "opencode-session-view__question-option-text" });
        text.createSpan({ text: option.label, cls: "opencode-session-view__question-option-label" });
        if (option.description) text.createSpan({ text: option.description, cls: "opencode-session-view__question-option-description" });
      }
      const custom = question.custom === false ? undefined : block.createEl("input", { cls: "opencode-session-view__question-custom", attr: { type: "text", placeholder: "Custom answer…" } });
      answerControls.push(() => [...inputs.filter((input) => input.checked).map((input) => input.value), custom?.value.trim()].filter((item): item is string => !!item));
    });

    const actions = dock.createDiv({ cls: "opencode-session-view__request-actions" });
    const responding = this.respondingRequestIds.has(request.id);
    this.renderRequestButton(actions, "Reject", "", responding, () => void this.rejectQuestion(request));
    this.renderRequestButton(actions, "Answer", "mod-cta", responding, () => void this.replyQuestion(request, answerControls.map((readAnswer) => readAnswer())));
  }

  /** Sends answers for a question request and removes the dock optimistically on success. */
  private async replyQuestion(request: OpenCodeQuestionRequest, answers: OpenCodeQuestionAnswer[]): Promise<void> {
    if (this.respondingRequestIds.has(request.id)) return;
    if (answers.some((answer) => answer.length === 0)) {
      new Notice("Answer each question before submitting.");
      return;
    }
    this.respondingRequestIds.add(request.id);
    this.refreshRequestDocks();
    try {
      await this.plugin.requireOpenCodeService().replyQuestion(request.id, answers, this.sessionDirectory ?? this.draftDirectory);
      this.removePendingRequest(request.id);
      this.refreshRequestDocks();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refreshRequestDocks();
      new Notice(error instanceof Error ? error.message : "Unable to answer question request.");
    }
  }

  /** Rejects a question request and removes the dock optimistically on success. */
  private async rejectQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    if (this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    this.refreshRequestDocks();
    try {
      await this.plugin.requireOpenCodeService().rejectQuestion(request.id, this.sessionDirectory ?? this.draftDirectory);
      this.removePendingRequest(request.id);
      this.refreshRequestDocks();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refreshRequestDocks();
      new Notice(error instanceof Error ? error.message : "Unable to reject question request.");
    }
  }

  /** Creates a dock action button with common disabled handling. */
  private renderRequestButton(container: HTMLElement, text: string, cls: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = container.createEl("button", { text, cls });
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  /** Returns true while a permission/question dock must be answered before more input is sent. */
  private isComposerBlocked(): boolean {
    return this.pendingPermissions.length > 0 || this.pendingQuestions.length > 0;
  }

  /** Renders the QUEUED badge shown while the agent is streaming; colored with the active agent's color. */
  private renderQueuedBadge(container: HTMLElement): void {
    const badge = container.createSpan({ text: "QUEUED", cls: "opencode-session-view__queued-badge" });
    badge.toggleClass("is-visible", this.sessionBusy);
    const agent = this.visibleAgents().find((item) => this.agentName(item) === this.selectedAgent);
    const color = this.agentColor(agent);
    if (color) badge.style.setProperty("--opencode-agent-label-color", color);
  }

  /** Renders the send/stop button; click calls abort when busy + composer empty, otherwise sends. */
  private renderSendButton(container: HTMLElement, textarea: HTMLTextAreaElement): void {
    const stopMode = this.sessionBusy && !textarea.value.trim();
    const send = container.createEl("button", { cls: "opencode-session-view__composer-send mod-cta" });
    send.toggleClass("is-stop", stopMode);
    send.toggleClass("is-loading", this.submittingPrompt || this.abortingSession);
    send.toggleClass("is-confirming", this.pendingInterruptConfirm);
    if (stopMode) {
      setIcon(send, this.abortingSession ? "loader-2" : this.pendingInterruptConfirm ? "triangle-alert" : "square");
      const label = this.pendingInterruptConfirm ? "Press Esc again to interrupt" : "Interrupt session";
      send.setAttr("aria-label", label);
      send.title = label;
      send.disabled = this.abortingSession;
    } else {
      setIcon(send, this.submittingPrompt ? "loader-2" : "send");
      send.setAttr("aria-label", "Send prompt");
      send.title = `${Platform.isMacOS ? "⌘" : "Ctrl"}+Enter to send · Shift+Enter for newline`;
      send.disabled = this.isComposerBlocked() || this.submittingPrompt || !textarea.value.trim();
    }
    send.addEventListener("click", () => {
      if (stopMode) void this.abortCurrentSession();
      else void this.sendComposerPrompt();
    });
  }

  /** Aborts the current session via `POST /session/:id/abort`; clears any pending Esc-confirm state. */
  private async abortCurrentSession(): Promise<void> {
    if (this.abortingSession || !this.sessionId) return;
    this.abortingSession = true;
    this.pendingInterruptConfirm = false;
    if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
    this.interruptConfirmTimer = undefined;
    await this.refreshComposerOnly();
    try {
      await this.plugin.requireOpenCodeService().abortSession(this.sessionId, this.sessionDirectory ?? this.draftDirectory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to interrupt OpenCode session.");
    } finally {
      this.abortingSession = false;
      await this.refreshComposerOnly();
    }
  }

  /** Renders one compact boolean composer control; referenced by auto-approve and mute toggles. */
  private renderTogglePill(container: HTMLElement, label: string, icon: string, active: boolean, onClick: () => void, title: string): HTMLElement {
    const el = container.createSpan({ cls: "opencode-session-view__composer-toggle", attr: { role: "button", tabindex: "0", "aria-pressed": String(active), "aria-label": title } });
    el.toggleClass("is-active", active);
    el.toggleClass("is-icon-only", label.length === 0);
    el.title = title;
    setIcon(el, icon);
    if (label) el.createSpan({ text: label });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return el;
  }

  /** Renders selected absolute file chips above the composer textarea. */
  private renderAttachmentChips(container: HTMLElement, composerKey: string): void {
    const files = this.plugin.settings.sessionAttachedFiles[composerKey] ?? [];
    if (files.length === 0) return;
    const chips = container.createDiv({ cls: "opencode-session-view__attachment-chips" });
    for (const file of files) {
      const chip = chips.createEl("button", { cls: "opencode-session-view__attachment-chip", attr: { "aria-label": `Remove ${file}` } });
      setIcon(chip, "file-text");
      chip.createSpan({ text: this.compactHomePath(file) });
      const remove = chip.createSpan({ cls: "opencode-session-view__attachment-chip-remove" });
      setIcon(remove, "x");
      chip.addEventListener("click", () => void this.removeComposerAttachment(file));
    }
  }

  /** Opens Electron's native picker and stores selected absolute file paths as composer chips. */
  private async pickComposerFiles(): Promise<void> {
    const composerKey = this.composerStorageKey();
    if (!composerKey) return;
    try {
      const electronRequire = (window as unknown as { require?: NodeRequire }).require ?? require;
      const electron = electronRequire("electron") as { remote?: { dialog?: ElectronDialogBridge; getCurrentWindow?: () => unknown }; dialog?: ElectronDialogBridge };
      const dialog = electron.remote?.dialog ?? electron.dialog;
      if (!dialog) throw new Error("Electron file picker is unavailable in this Obsidian window.");
      const options = { properties: ["openFile", "multiSelections"] };
      const result = electron.remote?.getCurrentWindow
        ? await dialog.showOpenDialog(electron.remote.getCurrentWindow(), options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return;
      const existing = this.plugin.settings.sessionAttachedFiles[composerKey] ?? [];
      await this.plugin.rememberSessionAttachedFiles(composerKey, [...new Set([...existing, ...result.filePaths])]);
      await this.refreshComposerOnly();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to attach files.");
    }
  }

  /** Removes one selected file chip and re-renders only the composer shell. */
  private async removeComposerAttachment(file: string): Promise<void> {
    const composerKey = this.composerStorageKey();
    if (!composerKey) return;
    const files = (this.plugin.settings.sessionAttachedFiles[composerKey] ?? []).filter((item) => item !== file);
    await this.plugin.rememberSessionAttachedFiles(composerKey, files);
    await this.refreshComposerOnly();
  }

  /** Rebuilds the sticky composer while preserving draft text and the existing timeline. */
  private async refreshComposerOnly(): Promise<void> {
    const shell = this.contentEl.querySelector<HTMLElement>(".opencode-session-view__shell");
    if (!shell) return;
    const focused = document.activeElement === this.composerTextarea;
    this.persistComposerDraft();
    this.composerEl?.remove();
    this.renderComposer(shell, this.currentSession ?? {}, focused);
  }

  /** Shows a floating slash-command popover above the composer, styled like the model selection menu. */
  private updateSlashMenu(textarea: HTMLTextAreaElement): void {
    const candidates = this.slashCommandCandidates(textarea).slice(0, 8);
    if (candidates.length === 0) {
      this.hideSlashMenu();
      return;
    }
    if (!this.composerSlashMenuEl) {
      this.composerSlashMenuEl = document.body.createDiv({ cls: "opencode-slash-menu" });
      this.slashMenuOutsideClick = (event: MouseEvent) => {
        if (!this.composerSlashMenuEl?.contains(event.target as Node) && event.target !== textarea) this.hideSlashMenu();
      };
      document.addEventListener("mousedown", this.slashMenuOutsideClick, true);
    }
    const menu = this.composerSlashMenuEl;
    menu.empty();
    this.slashMenuRows = [];
    for (const command of candidates) {
      const row = menu.createDiv({ cls: "opencode-slash-menu__row" });
      row.createSpan({ text: `/${command.name}`, cls: "opencode-slash-menu__name" });
      if (command.description) row.createSpan({ text: command.description, cls: "opencode-slash-menu__description" });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSlashCommand(textarea, command.name);
      });
      this.slashMenuRows.push(row);
    }
    this.slashMenuHighlight = 0;
    this.updateSlashMenuHighlight();
    this.positionSlashMenu(textarea);
  }

  /** Positions the popover above the textarea, clamped to the viewport. */
  private positionSlashMenu(textarea: HTMLTextAreaElement): void {
    if (!this.composerSlashMenuEl) return;
    const rect = textarea.getBoundingClientRect();
    const menuWidth = 360;
    const menuEl = this.composerSlashMenuEl;
    let left = rect.left;
    let top = rect.top - 4;
    menuEl.style.width = `${menuWidth}px`;
    const menuHeight = menuEl.offsetHeight;
    top = Math.max(8, top - menuHeight);
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  /** Applies the highlight class to the current slash menu selection. */
  private updateSlashMenuHighlight(): void {
    this.slashMenuRows.forEach((row, idx) => row.toggleClass("is-highlighted", idx === this.slashMenuHighlight));
    const highlighted = this.slashMenuRows[this.slashMenuHighlight];
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }

  /** Hides and removes the slash menu popover. */
  private hideSlashMenu(): void {
    this.composerSlashMenuEl?.remove();
    this.composerSlashMenuEl = undefined;
    this.slashMenuRows = [];
    this.slashMenuHighlight = -1;
    if (this.slashMenuOutsideClick) {
      document.removeEventListener("mousedown", this.slashMenuOutsideClick, true);
      this.slashMenuOutsideClick = undefined;
    }
  }

  /** Handles keyboard navigation for the slash-command popover. Returns true if the event was consumed. */
  private handleSlashMenuKeydown(event: KeyboardEvent, textarea: HTMLTextAreaElement): boolean {
    if (!this.composerSlashMenuEl) return false;
    if (event.key === "Escape") {
      this.hideSlashMenu();
      event.preventDefault();
      return true;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.slashMenuHighlight = Math.min(this.slashMenuHighlight + 1, this.slashMenuRows.length - 1);
      this.updateSlashMenuHighlight();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.slashMenuHighlight = Math.max(this.slashMenuHighlight - 1, 0);
      this.updateSlashMenuHighlight();
      return true;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      const row = this.slashMenuRows[this.slashMenuHighlight] ?? this.slashMenuRows[0];
      if (!row) return false;
      event.preventDefault();
      const name = this.slashCommandCandidates(textarea)[this.slashMenuHighlight]?.name ?? this.slashCommandCandidates(textarea)[0]?.name;
      if (name) this.insertSlashCommand(textarea, name);
      return true;
    }
    return false;
  }

  /** Returns built-in commands visible under current config + session state. Mirrors TUI/GUI gating logic. */
  private visibleBuiltinCommands(): { name: string; description: string }[] {
    const shareEnabled = this.readString(this.serverConfig ?? {}, ["share"]) !== "disabled";
    const shareObj = this.readObject(this.currentSession ?? {}, "share");
    const revertObj = this.readObject(this.currentSession ?? {}, "revert");
    const sessionShared = !!shareObj?.url;
    const canRedo = !!revertObj?.messageID;
    return ALL_BUILTIN_COMMANDS.filter((cmd) => {
      if (cmd.name === "share") return shareEnabled;
      if (cmd.name === "unshare") return shareEnabled && sessionShared;
      if (cmd.name === "redo") return canRedo;
      return true;
    });
  }

  /** Returns slash commands (server + built-in) matching the token currently being typed at the start of the composer. */
  private slashCommandCandidates(textarea: HTMLTextAreaElement): Array<{ name: string; description?: string }> {
    const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
    const match = beforeCursor.match(/^\/([^\s/]*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    const serverCommands = this.availableCommands
      .filter((command) => {
        if (this.readString(command, ["source"]) === "skill") return false;
        const name = this.commandName(command)?.toLowerCase();
        return name ? name.includes(query) : false;
      })
      .map((command) => ({ name: this.commandName(command)!, description: this.readString(command, ["description", "summary"]) }));
    const builtin = this.visibleBuiltinCommands().filter((cmd) => cmd.name.toLowerCase().includes(query));
    return [...serverCommands, ...builtin].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Replaces the current slash token with the selected command and leaves room for arguments. */
  private insertSlashCommand(textarea: HTMLTextAreaElement, name: string): void {
    const rest = textarea.value.slice(textarea.selectionStart).replace(/^\S*/, "");
    textarea.value = `/${name} ${rest}`;
    textarea.selectionStart = textarea.selectionEnd = name.length + 2;
    this.resizeComposerInput(textarea);
    this.hideSlashMenu();
    this.scheduleDraftSave();
    textarea.focus();
  }

  /** Renders the model-variant/thinking control; variants are OpenCode's reasoning/model-effort presets. */
  private renderThinkingPill(container: HTMLElement): void {
    const variants = this.modelVariants(this.selectedModel);
    const label = this.selectedModel?.variant ?? "off";
    const el = container.createSpan({ cls: "opencode-session-view__thinking-pill", attr: { role: "button", tabindex: "0" } });
    const icon = el.createSpan({ cls: "opencode-session-view__thinking-pill-icon" });
    setIcon(icon, "brain");
    el.createSpan({ text: label });
    el.title = variants.length > 0 ? "Cycle reasoning mode" : "This model exposes no reasoning variants";
    el.setAttr("aria-label", "Cycle reasoning mode");
    el.toggleClass("is-disabled", !this.selectedModel);
    el.toggleClass("is-empty", variants.length === 0);
    el.addEventListener("click", () => void this.cycleThinkingVariant());
  }

  /** Renders the selected model pill and its dropdown from `model.list`. */
  private renderModelPill(container: HTMLElement): void {
    const label = this.selectedModel ? this.modelShortLabelForRef(this.selectedModel) : "No model";
    const el = container.createSpan({ cls: "opencode-session-view__model-pill", attr: { role: "button", tabindex: "0" } });
    if (this.selectedModel) {
      const icon = el.createSpan({ cls: "opencode-session-view__model-pill-icon" });
      setProviderIcon(icon, this.selectedModel.providerID, 14);
    }
    el.createSpan({ text: label });
    el.title = this.selectedModel ? `Switch model · ${this.modelLabelForRef(this.selectedModel)}` : "Switch model";
    el.setAttr("aria-label", "Switch model");
    el.addEventListener("click", (event) => {
      event.preventDefault();
      void this.showModelMenu(event as MouseEvent);
    });
  }

  /** Loads models if needed and opens the custom model selection popover. */
  private async showModelMenu(event: MouseEvent): Promise<void> {
    if (this.availableModelRefs().length === 0) await this.loadAvailableModels();
    const entries = this.buildModelEntries();
    if (entries.length === 0) {
      new Notice("No OpenCode models are available from the server yet.");
      return;
    }
    this.modelMenuInstance?.close();
    this.modelMenuInstance = new ModelSelectionMenu({
      entries,
      selectedModel: this.selectedModel,
      favorites: this.plugin.settings.favoriteModels,
      anchorEl: event.currentTarget as HTMLElement,
      onSelect: (ref) => void this.chooseComposerModel(ref),
      onToggleFavorite: (ref) => { void this.plugin.toggleFavoriteModel(ref); },
    });
  }

  /** Builds ModelEntry[] from raw model info objects for the selection menu. */
  private buildModelEntries(): ModelEntry[] {
    return this.availableModels
      .filter((item) => item.enabled !== false)
      .map((item): ModelEntry | null => {
        const ref = this.modelRefFromInfo(item);
        if (!ref) return null;
        const name = this.readString(item, ["name", "id", "modelID", "modelId"]) ?? ref.modelID;
        return { providerID: ref.providerID, modelID: ref.modelID, name, variants: this.modelVariants(ref) };
      })
      .filter((e): e is ModelEntry => e !== null);
  }

  /** Refreshes the directory-scoped model catalog used by the model and reasoning pills. */
  private async loadAvailableModels(): Promise<void> {
    try {
      this.availableModels = await this.plugin.requireOpenCodeService().listModels(this.sessionDirectory ?? this.draftDirectory);
    } catch (error) {
      console.warn("[opencode-plugin:composer] model catalog failed", error);
      this.availableModels = [];
    }
  }

  /** Renders the active-agent selector; the chosen agent is sent with the next prompt. */
  /** Converts an agent ID to Title Case for display (e.g. "code-review" → "Code Review"). Referenced by renderAgentLabel(). */
  private titleCaseAgent(name: string): string {
    return name.split(/[\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  private renderAgentLabel(container: HTMLElement, session: JsonObject): void {
    const agent = this.selectedAgent ?? this.readString(session, ["agent"]) ?? "default";
    const el = container.createSpan({ cls: "opencode-session-view__agent-label", attr: { role: "button", tabindex: "0" } });
    el.title = "Switch agent";
    el.setAttr("aria-label", "Switch agent");
    const info = this.visibleAgents().find((item) => this.agentName(item) === agent);
    const color = this.agentColor(info);
    if (color) el.style.setProperty("--opencode-agent-label-color", color);
    const icon = el.createSpan({ cls: "opencode-session-view__agent-label-icon" });
    setIcon(icon, "bot");
    el.createSpan({ text: this.titleCaseAgent(agent), cls: "opencode-session-view__agent-label-text" });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const menu = new Menu();
      const agents = this.visibleAgents();
      for (const item of agents) {
        const name = this.agentName(item);
        if (!name) continue;
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(this.titleCaseAgent(name))
            .setIcon(name === agent ? "check" : "bot")
            .onClick(() => void this.chooseComposerAgent(name)),
        );
      }
      if (agents.length === 0) menu.addItem((item) => item.setTitle("No visible primary agents").setDisabled(true));
      menu.showAtMouseEvent(event as MouseEvent);
    });
  }

  /** Updates the composer agent choice and persists it for this session; the next send carries it via the per-prompt `agent` field. */
  private async chooseComposerAgent(agent: string): Promise<void> {
    const composerKey = this.composerStorageKey();
    if (!composerKey) return;
    this.selectedAgent = agent;
    this.selectedModel = this.modelForAgent(agent) ?? this.selectedModel;
    await this.plugin.rememberSessionAgentChoice(composerKey, agent);
    if (this.currentSession) this.currentSession = { ...this.currentSession, agent };
    await this.refreshComposerOnly();
  }

  /** Updates the composer model/variant; the next send carries it via the per-prompt `model` field. */
  private async chooseComposerModel(model: OpenCodeModelRef): Promise<void> {
    const composerKey = this.composerStorageKey();
    if (!composerKey) return;
    this.selectedModel = model;
    await this.plugin.rememberSessionModelChoice(composerKey, model);
    if (this.currentSession) this.currentSession = { ...this.currentSession, model: { providerID: model.providerID, id: model.modelID, variant: model.variant } };
    await this.refreshComposerOnly();
  }

  /** Cycles the current model's configured variants, treating no variant as thinking off/default. */
  private async cycleThinkingVariant(): Promise<void> {
    if (!this.selectedModel) return;
    if (this.availableModels.length === 0) await this.loadAvailableModels();
    const variants = this.modelVariants(this.selectedModel);
    if (variants.length === 0) {
      new Notice("This model does not expose reasoning variants.");
      return;
    }
    const current = this.selectedModel.variant;
    const index = current ? variants.indexOf(current) : -1;
    const firstEnabled = variants.find((variant) => !this.isOffReasoningVariant(variant)) ?? variants[0];
    const offVariant = variants.find((variant) => this.isOffReasoningVariant(variant));
    const next = index < 0 ? firstEnabled : index === variants.length - 1 ? offVariant : variants[index + 1];
    await this.chooseComposerModel({ ...this.selectedModel, variant: next });
  }

  /** Toggles client-side auto-approval and immediately clears existing permission docks when enabled. */
  private async toggleAutoApprove(): Promise<void> {
    const key = this.composerStorageKey();
    if (!key) return;
    const enabled = !this.shouldAutoApprovePermissions();
    await this.plugin.rememberSessionAutoApprove(key, enabled);
    if (enabled) await this.autoApprovePendingPermissions();
    await this.refreshComposerOnly();
  }

  /** Toggles local notification muting for the current session/draft. */
  private async toggleMute(): Promise<void> {
    const key = this.composerStorageKey();
    if (!key) return;
    await this.plugin.rememberSessionMute(key, !this.isSessionMuted());
    await this.refreshComposerOnly();
  }

  /** Handles keyboard send, interrupt, and prompt-history navigation in the composer textarea. */
  private handleComposerKeydown(event: KeyboardEvent): void {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    if (this.handleSlashMenuKeydown(event, textarea)) return;
    // Stop-button Esc confirmation: only active when agent is running and composer is empty.
    if (event.key === "Escape" && this.sessionBusy && !textarea.value.trim() && !this.abortingSession) {
      event.preventDefault();
      event.stopPropagation();
      if (this.pendingInterruptConfirm) {
        void this.abortCurrentSession();
      } else {
        this.pendingInterruptConfirm = true;
        const seconds = Math.max(1, Math.floor(this.plugin.settings.interruptConfirmSeconds ?? 3));
        this.interruptConfirmTimer = window.setTimeout(() => {
          this.pendingInterruptConfirm = false;
          this.interruptConfirmTimer = undefined;
          void this.refreshComposerOnly();
        }, seconds * 1000);
        void this.refreshComposerOnly();
      }
      return;
    }
    const sendModifier = Platform.isMacOS ? event.metaKey : event.ctrlKey;
    if (sendModifier && (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")) {
      event.preventDefault();
      event.stopPropagation();
      void this.sendComposerPrompt();
      return;
    }
    if (event.key === "ArrowUp" && this.isComposerAtStart(textarea)) {
      if (this.navigatePromptHistory(1)) event.preventDefault();
    }
    if (event.key === "ArrowDown" && this.isComposerAtEnd(textarea)) {
      if (this.navigatePromptHistory(-1)) event.preventDefault();
    }
  }

  /** Captures macOS Command+Enter before Obsidian's global hotkey layer consumes it. */
  private handleGlobalComposerSend = (event: KeyboardEvent): void => {
    if (!Platform.isMacOS || !event.metaKey) return;
    if (document.activeElement !== this.composerTextarea) return;
    if (event.key !== "Enter" && event.code !== "Enter" && event.code !== "NumpadEnter") return;
    event.preventDefault();
    event.stopPropagation();
    void this.sendComposerPrompt();
  };

  /** Sends the current composer prompt through OpenCode prompt/command endpoints. */
  private async sendComposerPrompt(): Promise<void> {
    const composerKey = this.composerStorageKey();
    if (!composerKey || this.submittingPrompt || this.isComposerBlocked()) return;
    const text = this.composerTextarea?.value.trim() ?? "";
    if (!text) return;
    // Per spec: while streaming, the composer stays enabled and prompts queue server-side.
    if (this.sessionBusy) this.pendingQueuedUserMessages += 1;
    this.enableFollowLatest();
    this.submittingPrompt = true;
    let targetSessionId = this.sessionId;
    let createdTitle: string | undefined;
    try {
      if (!targetSessionId) {
        const promptDirectory = this.draftDirectory ?? this.sessionDirectory;
        const created = await this.plugin.requireOpenCodeService().createSession(
          {
            agent: this.selectedAgent,
            model: this.selectedModel
              ? { providerID: this.selectedModel.providerID, id: this.selectedModel.modelID, variant: this.selectedModel.variant }
              : undefined,
          },
          promptDirectory,
        );
        targetSessionId = created.id;
        createdTitle = created.title;
        await this.plugin.promoteSessionDraft(composerKey, targetSessionId);
        await this.promoteDraftView(targetSessionId, createdTitle);
        await this.plugin.refreshAgentPanels({ showLoading: false });
      }

      const directory = this.sessionDirectory ?? this.draftDirectory;
      const fileParts = this.composerFileParts(targetSessionId);
      const builtinName = text.trim().match(/^\/(\w+)$/)?.[1];
      if (builtinName && this.visibleBuiltinCommands().some((c) => c.name === builtinName)) {
        await this.executeBuiltinCommand(builtinName, targetSessionId, directory);
      } else {
        const slash = this.parseSlashCommand(text);
        if (slash) {
          await this.plugin.requireOpenCodeService().runCommand(
            targetSessionId,
            {
              agent: this.selectedAgent,
              model: this.selectedModel ? `${this.selectedModel.providerID}/${this.selectedModel.modelID}` : undefined,
              variant: this.selectedModel?.variant,
              command: slash.command,
              arguments: slash.arguments,
              parts: fileParts,
            },
            directory,
          );
        } else {
          await this.plugin.requireOpenCodeService().sendPromptAsync(
            targetSessionId,
            {
              agent: this.selectedAgent,
              model: this.selectedModel
                ? { providerID: this.selectedModel.providerID, modelID: this.selectedModel.modelID }
                : undefined,
              variant: this.selectedModel?.variant,
              parts: [{ type: "text", text }, ...fileParts],
            },
            directory,
          );
        }
      }
      if (this.composerTextarea) {
        this.composerTextarea.value = "";
        this.resizeComposerInput(this.composerTextarea);
        this.updateComposerInsetSoon();
      }
      await this.plugin.rememberSessionDraft(targetSessionId, "");
      await this.plugin.rememberSessionAttachedFiles(targetSessionId, []);
      await this.plugin.rememberPromptHistory(targetSessionId, text);
      this.historyIndex = -1;
      this.submittingPrompt = false;
      await this.refreshComposerOnly();
      this.scrollToBottom(false);
    } catch (error) {
      this.disableFollowLatest();
      // Roll back the queue counter so the next successful send does not paint a stale QUEUED badge.
      if (this.pendingQueuedUserMessages > 0) this.pendingQueuedUserMessages -= 1;
      if (targetSessionId && this.draftId) await this.promoteDraftView(targetSessionId, createdTitle);
      new Notice(error instanceof Error ? error.message : "Unable to send OpenCode prompt.");
    } finally {
      this.submittingPrompt = false;
      if (this.composerTextarea) this.composerTextarea.disabled = false;
      this.composerTextarea?.focus();
    }
  }

  /** Determines the current composer agent from persisted choice, session state, or latest user message. */
  private composerAgentFromState(session: JsonObject): string | undefined {
    const key = this.composerStorageKey();
    const requested = (key ? this.plugin.settings.sessionAgentChoices[key] : undefined) ?? this.readString(session, ["agent"]) ?? this.latestUserAgent();
    const visible = this.visibleAgents();
    if (requested && visible.some((item) => this.agentName(item) === requested)) return requested;
    return this.agentName(visible[0] ?? {});
  }

  /** Filters agents exactly like OpenCode desktop: no subagents and no hidden internal agents. */
  private visibleAgents(): JsonObject[] {
    return this.availableAgents.filter((item) => this.readString(item, ["mode"]) !== "subagent" && item.hidden !== true);
  }

  /** Reads the display/ID field used by OpenCode agent objects across protocol versions. */
  private agentName(agent: JsonObject): string | undefined {
    return this.readString(agent, ["name", "id"]);
  }

  /** Resolves a CSS color for the agent label without leaking color to other UI surfaces. */
  private agentColor(agent: JsonObject | undefined): string | undefined {
    const color = agent ? this.readString(agent, ["color"]) : undefined;
    if (!color) return undefined;
    const named: Record<string, string> = {
      primary: "var(--interactive-accent)",
      secondary: "var(--text-muted)",
      accent: "var(--interactive-accent)",
      success: "var(--color-green)",
      warning: "var(--color-orange)",
      error: "var(--color-red)",
      info: "var(--color-blue)",
    };
    return named[color] ?? color;
  }

  /** Resolves an agent-configured model and variant for session creation and prompt submission. */
  private modelForAgent(agentName: string | undefined): OpenCodeModelRef | undefined {
    const agent = this.visibleAgents().find((item) => this.agentName(item) === agentName);
    const model = agent ? this.readObject(agent, "model") : undefined;
    const providerID = model ? this.readString(model, ["providerID", "providerId"]) : undefined;
    const modelID = model ? this.readString(model, ["modelID", "modelId", "id"]) : undefined;
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID, variant: agent ? this.readString(agent, ["variant"]) : undefined };
  }

  /** Determines the composer model from persisted choice, session state, agent default, or first available model. */
  private composerModelFromState(session: JsonObject, agentName: string | undefined): OpenCodeModelRef | undefined {
    const key = this.composerStorageKey();
    const saved = key ? this.plugin.settings.sessionModelChoices[key] : undefined;
    if (saved?.providerID && saved.modelID) return saved;
    const sessionModel = this.readObject(session, "model");
    const sessionProvider = sessionModel ? this.readString(sessionModel, ["providerID", "providerId"]) : undefined;
    const sessionModelID = sessionModel ? this.readString(sessionModel, ["modelID", "modelId", "id"]) : undefined;
    if (sessionProvider && sessionModelID) return { providerID: sessionProvider, modelID: sessionModelID, variant: sessionModel ? this.readString(sessionModel, ["variant"]) : undefined };
    return this.modelForAgent(agentName) ?? this.availableModelRefs()[0];
  }

  /** Lists enabled model references from OpenCode's directory-scoped `model.list`. */
  private availableModelRefs(): OpenCodeModelRef[] {
    return this.availableModels.flatMap((item) => {
      if (item.enabled === false) return [];
      const providerID = this.readString(item, ["providerID", "providerId"]);
      const modelID = this.readString(item, ["modelID", "modelId", "id"]);
      if (!providerID || !modelID) return [];
      return [{ providerID, modelID }];
    });
  }

  /** Returns true when two model refs point at the same provider/model pair. */
  private sameModel(left: OpenCodeModelRef | undefined, right: OpenCodeModelRef | undefined): boolean {
    return !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID;
  }

  /** Produces a concise provider/model label for menus and the composer pill. */
  private modelLabelForRef(ref: OpenCodeModelRef): string {
    const info = this.availableModels.find((item) => this.sameModel(this.modelRefFromInfo(item), ref));
    const name = info ? this.readString(info, ["name", "id", "modelID", "modelId"]) : undefined;
    const base = name ?? ref.modelID;
    return ref.variant ? `${base} · ${ref.providerID} · ${ref.variant}` : `${base} · ${ref.providerID}`;
  }

  /** Produces the compact model pill label, keeping provider details in the tooltip/menu. */
  private modelShortLabelForRef(ref: OpenCodeModelRef): string {
    const info = this.availableModels.find((item) => this.sameModel(this.modelRefFromInfo(item), ref));
    return (info ? this.readString(info, ["name", "id", "modelID", "modelId"]) : undefined) ?? ref.modelID;
  }

  /** Detects variant names that OpenCode models use for disabled/off reasoning. */
  private isOffReasoningVariant(variant: string): boolean {
    const normalized = variant.toLowerCase().replace(/[_-]+/g, " ").trim();
    return normalized === "none" || normalized === "off" || normalized === "disabled" || normalized === "no reasoning";
  }

  /** Reads a model reference from a loose OpenCode model object. */
  private modelRefFromInfo(info: JsonObject): OpenCodeModelRef | undefined {
    const providerID = this.readString(info, ["providerID", "providerId"]);
    const modelID = this.readString(info, ["modelID", "modelId", "id"]);
    return providerID && modelID ? { providerID, modelID } : undefined;
  }

  /** Reads variant IDs from model metadata, supporting both array and object encodings. */
  private modelVariants(ref: OpenCodeModelRef | undefined): string[] {
    if (!ref) return [];
    const info = this.availableModels.find((item) => this.sameModel(this.modelRefFromInfo(item), ref));
    const raw = info?.variants;
    if (Array.isArray(raw)) return raw.flatMap((item) => (item && typeof item === "object" ? [this.readString(item as JsonObject, ["id", "name"])] : typeof item === "string" ? [item] : [])).filter((item): item is string => !!item);
    if (raw && typeof raw === "object") return Object.keys(raw);
    return [];
  }

  /** Reads the command identifier from loose command-list entries. */
  private commandName(command: JsonObject): string | undefined {
    return this.readString(command, ["name", "id", "command"]);
  }

  /** Parses a composer buffer as a known slash command submission. */
  private parseSlashCommand(text: string): { command: string; arguments: string } | undefined {
    const match = text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    if (!match) return undefined;
    const command = match[1];
    if (!this.availableCommands.some((item) => this.commandName(item) === command && this.readString(item, ["source"]) !== "skill")) return undefined;
    return { command, arguments: match[2] ?? "" };
  }

  /** Executes a built-in functional command by calling the corresponding v1 session API endpoint. Referenced by sendComposerPrompt(). */
  private async executeBuiltinCommand(command: string, sessionId: string, directory?: string): Promise<void> {
    const service = this.plugin.requireOpenCodeService();
    switch (command) {
      case "compact":
        await service.summarizeSession(sessionId, directory);
        break;
      case "undo":
        await service.revertSession(sessionId, directory);
        break;
      case "redo":
        await service.unrevertSession(sessionId, directory);
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

  /** Converts selected composer attachment paths to prompt file parts. */
  private composerFileParts(key: string): Array<{ type: "file"; url: string; filename: string; mime: string }> {
    return (this.plugin.settings.sessionAttachedFiles[key] ?? []).map((file) => ({
      type: "file" as const,
      url: pathToFileURL(file).href,
      filename: file,
      mime: "text/plain",
    }));
  }

  /** Returns true when the per-session composer toggle should auto-allow permission prompts once. */
  private shouldAutoApprovePermissions(): boolean {
    const key = this.composerStorageKey();
    return !!key && this.plugin.settings.sessionAutoApprove[key] === true;
  }

  /** Returns true when the current session/draft is locally muted. */
  private isSessionMuted(): boolean {
    const key = this.composerStorageKey();
    return !!key && this.plugin.settings.sessionMute[key] === true;
  }

  /** Auto-replies to all visible pending permissions if the composer auto-approve toggle is enabled. */
  private async autoApprovePendingPermissions(): Promise<void> {
    if (!this.shouldAutoApprovePermissions() || this.pendingPermissions.length === 0) return;
    const requests = [...this.pendingPermissions];
    this.pendingPermissions = [];
    this.refreshRequestDocks();
    await Promise.all(requests.map((request) => this.autoReplyPermission(request)));
  }

  /** Sends a client-side auto-approval reply without surfacing a permission dock. */
  private async autoReplyPermission(request: OpenCodePermissionRequest): Promise<void> {
    if (!request.id || request.sessionID !== this.sessionId || this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    try {
      await this.plugin.requireOpenCodeService().replyPermission(request.id, "once", this.sessionDirectory ?? this.draftDirectory);
      this.removePendingRequest(request.id);
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.upsertPendingPermission(request);
      this.refreshRequestDocks();
      new Notice(error instanceof Error ? error.message : "Unable to auto-approve permission request.");
    }
  }

  /** Promotes this Obsidian draft leaf to a normal server-backed session leaf. */
  private async promoteDraftView(sessionId: string, sessionTitle?: string): Promise<void> {
    this.sessionId = sessionId;
    this.sessionTitle = sessionTitle;
    this.draftId = undefined;
    this.draftDirectory = undefined;
    await this.leaf.setViewState({ type: VIEW_TYPE_OPENCODE_SESSION, state: { sessionId, sessionTitle }, active: true });
    await this.plugin.updateDiffPanelContext(this.diffPanelContext(), { force: true });
  }

  /** Returns the persistence key for either a server session or a client-only draft. */
  private composerStorageKey(): string | undefined {
    return this.sessionId ?? (this.draftId ? `draft:${this.draftId}` : undefined);
  }

  /** Reads the latest user-message agent for composer fallback display. */
  private latestUserAgent(): string | undefined {
    for (const bundle of [...this.loadedMessages].reverse()) {
      if (this.messageRole(bundle) !== "user") continue;
      const agent = this.readString(bundle.info, ["agent"]);
      if (agent) return agent;
    }
    return undefined;
  }

  /** Saves the currently mounted composer text to plugin data. */
  private persistComposerDraft(): void {
    const key = this.composerStorageKey();
    if (!key || !this.composerTextarea) return;
    void this.plugin.rememberSessionDraft(key, this.composerTextarea.value);
  }

  /** Debounces draft persistence for normal typing. */
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = undefined;
      this.persistComposerDraft();
    }, 400);
  }

  /** Autosizes the composer textarea while keeping it bounded. */
  private resizeComposerInput(textarea: HTMLTextAreaElement): void {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }

  /** Captures text selection and focus so token renders do not disrupt active drafting. */
  private captureComposerDomState(): ComposerDomState | undefined {
    const textarea = this.composerTextarea;
    if (!textarea?.isConnected) return undefined;
    return {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      focused: document.activeElement === textarea,
    };
  }

  /** Restores composer DOM state after a streaming timeline reconciliation. */
  private restoreComposerDomState(state: ComposerDomState | undefined): void {
    if (!state || !this.composerTextarea) return;
    this.composerTextarea.value = state.value;
    this.resizeComposerInput(this.composerTextarea);
    this.composerTextarea.setSelectionRange(state.selectionStart, state.selectionEnd);
    if (state.focused) this.composerTextarea.focus({ preventScroll: true });
  }

  /** Returns true when ArrowUp should traverse prompt history. */
  private isComposerAtStart(textarea: HTMLTextAreaElement): boolean {
    return textarea.selectionStart === 0 && textarea.selectionEnd === 0;
  }

  /** Returns true when ArrowDown should traverse prompt history. */
  private isComposerAtEnd(textarea: HTMLTextAreaElement): boolean {
    return textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length;
  }

  /** Navigates previously sent prompts in the mounted composer textarea. */
  private navigatePromptHistory(delta: 1 | -1): boolean {
    const key = this.composerStorageKey();
    if (!key || !this.composerTextarea) return false;
    const history = this.plugin.settings.sessionPromptHistory[key] ?? [];
    if (history.length === 0) return false;
    this.historyIndex = Math.min(history.length - 1, Math.max(-1, this.historyIndex + delta));
    this.composerTextarea.value = this.historyIndex === -1 ? (this.plugin.settings.sessionDrafts[key] ?? "") : history[this.historyIndex];
    this.resizeComposerInput(this.composerTextarea);
    this.scheduleDraftSave();
    return true;
  }

  /** Extracts the user-facing session title used by the Obsidian tab and in-view header. */
  private sessionTitleFromSession(session: JsonObject): string {
    return this.readString(session, ["title", "name", "slug"]) ?? this.sessionId ?? "OpenCode session";
  }

  /** Reads the workspace directory used for directory-scoped agent and prompt APIs. */
  private sessionDirectoryFromSession(session: JsonObject): string | undefined {
    return this.readString(session, ["directory", "cwd"]);
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

  /** Renders one user/assistant message block. */
  private async renderMessage(container: HTMLElement, bundle: OpenCodeMessageBundle, options: MessageRenderOptions): Promise<void> {
    if (this.isCompactionMessage(bundle)) {
      await this.renderCompactionDivider(container, bundle);
      return;
    }

    const role = this.messageRole(bundle);

    if (role === "assistant") {
      await this.renderAssistantParts(container, bundle.parts, bundle.info);
      if (options.showAssistantMeta) this.renderMessageMeta(container, bundle, "assistant", options.assistantTurnText);
      return;
    }

    const text = this.userMessageText(bundle);
    const images = this.imageAttachments(bundle);
    if (!text.trim() && images.length === 0) return;

    const wrapper = container.createDiv({ cls: "opencode-session-view__user-message-wrap" });
    const article = wrapper.createDiv({ cls: `opencode-session-view__message opencode-session-view__message--${role}` });
    this.renderImageAttachments(article, images);
    if (text.trim()) {
      const body = article.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
      await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
    }
    this.renderMessageMeta(wrapper, bundle, "user", text);
  }

  /** Decides whether this visible assistant message is the final step of an assistant turn. */
  private messageRenderOptions(messages: OpenCodeMessageBundle[], index: number): MessageRenderOptions {
    const bundle = messages[index];
    if (this.messageRole(bundle) !== "assistant" || this.isCompactionMessage(bundle)) return { showAssistantMeta: false, assistantTurnText: "" };
    const next = messages[index + 1];
    const showAssistantMeta = !next || this.messageRole(next) !== "assistant" || this.isCompactionMessage(next);
    if (!showAssistantMeta) return { showAssistantMeta, assistantTurnText: "" };

    let start = index;
    while (start > 0 && this.messageRole(messages[start - 1]) === "assistant" && !this.isCompactionMessage(messages[start - 1])) start -= 1;
    const assistantTurnText = messages.slice(start, index + 1).map((message) => this.textFromParts(message.parts)).filter((text) => text.trim()).join("\n\n");
    return { showAssistantMeta, assistantTurnText };
  }

  /** Renders a muted metadata row plus a message-level copy button. */
  private renderMessageMeta(container: HTMLElement, bundle: OpenCodeMessageBundle, role: "assistant" | "user", copyText: string): void {
    const items = role === "assistant" ? this.assistantMetaItems(bundle) : this.userMetaItems(bundle);
    if (items.length === 0 && !copyText.trim()) return;

    const meta = container.createDiv({ cls: `opencode-session-view__message-meta opencode-session-view__message-meta--${role}` });
    if (items.length > 0) meta.createSpan({ text: items.join(" · "), cls: "opencode-session-view__message-meta-text" });
    if (role === "user" && this.queuedMessageIds.has(this.messageId(bundle))) meta.createSpan({ text: "QUEUED", cls: "opencode-session-view__queued-badge is-visible" });
    if (!copyText.trim()) return;

    const copy = meta.createEl("button", { attr: { "aria-label": `Copy ${role} message` }, cls: "opencode-session-view__message-copy clickable-icon" });
    setIcon(copy, "copy");
    copy.addEventListener("click", async (event) => {
      event.stopPropagation();
      await navigator.clipboard.writeText(copyText);
      setIcon(copy, "check");
      window.setTimeout(() => setIcon(copy, "copy"), 1400);
    });
  }

  /** Builds the lean user-message metadata fields from message time. */
  private userMetaItems(bundle: OpenCodeMessageBundle): string[] {
    const time = this.messageTime(bundle);
    return time ? [new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(time)] : [];
  }

  /** Builds assistant turn metadata from agent/model/time/error fields. */
  private assistantMetaItems(bundle: OpenCodeMessageBundle): string[] {
    const items = [this.capitalized(this.readString(bundle.info, ["agent"])), this.modelLabel(bundle.info), this.durationLabel(bundle.info)].filter((item): item is string => !!item);
    const error = this.readObject(bundle.info, "error");
    if (this.readString(error ?? {}, ["name", "type"]) === "MessageAbortedError") items.push("Interrupted");
    return items;
  }

  /** Normalizes v1 role and v2 type fields into renderer role names. */
  private messageRole(bundle: OpenCodeMessageBundle): string {
    const role = this.readString(bundle.info, ["role"]);
    if (role) return role;
    const type = this.readString(bundle.info, ["type"]);
    if (type === "user" || type === "assistant") return type;
    return "assistant";
  }

  /** Renders clickable, bounded image thumbnails attached to a user message. */
  private renderImageAttachments(container: HTMLElement, images: ImageAttachment[]): void {
    if (images.length === 0) return;
    const grid = container.createDiv({ cls: "opencode-session-view__attachments" });
    for (const image of images) {
      const button = grid.createEl("button", { attr: { "aria-label": `Open image ${image.name}` }, cls: "opencode-session-view__attachment" });
      button.createEl("img", { attr: { src: image.url, alt: image.name, loading: "lazy" }, cls: "opencode-session-view__attachment-image" });
      button.createSpan({ text: image.name, cls: "opencode-session-view__attachment-name" });
      button.addEventListener("click", () => this.openImagePreview(image));
    }
  }

  /** Opens an image inspection modal for user-message attachments. */
  private openImagePreview(image: ImageAttachment): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText(image.name);
    modal.contentEl.addClass("opencode-session-view__image-modal");
    modal.contentEl.createEl("img", { attr: { src: image.url, alt: image.name }, cls: "opencode-session-view__image-modal-img" });
    modal.open();
  }

  /** Extracts text for user messages from parts first, then v2 info.text fallback. */
  private userMessageText(bundle: OpenCodeMessageBundle): string {
    return this.textFromParts(bundle.parts) || this.readString(bundle.info, ["text"]) || "";
  }

  /** Finds image file parts/attachments attached to a user message. */
  private imageAttachments(bundle: OpenCodeMessageBundle): ImageAttachment[] {
    const candidates = [
      ...bundle.parts.filter((part) => this.readString(part, ["type"]) === "file"),
      ...this.readObjectArray(bundle.info, "files"),
      ...this.readObjectArray(bundle.info, "attachments"),
    ];
    return candidates.flatMap((file) => {
      const url = this.attachmentUrl(file);
      const name = this.readString(file, ["filename", "name", "uri", "url"]) ?? "image";
      const mime = this.readString(file, ["mime", "mimeType"]);
      if (!url || !this.isImageAttachment(url, name, mime)) return [];
      return [{ url, name: this.basename(name), mime }];
    });
  }

  /** Resolves the displayable URL for OpenCode v1 file parts and v2 prompt files. */
  private attachmentUrl(file: JsonObject): string | undefined {
    const raw = this.readString(file, ["url", "uri", "path"]);
    if (!raw) return undefined;
    if (/^(https?:|file:|data:|blob:)/i.test(raw)) return raw;
    if (raw.startsWith("/")) return `file://${encodeURI(raw)}`;
    return raw;
  }

  /** Detects images by MIME type first, then common image extensions. */
  private isImageAttachment(url: string, name: string, mime?: string): boolean {
    if (mime?.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(url);
  }

  /** Renders a prominent compaction divider with an expandable summary. */
  private async renderCompactionDivider(container: HTMLElement, bundle: OpenCodeMessageBundle): Promise<void> {
    const details = container.createEl("details", { cls: "opencode-session-view__compaction" });
    const summary = details.createEl("summary", { cls: "opencode-session-view__compaction-summary" });
    summary.createSpan({ cls: "opencode-session-view__compaction-line" });
    summary.createSpan({ text: "Session compacted", cls: "opencode-session-view__compaction-label" });
    summary.createSpan({ cls: "opencode-session-view__compaction-line" });

    const body = details.createDiv({ cls: "opencode-session-view__compaction-body opencode-session-view__markdown markdown-rendered" });
    const text = this.compactionText(bundle);
    await MarkdownRenderer.renderMarkdown(text || "Earlier context was compacted. No summary was provided by OpenCode.", body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Returns true when a message bundle represents a compaction boundary. */
  private isCompactionMessage(bundle: OpenCodeMessageBundle): boolean {
    return this.readString(bundle.info, ["type"]) === "compaction" || bundle.parts.some((part) => this.readString(part, ["type"]) === "compaction");
  }

  /** Extracts the readable compaction summary/recent text from v2 info or legacy compaction parts. */
  private compactionText(bundle: OpenCodeMessageBundle): string {
    const summary = this.readString(bundle.info, ["summary"]);
    const recent = this.readString(bundle.info, ["recent"]);
    const reason = this.readString(bundle.info, ["reason"]);
    if (summary || recent) return [reason ? `_${this.capitalized(reason)} compaction_` : undefined, summary, recent ? `## Recent context\n\n${recent}` : undefined].filter(Boolean).join("\n\n");
    const part = bundle.parts.find((item) => this.readString(item, ["type"]) === "compaction");
    if (!part) return "";
    const auto = part.auto === true ? "Automatic" : "Manual";
    const overflow = part.overflow === true ? " due to context overflow" : "";
    return `${auto} compaction${overflow}.`;
  }

  /** Produces a human-readable model label from loose OpenCode message info. */
  private modelLabel(info: JsonObject): string | undefined {
    const model = this.readObject(info, "model");
    if (model) return this.readString(model, ["modelID", "modelId", "id", "name"]);
    return this.readString(info, ["modelID", "modelId", "model"]);
  }

  /** Formats assistant turn duration from message time.created/completed. */
  private durationLabel(info: JsonObject): string | undefined {
    const time = this.readObject(info, "time");
    const start = typeof time?.created === "number" ? time.created : undefined;
    const end = typeof time?.completed === "number" ? time.completed : undefined;
    if (start === undefined || end === undefined || end < start) return undefined;
    const seconds = (end - start) / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }

  /** Capitalizes short metadata labels without changing undefined values. */
  private capitalized(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  /** Renders assistant parts in server order so text, reasoning, and tool calls appear at their original turn positions. */
  private async renderAssistantParts(container: HTMLElement, parts: JsonObject[], info: JsonObject): Promise<void> {
    let textBuffer: JsonObject[] = [];
    let contextBuffer: JsonObject[] = [];
    let reasoningBuffer: JsonObject[] = [];
    let hasRenderedPart = false;
    let pendingStepGap = false;

    const markRendered = () => {
      hasRenderedPart = true;
    };

    const insertPendingStepGap = () => {
      if (!pendingStepGap) return;
      container.createDiv({ cls: "opencode-session-view__part-gap" });
      pendingStepGap = false;
    };

    const flushText = async () => {
      const group = textBuffer;
      textBuffer = [];
      const text = group.map((part) => this.readString(part, ["text"]) ?? "").join("\n\n").trim();
      if (!text) return;
      pendingStepGap = false;
      const body = container.createDiv({ cls: "opencode-session-view__markdown opencode-session-view__assistant-markdown markdown-preview-view markdown-rendered" });
      this.bindStreamingTextTarget(body, group);
      await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
      markRendered();
    };

    const flushContext = async () => {
      const group = contextBuffer;
      contextBuffer = [];
      if (group.length === 0) return;
      insertPendingStepGap();
      if (group.length === 1) {
        await this.renderToolCall(container, group[0]);
        markRendered();
        return;
      }
      await this.renderContextToolGroup(container, group);
      markRendered();
    };

    const flushReasoning = async () => {
      const group = reasoningBuffer;
      reasoningBuffer = [];
      if (group.length === 0 || !this.plugin.settings.showReasoningBlocks) return;
      insertPendingStepGap();
      if (await this.renderReasoningBlock(container, group, info)) markRendered();
    };

    for (const part of parts) {
      const type = this.readString(part, ["type"]);
      if (type === "text") {
        const text = part.synthetic === true || part.ignored === true ? undefined : this.readString(part, ["text"]);
        if (!text) continue;
        await flushContext();
        await flushReasoning();
        if (text) textBuffer.push(part);
        continue;
      }

      if (type === "step-start") {
        await flushText();
        await flushContext();
        await flushReasoning();
        pendingStepGap = hasRenderedPart;
        continue;
      }

      if (type === "step-finish") {
        await flushText();
        await flushContext();
        await flushReasoning();
        continue;
      }

      if (type === "reasoning") {
        await flushText();
        await flushContext();
        reasoningBuffer.push(part);
        continue;
      }

      if (type !== "tool") continue;
      await flushText();
      await flushReasoning();
      const tool = this.normalizedToolName(part);
      if (this.plugin.settings.groupContextTools && CONTEXT_TOOLS.has(tool)) {
        contextBuffer.push(part);
        continue;
      }
      await flushContext();
      insertPendingStepGap();
      await this.renderToolCall(container, part);
      markRendered();
    }

    await flushText();
    await flushReasoning();
    await flushContext();
  }

  /** Marks a rendered prose block as directly patchable while its single source part streams. */
  private bindStreamingTextTarget(body: HTMLElement, parts: JsonObject[]): void {
    if (parts.length !== 1) return;
    const partId = this.readString(parts[0], ["id", "partID", "partId"]);
    if (!partId) return;
    body.setAttr("data-part-id", partId);
    body.setAttr("data-stream-field", "text");
  }

  /** Renders consecutive assistant reasoning parts as one collapsed Thinking/Thought block; referenced by renderAssistantParts. */
  private async renderReasoningBlock(container: HTMLElement, parts: JsonObject[], info: JsonObject): Promise<boolean> {
    const text = this.reasoningText(parts);
    if (!text) return false;

    const complete = this.reasoningComplete(parts);
    const tokens = this.reasoningTokenCount(info);
    const details = container.createEl("details", { cls: `opencode-session-view__reasoning opencode-session-view__reasoning--${complete ? "complete" : "streaming"}` });
    const summary = details.createEl("summary", { cls: "opencode-session-view__reasoning-summary" });
    const icon = summary.createSpan({ cls: "opencode-session-view__reasoning-icon" });
    setIcon(icon, "brain");
    summary.createSpan({ text: complete && tokens ? `Thought for ${tokens.toLocaleString()} tokens` : complete ? "Thought" : "Thinking", cls: "opencode-session-view__reasoning-title" });
    if (!complete) summary.createSpan({ cls: "opencode-session-view__reasoning-spinner" });

    const body = details.createDiv({ cls: "opencode-session-view__reasoning-body opencode-session-view__markdown markdown-rendered" });
    this.bindStreamingTextTarget(body, parts);
    await MarkdownRenderer.renderMarkdown(text, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
    return true;
  }

  /** Joins visible reasoning summaries without introducing separate collapsed rows for each provider summary fragment. */
  private reasoningText(parts: JsonObject[]): string {
    return parts.map((part) => this.readString(part, ["text"]) ?? "").filter((text) => text.trim().length > 0).join("\n\n");
  }

  /** Returns whether all reasoning fragments have finished streaming based on their time.end markers. */
  private reasoningComplete(parts: JsonObject[]): boolean {
    return parts.every((part) => {
      const time = this.readObject(part, "time");
      return typeof time?.end === "number";
    });
  }

  /** Reads the assistant message reasoning token count for the collapsed thought label. */
  private reasoningTokenCount(info: JsonObject): number | undefined {
    const tokens = this.readObject(info, "tokens");
    return tokens ? this.readNumber(tokens, ["reasoning", "reasoningTokens", "reasoning_tokens"]) : undefined;
  }

  /** Renders consecutive read/search/list tools under one collapsed context-gathering container. */
  private async renderContextToolGroup(container: HTMLElement, parts: JsonObject[]): Promise<void> {
    const details = container.createEl("details", { cls: "opencode-session-view__tool-group opencode-session-view__tool" });
    const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
    const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
    setIcon(icon, "search");
    summary.createSpan({ text: "Gathered context", cls: "opencode-session-view__tool-title" });
    summary.createSpan({ text: this.contextSummary(parts), cls: "opencode-session-view__tool-subtitle" });

    this.renderLazyDetailsBody(details, "opencode-session-view__tool-group-list", async (list) => {
      for (const part of parts) await this.renderToolCall(list, part);
    });
  }

  /** Renders one collapsed-by-default tool call with specialized expanded states for common opencode tools. */
  private async renderToolCall(container: HTMLElement, part: JsonObject): Promise<void> {
    const tool = this.normalizedToolName(part);
    const state = this.readObject(part, "state") ?? {};
    const input = this.readObject(state, "input") ?? {};
    const output = this.readString(state, ["output", "error"]);
    const status = this.readString(state, ["status"]) ?? "unknown";
    const info = this.toolInfo(tool, input, state);

    const details = container.createEl("details", { cls: `opencode-session-view__tool opencode-session-view__tool--${status}` });
    const summary = details.createEl("summary", { cls: "opencode-session-view__tool-summary" });
    if (this.hasToolIcon(tool)) {
      const icon = summary.createSpan({ cls: "opencode-session-view__tool-icon" });
      setIcon(icon, this.toolIcon(tool));
    }
    if (this.isPathTool(tool)) this.renderPathToolSummary(summary, tool, input, state);
    else if (this.isContextLocationTool(tool)) this.renderContextLocationSummary(summary, tool, input);
    else if (tool === "bash" || tool === "shell") this.renderBashToolSummary(summary, input, state);
    else {
      summary.createSpan({ text: info.title, cls: "opencode-session-view__tool-title" });
      if (info.subtitle) summary.createSpan({ text: info.subtitle, cls: "opencode-session-view__tool-subtitle" });
    }
    if (status !== "completed" && status !== "error") summary.createSpan({ text: status, cls: "opencode-session-view__tool-status" });

    this.renderLazyDetailsBody(details, "opencode-session-view__tool-body", async (body) => this.renderToolBody(body, tool, input, output, state, info.tags));
  }

  /** Defers expensive details body DOM/Markdown work until a tool disclosure is opened. */
  private renderLazyDetailsBody(details: HTMLDetailsElement, bodyClass: string, render: (body: HTMLElement) => Promise<void>): void {
    let hydrated = false;
    details.addEventListener("toggle", () => {
      if (!details.open || hydrated) return;
      hydrated = true;
      const body = details.createDiv({ cls: bodyClass });
      body.createDiv({ text: "Loading details…", cls: "opencode-session-view__tool-empty" });
      void Promise.resolve().then(() => {
        body.empty();
        return render(body);
      });
    });
  }

  /** Renders the specialized expanded body for a tool once its disclosure has been opened. */
  private async renderToolBody(container: HTMLElement, tool: string, input: JsonObject, output: string | undefined, state: JsonObject, tags: string[]): Promise<void> {
    if (tool === "read" || tool === "read_file") await this.renderReadTool(container, input, output, state);
    else if (tool === "bash" || tool === "shell") await this.renderBashTool(container, input, output);
    else if (tool === "edit" || tool === "write" || tool === "apply_patch") await this.renderEditTool(container, tool, input, output, state);
    else if (tool === "task") await this.renderTaskTool(container, input, output, state);
    else if (tool.startsWith("todo")) await this.renderTodoTool(container, input, state);
    else await this.renderGenericTool(container, input, output, tags);
  }

  /** Renders read/read_file output as a syntax-highlighted Obsidian code block using the file extension. */
  private async renderReadTool(container: HTMLElement, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const filePath = this.toolPath(input);
    if (output) await this.renderReadOutput(container, output, this.languageFromPath(filePath));

    const loaded = this.readStringArray(this.readObject(state, "metadata") ?? {}, "loaded");
    for (const path of loaded) container.createDiv({ text: `Loaded ${this.displayPath(path)}`, cls: "opencode-session-view__tool-path" });
    if (!output && loaded.length === 0) container.createDiv({ text: "No output yet.", cls: "opencode-session-view__tool-empty" });
  }

  /** Renders read output with parsed line numbers in a dedicated gutter; referenced by renderReadTool. */
  private async renderReadOutput(container: HTMLElement, output: string, language: string): Promise<void> {
    const rows = this.parseReadOutputRows(output);
    if (rows.length === 0) {
      await this.renderCodeBlock(container, output, language);
      return;
    }

    const table = container.createDiv({ cls: "opencode-session-view__read-table" });
    for (const row of rows) {
      const line = table.createDiv({ cls: "opencode-session-view__read-line" });
      line.createSpan({ text: String(row.line), cls: "opencode-session-view__read-line-number" });
      const code = line.createSpan({ cls: "opencode-session-view__read-code" });
      await this.renderHighlightedCodeLine(code, row.text || " ", language);
    }
  }

  /** Extracts OpenCode read tool `<content>` rows like `123: code` while omitting path/type wrappers. */
  private parseReadOutputRows(output: string): Array<{ line: number; text: string }> {
    const content = output.match(/<content>\s*([\s\S]*?)\s*<\/content>/)?.[1] ?? output;
    return content.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
      const match = line.match(/^(\d+):\s?(.*)$/);
      if (!match) return [];
      return [{ line: Number(match[1]), text: match[2] ?? "" }];
    });
  }

  /** Renders shell tool output in a terminal-styled block with a copy action. */
  private async renderBashTool(container: HTMLElement, input: JsonObject, output: string | undefined): Promise<void> {
    const command = this.readString(input, ["command", "cmd"]) ?? "";
    const shell = container.createDiv({ cls: "opencode-session-view__terminal" });
    const copy = shell.createEl("button", { attr: { "aria-label": "Copy shell output" }, cls: "opencode-session-view__copy clickable-icon" });
    setIcon(copy, "copy");
    const terminalText = [`$ ${command}`, this.stripAnsi(output ?? "")].join("\n\n");
    copy.addEventListener("click", () => void this.copyText(terminalText, "Copied shell output"));
    shell.createEl("pre", { text: terminalText });
  }

  /** Renders edit/write tools with available diff metadata followed by the post-state or output code block. */
  private async renderEditTool(container: HTMLElement, tool: string, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const filePath = this.toolPath(input) ?? this.patchToolPath(input, state);
    const diffs = this.diffsFromEditTool(tool, input, state);
    for (const diff of diffs) await this.renderDiffSection(container, diff);
    const content = this.postStateFromTool(tool, input, state);
    if (content) {
      container.createDiv({ text: "Post-state", cls: "opencode-session-view__tool-section-title" });
      await this.renderCodeBlock(container, content, this.languageFromPath(filePath));
    }
    this.renderDiagnostics(container, filePath, state);
    if (output && diffs.length === 0 && !content) await this.renderMarkdownSection(container, "Result", output);
  }

  /** Renders one unified diff block with an optional affected-file label. */
  private async renderDiffSection(container: HTMLElement, diff: { file?: string; patch: string; additions?: number; deletions?: number }): Promise<void> {
    const table = container.createDiv({ cls: "opencode-session-view__diff-table" });
    const language = this.languageFromPath(diff.file);
    for (const row of this.parseUnifiedDiffRows(diff.patch)) {
      const line = table.createDiv({ cls: `opencode-session-view__diff-line opencode-session-view__diff-line--${row.kind}` });
      line.createSpan({ text: row.oldLine === undefined ? "" : String(row.oldLine), cls: "opencode-session-view__diff-line-number" });
      line.createSpan({ text: row.newLine === undefined ? "" : String(row.newLine), cls: "opencode-session-view__diff-line-number" });
      const code = line.createSpan({ cls: "opencode-session-view__diff-code" });
      if (row.kind === "meta") code.setText(row.text || " ");
      else await this.renderHighlightedCodeLine(code, row.text || " ", language);
    }
  }

  /** Renders one code line through Obsidian's fenced-code highlighter, then embeds the highlighted tokens in the diff table. */
  private async renderHighlightedCodeLine(container: HTMLElement, code: string, language: string): Promise<void> {
    const scratch = document.createElement("div");
    scratch.addClass("markdown-rendered");
    await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${this.escapeFence(code)}\n\`\`\``, scratch, `opencode-session/${this.sessionId ?? "session"}.md`, this);
    const highlighted = scratch.querySelector("code");
    if (!highlighted) {
      container.setText(code);
      return;
    }
    while (highlighted.firstChild) container.appendChild(highlighted.firstChild);
  }

  /** Renders LSP diagnostic errors reported in edit/write/apply_patch metadata. */
  private renderDiagnostics(container: HTMLElement, filePath: string | undefined, state: JsonObject): void {
    const diagnostics = this.diagnosticsFromTool(filePath, state);
    if (diagnostics.length === 0) return;

    const section = container.createDiv({ cls: "opencode-session-view__diagnostics" });
    section.createDiv({ text: "LSP errors", cls: "opencode-session-view__tool-section-title" });
    for (const diagnostic of diagnostics) {
      const row = section.createDiv({ cls: "opencode-session-view__diagnostic" });
      row.createSpan({ text: "ERROR", cls: "opencode-session-view__diagnostic-label" });
      if (diagnostic.location) row.createSpan({ text: diagnostic.location, cls: "opencode-session-view__diagnostic-location" });
      row.createSpan({ text: diagnostic.message, cls: "opencode-session-view__diagnostic-message" });
    }
  }

  /** Renders task/subagent spawns without inlining the child conversation. */
  private async renderTaskTool(container: HTMLElement, input: JsonObject, output: string | undefined, state: JsonObject): Promise<void> {
    const childId = this.readString(this.readObject(state, "metadata") ?? {}, ["sessionId", "sessionID"]);
    await this.renderJsonSection(container, "Input", input);
    if (output) await this.renderMarkdownSection(container, "Result", output);
    if (childId) container.createDiv({ text: `Child session: ${childId}`, cls: "opencode-session-view__tool-path" });
  }

  /** Renders todo* tool calls as an inert checklist, matching opencode's dedicated todo renderer intent. */
  private async renderTodoTool(container: HTMLElement, input: JsonObject, state: JsonObject): Promise<void> {
    const todos = this.todosFromTool(input, state);
    if (todos.length === 0) {
      await this.renderJsonSection(container, "Input", input);
      return;
    }

    const list = container.createDiv({ cls: "opencode-session-view__todos" });
    for (const todo of todos) {
      const row = list.createDiv({ cls: "opencode-session-view__todo" });
      const checkbox = row.createEl("input", { type: "checkbox", cls: "opencode-session-view__todo-checkbox" });
      checkbox.checked = this.readString(todo, ["status"]) === "completed";
      checkbox.disabled = true;
      row.createSpan({ text: this.readString(todo, ["content"]) ?? "Untitled todo", cls: "opencode-session-view__todo-content" });
      const priority = this.readString(todo, ["priority"]);
      if (priority) row.createSpan({ text: priority, cls: "opencode-session-view__tool-tag" });
    }
  }

  /** Extracts todo arrays from OpenCode input/metadata records. */
  private todosFromTool(input: JsonObject, state: JsonObject): JsonObject[] {
    const metadata = this.readObject(state, "metadata") ?? {};
    const metadataTodos = this.readObjectArray(metadata, "todos");
    return metadataTodos.length > 0 ? metadataTodos : this.readObjectArray(input, "todos");
  }

  /** Renders unknown tools as readable input/output sections plus up to three argument tags. */
  private async renderGenericTool(container: HTMLElement, input: JsonObject, output: string | undefined, tags: string[]): Promise<void> {
    if (tags.length > 0) {
      const tagWrap = container.createDiv({ cls: "opencode-session-view__tool-tags" });
      for (const tag of tags) tagWrap.createSpan({ text: tag, cls: "opencode-session-view__tool-tag" });
    }
    await this.renderJsonSection(container, "Input", input);
    if (output) await this.renderMarkdownSection(container, "Output", output);
  }

  /** Renders a labeled JSON section through Obsidian's code block highlighter. */
  private async renderJsonSection(container: HTMLElement, label: string, value: JsonObject): Promise<void> {
    container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
    await this.renderCodeBlock(container, JSON.stringify(value, null, 2), "json");
  }

  /** Renders a labeled markdown output section. */
  private async renderMarkdownSection(container: HTMLElement, label: string, markdown: string): Promise<void> {
    container.createDiv({ text: label, cls: "opencode-session-view__tool-section-title" });
    const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(markdown, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Uses MarkdownRenderer fenced code blocks so Obsidian supplies native syntax highlighting. */
  private async renderCodeBlock(container: HTMLElement, code: string, language: string): Promise<void> {
    const body = container.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
    await MarkdownRenderer.renderMarkdown(`\`\`\`${language}\n${this.escapeFence(code)}\n\`\`\``, body, `opencode-session/${this.sessionId ?? "session"}.md`, this);
  }

  /** Normalizes OpenCode tool names so aliases share one renderer path. */
  private normalizedToolName(part: JsonObject): string {
    return (this.readString(part, ["tool", "name"]) ?? "tool").toLowerCase();
  }

  /** Builds fallback tool title/subtitle/tags using the getToolInfo-style primary argument extraction from the spec. */
  private toolInfo(tool: string, input: JsonObject, state: JsonObject): { title: string; subtitle?: string; tags: string[] } {
    const title = this.readString(state, ["title"]) ?? this.toolTitle(tool, input);
    const subtitle = tool.startsWith("todo") ? this.todoSubtitle(this.todosFromTool(input, state)) : this.primaryArg(input);
    const tags = Object.entries(input)
      .filter(([key]) => !PRIMARY_ARG_KEYS.includes(key))
      .slice(0, 3)
      .map(([key, value]) => `${key}=${this.inlineValue(value)}`);
    return { title, subtitle, tags };
  }

  /** Returns true for tools whose collapsed row should prioritize a filesystem path over the tool title. */
  private isPathTool(tool: string): boolean {
    return tool === "read" || tool === "read_file" || tool === "edit" || tool === "write" || tool === "apply_patch";
  }

  /** Returns true for context tools that carry a directory plus optional search pattern. */
  private isContextLocationTool(tool: string): boolean {
    return tool === "list" || tool === "glob" || tool === "grep";
  }

  /** Renders path-tool summaries as muted path text with the final segment emphasized. */
  private renderPathToolSummary(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
    const rawPath = this.toolPath(input) ?? this.patchToolPath(input, state);
    if (!rawPath) {
      summary.createSpan({ text: this.toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
      return;
    }

    this.renderDisplayPath(summary, rawPath);
    this.renderDiffStats(summary, tool, input, state);
  }

  /** Appends edit/write/apply_patch additions/deletions to the collapsed row. */
  private renderDiffStats(summary: HTMLElement, tool: string, input: JsonObject, state: JsonObject): void {
    if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") return;
    const totals = this.diffsFromEditTool(tool, input, state).reduce(
      (acc, diff) => ({ additions: acc.additions + (diff.additions ?? 0), deletions: acc.deletions + (diff.deletions ?? 0) }),
      { additions: 0, deletions: 0 },
    );
    if (totals.additions === 0 && totals.deletions === 0) return;
    const stats = summary.createSpan({ cls: "opencode-session-view__diff-stats" });
    stats.createSpan({ text: `+${totals.additions}`, cls: "opencode-session-view__diff-stat-add" });
    stats.createSpan({ text: `−${totals.deletions}`, cls: "opencode-session-view__diff-stat-del" });
  }

  /** Renders list/glob/grep rows with the same path normalization used by standalone path tools. */
  private renderContextLocationSummary(summary: HTMLElement, tool: string, input: JsonObject): void {
    const rawPath = this.readString(input, ["path"]);
    const pattern = this.readString(input, ["pattern"]);
    const include = this.readString(input, ["include"]);

    if (tool === "list") summary.createSpan({ text: this.toolTitle(tool, input), cls: "opencode-session-view__tool-title" });
    if (rawPath) this.renderDisplayPath(summary, rawPath);
    if (pattern) summary.createSpan({ text: `pattern=${pattern}`, cls: "opencode-session-view__tool-tag" });
    if (include) summary.createSpan({ text: `include=${include}`, cls: "opencode-session-view__tool-tag" });
  }

  /** Renders bash collapsed rows with only the command as muted text, avoiding duplicate title/subtitle. */
  private renderBashToolSummary(summary: HTMLElement, input: JsonObject, state: JsonObject): void {
    const command = this.readString(input, ["command", "cmd"]) ?? this.readString(state, ["title"]) ?? "Shell";
    summary.createSpan({ text: command, cls: "opencode-session-view__tool-subtitle" });
  }

  /** Appends a muted-prefix/emphasized-basename path span using the global tool path policy. */
  private renderDisplayPath(container: HTMLElement, rawPath: string): void {
    const display = this.displayPath(rawPath);
    const split = this.splitPath(display);
    const path = container.createSpan({ cls: "opencode-session-view__tool-display-path" });
    if (split.prefix) path.createSpan({ text: split.prefix, cls: "opencode-session-view__tool-path-prefix" });
    path.createSpan({ text: split.basename, cls: "opencode-session-view__tool-path-basename" });
  }

  /** Reads the preferred path-like input key from read/edit/write tool arguments. */
  private toolPath(input: JsonObject): string | undefined {
    return this.readString(input, ["filePath", "filepath", "path"]);
  }

  /** Extracts the first affected file from apply_patch-style inputs or metadata. */
  private patchToolPath(input: JsonObject, state: JsonObject): string | undefined {
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    const diffFile = filediff ? this.readString(filediff, ["file", "filePath", "path"]) : undefined;
    if (diffFile) return diffFile;

    const metadataFiles = this.readObjectArray(metadata, "files");
    const inputFiles = this.readObjectArray(input, "files");
    const first = [...metadataFiles, ...inputFiles][0];
    return first ? this.readString(first, ["filePath", "relativePath", "path", "file"]) : undefined;
  }

  /** Displays internal paths relative to the session directory and external paths from filesystem root. */
  private displayPath(rawPath: string): string {
    const absolute = this.toAbsolutePath(rawPath);
    const root = this.sessionDirectory ? this.normalizePath(this.sessionDirectory) : undefined;
    if (root && this.isInsidePath(absolute, root)) return this.relativePath(root, absolute) || this.basename(absolute);
    return this.compactHomePath(absolute);
  }

  /** Resolves relative paths against the OpenCode session directory before normalizing dot segments. */
  private toAbsolutePath(rawPath: string): string {
    if (rawPath === "~" || rawPath.startsWith("~/")) {
      const home = this.homeDirectory();
      if (home) return this.normalizePath(rawPath === "~" ? home : `${home}/${rawPath.slice(2)}`);
    }
    if (rawPath.startsWith("/")) return this.normalizePath(rawPath);
    if (!this.sessionDirectory) return this.normalizePath(rawPath);
    return this.normalizePath(`${this.sessionDirectory}/${rawPath}`);
  }

  /** Replaces the current user's home directory with ~ for shorter external absolute paths. */
  private compactHomePath(path: string): string {
    const home = this.homeDirectory();
    if (!home) return path;
    const normalizedHome = this.normalizePath(home).replace(/\/$/, "");
    if (path === normalizedHome) return "~";
    if (path.startsWith(`${normalizedHome}/`)) return `~/${path.slice(normalizedHome.length + 1)}`;
    return path;
  }

  /** Returns the desktop user's home directory when available in Obsidian/Electron. */
  private homeDirectory(): string | undefined {
    const home = process.env.HOME || process.env.USERPROFILE;
    return home ? this.normalizePath(home) : undefined;
  }

  /** Normalizes POSIX paths without relying on Node's path module in the Obsidian renderer. */
  private normalizePath(path: string): string {
    const absolute = path.startsWith("/");
    const segments: string[] = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
        else if (!absolute) segments.push(segment);
        continue;
      }
      segments.push(segment);
    }
    return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
  }

  /** Checks path containment on segment boundaries. */
  private isInsidePath(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
  }

  /** Returns a relative path from the session directory to an internal file. */
  private relativePath(root: string, path: string): string {
    const normalizedRoot = root.replace(/\/$/, "");
    return path === normalizedRoot ? "" : path.slice(normalizedRoot.length + 1);
  }

  /** Splits display paths while preserving the slash after a muted prefix. */
  private splitPath(path: string): { prefix: string; basename: string } {
    const normalized = path.replace(/\/$/, "");
    if (normalized === "") return { prefix: "", basename: "/" };
    if (normalized === "~") return { prefix: "", basename: "~" };
    const index = normalized.lastIndexOf("/");
    if (index < 0) return { prefix: "", basename: normalized };
    return { prefix: normalized.slice(0, index + 1), basename: normalized.slice(index + 1) };
  }

  /** Returns the final segment of a path for root/session-directory fallbacks. */
  private basename(path: string): string {
    return this.splitPath(path).basename;
  }

  /** Chooses concise collapsed-state labels for common tools. */
  private toolTitle(tool: string, input: JsonObject): string {
    if (tool === "read" || tool === "read_file") return "Read";
    if (tool === "glob" || tool === "grep") return "Search";
    if (tool === "list") return "List";
    if (tool === "bash" || tool === "shell") return "Shell";
    if (tool === "edit") return "Edit";
    if (tool === "write") return "Write";
    if (tool === "task") return this.readString(input, ["description"]) ?? "Task";
    if (tool.startsWith("todo")) return "Todos";
    return tool;
  }

  /** Returns the best single-line descriptor from a tool input object. */
  private primaryArg(input: JsonObject): string | undefined {
    for (const key of PRIMARY_ARG_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }

  /** Returns true when a tool has a representative icon; generic tools intentionally do not. */
  private hasToolIcon(tool: string): boolean {
    return this.isPathTool(tool) || this.isContextLocationTool(tool) || tool === "bash" || tool === "shell" || tool === "task" || tool.startsWith("todo");
  }

  /** Chooses muted Lucide icons for non-generic collapsed tool rows. */
  private toolIcon(tool: string): string {
    if (tool === "read" || tool === "read_file") return "eye";
    if (tool === "grep" || tool === "glob") return "search";
    if (tool === "list") return "list";
    if (tool === "bash" || tool === "shell") return "terminal";
    if (tool === "edit" || tool === "write" || tool === "apply_patch") return "pencil";
    if (tool === "task") return "brain";
    if (tool.startsWith("todo")) return "list-checks";
    return "wrench";
  }

  /** Builds a compact completed/total subtitle for todo tool calls. */
  private todoSubtitle(todos: JsonObject[]): string | undefined {
    if (todos.length === 0) return undefined;
    const completed = todos.filter((todo) => this.readString(todo, ["status"]) === "completed").length;
    return `${completed}/${todos.length}`;
  }

  /** Summarizes grouped context tools as read/search/list counts. */
  private contextSummary(parts: JsonObject[]): string {
    const counts = new Map<string, number>();
    for (const part of parts) {
      const tool = this.normalizedToolName(part);
      const label = tool === "read" || tool === "read_file" ? "read" : tool === "grep" || tool === "glob" ? "search" : "list";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(", ");
  }

  /** Infers Obsidian code-block language from a file path extension. */
  private languageFromPath(filePath: string | undefined): string {
    const ext = filePath?.split(".").pop()?.toLowerCase();
    const languageByExtension: Record<string, string> = {
      js: "javascript",
      jsx: "jsx",
      ts: "typescript",
      tsx: "tsx",
      json: "json",
      jsonc: "jsonc",
      md: "markdown",
      css: "css",
      scss: "scss",
      html: "html",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
    };
    return ext ? languageByExtension[ext] ?? ext : "text";
  }

  /** Extracts unified diffs from edit/write/apply_patch metadata, falling back to old/new strings. */
  private diffsFromEditTool(tool: string, input: JsonObject, state: JsonObject): Array<{ file?: string; patch: string; additions?: number; deletions?: number }> {
    const metadata = this.readObject(state, "metadata") ?? {};
    const files = this.patchFilesFromMetadata(metadata);
    if (files.length > 0) return files;

    const single = this.diffFromTool(input, state);
    if (single) return [single];
    if (tool === "write") {
      const content = this.readString(input, ["content"]);
      const file = this.toolPath(input);
      if (content) return [{ file, patch: [`--- /dev/null`, `+++ ${file ?? "after"}`, ...content.split("\n").map((line) => `+${line}`)].join("\n") }];
    }
    return [];
  }

  /** Converts apply_patch metadata files into renderable unified diff blocks. */
  private patchFilesFromMetadata(metadata: JsonObject): Array<{ file?: string; patch: string; additions?: number; deletions?: number }> {
    return this.readObjectArray(metadata, "files").flatMap((file) => {
      const path = this.readString(file, ["relativePath", "filePath", "path", "file"]);
      const patch = this.readString(file, ["patch", "diff"]);
      const additions = this.readNumber(file, ["additions"]);
      const deletions = this.readNumber(file, ["deletions"]);
      if (patch) return [{ file: path, patch, additions, deletions }];

      const before = this.readString(file, ["before"]);
      const after = this.readString(file, ["after"]);
      if (before === undefined && after === undefined) return [];
      return [{ file: path, patch: this.beforeAfterDiff(before ?? "", after ?? "", path), additions, deletions }];
    });
  }

  /** Creates a single unified diff from edit metadata or old/new strings. */
  private diffFromTool(input: JsonObject, state: JsonObject): { file?: string; patch: string; additions?: number; deletions?: number } | undefined {
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    if (filediff) {
      const patch = this.readString(filediff, ["patch"]);
      const file = this.readString(filediff, ["file", "filePath", "path"]) ?? this.toolPath(input);
      const additions = this.readNumber(filediff, ["additions"]);
      const deletions = this.readNumber(filediff, ["deletions"]);
      if (patch) return { file, patch, additions, deletions };
      const before = this.readString(filediff, ["before"]) ?? "";
      const after = this.readString(filediff, ["after"]) ?? "";
      return { file, patch: this.beforeAfterDiff(before, after, file), additions, deletions };
    }
    const oldString = this.readString(input, ["oldString", "old"]);
    const newString = this.readString(input, ["newString", "new"]);
    if (!oldString && !newString) return undefined;
    const file = this.toolPath(input);
    return { file, patch: this.beforeAfterDiff(oldString ?? "", newString ?? "", file) };
  }

  /** Produces a simple diff block from complete before/after strings when no patch is supplied. */
  private beforeAfterDiff(before: string, after: string, file?: string): string {
    return [`--- ${file ?? "before"}`, `+++ ${file ?? "after"}`, ...before.split("\n").map((line) => `-${line}`), ...after.split("\n").map((line) => `+${line}`)].join("\n");
  }

  /** Parses unified diff text into display rows with old/new line numbers and no +/- glyph prefix. */
  private parseUnifiedDiffRows(patch: string): Array<{ kind: "context" | "add" | "del" | "meta"; oldLine?: number; newLine?: number; text: string }> {
    const rows: Array<{ kind: "context" | "add" | "del" | "meta"; oldLine?: number; newLine?: number; text: string }> = [];
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
      if (!raw) continue;
      if (raw.startsWith("Index: ") || raw.startsWith("====") || raw.startsWith("diff --git ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;

      const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: "meta", text: hunk[3] || `Lines ${oldLine}-${newLine}` });
        continue;
      }

      if (raw.startsWith("-")) {
        rows.push({ kind: "del", oldLine, text: raw.slice(1) });
        oldLine += 1;
        continue;
      }

      if (raw.startsWith("+")) {
        rows.push({ kind: "add", newLine, text: raw.slice(1) });
        newLine += 1;
        continue;
      }

      if (raw.startsWith(" ")) {
        rows.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
        oldLine += 1;
        newLine += 1;
        continue;
      }

      if (!raw.startsWith("\\")) rows.push({ kind: "meta", text: raw });
    }

    return rows;
  }

  /** Extracts severity-1 diagnostics from OpenCode edit/write metadata. */
  private diagnosticsFromTool(filePath: string | undefined, state: JsonObject): Array<{ location?: string; message: string }> {
    const metadata = this.readObject(state, "metadata") ?? {};
    const diagnosticsByFile = this.readObject(metadata, "diagnostics");
    if (!diagnosticsByFile) return [];
    const key = filePath && diagnosticsByFile[filePath] ? filePath : Object.keys(diagnosticsByFile)[0];
    const raw = key ? diagnosticsByFile[key] : undefined;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const diagnostic = item as JsonObject;
      if (this.readNumber(diagnostic, ["severity"]) !== 1) return [];
      const range = this.readObject(diagnostic, "range");
      const start = range ? this.readObject(range, "start") : undefined;
      const line = start ? this.readNumber(start, ["line"]) : undefined;
      const character = start ? this.readNumber(start, ["character"]) : undefined;
      return [{ location: line !== undefined && character !== undefined ? `[${line + 1}:${character + 1}]` : undefined, message: this.readString(diagnostic, ["message"]) ?? "Unknown diagnostic" }];
    }).slice(0, 3);
  }

  /** Returns best available post-edit/write contents for the expanded code block. */
  private postStateFromTool(tool: string, input: JsonObject, state: JsonObject): string | undefined {
    if (tool === "write") return this.readString(input, ["content"]);
    const metadata = this.readObject(state, "metadata") ?? {};
    const filediff = this.readObject(metadata, "filediff");
    return (filediff ? this.readString(filediff, ["after"]) : undefined) ?? this.readString(input, ["newString", "new"]);
  }

  /** Prevents nested triple-backtick content from breaking generated fenced code blocks. */
  private escapeFence(code: string): string {
    return code.replace(/```/g, "``\\`");
  }

  /** Strips ANSI control codes from terminal output before display/copy. */
  private stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
  }

  /** Formats arbitrary values for compact key=value tags. */
  private inlineValue(value: unknown): string {
    if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}…` : value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return String(value);
    return JSON.stringify(value).slice(0, 40);
  }

  /** Copies arbitrary rendered tool text to the clipboard. */
  private async copyText(text: string, notice: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    new Notice(notice);
  }

  /** Joins visible text parts for non-assistant messages, skipping synthetic/ignored and non-text parts. */
  private textFromParts(parts: JsonObject[]): string {
    return parts
      .flatMap((part) => {
        if (this.readString(part, ["type"]) !== "text") return [];
        if (part.synthetic === true || part.ignored === true) return [];
        return [this.readString(part, ["text"]) ?? ""];
      })
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
  }

  /** Returns message creation time for stable chronological rendering. */
  private messageTime(bundle: OpenCodeMessageBundle): number {
    const time = this.readObject(bundle.info, "time");
    const created = time?.created;
    return typeof created === "number" ? created : 0;
  }

  /** Copies the active session id to clipboard for debugging and API testing. */
  private async copySessionId(): Promise<void> {
    if (!this.sessionId) return;
    await navigator.clipboard.writeText(this.sessionId);
    new Notice(`Copied session ID: ${this.sessionId}`);
  }

  /** Reads a nested object field from a loosely typed OpenCode object. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    return undefined;
  }

  /** Reads an array of objects from a loosely typed OpenCode object. */
  private readObjectArray(source: JsonObject, key: string): JsonObject[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item));
  }

  /** Reads an array of strings from a loosely typed OpenCode object. */
  private readStringArray(source: JsonObject, key: string): string[] {
    const value = source[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  /** Reads the first numeric value from a loosely typed OpenCode object. */
  private readNumber(source: JsonObject, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
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
}
