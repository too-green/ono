import { Notice, setIcon } from "obsidian";
import type OpenCodePlugin from "../../../main";
import type { SessionViewModel } from "./session-view-model";
import type { OpenCodePermissionReply, OpenCodePermissionRequest, OpenCodeQuestionAnswer, OpenCodeQuestionRequest } from "../../services/opencode-types";

/**
 * Deps injected by `SessionView` when constructing a `RequestDocksController`.
 *
 * `onChanged` is emitted after any dock re-render so the shell can refresh the
 * session status indicator, the composer's disabled state, the composer inset,
 * and (if near bottom) scroll to latest. The controller never reaches into
 * siblings directly.
 */
export interface RequestDocksDeps {
  plugin: OpenCodePlugin;
  model: SessionViewModel;
  onChanged: () => void;
  requestCanonicalSync: () => void;
}

/**
 * Owns the permission and question request docks above the composer.
 *
 * Controller-private state (`requestDockEl`, `respondingRequestIds`) lives here
 * and never leaks into `SessionViewModel`. Shared domain state
 * (`model.pendingPermissions`, `model.pendingQuestions`) is read/written through
 * the model so the shell, streaming event handler, and composer can all observe
 * pending-request transitions.
 *
 * Reference: Phase 3 of `docs/tmp/SessionView Decomposition Plan.md`.
 */
export class RequestDocksController {
  private requestDockEl?: HTMLElement;

  constructor(private readonly deps: RequestDocksDeps) {}

  // ---- lifecycle

  /** Creates the dock container inside the composer and renders the initial set; called by `renderComposer`. */
  mount(parent: HTMLElement): void {
    this.requestDockEl = parent.createDiv({ cls: "opencode-session-view__request-docks" });
    this.renderRequestDocks(this.requestDockEl);
  }

  /** Drops DOM references so a closed view cannot leak dock updates; called by `SessionView.onClose`. */
  dispose(): void {
    this.requestDockEl = undefined;
  }

  // ---- stream-event ingestion (replaces inline shell blocks in applyStreamingEvent)

  /** Applies a `permission.asked` event: silently auto-reply if enabled, otherwise surface a dock. */
  ingestPermissionAsked(request: OpenCodePermissionRequest): void {
    if (!this.requestBelongsToVisibleTree(request.sessionID)) {
      this.upsertUnscopedPermission(request);
      this.deps.requestCanonicalSync();
      return;
    }
    this.upsertPendingPermission(request);
    if (this.isAutoApproveEnabledFor(request.sessionID)) {
      void this.autoReplyPermission(request);
      return;
    }
    this.refresh();
  }

  /** Applies a `permission.replied` event: remove the matching dock if still present. */
  ingestPermissionReplied(requestId: string | undefined): void {
    this.removePendingRequest(requestId);
    this.refresh();
  }

  /** Applies a `question.asked` event: surface a question dock. */
  ingestQuestionAsked(request: OpenCodeQuestionRequest): void {
    if (!this.requestBelongsToVisibleTree(request.sessionID)) {
      this.upsertUnscopedQuestion(request);
      this.deps.requestCanonicalSync();
      return;
    }
    this.upsertPendingQuestion(request);
    this.refresh();
  }

  /** Applies a `question.replied` / `question.rejected` event: remove the matching dock. */
  ingestQuestionReplied(requestId: string | undefined): void {
    this.removePendingRequest(requestId);
    this.refresh();
  }

  // ---- public reads

  /** True while a permission/question dock must be answered before more input is sent. */
  isComposerBlocked(): boolean {
    return this.deps.model.pendingPermissions.length > 0 || this.deps.model.pendingQuestions.length > 0;
  }

  /** True when the per-session composer toggle should auto-allow permission prompts once. */
  shouldAutoApprove(): boolean {
    const key = this.deps.model.composerStorageKey;
    return !!key && this.deps.plugin.settings.sessionAutoApprove[key] === true;
  }

  // ---- canonical sync + toggle-driven mutations

