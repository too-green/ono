import { MarkdownRenderer, Notice, setIcon, type App, type Component } from "obsidian";

import { assistantErrorDiagnostics, assistantErrorDiagnosticsText, assistantErrorMessage, isDisplayableAssistantError } from "../../../services/assistant-error";
import type { JsonObject, OpenCodeMessageBundle } from "../../../services/opencode-types";
import { orderedBoundary } from "../../../message-order";
import { renderContextToolGroup } from "../blocks/context-tool-group";
import { renderMessageMeta, renderRewindBoundary, type AssistantMetaOptions, type MessageMetaCallbacks, type RewindBoundaryProps } from "../blocks/message-meta";
import { bindStreamingTextTarget, renderReasoningBlock } from "../blocks/reasoning-block";
import { taskSessionId } from "../blocks/specialized-tool-renderers";
import { normalizedToolName, renderToolCall } from "../blocks/tool-renderer";
import { adoptLazyDetailsBody, blockPartId, hydrateLazyDetails, type BlockRenderCtx } from "../blocks/tool-primitives";
import * as jsonHelpers from "../json-helpers";
import * as messageHelpers from "../message-helpers";
import type { ImageAttachment } from "../message-helpers";
import { hashRenderState, projectedRenderState, renderedPartHash } from "../render-signature";
import { RenderScopeRegistry } from "./render-scopes";
import type { SessionViewModel } from "../session-view-model";
import { retryCountdownText, type SessionRetryStatus } from "../session-status";
import type { WorkingAnimation } from "../../../session-state";
import type { FollowLatestAnchor } from "../scroll-controller";
import type { ToolDisplaySetting } from "../../../settings";
import { openImagePreview } from "../image-preview";

const CONTEXT_TOOLS = new Set(["read", "read_file", "glob", "grep", "list"]);

export type MessageRenderKind = "none" | "user" | "assistant-text" | "assistant-compact" | "assistant-mixed";

export interface MessageRenderOptions {
  showAssistantMeta: boolean;
  assistantTurnText: string;
}

export interface AssistantTurnTiming {
  startedAt?: number;
  completedAt?: number;
}

