import { MarkdownRenderer, Modal, type App, type Component } from "obsidian";

import type { JsonObject, OpenCodeMessageBundle } from "../../../services/opencode-types";
import { renderContextToolGroup } from "../blocks/context-tool-group";
import { renderMessageMeta, renderRewindBoundary, type MessageMetaCallbacks, type RewindBoundaryProps } from "../blocks/message-meta";
import { bindStreamingTextTarget, renderReasoningBlock } from "../blocks/reasoning-block";
import { normalizedToolName, renderToolCall } from "../blocks/tool-renderer";
import type { BlockRenderCtx } from "../blocks/tool-primitives";
import * as jsonHelpers from "../json-helpers";
import * as messageHelpers from "../message-helpers";
import type { ImageAttachment } from "../message-helpers";
import type { SessionViewModel } from "../session-view-model";

const CONTEXT_TOOLS = new Set(["read", "read_file", "glob", "grep", "list"]);

export type MessageRenderKind = "none" | "user" | "assistant-text" | "assistant-compact" | "assistant-mixed";

export interface MessageRenderOptions {
  showAssistantMeta: boolean;
  assistantTurnText: string;
}

/** Dependencies used by `TimelineRenderer` for rendering and shell-owned actions. */
export interface TimelineDeps {
  app: App;
  component: Component;
  contentEl: HTMLElement;
  model: SessionViewModel;
  getShowReasoningBlocks: () => boolean;
  getGroupContextTools: () => boolean;
  getBindingVersion: () => number;
  isCurrentBinding: (sessionId: string, bindingVersion: number) => boolean;
  getRevertMessageId: () => string | undefined;
  requestShellRender: () => Promise<void>;
  shouldFollowLatest: () => boolean;
  markProgrammaticScroll: (durationMs: number) => void;
  scrollToBottom: (smooth: boolean) => void;
  updateJumpButton: () => void;
  onFork: (messageId: string) => void;
  onRewind: (bundle: OpenCodeMessageBundle) => void;
  onRedo: () => void;
}

/** Classifies visible message content for timeline spacing and filtering. */
export function messageRenderKind(bundle: OpenCodeMessageBundle, showReasoningBlocks: boolean): MessageRenderKind {
  if (messageHelpers.isCompactionMessage(bundle)) return "assistant-text";
  const role = messageHelpers.messageRole(bundle);
  if (role !== "assistant") return messageHelpers.userMessageText(bundle).trim() || messageHelpers.imageAttachments(bundle).length > 0 ? "user" : "none";

  const hasText = bundle.parts.some((part) => {
    if (jsonHelpers.readString(part, ["type"]) !== "text") return false;
    if (part.synthetic === true || part.ignored === true) return false;
    return !!jsonHelpers.readString(part, ["text"]);
  });
  const hasCompact = bundle.parts.some((part) => isCompactAssistantPart(part, showReasoningBlocks));
  if (hasText && hasCompact) return "assistant-mixed";
  if (hasText) return "assistant-text";
  if (hasCompact) return "assistant-compact";
  return "none";
}

/** Returns whether an assistant part is visible non-prose content. */
export function isCompactAssistantPart(part: JsonObject, showReasoningBlocks: boolean): boolean {
  const type = jsonHelpers.readString(part, ["type"]);
  if (type === "tool") return true;
  if (type === "reasoning") return showReasoningBlocks && !!jsonHelpers.readString(part, ["text"]);
  return false;
}

/** Returns chronologically renderable messages before the v1 rewind boundary. */
export function visibleTimelineMessages(
  messages: OpenCodeMessageBundle[],
  boundary: string | undefined,
  showReasoningBlocks: boolean,
): OpenCodeMessageBundle[] {
  return [...messages]
    .sort((left, right) => messageHelpers.messageTime(left) - messageHelpers.messageTime(right))
    .filter((message) => messageRenderKind(message, showReasoningBlocks) !== "none")
    .filter((message) => !boundary || messageHelpers.messageId(message) < boundary);
}

/** Finds the highest canonical index represented by the mounted message ids. */
export function latestMessageIndex(messages: OpenCodeMessageBundle[], renderedIds: string[]): number {
  let index = -1;
  for (const id of renderedIds) {
    const messageIndex = messages.findIndex((message) => messageHelpers.messageId(message) === id);
    if (messageIndex > index) index = messageIndex;
  }
  return index;
}