  /** Auto-replies to all visible pending permissions if the composer auto-approve toggle is enabled. */
  async autoApprovePending(): Promise<void> {
    const { model } = this.deps;
    const requests = model.pendingPermissions.filter((request) => this.isAutoApproveEnabledFor(request.sessionID));
    if (requests.length === 0) return;
    await Promise.all(requests.map((request) => this.autoReplyPermission(request)));
  }

  /** Promotes held directory requests after canonical descendant discovery confirms their ownership. */
  reconcileRequestScope(): void {
    const { model } = this.deps;
    const permissions = model.unscopedPendingPermissions.filter((request) => this.requestBelongsToVisibleTree(request.sessionID));
    const questions = model.unscopedPendingQuestions.filter((request) => this.requestBelongsToVisibleTree(request.sessionID));
    const permissionIds = new Set(permissions.map((request) => request.id));
    const questionIds = new Set(questions.map((request) => request.id));
    model.unscopedPendingPermissions = model.unscopedPendingPermissions.filter((request) => !permissionIds.has(request.id));
    model.unscopedPendingQuestions = model.unscopedPendingQuestions.filter((request) => !questionIds.has(request.id));
    permissions.forEach((request) => this.upsertPendingPermission(request));
    questions.forEach((request) => this.upsertPendingQuestion(request));
  }

  /** Re-renders the dock DOM and emits `onChanged` so the shell refreshes composer + indicator + scroll. */
  refresh(): void {
    if (this.requestDockEl?.isConnected) {
      this.requestDockEl.empty();
      this.renderRequestDocks(this.requestDockEl);
    }
    this.deps.onChanged();
  }

  // ---- internal upsert / remove on model.pending{Permissions,Questions}

  /** Adds or replaces one pending permission request from the event stream. */
  private upsertPendingPermission(request: OpenCodePermissionRequest): void {
    if (!request.id || !this.requestBelongsToVisibleTree(request.sessionID)) return;
    const list = this.deps.model.pendingPermissions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
    this.recordRequestMutation(request.id);
  }

  /** Adds or replaces one pending question request from the event stream. */
  private upsertPendingQuestion(request: OpenCodeQuestionRequest): void {
    if (!request.id || !this.requestBelongsToVisibleTree(request.sessionID)) return;
    const list = this.deps.model.pendingQuestions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
    this.recordRequestMutation(request.id);
  }

  /** Holds one permission until canonical session discovery can confirm its owner belongs to this tree. */
  private upsertUnscopedPermission(request: OpenCodePermissionRequest): void {
    if (!request.id) return;
    const list = this.deps.model.unscopedPendingPermissions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
    this.recordRequestMutation(request.id);
  }

  /** Holds one question until canonical session discovery can confirm its owner belongs to this tree. */
  private upsertUnscopedQuestion(request: OpenCodeQuestionRequest): void {
    if (!request.id) return;
    const list = this.deps.model.unscopedPendingQuestions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
    this.recordRequestMutation(request.id);
  }

  /** Removes any settled permission/question request by id. */
  private removePendingRequest(requestId: string | undefined): void {
    if (!requestId) return;
    const { model } = this.deps;
    model.pendingPermissions = model.pendingPermissions.filter((item) => item.id !== requestId);
    model.pendingQuestions = model.pendingQuestions.filter((item) => item.id !== requestId);
    model.unscopedPendingPermissions = model.unscopedPendingPermissions.filter((item) => item.id !== requestId);
    model.unscopedPendingQuestions = model.unscopedPendingQuestions.filter((item) => item.id !== requestId);
    this.recordRequestMutation(requestId);
  }

  /** Returns true when a request belongs to this session or one of its loaded descendants. */
  private requestBelongsToVisibleTree(sessionId: string): boolean {
    return sessionId === this.deps.model.sessionId || this.deps.model.descendantSessions.has(sessionId);
  }

  /** Returns the owner session's explicit auto-approval setting without inheriting an ancestor's setting. */
  private isAutoApproveEnabledFor(sessionId: string): boolean {
    return this.deps.plugin.settings.sessionAutoApprove[sessionId] === true;
  }

