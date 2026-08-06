import { Notice } from "obsidian";
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
  private respondingRequestIds = new Set<string>();

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
    this.respondingRequestIds.clear();
  }

  // ---- stream-event ingestion (replaces inline shell blocks in applyStreamingEvent)

  /** Applies a `permission.asked` event: silently auto-reply if enabled, otherwise surface a dock. */
  ingestPermissionAsked(request: OpenCodePermissionRequest): void {
    if (this.shouldAutoApprove()) {
      void this.autoReplyPermission(request);
      return;
    }
    this.upsertPendingPermission(request);
    this.refresh();
  }

  /** Applies a `permission.replied` event: remove the matching dock if still present. */
  ingestPermissionReplied(requestId: string | undefined): void {
    this.removePendingRequest(requestId);
    this.refresh();
  }

  /** Applies a `question.asked` event: surface a question dock. */
  ingestQuestionAsked(request: OpenCodeQuestionRequest): void {
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
    if (!this.shouldAutoApprove() || model.pendingPermissions.length === 0) return;
    const requests = [...model.pendingPermissions];
    model.pendingPermissions = [];
    this.refresh();
    await Promise.all(requests.map((request) => this.autoReplyPermission(request)));
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
    if (!request.id || request.sessionID !== this.deps.model.sessionId) return;
    const list = this.deps.model.pendingPermissions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
  }

  /** Adds or replaces one pending question request from the event stream. */
  private upsertPendingQuestion(request: OpenCodeQuestionRequest): void {
    if (!request.id || request.sessionID !== this.deps.model.sessionId) return;
    const list = this.deps.model.pendingQuestions;
    const index = list.findIndex((item) => item.id === request.id);
    if (index >= 0) list[index] = request;
    else list.push(request);
  }

  /** Removes any settled permission/question request by id. */
  private removePendingRequest(requestId: string | undefined): void {
    if (!requestId) return;
    const { model } = this.deps;
    model.pendingPermissions = model.pendingPermissions.filter((item) => item.id !== requestId);
    model.pendingQuestions = model.pendingQuestions.filter((item) => item.id !== requestId);
    this.respondingRequestIds.delete(requestId);
  }

  // ---- rendering (private)

  /** Renders pending permission and question requests into a container. */
  private renderRequestDocks(container: HTMLElement): void {
    const { model } = this.deps;
    container.toggleClass("is-empty", model.pendingPermissions.length === 0 && model.pendingQuestions.length === 0);
    for (const request of model.pendingPermissions) this.renderPermissionDock(container, request);
    for (const request of model.pendingQuestions) this.renderQuestionDock(container, request);
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
    if (this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    this.refresh();
    try {
      await this.deps.plugin.requireOpenCodeService().replyPermission(request.id, reply, this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory);
      this.removePendingRequest(request.id);
      this.refresh();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refresh();
      new Notice(error instanceof Error ? error.message : "Unable to reply to permission request.");
    }
  }

  /** Sends answers for a question request and removes the dock optimistically on success. */
  private async replyQuestion(request: OpenCodeQuestionRequest, answers: OpenCodeQuestionAnswer[]): Promise<void> {
    if (this.respondingRequestIds.has(request.id)) return;
    if (answers.some((answer) => answer.length === 0)) {
      new Notice("Answer each question before submitting.");
      return;
    }
    this.respondingRequestIds.add(request.id);
    this.refresh();
    try {
      await this.deps.plugin.requireOpenCodeService().replyQuestion(request.id, answers, this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory);
      this.removePendingRequest(request.id);
      this.refresh();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refresh();
      new Notice(error instanceof Error ? error.message : "Unable to answer question request.");
    }
  }

  /** Rejects a question request and removes the dock optimistically on success. */
  private async rejectQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    if (this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    this.refresh();
    try {
      await this.deps.plugin.requireOpenCodeService().rejectQuestion(request.id, this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory);
      this.removePendingRequest(request.id);
      this.refresh();
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.refresh();
      new Notice(error instanceof Error ? error.message : "Unable to reject question request.");
    }
  }

  /** Sends a client-side auto-approval reply without surfacing a permission dock. */
  private async autoReplyPermission(request: OpenCodePermissionRequest): Promise<void> {
    if (!request.id || request.sessionID !== this.deps.model.sessionId || this.respondingRequestIds.has(request.id)) return;
    this.respondingRequestIds.add(request.id);
    try {
      await this.deps.plugin.requireOpenCodeService().replyPermission(request.id, "once", this.deps.model.sessionDirectory ?? this.deps.model.draftDirectory);
      this.removePendingRequest(request.id);
    } catch (error) {
      this.respondingRequestIds.delete(request.id);
      this.upsertPendingPermission(request);
      this.refresh();
      new Notice(error instanceof Error ? error.message : "Unable to auto-approve permission request.");
    }
  }
}