/** Finds the latest non-compaction assistant at or before the supplied index. */
export function latestVisibleAssistantIndex(messages: OpenCodeMessageBundle[], endIndex: number): number {
  for (let index = endIndex; index >= 0; index -= 1) {
    if (messageHelpers.messageRole(messages[index]) === "assistant" && !messageHelpers.isCompactionMessage(messages[index])) return index;
  }
  return -1;
}

/** Decides whether a visible assistant message closes an assistant turn and builds its combined prose. */
export function messageRenderOptions(messages: OpenCodeMessageBundle[], index: number): MessageRenderOptions {
  const bundle = messages[index];
  if (messageHelpers.messageRole(bundle) !== "assistant" || messageHelpers.isCompactionMessage(bundle)) {
    return { showAssistantMeta: false, assistantTurnText: "" };
  }
  const next = messages[index + 1];
  const showAssistantMeta = !next || messageHelpers.messageRole(next) !== "assistant" || messageHelpers.isCompactionMessage(next);
  if (!showAssistantMeta) return { showAssistantMeta, assistantTurnText: "" };

  let start = index;
  while (start > 0 && messageHelpers.messageRole(messages[start - 1]) === "assistant" && !messageHelpers.isCompactionMessage(messages[start - 1])) start -= 1;
  const assistantTurnText = messages
    .slice(start, index + 1)
    .map((message) => messageHelpers.textFromParts(message.parts))
    .filter((text) => text.trim())
    .join("\n\n");
  return { showAssistantMeta, assistantTurnText };
}

/** Returns a compact signature used to detect canonical changes to an already-mounted message. */
export function messageRenderSignature(bundle: OpenCodeMessageBundle): string {
  return hashRenderState(JSON.stringify(bundle));
}

/** Owns session timeline classification, message rendering, replacement, and append reconciliation. */
export class TimelineRenderer {
  constructor(private readonly deps: TimelineDeps) {}