  /** Records one live request mutation so a concurrent canonical fetch cannot overwrite it. */
  private recordRequestMutation(requestId: string): void {
    const revision = this.deps.model.pendingRequestRevision + 1;
    this.deps.model.pendingRequestRevision = revision;
    this.deps.model.pendingRequestRevisionById.set(requestId, revision);
  }

  // ---- rendering (private)

  /** Renders pending permission and question requests into a container. */
  private renderRequestDocks(container: HTMLElement): void {
    const { model } = this.deps;
    const permissions = model.pendingPermissions.filter((request) => !(this.isAutoApproveEnabledFor(request.sessionID) && this.deps.plugin.isSessionRequestResponding(request.id)));
    container.toggleClass("is-empty", permissions.length === 0 && model.pendingQuestions.length === 0);
    for (const request of this.requestsInDisplayOrder(permissions)) this.renderPermissionDock(container, request);
    for (const request of this.requestsInDisplayOrder(model.pendingQuestions)) this.renderQuestionDock(container, request);
  }

  /** Keeps current-session requests ahead of descendant requests while preserving arrival order. */
  private requestsInDisplayOrder<T extends { sessionID: string }>(requests: T[]): T[] {
    const currentSessionId = this.deps.model.sessionId;
    return [...requests].sort((left, right) => Number(right.sessionID === currentSessionId) - Number(left.sessionID === currentSessionId));
  }

  /** Renders one permission decision prompt with deny, always, and once actions. */
  private renderPermissionDock(container: HTMLElement, request: OpenCodePermissionRequest): void {
    const dock = container.createDiv({ cls: "opencode-session-view__request-dock opencode-session-view__request-dock--permission" });
    const header = dock.createDiv({ cls: "opencode-session-view__request-header" });
    const title = header.createDiv({ cls: "opencode-session-view__request-title" });
    title.createSpan({ text: "Permission required" });
    title.createSpan({ text: request.permission, cls: "opencode-session-view__request-badge" });
    this.renderRequestOwner(header, request.sessionID);
    const summary = dock.createDiv({ cls: "opencode-session-view__request-summary" });
    const patterns = Array.isArray(request.patterns) ? request.patterns : [];
    if (patterns.length === 0) summary.setText("OpenCode wants to run a protected action.");
    for (const pattern of patterns) summary.createEl("code", { text: pattern });

    const actions = dock.createDiv({ cls: "opencode-session-view__request-actions" });
    const responding = this.deps.plugin.isSessionRequestResponding(request.id);
    this.renderRequestButton(actions, "Deny", "", responding, () => void this.replyPermission(request, "reject"));
    this.renderRequestButton(actions, "Allow always", "", responding, () => void this.replyPermission(request, "always"));
    this.renderRequestButton(actions, "Allow once", "mod-cta", responding, () => void this.replyPermission(request, "once"));
  }

  /** Renders one question request, supporting single-select, multi-select, and custom answers. */
  private renderQuestionDock(container: HTMLElement, request: OpenCodeQuestionRequest): void {
    const dock = container.createDiv({ cls: "opencode-session-view__request-dock opencode-session-view__request-dock--question" });
    const header = dock.createDiv({ cls: "opencode-session-view__request-header" });
    header.createDiv({ text: "Question from OpenCode", cls: "opencode-session-view__request-title" });
    this.renderRequestOwner(header, request.sessionID);
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
    const responding = this.deps.plugin.isSessionRequestResponding(request.id);
    this.renderRequestButton(actions, "Reject", "", responding, () => void this.rejectQuestion(request));
    this.renderRequestButton(actions, "Answer", "mod-cta", responding, () => void this.replyQuestion(request, answerControls.map((readAnswer) => readAnswer())));
  }