/** Dependencies used by `TimelineRenderer` for rendering and shell-owned actions. */
export interface TimelineDeps {
  app: App;
  component: Component;
  contentEl: HTMLElement;
  model: SessionViewModel;
  getShowReasoningBlocks: () => boolean;
  getWorkingAnimation: () => WorkingAnimation;
  getGroupContextTools: () => boolean;
  getCustomToolDisplays: () => ToolDisplaySetting[];
  getBindingVersion: () => number;
  isCurrentBinding: (sessionId: string, bindingVersion: number) => boolean;
  getRevertMessageId: () => string | undefined;
  requestShellRender: () => Promise<void>;
  cancelStreamingMarkdownPatch: (key: string) => void;
  isStreamingPartActive: (messageId: string, partId: string) => boolean;
  captureFollowLatest: () => FollowLatestAnchor | undefined;
  restoreFollowLatest: (anchor: FollowLatestAnchor | undefined) => boolean;
  updateJumpButton: () => void;
  onFork: (messageId: string) => void;
  onRewind: (bundle: OpenCodeMessageBundle) => void;
  onRedo: () => void;
  onOpenSession: (sessionId: string, title: string) => void | Promise<void>;
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
  const hasError = bundle.info.error !== undefined && bundle.info.error !== null;
  if (hasText && hasCompact) return "assistant-mixed";
  if (hasText) return "assistant-text";
  if (hasCompact || hasError) return "assistant-compact";
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
  const location = orderedBoundary(messages, boundary, messageHelpers.messageId, messageHelpers.messageTime);
  return location.ordered
    .slice(0, location.index)
    .filter((message) => messageRenderKind(message, showReasoningBlocks) !== "none");
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

/**
 * Index of the last uncompleted assistant turn; user messages after it are queued
 * while the session is busy. Mirrors the first-party TUI derivation
 * (`packages/tui/src/routes/session/index.tsx`) because the v1 API exposes no
 * queued flag: a prompt sent during a run is persisted immediately and only an
 * assistant message appearing after it distinguishes pickup.
 */
export function lastUncompletedAssistantIndex(messages: OpenCodeMessageBundle[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageHelpers.messageRole(message) !== "assistant" || messageHelpers.isCompactionMessage(message)) continue;
    return messageHelpers.messageCompletedTime(message) === undefined ? index : -1;
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

/** Resolves complete turn timing from the preceding user message through the final assistant message. */
export function assistantTurnTiming(messages: OpenCodeMessageBundle[], index: number): AssistantTurnTiming {
  const bundle = messages[index];
  if (messageHelpers.messageRole(bundle) !== "assistant" || messageHelpers.isCompactionMessage(bundle)) return {};

  let start = index;
  while (start > 0 && messageHelpers.messageRole(messages[start - 1]) === "assistant" && !messageHelpers.isCompactionMessage(messages[start - 1])) start -= 1;
  const firstAssistant = messages[start];
  const parentId = jsonHelpers.readString(firstAssistant.info, ["parentID", "parentId"]);
  const parent = parentId ? messages.find((message) => messageHelpers.messageId(message) === parentId && messageHelpers.messageRole(message) === "user") : undefined;
  let precedingUser: OpenCodeMessageBundle | undefined;
  for (let candidate = start - 1; candidate >= 0; candidate -= 1) {
    if (messageHelpers.messageRole(messages[candidate]) !== "user") continue;
    precedingUser = messages[candidate];
    break;
  }
  const startBundle = parent ?? precedingUser ?? firstAssistant;
  return {
    startedAt: messageHelpers.messageTime(startBundle),
    completedAt: messageHelpers.messageCompletedTime(bundle),
  };
}

/** Returns a compact signature used to detect canonical changes to an already-mounted message. */
export function messageRenderSignature(bundle: OpenCodeMessageBundle): string {
  return hashRenderState(JSON.stringify([JSON.stringify(bundle.info), bundle.parts.map(renderedPartHash)]));
}

/** Owns session timeline classification, message rendering, replacement, and append reconciliation. */
export class TimelineRenderer {
  private readonly openDisclosures = new Set<string>();
  private readonly scopes: RenderScopeRegistry;
  private reconcileVersion = 0;

  constructor(private readonly deps: TimelineDeps) {
    this.scopes = new RenderScopeRegistry(deps.component);
  }

  /** Releases every markdown render scope; called by `SessionView.onClose` before the view unloads. */
  dispose(): void {
    this.scopes.releaseAll();
  }

  /** Clears interaction state when `SessionView` binds the renderer to another session. */
  clearDisclosureState(): void {
    this.openDisclosures.clear();
    this.scopes.releaseAll();
  }

  /** Renders history, visible messages, rewind state, and empty state into a shell-owned timeline. */
  async renderInto(timeline: HTMLElement, messages: OpenCodeMessageBundle[]): Promise<number> {
    const binding = this.captureBinding();
    this.renderHistoryBoundary(timeline);
    const visibleMessages = this.visibleMessages(messages);
    const activeAssistantId = this.activeAssistantMessageId(visibleMessages);
    const pendingIndex = lastUncompletedAssistantIndex(visibleMessages);
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const options = messageRenderOptions(visibleMessages, index);
      const assistantOptions = this.assistantMetaOptions(visibleMessages, index, activeAssistantId);
      const row = await this.renderMessageRow(message, options, assistantOptions, this.isUserQueued(visibleMessages, index, pendingIndex));
      if (!this.isBindingCurrent(binding)) return visibleMessages.length;
      timeline.appendChild(row);
      hydrateLazyDetails(row);
    }
    if (!this.isBindingCurrent(binding)) return visibleMessages.length;
    const renderedRetry = this.renderSessionRetry(timeline);
    const renderedSessionError = this.renderTransientSessionError(timeline, visibleMessages);
    const renderedWorkingPlaceholder = this.renderWorkingAssistantPlaceholder(timeline, activeAssistantId);
    renderRewindBoundary(timeline, this.rewindBoundaryProps());
    this.annotateRewindBoundary(timeline);
    if (visibleMessages.length === 0 && !renderedRetry && !renderedSessionError && !renderedWorkingPlaceholder && !this.deps.getRevertMessageId()) {
      timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
    }
    return visibleMessages.length;
  }

  /** Releases scopes belonging to timeline DOM discarded by a shell replacement; called after the new shell mounts. */
  releaseDetachedScopes(): void {
    this.scopes.releaseDetached();
  }

  /** Reconciles streamed state while retaining mounted rows, disclosures, and active animation nodes. */
  async renderStreaming(): Promise<void> {
    await this.reconcileTimeline(this.deps.model.loadedMessages);
  }

  /** Reconciles canonical messages by stable id without replacing unchanged timeline content. */
  async reconcileAppendOnly(messages: OpenCodeMessageBundle[]): Promise<void> {
    await this.reconcileTimeline(messages);
  }

  /** Builds changed rows off-DOM, then commits one keyed timeline reconciliation synchronously. */
  private async reconcileTimeline(messages: OpenCodeMessageBundle[], retryOnStale = true): Promise<void> {
    const reconcileVersion = ++this.reconcileVersion;
    const binding = this.captureBinding();
    try {
      const timeline = this.deps.contentEl.querySelector<HTMLElement>(".opencode-session-view__timeline");
      if (!timeline) {
        if (this.deps.model.currentSession) await this.deps.requestShellRender();
        return;
      }
      if (!this.isBindingCurrent(binding)) return;

      const visibleMessages = this.visibleMessages(messages);
      const activeAssistantId = this.activeAssistantMessageId(visibleMessages);
      const pendingIndex = lastUncompletedAssistantIndex(visibleMessages);
      const mountedRows = new Map(
        Array.from(timeline.children)
          .filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.messageId)
          .map((row) => [row.dataset.messageId!, row]),
      );
      const entries: Array<{ id: string; signature: string; current?: HTMLElement; next?: HTMLElement }> = [];
      const followGeneration = this.deps.captureFollowLatest();

      for (let index = 0; index < visibleMessages.length; index += 1) {
        const message = visibleMessages[index];
        const id = messageHelpers.messageId(message);
        const options = messageRenderOptions(visibleMessages, index);
        const assistantOptions = this.assistantMetaOptions(visibleMessages, index, activeAssistantId);
        const queued = this.isUserQueued(visibleMessages, index, pendingIndex);
        const signature = this.messageRowSignature(message, options, assistantOptions, queued);
        const current = mountedRows.get(id);
        const next = current?.dataset.messageSignature === signature ? undefined : await this.renderMessageRow(message, options, assistantOptions, queued);
        if (!this.isBindingCurrent(binding) || reconcileVersion !== this.reconcileVersion || !timeline.isConnected) return;
        entries.push({ id, signature, current, next });
      }

      const latestVisibleMessages = this.visibleMessages(messages);
      const latestActiveAssistantId = this.activeAssistantMessageId(latestVisibleMessages);
      const latestPendingIndex = lastUncompletedAssistantIndex(latestVisibleMessages);
      const staleSnapshot = latestVisibleMessages.length !== entries.length || entries.some((entry, index) => {
        const message = latestVisibleMessages[index];
        if (!message || messageHelpers.messageId(message) !== entry.id) return true;
        return this.messageRowSignature(
          message,
          messageRenderOptions(latestVisibleMessages, index),
          this.assistantMetaOptions(latestVisibleMessages, index, latestActiveAssistantId),
          this.isUserQueued(latestVisibleMessages, index, latestPendingIndex),
        ) !== entry.signature;
      });
      if (staleSnapshot) {
        if (retryOnStale) await this.reconcileTimeline(messages, false);
        return;
      }

      const desiredIds = new Set(entries.map((entry) => entry.id));
      for (const [id, row] of mountedRows) {
        if (desiredIds.has(id)) continue;
        this.cancelStreamingPatches(row, id);
        this.forgetDisclosureState(row);
        row.remove();
      }
      const history = this.refreshHistoryBoundary(timeline);
      let previous: Element = history;
      for (const entry of entries) {
        const row = entry.current ?? entry.next!;
        if (entry.current && entry.next) this.reconcileMessageRow(entry.current, entry.next);
        const moved = previous.nextElementSibling !== row;
        if (moved) timeline.insertBefore(row, previous.nextElementSibling);
        if (entry.next || moved) hydrateLazyDetails(row);
        previous = row;
      }

      const retry = this.reconcileSessionRetry(timeline);
      if (retry) {
        if (previous.nextElementSibling !== retry) timeline.insertBefore(retry, previous.nextElementSibling);
        previous = retry;
      }
      const sessionError = this.reconcileTransientSessionError(timeline, visibleMessages);
      if (sessionError) {
        if (previous.nextElementSibling !== sessionError) timeline.insertBefore(sessionError, previous.nextElementSibling);
        previous = sessionError;
      }
      const placeholder = this.reconcileWorkingPlaceholder(timeline, activeAssistantId);
      if (placeholder) {
        if (previous.nextElementSibling !== placeholder) timeline.insertBefore(placeholder, previous.nextElementSibling);
        previous = placeholder;
      }
      const rewind = this.refreshRewindBoundary(timeline);
      if (rewind) {
        if (previous.nextElementSibling !== rewind) timeline.insertBefore(rewind, previous.nextElementSibling);
        previous = rewind;
      }
      for (const child of Array.from(timeline.children)) {
        if (child === history || entries.some((entry) => (entry.current ?? entry.next) === child) || child === retry || child === sessionError || child === placeholder || child === rewind) continue;
        child.remove();
      }
      if (visibleMessages.length === 0 && !retry && !sessionError && !placeholder && !rewind) timeline.createDiv({ text: "No messages in this session yet.", cls: "opencode-session-view__empty" });
      this.deps.restoreFollowLatest(followGeneration);
      this.deps.updateJumpButton();
    } finally {
      // Replaced rows, discarded next-generation blocks, and removed content left disconnected markdown behind.
      this.scopes.releaseDetached();
    }
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

  /** Renders one keyed message row off-DOM for initial mount or changed-row reconciliation. */
  private async renderMessageRow(
    bundle: OpenCodeMessageBundle,
    options: MessageRenderOptions,
    assistantOptions?: AssistantMetaOptions,
    queued = false,
  ): Promise<HTMLElement> {
    const row = document.createElement("div");
    row.classList.add("opencode-session-view__message-row");
    row.dataset.messageId = messageHelpers.messageId(bundle);
    row.dataset.messageSignature = this.messageRowSignature(bundle, options, assistantOptions, queued);
    await this.renderMessage(row, bundle, options, assistantOptions, queued);
    return row;
  }

  /** Includes message-adjacent state and resolved task children in one row's visual signature. */
  private messageRowSignature(
    bundle: OpenCodeMessageBundle,
    options: MessageRenderOptions,
    assistantOptions?: AssistantMetaOptions,
    queued = false,
  ): string {
    return hashRenderState(JSON.stringify([
      JSON.stringify(bundle.info),
      bundle.parts.map(renderedPartHash),
      options,
      assistantOptions,
      queued,
      bundle.parts.map((part) => this.taskSessionRenderState(part)),
    ]));
  }

  /** Derives TUI-parity queued state: a user message trailing the active assistant turn while busy. */
  private isUserQueued(messages: OpenCodeMessageBundle[], index: number, pendingIndex: number): boolean {
    if (!this.deps.model.sessionBusy || pendingIndex < 0) return false;
    return messageHelpers.messageRole(messages[index]) === "user" && index > pendingIndex;
  }

  /** Reuses stable direct blocks while committing changed content into an existing message row. */
  private reconcileMessageRow(current: HTMLElement, next: HTMLElement): void {
    const currentBlocks = new Map(
      Array.from(current.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.blockKey)
        .map((block) => [block.dataset.blockKey!, block]),
    );
    const retainedChildren = new Set<ChildNode>();
    const desiredChildren = Array.from(next.childNodes, (nextChild) => {
      if (!(nextChild instanceof HTMLElement)) return nextChild;
      const nextBlock = nextChild;
      const nextBlockKey = nextBlock.dataset.blockKey;
      if (!nextBlockKey) return nextBlock;
      const currentBlock = currentBlocks.get(nextBlockKey);
      if (!currentBlock) return nextBlock;
      currentBlocks.delete(nextBlockKey);
      if (currentBlock.dataset.blockSignature === nextBlock.dataset.blockSignature) {
        retainedChildren.add(currentBlock);
        return currentBlock;
      }
      if (this.keepStreamingBlock(currentBlock, nextBlock, current.dataset.messageId)) {
        retainedChildren.add(currentBlock);
        return currentBlock;
      }
      if (
        currentBlock.classList.contains("opencode-session-view__message-meta--working")
        && nextBlock.classList.contains("opencode-session-view__message-meta--working")
      ) {
        this.reconcileWorkingMeta(currentBlock, nextBlock);
        retainedChildren.add(currentBlock);
        return currentBlock;
      }
      if (this.reconcileReasoningBlock(currentBlock, nextBlock, current.dataset.messageId)) {
        retainedChildren.add(currentBlock);
        return currentBlock;
      }
      if (this.reconcileToolBlock(currentBlock, nextBlock)) {
        retainedChildren.add(currentBlock);
        return currentBlock;
      }
      return nextBlock;
    });
    const nextDisclosureKeys = new Set(
      Array.from(next.querySelectorAll<HTMLElement>("[data-disclosure-key]"))
        .map((element) => element.dataset.disclosureKey)
        .filter((key): key is string => !!key),
    );
    for (const child of Array.from(current.children)) {
      if (!retainedChildren.has(child)) {
        this.cancelStreamingPatches(child as HTMLElement, current.dataset.messageId);
        this.forgetDisclosureState(child as HTMLElement, nextDisclosureKeys);
      }
    }
    this.syncAttributes(current, next);
    this.commitChildrenInPlace(current, desiredChildren, retainedChildren);
  }

  /** Updates live metadata while preserving the mounted CSS-animation badge element. */
  private reconcileWorkingMeta(current: HTMLElement, next: HTMLElement): void {
    const currentIndicator = current.querySelector<HTMLElement>(".opencode-status-badge");
    const nextIndicator = next.querySelector<HTMLElement>(".opencode-status-badge");
    const retainedChildren = new Set<ChildNode>();
    const desiredChildren = Array.from(next.childNodes, (nextChild) => {
      if (nextChild !== nextIndicator || !currentIndicator) return nextChild;
      retainedChildren.add(currentIndicator);
      return currentIndicator;
    });
    this.syncAttributes(current, next);
    this.commitChildrenInPlace(current, desiredChildren, retainedChildren);
  }

  /** Returns the streamed part ids a rendered block is mounted for. */
  private streamingPartIds(block: HTMLElement): string[] {
    return (block.dataset.partIds ?? block.dataset.partId ?? "").split(" ").filter(Boolean);
  }

  /** Returns true when the mounted target is a live patcher target for the same grouped parts. */
  private keepStreamingBlock(currentBlock: HTMLElement, nextBlock: HTMLElement, messageId: string | undefined): boolean {
    const currentIds = this.streamingPartIds(currentBlock);
    if (!messageId || currentIds.length === 0) return false;
    const nextIds = this.streamingPartIds(nextBlock);
    if (nextIds.join(" ") !== currentIds.join(" ")) return false;
    return currentIds.some((partId) => this.deps.isStreamingPartActive(messageId, partId));
  }

  /** Updates a reasoning shell in place so streaming and completion never remount its disclosure or icon. */
  private reconcileReasoningBlock(current: HTMLElement, next: HTMLElement, messageId: string | undefined): boolean {
    if (!(current instanceof HTMLDetailsElement) || !(next instanceof HTMLDetailsElement)) return false;
    if (!current.classList.contains("opencode-session-view__reasoning") || !next.classList.contains("opencode-session-view__reasoning")) return false;
    if (current.dataset.disclosureKey !== next.dataset.disclosureKey) return false;
    const currentSummary = current.querySelector<HTMLElement>(":scope > .opencode-session-view__reasoning-summary");
    const nextSummary = next.querySelector<HTMLElement>(":scope > .opencode-session-view__reasoning-summary");
    const currentBody = current.querySelector<HTMLElement>(":scope > .opencode-session-view__reasoning-body");
    const nextBody = next.querySelector<HTMLElement>(":scope > .opencode-session-view__reasoning-body");
    if (!currentSummary || !nextSummary || !currentBody || !nextBody) return false;

    this.reconcileAnimatedSummary(currentSummary, nextSummary, ".opencode-session-view__reasoning-icon");
    this.syncAttributes(currentBody, nextBody);
    if (currentBody.innerHTML !== nextBody.innerHTML && !this.keepStreamingBlock(currentBody, nextBody, messageId)) {
      this.cancelStreamingPatches(currentBody, messageId);
      currentBody.replaceChildren(...Array.from(nextBody.childNodes));
    }
    const wasOpen = current.open;
    this.syncAttributes(current, next);
    current.open = wasOpen;
    this.commitChildrenInPlace(current, [currentSummary, currentBody], new Set([currentSummary, currentBody]));
    return true;
  }

  /** Updates a lazy tool/group shell while preserving its disclosure, animated icon, and raw-mode state. */
  private reconcileToolBlock(current: HTMLElement, next: HTMLElement): boolean {
    if (!(current instanceof HTMLDetailsElement) || !(next instanceof HTMLDetailsElement)) return false;
    if (!current.classList.contains("opencode-session-view__tool") || !next.classList.contains("opencode-session-view__tool")) return false;
    if (current.dataset.disclosureKey !== next.dataset.disclosureKey) return false;
    const currentSummary = current.querySelector<HTMLElement>(":scope > .opencode-session-view__tool-summary");
    const nextSummary = next.querySelector<HTMLElement>(":scope > .opencode-session-view__tool-summary");
    if (!currentSummary || !nextSummary) return false;
    const resetBody = current.dataset.toolDetailSignature && next.dataset.toolDetailSignature
      ? current.dataset.toolDetailSignature !== next.dataset.toolDetailSignature
      : current.dataset.blockSignature !== next.dataset.blockSignature;
    if (!adoptLazyDetailsBody(current, next, resetBody)) return false;

    const wasOpen = current.open;
    const rawMode = current.dataset.toolRaw;
    this.syncAttributes(current, next);
    current.open = wasOpen;
    if (rawMode !== undefined) current.dataset.toolRaw = rawMode;
    this.reconcileAnimatedSummary(currentSummary, nextSummary, ".opencode-session-view__tool-icon");
    return true;
  }

  /** Replaces summary content while retaining the mounted span that owns its CSS animation. */
  private reconcileAnimatedSummary(current: HTMLElement, next: HTMLElement, iconSelector: string): void {
    const currentIcon = current.querySelector<HTMLElement>(`:scope > ${iconSelector}`);
    const nextIcon = next.querySelector<HTMLElement>(`:scope > ${iconSelector}`);
    const retainedChildren = new Set<ChildNode>();
    const desiredChildren = Array.from(next.childNodes, (nextChild) => {
      if (nextChild !== nextIcon || !currentIcon) return nextChild;
      retainedChildren.add(currentIcon);
      this.syncAttributes(currentIcon, nextIcon);
      if (currentIcon.innerHTML !== nextIcon.innerHTML) currentIcon.replaceChildren(...Array.from(nextIcon.childNodes));
      return currentIcon;
    });
    this.syncAttributes(current, next);
    this.commitChildrenInPlace(current, desiredChildren, retainedChildren);
  }

  /** Synchronizes changed attributes without transiently clearing unchanged CSS state. */
  private syncAttributes(current: HTMLElement, next: HTMLElement): void {
    for (const attribute of Array.from(current.attributes)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
  }

  /** Commits desired children while leaving retained mounted nodes connected when order permits. */
  private commitChildrenInPlace(container: HTMLElement, desiredChildren: ChildNode[], retainedChildren: Set<ChildNode>): void {
    for (const child of Array.from(container.childNodes)) {
      if (!retainedChildren.has(child)) child.remove();
    }
    let cursor = container.firstChild;
    for (const child of desiredChildren) {
      if (child === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      container.insertBefore(child, cursor);
    }
  }

  /** Reconciles the pre-assistant working metadata placeholder without restarting its indicator. */
  private reconcileWorkingPlaceholder(timeline: HTMLElement, activeAssistantId: string | undefined): HTMLElement | undefined {
    const current = timeline.querySelector<HTMLElement>(":scope > .opencode-session-view__assistant-meta-placeholder");
    if (!this.deps.model.sessionBusy || activeAssistantId) {
      current?.remove();
      return undefined;
    }
    const scratch = document.createElement("div");
    if (!this.renderWorkingAssistantPlaceholder(scratch, activeAssistantId)) return undefined;
    const next = scratch.firstElementChild as HTMLElement | null;
    if (!next) return undefined;
    if (!current) return next;
    const currentMeta = current.querySelector<HTMLElement>(".opencode-session-view__message-meta--working");
    const nextMeta = next.querySelector<HTMLElement>(".opencode-session-view__message-meta--working");
    if (currentMeta && nextMeta) this.reconcileWorkingMeta(currentMeta, nextMeta);
    return current;
  }

  /** Replaces only the rewind boundary when its id or affected-file signature changes. */
  private refreshRewindBoundary(timeline: HTMLElement): HTMLElement | undefined {
    const current = timeline.querySelector<HTMLElement>(":scope > .opencode-session-view__rewind-boundary");
    const signature = this.rewindSignature();
    if (!signature) {
      current?.remove();
      return undefined;
    }
    if (current?.dataset.rewindSignature === signature) return current;
    const scratch = document.createElement("div");
    renderRewindBoundary(scratch, this.rewindBoundaryProps());
    this.annotateRewindBoundary(scratch);
    const next = scratch.firstElementChild as HTMLElement | null;
    if (!next) return undefined;
    current?.remove();
    return next;
  }

  /** Renders one user, assistant, or compaction message block. */
  private async renderMessage(
    container: HTMLElement,
    bundle: OpenCodeMessageBundle,
    options: MessageRenderOptions,
    assistantOptions?: AssistantMetaOptions,
    queued = false,
  ): Promise<void> {
    if (messageHelpers.isCompactionMessage(bundle)) {
      this.renderCompactionDivider(container, bundle);
      return;
    }
    const role = messageHelpers.messageRole(bundle);
    if (role === "assistant") {
      await this.renderAssistantParts(container, bundle.parts, bundle.info, messageHelpers.messageId(bundle));
      if (isDisplayableAssistantError(bundle.info.error)) this.renderAssistantError(container, bundle.info.error, "assistant-error", false);
      if (options.showAssistantMeta) {
        const meta = renderMessageMeta(container, bundle, "assistant", options.assistantTurnText, this.messageMetaCallbacks(), assistantOptions);
        this.annotateBlock(meta, "assistant-meta", [bundle.info, options, assistantOptions]);
      }
      return;
    }

    const text = messageHelpers.userMessageText(bundle);
    const wrapper = container.createDiv({ cls: "opencode-session-view__user-message-wrap" });
    const article = wrapper.createDiv({ cls: `opencode-session-view__message opencode-session-view__message--${role}` });
    this.renderImageAttachments(article, messageHelpers.imageAttachments(bundle));
    if (text.trim()) {
      const body = article.createDiv({ cls: "opencode-session-view__markdown markdown-rendered" });
      const scopeKey = this.blockScopeKey(messageHelpers.messageId(bundle), "user");
      await MarkdownRenderer.renderMarkdown(text, body, this.markdownSourcePath(), this.claimBlockScope(scopeKey));
      this.scopes.bind(scopeKey, body);
    }
    renderMessageMeta(wrapper, bundle, "user", text, this.messageMetaCallbacks(), undefined, queued);
    this.annotateBlock(wrapper, "user-message", [bundle, queued]);
  }

  /** Renders clickable image thumbnails attached to a user message. */
  private renderImageAttachments(container: HTMLElement, images: ImageAttachment[]): void {
    if (images.length === 0) return;
    const grid = container.createDiv({ cls: "opencode-session-view__attachments" });
    for (const image of images) {
      const button = grid.createEl("button", { attr: { "aria-label": `Open image ${image.name}` }, cls: "opencode-session-view__attachment" });
      button.createEl("img", { attr: { src: image.url, alt: image.name, loading: "lazy" }, cls: "opencode-session-view__attachment-image" });
      button.createSpan({ text: image.name, cls: "opencode-session-view__attachment-name" });
      button.addEventListener("click", () => openImagePreview(this.deps.app, image));
    }
  }

  /** Renders one static compaction boundary divider; its summary assistant renders as a normal turn. */
  private renderCompactionDivider(container: HTMLElement, bundle: OpenCodeMessageBundle): void {
    const divider = container.createDiv({ cls: "opencode-session-view__compaction" });
    this.annotateBlock(divider, "compaction", bundle);
    divider.createSpan({ cls: "opencode-session-view__compaction-line" });
    divider.createSpan({ text: "Session compacted", cls: "opencode-session-view__compaction-label" });
    divider.createSpan({ cls: "opencode-session-view__compaction-line" });
  }

  /** Renders assistant parts in server order, preserving step gaps and grouped context tools. */
  private async renderAssistantParts(container: HTMLElement, parts: JsonObject[], info: JsonObject, messageId: string): Promise<void> {
    let textBuffer: JsonObject[] = [];
    let contextBuffer: JsonObject[] = [];
    let reasoningBuffer: JsonObject[] = [];
    let hasRenderedPart = false;
    let pendingStepGapKey: string | undefined;
    const ctx = this.blockCtx(messageId);

    const markRendered = (): void => {
      hasRenderedPart = true;
    };
    const insertPendingStepGap = (): void => {
      if (!pendingStepGapKey) return;
      const gap = container.createDiv({ cls: "opencode-session-view__part-gap" });
      this.annotateBlock(gap, pendingStepGapKey, pendingStepGapKey);
      pendingStepGapKey = undefined;
    };
    const flushText = async (): Promise<void> => {
      const group = textBuffer;
      textBuffer = [];
      const text = group.map((part) => jsonHelpers.readString(part, ["text"]) ?? "").join("\n\n").trim();
      if (!text) return;
      pendingStepGapKey = undefined;
      const body = container.createDiv({ cls: "opencode-session-view__markdown opencode-session-view__assistant-markdown markdown-preview-view markdown-rendered" });
      bindStreamingTextTarget(body, group);
      this.annotateBlock(body, this.assistantBlockKey("text", group), group);
      const scopeKey = this.blockScopeKey(messageId, this.assistantBlockKey("text", group));
      await MarkdownRenderer.renderMarkdown(text, body, this.markdownSourcePath(), this.claimBlockScope(scopeKey));
      this.scopes.bind(scopeKey, body);
      markRendered();
    };
    const flushContext = async (): Promise<void> => {
      const group = contextBuffer;
      contextBuffer = [];
      if (group.length === 0) return;
      insertPendingStepGap();
      const firstIndex = container.children.length;
      const scopeKey = this.blockScopeKey(messageId, this.assistantBlockKey("context", group));
      const scopedCtx = this.scopedBlockCtx(ctx, scopeKey);
      if (group.length === 1) await renderToolCall(container, group[0], scopedCtx);
      else await renderContextToolGroup(container, group, scopedCtx);
      const block = container.children.item(firstIndex);
      if (block instanceof HTMLElement) {
        this.annotateBlock(block, this.assistantBlockKey("context", group), group);
        this.scopes.bind(scopeKey, block);
      }
      markRendered();
    };
    const flushReasoning = async (): Promise<void> => {
      const group = reasoningBuffer;
      reasoningBuffer = [];
      if (group.length === 0 || !this.deps.getShowReasoningBlocks()) return;
      insertPendingStepGap();
      const firstIndex = container.children.length;
      const scopeKey = this.blockScopeKey(messageId, this.assistantBlockKey("reasoning", group));
      if (await renderReasoningBlock(container, group, info, this.scopedBlockCtx(ctx, scopeKey))) {
        const block = container.children.item(firstIndex);
        if (block instanceof HTMLElement) {
          this.annotateBlock(block, this.assistantBlockKey("reasoning", group), [group, info.tokens]);
          this.scopes.bind(scopeKey, block);
        }
        markRendered();
      }
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
        pendingStepGapKey = hasRenderedPart ? this.assistantBlockKey("gap", [part]) : undefined;
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
      const firstIndex = container.children.length;
      const scopeKey = this.blockScopeKey(messageId, this.assistantBlockKey("tool", [part]));
      await renderToolCall(container, part, this.scopedBlockCtx(ctx, scopeKey));
      const block = container.children.item(firstIndex);
      if (block instanceof HTMLElement) {
        this.annotateBlock(block, this.assistantBlockKey("tool", [part]), [part, this.taskSessionRenderState(part)]);
        this.scopes.bind(scopeKey, block);
      }
      markRendered();
    }

    await flushText();
    await flushReasoning();
    await flushContext();
  }

  /** Renders one native-theme error card for a durable assistant error or transient session event. */
  private renderAssistantError(container: HTMLElement, error: unknown, key: string, live: boolean): HTMLElement {
    const message = assistantErrorMessage(error);
    const card = container.createDiv({ cls: "opencode-session-view__assistant-error", attr: { role: live ? "alert" : "note" } });
    const icon = card.createSpan({ cls: "opencode-session-view__assistant-error-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "alert-circle");
    const content = card.createDiv({ cls: "opencode-session-view__assistant-error-content" });
    content.createDiv({ text: "OpenCode error", cls: "opencode-session-view__assistant-error-title" });
    content.createDiv({ text: message, cls: "opencode-session-view__assistant-error-message" });
    const diagnostics = assistantErrorDiagnostics(error);
    const diagnosticsText = assistantErrorDiagnosticsText(error);
    if (diagnostics.length > 0) {
      const details = content.createEl("details", { cls: "opencode-session-view__error-diagnostics" });
      details.createEl("summary", { text: "Diagnostics" });
      const rows = details.createDiv({ cls: "opencode-session-view__error-diagnostic-rows" });
      for (const diagnostic of diagnostics) {
        const row = rows.createDiv({ cls: "opencode-session-view__error-diagnostic" });
        row.createSpan({ text: diagnostic.label, cls: "opencode-session-view__error-diagnostic-label" });
        row.createSpan({ text: diagnostic.value, cls: "opencode-session-view__error-diagnostic-value" });
      }
      const copy = details.createEl("button", { text: "Copy diagnostics", cls: "opencode-session-view__error-diagnostic-copy" });
      copy.addEventListener("click", () => void this.copyErrorDiagnostics(diagnosticsText));
    }
    this.annotateBlock(card, key, [message, diagnosticsText]);
    return card;
  }

  /** Renders the active v1 retry payload with its provider message, spinner, countdown, and attempt. */
  private renderSessionRetry(container: HTMLElement): HTMLElement | undefined {
    const retry = this.deps.model.sessionRetry;
    if (!retry || this.deps.getRevertMessageId()) return undefined;
    const card = container.createDiv({ cls: "opencode-session-view__retry-card", attr: { role: "note" } });
    card.createSpan({ cls: "opencode-session-view__retry-spinner", attr: { "aria-hidden": "true" } });
    const content = card.createDiv({ cls: "opencode-session-view__retry-content" });
    const display = this.retryMessageDisplay(retry.message);
    content.createDiv({ text: display.text, cls: "opencode-session-view__retry-message", attr: display.title ? { title: display.title } : undefined });
    content.createDiv({
      text: retryCountdownText(retry),
      cls: "opencode-session-view__retry-info",
      attr: { "data-retry-next": String(retry.next), "data-retry-attempt": String(retry.attempt) },
    });
    card.dataset.sessionRetrySignature = this.sessionRetrySignature(retry);
    return card;
  }

  /** Reconciles the retry card independently so countdown ticks never rebuild message rows. */
  private reconcileSessionRetry(timeline: HTMLElement): HTMLElement | undefined {
    const current = timeline.querySelector<HTMLElement>(":scope > .opencode-session-view__retry-card");
    const retry = this.deps.model.sessionRetry;
    if (!retry || this.deps.getRevertMessageId()) {
      current?.remove();
      return undefined;
    }
    const signature = this.sessionRetrySignature(retry);
    if (current?.dataset.sessionRetrySignature === signature) return current;
    const scratch = document.createElement("div");
    const next = this.renderSessionRetry(scratch);
    current?.remove();
    return next;
  }

  /** Truncates retry text to the product-spec limit while retaining the full tooltip. */
  private retryMessageDisplay(message: string): { text: string; title?: string } {
    if (message.length <= 80) return { text: message };
    return { text: `${message.slice(0, 79)}…`, title: message };
  }

  /** Hashes only retry fields represented by the mounted card. */
  private sessionRetrySignature(retry: SessionRetryStatus): string {
    return hashRenderState(JSON.stringify([retry.attempt, retry.message, retry.next]));
  }

  /** Copies only the sanitized diagnostic summary from an explicit user action. */
  private async copyErrorDiagnostics(diagnostics: string): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(diagnostics);
      new Notice("Copied OpenCode error diagnostics.");
    } catch {
      new Notice("Unable to copy OpenCode error diagnostics.");
    }
  }

  /** Appends the event-only fallback unless the latest assistant already persists the same error. */
  private renderTransientSessionError(container: HTMLElement, messages: OpenCodeMessageBundle[]): HTMLElement | undefined {
    const state = this.visibleSessionError(messages);
    if (!state) return undefined;
    const card = this.renderAssistantError(container, state.error, "session-error", true);
    card.dataset.sessionErrorSignature = hashRenderState(assistantErrorDiagnosticsText(state.error) || state.message);
    return card;
  }

  /** Reconciles the event-only error card independently from keyed message rows. */
  private reconcileTransientSessionError(timeline: HTMLElement, messages: OpenCodeMessageBundle[]): HTMLElement | undefined {
    const current = timeline.querySelector<HTMLElement>(":scope > .opencode-session-view__assistant-error[data-session-error-signature]");
    const state = this.visibleSessionError(messages);
    if (!state) {
      current?.remove();
      return undefined;
    }
    const signature = hashRenderState(assistantErrorDiagnosticsText(state.error) || state.message);
    if (current?.dataset.sessionErrorSignature === signature) return current;
    const scratch = document.createElement("div");
    const next = this.renderTransientSessionError(scratch, messages);
    current?.remove();
    return next;
  }

  /** Returns the retained event error when no latest assistant error already renders it. */
  private visibleSessionError(messages: OpenCodeMessageBundle[]): SessionViewModel["sessionError"] {
    const state = this.deps.model.sessionError;
    if (!state || this.deps.model.sessionRetry || this.deps.getRevertMessageId()) return undefined;
    const latestAssistant = [...messages].reverse().find((bundle) => messageHelpers.messageRole(bundle) === "assistant" && !messageHelpers.isCompactionMessage(bundle));
    const persistedError = latestAssistant?.info.error;
    if (isDisplayableAssistantError(persistedError) && assistantErrorMessage(persistedError) === state.message) return undefined;
    return state;
  }

  /** Assigns stable identity and visual state to a direct message block. */
  private annotateBlock(block: HTMLElement, key: string, state: unknown): void {
    block.dataset.blockKey = key;
    block.dataset.blockSignature = hashRenderState(JSON.stringify(projectedRenderState(state)));
  }

  /** Returns external child identity that can change a task block without changing its message part. */
  private taskSessionRenderState(part: JsonObject): [string, string | undefined] | undefined {
    if (normalizedToolName(part) !== "task") return undefined;
    const state = jsonHelpers.readObject(part, "state") ?? {};
    const input = jsonHelpers.readObject(state, "input") ?? {};
    const sessionId = taskSessionId(input, state);
    return sessionId ? [sessionId, this.deps.model.descendantSessions.get(sessionId)?.title] : undefined;
  }

  /** Builds a stable assistant block key from its first constituent OpenCode part. */
  private assistantBlockKey(kind: string, parts: JsonObject[]): string {
    return `${kind}:${blockPartId(parts[0] ?? {}) ?? "part"}`;
  }

  /** Removes disclosure state owned by timeline content that is no longer mounted. */
  private forgetDisclosureState(container: HTMLElement, retainedKeys = new Set<string>()): void {
    if (container.dataset.disclosureKey && !retainedKeys.has(container.dataset.disclosureKey)) this.openDisclosures.delete(container.dataset.disclosureKey);
    for (const details of Array.from(container.querySelectorAll<HTMLElement>("[data-disclosure-key]"))) {
      if (details.dataset.disclosureKey && !retainedKeys.has(details.dataset.disclosureKey)) this.openDisclosures.delete(details.dataset.disclosureKey);
    }
  }

  /** Cancels every streamed-part patch whose mounted target is about to be removed or replaced. */
  private cancelStreamingPatches(container: HTMLElement, messageId: string | undefined): void {
    if (!messageId) return;
    const targets = [
      ...(container.matches('[data-stream-field="text"]') ? [container] : []),
      ...Array.from(container.querySelectorAll<HTMLElement>('[data-stream-field="text"]')),
    ];
    for (const target of targets) {
      const partIds = (target.dataset.partIds ?? target.dataset.partId ?? "").split(" ").filter(Boolean);
      for (const partId of partIds) this.deps.cancelStreamingMarkdownPatch(`${messageId}:${partId}:text`);
    }
  }

  /** Updates active-turn duration and retry countdown labels without rebuilding timeline content. */
  refreshLiveTimelineStatus(now = Date.now()): void {
    if (this.deps.model.sessionBusy) {
      const durations = this.deps.contentEl.querySelectorAll<HTMLElement>(".opencode-session-view__message-meta--working [data-turn-started-at]");
      for (const duration of Array.from(durations)) {
        const startedAt = Number(duration.dataset.turnStartedAt);
        const label = messageHelpers.elapsedDurationLabel(Number.isFinite(startedAt) ? startedAt : undefined, now);
        if (label) duration.setText(`${duration.dataset.metaPrefix ?? ""}${label}`);
      }
    }
    for (const countdown of Array.from(this.deps.contentEl.querySelectorAll<HTMLElement>("[data-retry-next][data-retry-attempt]"))) {
      const retry: SessionRetryStatus = { message: "", next: Number(countdown.dataset.retryNext), attempt: Number(countdown.dataset.retryAttempt) };
      countdown.setText(retryCountdownText(retry, now));
    }
  }

  /** Replaces the history row so pagination completion changes are reflected without rebuilding messages. */
  private refreshHistoryBoundary(timeline: HTMLElement): HTMLElement {
    const scratch = document.createElement("div");
    this.renderHistoryBoundary(scratch);
    const next = scratch.firstElementChild as HTMLElement;
    const current = timeline.querySelector<HTMLElement>(":scope > .opencode-session-view__history-boundary");
    if (current && current.className === next.className && current.innerHTML === next.innerHTML) return current;
    if (current) current.replaceWith(next);
    else timeline.prepend(next);
    return next;
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

  /** Finds the visible assistant row that owns the current busy turn's metadata. */
  private activeAssistantMessageId(messages: OpenCodeMessageBundle[]): string | undefined {
    if (!this.deps.model.sessionBusy) return undefined;
    const latest = messages.at(-1);
    if (latest && messageHelpers.messageRole(latest) === "assistant" && !messageHelpers.isCompactionMessage(latest)) return messageHelpers.messageId(latest);
    if (!latest || messageHelpers.messageRole(latest) !== "user") return undefined;
    // A trailing user message during a busy turn means the active row is the last uncompleted assistant before it.
    for (const message of [...messages].reverse()) {
      if (messageHelpers.messageRole(message) !== "assistant" || messageHelpers.isCompactionMessage(message)) continue;
      return messageHelpers.messageCompletedTime(message) === undefined ? messageHelpers.messageId(message) : undefined;
    }
    return undefined;
  }

  /** Builds live/final timing and action state for one assistant turn metadata row. */
  private assistantMetaOptions(messages: OpenCodeMessageBundle[], index: number, activeAssistantId?: string): AssistantMetaOptions | undefined {
    const bundle = messages[index];
    if (messageHelpers.messageRole(bundle) !== "assistant" || messageHelpers.isCompactionMessage(bundle)) return undefined;
    const timing = assistantTurnTiming(messages, index);
    const working = messageHelpers.messageId(bundle) === activeAssistantId;
    const latestAssistant = index === messages.length - 1;
    return {
      working,
      workingAnimation: this.deps.getWorkingAnimation(),
      startedAt: working ? this.liveTurnStartedAt(timing.startedAt) : timing.startedAt,
      completedAt: !this.deps.model.sessionBusy && latestAssistant
        ? this.deps.model.activeTurnCompletedAt ?? timing.completedAt
        : timing.completedAt,
      forkMessageId: messageHelpers.messageId(bundle),
    };
  }

  /** Renders metadata immediately when a busy turn has no visible assistant message yet. */
  private renderWorkingAssistantPlaceholder(container: HTMLElement, activeAssistantId: string | undefined): boolean {
    if (!this.deps.model.sessionBusy || activeAssistantId) return false;
    const latestUser = [...this.deps.model.loadedMessages]
      .sort((left, right) => messageHelpers.messageTime(right) - messageHelpers.messageTime(left))
      .find((message) => messageHelpers.messageRole(message) === "user");
    const startedAt = this.liveTurnStartedAt(latestUser ? messageHelpers.messageTime(latestUser) : undefined);
    const source = latestUser ?? this.syntheticAssistantMetaSource(startedAt);
    const row = container.createDiv({ cls: "opencode-session-view__message-row opencode-session-view__assistant-meta-placeholder" });
    const meta = renderMessageMeta(row, source, "assistant", "", this.messageMetaCallbacks(), { working: true, workingAnimation: this.deps.getWorkingAnimation(), startedAt });
    this.annotateBlock(meta, "assistant-meta", [source.info, startedAt, true]);
    return true;
  }

  /** Prefers the current turn's persisted user timestamp over its local status-receipt fallback. */
  private liveTurnStartedAt(messageStartedAt: number | undefined): number | undefined {
    return messageStartedAt && messageStartedAt > 0 ? messageStartedAt : this.deps.model.activeTurnStartedAt;
  }

  /** Creates metadata fields before OpenCode has streamed the first assistant message object. */
  private syntheticAssistantMetaSource(startedAt: number | undefined): OpenCodeMessageBundle {
    const info: JsonObject = { role: "assistant", time: { created: startedAt ?? Date.now() } };
    if (this.deps.model.selectedAgent) info.agent = this.deps.model.selectedAgent;
    if (this.deps.model.selectedModel) info.model = this.deps.model.selectedModel;
    return { info, parts: [] };
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
  private blockCtx(messageId?: string): BlockRenderCtx {
    return {
      component: this.deps.component,
      sessionId: this.deps.model.sessionId,
      messageId,
      sessionDirectory: this.deps.model.sessionDirectory,
      customToolDisplays: this.deps.getCustomToolDisplays(),
      openDisclosures: this.openDisclosures,
      resolveSession: (sessionId) => this.deps.model.descendantSessions.get(sessionId),
      openSession: (sessionId, title) => this.deps.onOpenSession(sessionId, title),
    };
  }

  /** Builds a globally unique render-scope key for one markdown block inside a message row. */
  private blockScopeKey(messageId: string | undefined, blockKey: string): string {
    return `${messageId ?? "message"}:${blockKey}`;
  }

  /** Claims a fresh lifecycle scope for one keyed markdown block, retiring the previous generation until its DOM is discarded. */
  private claimBlockScope(key: string): Component {
    this.scopes.retire(key);
    return this.scopes.scope(key);
  }

  /** Derives a block rendering context whose markdown children register on a fresh scoped component instead of the view. */
  private scopedBlockCtx(ctx: BlockRenderCtx, key: string): BlockRenderCtx {
    return { ...ctx, component: this.claimBlockScope(key) };
  }

  /** Builds message action callbacks without exposing shell/controller references. */
  private messageMetaCallbacks(): MessageMetaCallbacks {
    return {
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