  /** Renders history, visible messages, rewind state, and empty state into a shell-owned timeline. */
  async renderInto(timeline: HTMLElement, messages: OpenCodeMessageBundle[]): Promise<number> {
    const binding = this.captureBinding();
    this.renderHistoryBoundary(timeline);
    const visibleMessages = this.visibleMessages(messages);
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": messageHelpers.messageId(message) } });
      row.dataset.messageSignature = messageRenderSignature(message);
      await this.renderMessage(row, message, messageRenderOptions(visibleMessages, index));
      if (!this.isBindingCurrent(binding)) return visibleMessages.length;
    }
    if (!this.isBindingCurrent(binding)) return visibleMessages.length;
    renderRewindBoundary(timeline, this.rewindBoundaryProps());
    this.annotateRewindBoundary(timeline);
    if (visibleMessages.length === 0 && !this.deps.getRevertMessageId()) {
      timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
    }
    return visibleMessages.length;
  }

  /** Re-renders the active timeline into a detached node and swaps it after binding validation. */
  async renderStreaming(): Promise<void> {
    const binding = this.captureBinding();
    const current = this.deps.contentEl.querySelector<HTMLElement>(".opencode-session-view__timeline");
    if (!current) {
      if (this.deps.model.currentSession) await this.deps.requestShellRender();
      return;
    }
    const wasAtBottom = this.deps.shouldFollowLatest();
    if (wasAtBottom) this.deps.markProgrammaticScroll(1200);
    const next = document.createElement("div");
    next.classList.add("opencode-session-view__timeline");
    await this.renderInto(next, this.deps.model.loadedMessages);
    if (!this.isBindingCurrent(binding) || !current.isConnected) return;
    current.replaceWith(next);
    if (wasAtBottom) this.deps.scrollToBottom(false);
    this.deps.updateJumpButton();
  }

  /** Appends canonical tail messages while rebuilding when mounted rows or rewind state are stale. */
  async reconcileAppendOnly(messages: OpenCodeMessageBundle[]): Promise<void> {
    const binding = this.captureBinding();
    const timeline = this.deps.contentEl.querySelector<HTMLElement>(".opencode-session-view__timeline");
    if (!timeline) {
      if (this.deps.model.currentSession) await this.deps.requestShellRender();
      return;
    }
    if (!this.isBindingCurrent(binding)) return;

    const visibleMessages = this.visibleMessages(messages);
    if (visibleMessages.length === 0) {
      timeline.replaceChildren();
      this.renderHistoryBoundary(timeline);
      renderRewindBoundary(timeline, this.rewindBoundaryProps());
      this.annotateRewindBoundary(timeline);
      if (!this.deps.getRevertMessageId()) timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
      return;
    }

    const renderedRows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]"));
    const renderedIds = renderedRows
      .map((row) => row.dataset.messageId)
      .filter((id): id is string => !!id);
    const prefixMismatch = renderedIds.some((id, index) => {
      const message = visibleMessages[index];
      return !message || messageHelpers.messageId(message) !== id;
    });
    const changedRows = renderedRows.some((row, index) => {
      const message = visibleMessages[index];
      return !message || row.dataset.messageSignature !== messageRenderSignature(message);
    });
    const mountedBoundary = timeline.querySelector<HTMLElement>(".opencode-session-view__rewind-boundary")?.dataset.rewindMessageId;
    const mountedBoundarySignature = timeline.querySelector<HTMLElement>(".opencode-session-view__rewind-boundary")?.dataset.rewindSignature;
    if (
      prefixMismatch
      || changedRows
      || mountedBoundary !== this.deps.getRevertMessageId()
      || mountedBoundarySignature !== this.rewindSignature()
    ) {
      await this.renderStreaming();
      return;
    }
    const lastRenderedIndex = latestMessageIndex(visibleMessages, renderedIds);
    if (lastRenderedIndex === -1) {
      await this.renderStreaming();
      return;
    }

    const wasAtBottom = this.deps.shouldFollowLatest();
    if (wasAtBottom) this.deps.markProgrammaticScroll(1200);
    this.refreshHistoryBoundary(timeline);
    const previousBundle = visibleMessages[lastRenderedIndex];
    if (previousBundle) this.reconcilePreviousAssistantMeta(timeline, previousBundle, visibleMessages, lastRenderedIndex);

    for (let index = lastRenderedIndex + 1; index < visibleMessages.length; index += 1) {
      if (!this.isBindingCurrent(binding) || !timeline.isConnected) return;
      const message = visibleMessages[index];
      const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": messageHelpers.messageId(message) } });
      row.dataset.messageSignature = messageRenderSignature(message);
      await this.renderMessage(row, message, messageRenderOptions(visibleMessages, index));
      if (!this.isBindingCurrent(binding) || !timeline.isConnected) {
        row.remove();
        return;
      }
    }

    timeline.querySelector(".opencode-session-view__empty")?.remove();
    if (wasAtBottom) this.deps.scrollToBottom(false);
    this.deps.updateJumpButton();
  }

  /** Renders the lazy-history status row at the top of a timeline. */
  private renderHistoryBoundary(container: HTMLElement): void {
    const boundary = container.createDiv({ cls: "opencode-session-view__history-boundary" });
    if (this.deps.model.loadingOlder) {
      boundary.createSpan({ cls: "opencode-session-view__history-spinner" });
      boundary.createSpan({ text: "Loading earlier messages…" });
      return;
    }
    boundary.setText(this.deps.model.historyComplete ? "Beginning of loaded session" : "Scroll up to load earlier messages");
  }

  /** Renders one user, assistant, or compaction message block. */
  private async renderMessage(container: HTMLElement, bundle: OpenCodeMessageBundle, options: MessageRenderOptions): Promise<void> {
    if (messageHelpers.isCompactionMessage(bundle)) {
      await this.renderCompactionDivider(container, bundle);
      return;
    }
    const role = messageHelpers.messageRole(bundle);
    if (role === "assistant") {
      await this.renderAssistantParts(container, bundle.parts, bundle.info);
      if (options.showAssistantMeta) renderMessageMeta(container, bundle, "assistant", options.assistantTurnText, this.messageMetaCallbacks());
      return;
    }

    const text = messageHelpers.userMessageText(bundle);
    const wrapper = container.createDiv({ cls: "opencode-session-view__user-message-wrap" });
    const article = wrapper.createDiv({ cls: `opencode-session-view__message opencode-session-view__message--${role}` });
    this.renderImageAttachments(article, messageHelpers.imageAttachments(bundle));
    if (text.trim()) {
      const body = article.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
      await MarkdownRenderer.renderMarkdown(text, body, this.markdownSourcePath(), this.deps.component);
    }
    renderMessageMeta(wrapper, bundle, "user", text, this.messageMetaCallbacks());
  }

  /** Renders clickable image thumbnails attached to a user message. */
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

  /** Opens an Obsidian modal for a full-size message attachment. */
  private openImagePreview(image: ImageAttachment): void {
    const modal = new Modal(this.deps.app);
    modal.titleEl.setText(image.name);
    modal.contentEl.addClass("opencode-session-view__image-modal");
    modal.contentEl.createEl("img", { attr: { src: image.url, alt: image.name }, cls: "opencode-session-view__image-modal-img" });
    modal.open();
  }

  /** Renders a prominent compaction divider with its expandable summary. */
  private async renderCompactionDivider(container: HTMLElement, bundle: OpenCodeMessageBundle): Promise<void> {
    const details = container.createEl("details", { cls: "opencode-session-view__compaction" });
    const summary = details.createEl("summary", { cls: "opencode-session-view__compaction-summary" });
    summary.createSpan({ cls: "opencode-session-view__compaction-line" });
    summary.createSpan({ text: "Session compacted", cls: "opencode-session-view__compaction-label" });
    summary.createSpan({ cls: "opencode-session-view__compaction-line" });
    const body = details.createDiv({ cls: "opencode-session-view__compaction-body opencode-session-view__markdown markdown-rendered" });
    const text = messageHelpers.compactionText(bundle);
    await MarkdownRenderer.renderMarkdown(text || "Earlier context was compacted. No summary was provided by OpenCode.", body, this.markdownSourcePath(), this.deps.component);
  }

  /** Renders assistant parts in server order, preserving step gaps and grouped context tools. */
  private async renderAssistantParts(container: HTMLElement, parts: JsonObject[], info: JsonObject): Promise<void> {
    let textBuffer: JsonObject[] = [];
    let contextBuffer: JsonObject[] = [];
    let reasoningBuffer: JsonObject[] = [];
    let hasRenderedPart = false;
    let pendingStepGap = false;

    const markRendered = (): void => {
      hasRenderedPart = true;
    };
    const insertPendingStepGap = (): void => {
      if (!pendingStepGap) return;
      container.createDiv({ cls: "opencode-session-view__part-gap" });
      pendingStepGap = false;
    };
    const flushText = async (): Promise<void> => {
      const group = textBuffer;
      textBuffer = [];
      const text = group.map((part) => jsonHelpers.readString(part, ["text"]) ?? "").join("\n\n").trim();
      if (!text) return;
      pendingStepGap = false;
      const body = container.createDiv({ cls: "opencode-session-view__markdown opencode-session-view__assistant-markdown markdown-preview-view markdown-rendered" });
      bindStreamingTextTarget(body, group);
      await MarkdownRenderer.renderMarkdown(text, body, this.markdownSourcePath(), this.deps.component);
      markRendered();
    };
    const flushContext = async (): Promise<void> => {
      const group = contextBuffer;
      contextBuffer = [];
      if (group.length === 0) return;
      insertPendingStepGap();
      if (group.length === 1) await renderToolCall(container, group[0], this.blockCtx());
      else await renderContextToolGroup(container, group, this.blockCtx());
      markRendered();
    };
    const flushReasoning = async (): Promise<void> => {
      const group = reasoningBuffer;
      reasoningBuffer = [];
      if (group.length === 0 || !this.deps.getShowReasoningBlocks()) return;
      insertPendingStepGap();
      if (await renderReasoningBlock(container, group, info, this.blockCtx())) markRendered();
    };

    for (const part of parts) {
      const type = jsonHelpers.readString(part, ["type"]);
      if (type === "text") {
        const text = part.synthetic === true || part.ignored === true ? undefined : jsonHelpers.readString(part, ["text"]);
        if (!text) continue;
        await flushContext();
        await flushReasoning();
        textBuffer.push(part);
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
      const tool = normalizedToolName(part);
      if (this.deps.getGroupContextTools() && CONTEXT_TOOLS.has(tool)) {
        contextBuffer.push(part);
        continue;
      }
      await flushContext();
      insertPendingStepGap();
      await renderToolCall(container, part, this.blockCtx());
      markRendered();
    }

    await flushText();
    await flushReasoning();
    await flushContext();
  }

  /** Reconciles final-turn metadata on the previous assistant before appending the canonical tail. */
  private reconcilePreviousAssistantMeta(
    timeline: HTMLElement,
    previousBundle: OpenCodeMessageBundle,
    visibleMessages: OpenCodeMessageBundle[],
    previousIndex: number,
  ): void {
    const previousRow = timeline.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageHelpers.messageId(previousBundle))}"]`);
    if (!previousRow || messageHelpers.messageRole(previousBundle) !== "assistant" || messageHelpers.isCompactionMessage(previousBundle)) return;
    const options = messageRenderOptions(visibleMessages, previousIndex);
    const existing = Array.from(previousRow.querySelectorAll(".opencode-session-view__message-meta--assistant"));
    if (!options.showAssistantMeta) {
      for (const meta of existing) meta.remove();
      return;
    }
    if (existing.length === 0) renderMessageMeta(previousRow, previousBundle, "assistant", options.assistantTurnText, this.messageMetaCallbacks());
  }

  /** Replaces the history row so pagination completion changes are reflected without rebuilding messages. */
  private refreshHistoryBoundary(timeline: HTMLElement): void {
    const scratch = document.createElement("div");
    this.renderHistoryBoundary(scratch);
    const next = scratch.firstElementChild;
    if (!next) return;
    const current = timeline.querySelector(":scope > .opencode-session-view__history-boundary");
    if (current) current.replaceWith(next);
    else timeline.prepend(next);
  }

  /** Stores a signature for same-message rewind diff changes detected during canonical reconciliation. */
  private annotateRewindBoundary(timeline: HTMLElement): void {
    const boundary = timeline.querySelector<HTMLElement>(".opencode-session-view__rewind-boundary");
    const signature = this.rewindSignature();
    if (boundary && signature) boundary.dataset.rewindSignature = signature;
  }

  /** Returns the active rewind boundary signature, including affected-file details. */
  private rewindSignature(): string | undefined {
    const messageId = this.deps.getRevertMessageId();
    return messageId ? hashRenderState(JSON.stringify([messageId, this.deps.model.revertDiffFiles])) : undefined;
  }

  /** Returns visible messages using current rewind and reasoning settings. */
  private visibleMessages(messages: OpenCodeMessageBundle[]): OpenCodeMessageBundle[] {
    return visibleTimelineMessages(messages, this.deps.getRevertMessageId(), this.deps.getShowReasoningBlocks());
  }

  /** Captures the active binding before asynchronous Markdown rendering begins. */
  private captureBinding(): { sessionId: string | undefined; version: number } {
    return { sessionId: this.deps.model.sessionId, version: this.deps.getBindingVersion() };
  }

  /** Returns whether an async render still belongs to the active session binding. */
  private isBindingCurrent(binding: { sessionId: string | undefined; version: number }): boolean {
    return !!binding.sessionId && this.deps.isCurrentBinding(binding.sessionId, binding.version);
  }

  /** Builds the rendering context shared by tool, context, and reasoning blocks. */
  private blockCtx(): BlockRenderCtx {
    return { component: this.deps.component, sessionId: this.deps.model.sessionId, sessionDirectory: this.deps.model.sessionDirectory };
  }

  /** Builds message action callbacks without exposing shell/controller references. */
  private messageMetaCallbacks(): MessageMetaCallbacks {
    return {
      isQueued: (id) => this.deps.model.queuedMessageIds.has(id),
      onFork: (id) => this.deps.onFork(id),
      onRewind: (bundle) => this.deps.onRewind(bundle),
    };
  }

  /** Builds the current rewind boundary presentation and redo action. */
  private rewindBoundaryProps(): RewindBoundaryProps {
    return { revertMessageId: this.deps.getRevertMessageId(), revertDiffFiles: this.deps.model.revertDiffFiles, onRedo: this.deps.onRedo };
  }

  /** Returns the synthetic source path used for Obsidian Markdown link resolution. */
  private markdownSourcePath(): string {
    return `opencode-session/${this.deps.model.sessionId ?? "session"}.md`;
  }
}

/** Hashes JSON render state into a short stable DOM attribute value. */
function hashRenderState(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}