  /** Renders a compact owner chip that opens the child session responsible for a routed request. */
  private renderRequestOwner(container: HTMLElement, sessionId: string): void {
    if (sessionId === this.deps.model.sessionId) return;
    const title = this.deps.model.descendantSessions.get(sessionId)?.title ?? sessionId;
    const owner = container.createEl("button", {
      cls: "opencode-session-view__request-owner",
      attr: { type: "button", "aria-label": `Open subagent session ${title}`, title: `Open subagent session ${title}` },
    });
    owner.createSpan({ text: `Subagent: ${title}`, cls: "opencode-session-view__request-owner-label" });
    const icon = owner.createSpan({ cls: "opencode-session-view__request-owner-icon" });
    setIcon(icon, "external-link");
    owner.addEventListener("click", () => void this.deps.plugin.openSessionTab(sessionId, title));
  }

  /** Creates a dock action button with common disabled handling. */
  private renderRequestButton(container: HTMLElement, text: string, cls: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = container.createEl("button", { text, cls });
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  // ---- reply / reject handlers

  /** Sends a permission reply and removes the dock optimistically on success. */
  private async replyPermission(request: OpenCodePermissionRequest, reply: OpenCodePermissionReply): Promise<void> {
    if (!this.deps.plugin.beginSessionRequestResponse(request.id)) return;
    try {
      await this.deps.plugin.requireOpenCodeService().replyPermission(request.id, reply, this.requestDirectory(request.sessionID));
      this.deps.plugin.settleSessionRequest(request.id);
    } catch (error) {
      this.deps.plugin.finishSessionRequestResponse(request.id);
      new Notice(error instanceof Error ? error.message : "Unable to reply to permission request.");
    }
  }

  /** Sends answers for a question request and removes the dock optimistically on success. */
  private async replyQuestion(request: OpenCodeQuestionRequest, answers: OpenCodeQuestionAnswer[]): Promise<void> {
    if (answers.some((answer) => answer.length === 0)) {
      new Notice("Answer each question before submitting.");
      return;
    }
    if (!this.deps.plugin.beginSessionRequestResponse(request.id)) return;
    try {
      await this.deps.plugin.requireOpenCodeService().replyQuestion(request.id, answers, this.requestDirectory(request.sessionID));
      this.deps.plugin.settleSessionRequest(request.id);
    } catch (error) {
      this.deps.plugin.finishSessionRequestResponse(request.id);
      new Notice(error instanceof Error ? error.message : "Unable to answer question request.");
    }
  }

  /** Rejects a question request and removes the dock optimistically on success. */
  private async rejectQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    if (!this.deps.plugin.beginSessionRequestResponse(request.id)) return;
    try {
      await this.deps.plugin.requireOpenCodeService().rejectQuestion(request.id, this.requestDirectory(request.sessionID));
      this.deps.plugin.settleSessionRequest(request.id);
    } catch (error) {
      this.deps.plugin.finishSessionRequestResponse(request.id);
      new Notice(error instanceof Error ? error.message : "Unable to reject question request.");
    }
  }

  /** Sends a client-side auto-approval reply without surfacing a permission dock. */
  private async autoReplyPermission(request: OpenCodePermissionRequest): Promise<void> {
    if (!request.id || !this.requestBelongsToVisibleTree(request.sessionID) || !this.isAutoApproveEnabledFor(request.sessionID) || !this.deps.plugin.beginSessionRequestResponse(request.id)) return;
    try {
      await this.deps.plugin.requireOpenCodeService().replyPermission(request.id, "once", this.requestDirectory(request.sessionID));
      this.deps.plugin.settleSessionRequest(request.id);
    } catch (error) {
      this.deps.plugin.finishSessionRequestResponse(request.id);
      new Notice(error instanceof Error ? error.message : "Unable to auto-approve permission request.");
    }
  }

  /** Resolves API instance routing from the request owner rather than whichever ancestor displays it. */
  private requestDirectory(sessionId: string): string | undefined {
    if (sessionId === this.deps.model.sessionId) return this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory;
    return this.deps.model.descendantSessions.get(sessionId)?.directory ?? this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory;
  }
}
