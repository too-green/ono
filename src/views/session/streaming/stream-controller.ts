import { diffFilesFromRecords, type DiffFileSummary } from "../../../diff-utils";
import type { OpenCodeEventHandlers, OpenCodeEventSubscription } from "../../../services/opencode-events";
import type { JsonObject, OpenCodeEvent, OpenCodePermissionRequest, OpenCodeQuestionRequest } from "../../../services/opencode-types";
import * as jsonHelpers from "../json-helpers";
import { messageId, messageTime } from "../message-helpers";
import type { SessionViewModel } from "../session-view-model";

interface AppliedPartDelta {
  messageId: string;
  partId: string;
  field: string;
  part: JsonObject;
}

/** Dependencies used by `StreamController` to emit shell and collaborator events. */
export interface StreamDeps {
  model: SessionViewModel;
  subscribeToEvents: (handlers: OpenCodeEventHandlers, directory?: string) => OpenCodeEventSubscription;
  findStreamingPartTarget: (messageId: string, partId: string, type: string) => HTMLElement | undefined;
  queueStreamingMarkdownPatch: (key: string, element: HTMLElement, markdown: string) => void;
  shouldFollowLatest: () => boolean;
  extendFollowLatest: (durationMs: number) => void;
  scrollToBottom: (smooth: boolean) => void;
  updateJumpButton: () => void;
  onSessionUpdated: (session: JsonObject) => void;
  onSessionDiff: (diffs: DiffFileSummary[]) => void;
  onStatusChange: (status: JsonObject) => void;
  onPermissionAsked: (request: OpenCodePermissionRequest) => void;
  onPermissionReplied: (requestId: string | undefined) => void;
  onQuestionAsked: (request: OpenCodeQuestionRequest) => void;
  onQuestionSettled: (requestId: string | undefined) => void;
  requestTimelineRender: () => Promise<void>;
  requestDiffPanelRefresh: (force: boolean) => Promise<void>;
  requestComposerProgressRefresh: () => void;
  requestCanonicalSync: () => void | Promise<void>;
}

/** Checks common v1 event payload locations for the active session id. */
export function eventReferencesSession(properties: JsonObject | undefined, sessionId: string | undefined): boolean {
  if (!sessionId || !properties) return false;
  if (properties.sessionID === sessionId || properties.sessionId === sessionId) return true;
  const info = jsonHelpers.readObject(properties, "info");
  if (info?.sessionID === sessionId || info?.sessionId === sessionId || info?.id === sessionId) return true;
  const part = jsonHelpers.readObject(properties, "part");
  return part?.sessionID === sessionId || part?.sessionId === sessionId;
}

/** Owns directory-scoped stream subscriptions and reconciles v1 events into `SessionViewModel`. */
export class StreamController {
  private refreshTimer?: number;
  private renderFrame?: number;
  private renderInFlight = false;
  private renderPending = false;
  private subscription?: OpenCodeEventSubscription;
  private subscriptionDirectory?: string;
  private workVersion = 0;
  private disposed = false;

  constructor(private readonly deps: StreamDeps) {}

  /** Subscribes to the active directory and replaces any subscription from a previous session binding. */
  subscribe(directory: string | undefined): void {
    if (this.disposed || (this.subscriptionDirectory === directory && this.subscription)) return;
    this.disconnect();
    const version = this.workVersion;
    this.subscriptionDirectory = directory;
    this.subscription = this.deps.subscribeToEvents({
      onEvent: (event) => {
        if (this.disposed || version !== this.workVersion || !eventReferencesSession(event.properties, this.deps.model.sessionId)) return;
        this.applyEvent(event);
      },
      onOpen: () => {
        if (this.disposed || version !== this.workVersion) return;
        if (this.deps.model.renderedSessionId === this.deps.model.sessionId) this.scheduleCanonicalSync(0);
      },
    }, directory);
  }

  /** Closes the current subscription and cancels work associated with the previous session binding. */
  disconnect(): void {
    this.workVersion += 1;
    this.subscription?.close();
    this.subscription = undefined;
    this.subscriptionDirectory = undefined;
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
    if (this.renderFrame !== undefined) window.cancelAnimationFrame(this.renderFrame);
    this.refreshTimer = undefined;
    this.renderFrame = undefined;
    this.renderPending = false;
  }

  /** Debounces a canonical sync request while keeping canonical data fetching in the shell. */
  scheduleCanonicalSync(delayMs = 500): void {
    if (this.disposed) return;
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
    const version = this.workVersion;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.disposed && version === this.workVersion) void this.requestCanonicalSyncSafely();
    }, delayMs);
  }

  /** Releases the SSE subscription, timers, and animation-frame work when the session view closes. */
  dispose(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
  }

  /** Dispatches one filtered v1 event into model reconciliation or a narrow shell callback. */
  private applyEvent(event: OpenCodeEvent): void {
    const properties = event.properties;
    if (!properties) return;
    console.debug("[opencode-plugin:session-stream] applying", { sessionId: this.deps.model.sessionId, type: event.type, properties });
    if (this.deps.model.followLatest && (event.type.startsWith("message.") || event.type === "session.updated" || event.type === "session.status")) {
      this.deps.extendFollowLatest(1600);
    }

    if (event.type === "message.updated") {
      const info = jsonHelpers.readObject(properties, "info");
      if (info) this.upsertMessage(info);
      this.scheduleRender();
      return;
    }
    if (event.type === "message.removed") {
      const removedId = jsonHelpers.readString(properties, ["messageID", "messageId"]);
      if (removedId) {
        this.deps.model.loadedMessages = this.deps.model.loadedMessages.filter((message) => messageId(message) !== removedId);
        this.deps.model.queuedMessageIds.delete(removedId);
        this.scheduleRender();
      }
      return;
    }
    if (event.type === "message.part.removed") {
      const parentId = jsonHelpers.readString(properties, ["messageID", "messageId"]);
      const removedId = jsonHelpers.readString(properties, ["partID", "partId"]);
      const message = parentId ? this.deps.model.loadedMessages.find((item) => messageId(item) === parentId) : undefined;
      if (message && removedId) {
        message.parts = message.parts.filter((part) => jsonHelpers.readString(part, ["id", "partID", "partId"]) !== removedId);
        this.scheduleRender();
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = jsonHelpers.readObject(properties, "part");
      if (part) this.upsertPart(part);
      this.scheduleRender();
      return;
    }
    if (event.type === "message.part.delta") {
      const applied = this.applyPartDelta(properties);
      if (applied && this.patchPart(applied)) {
        // A detached timeline already being rendered may not contain this delta; replace it once more afterward.
        if (this.renderInFlight) this.scheduleRender();
        return;
      }
      this.scheduleRender();
      return;
    }
    if (event.type === "session.updated") {
      if (this.deps.model.rewindInFlight) return;
      const info = jsonHelpers.readObject(properties, "info");
      if (info) this.deps.onSessionUpdated(info);
      this.scheduleRender();
      return;
    }
    if (event.type === "session.diff") {
      this.deps.onSessionDiff(diffFilesFromRecords(jsonHelpers.readObjectArray(properties, "diff")));
      this.scheduleRender();
      void this.deps.requestDiffPanelRefresh(true).catch((error) => {
        console.warn("[opencode-plugin:session-stream] diff panel refresh failed", error);
      });
      return;
    }
    if (event.type === "session.status") {
      const status = jsonHelpers.readObject(properties, "status");
      if (status) this.deps.onStatusChange(status);
      return;
    }
    if (event.type === "permission.asked") {
      this.deps.onPermissionAsked(properties as OpenCodePermissionRequest);
      return;
    }
    if (event.type === "permission.replied") {
      this.deps.onPermissionReplied(jsonHelpers.readString(properties, ["requestID", "requestId", "id"]));
      return;
    }
    if (event.type === "question.asked") {
      this.deps.onQuestionAsked(properties as OpenCodeQuestionRequest);
      return;
    }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      this.deps.onQuestionSettled(jsonHelpers.readString(properties, ["requestID", "requestId", "id"]));
    }
  }

  /** Inserts or replaces one streamed message while preserving already received parts. */
  private upsertMessage(info: JsonObject): void {
    const id = jsonHelpers.readString(info, ["id", "messageID", "messageId"]);
    if (!id) return;
    const role = jsonHelpers.readString(info, ["role"]);
    const index = this.deps.model.loadedMessages.findIndex((bundle) => messageId(bundle) === id);
    const isNew = index < 0;
    if (index >= 0) this.deps.model.loadedMessages[index] = { ...this.deps.model.loadedMessages[index], info };
    else this.deps.model.loadedMessages.push({ info, parts: [] });
    if (isNew && role === "user" && this.deps.model.pendingQueuedUserMessages > 0) {
      this.deps.model.pendingQueuedUserMessages -= 1;
      this.deps.model.queuedMessageIds.add(id);
    }
    this.deps.model.loadedMessages.sort((left, right) => messageTime(left) - messageTime(right));
  }

  /** Inserts or replaces a full streamed part in its parent message bundle. */
  private upsertPart(part: JsonObject): void {
    const parentId = jsonHelpers.readString(part, ["messageID", "messageId"]);
    const partId = jsonHelpers.readString(part, ["id", "partID", "partId"]);
    if (!parentId || !partId) return;
    const bundle = this.deps.model.loadedMessages.find((item) => messageId(item) === parentId);
    if (!bundle) {
      this.deps.model.loadedMessages.push({
        info: { id: parentId, sessionID: this.deps.model.sessionId, role: "assistant", time: { created: Date.now() } },
        parts: [part],
      });
      this.deps.model.loadedMessages.sort((left, right) => messageTime(left) - messageTime(right));
      return;
    }
    const index = bundle.parts.findIndex((item) => jsonHelpers.readString(item, ["id", "partID", "partId"]) === partId);
    if (index >= 0) bundle.parts[index] = part;
    else bundle.parts.push(part);
  }

  /** Appends one text/reasoning field delta to an existing streamed part. */
  private applyPartDelta(properties: JsonObject): AppliedPartDelta | undefined {
    const parentId = jsonHelpers.readString(properties, ["messageID", "messageId"]);
    const partId = jsonHelpers.readString(properties, ["partID", "partId"]);
    const field = jsonHelpers.readString(properties, ["field"]);
    const delta = jsonHelpers.readString(properties, ["delta"]);
    if (!parentId || !partId || !field || delta === undefined) return undefined;
    const bundle = this.deps.model.loadedMessages.find((item) => messageId(item) === parentId);
    const part = bundle?.parts.find((item) => jsonHelpers.readString(item, ["id", "partID", "partId"]) === partId);
    if (!part) return undefined;
    const current = typeof part[field] === "string" ? part[field] : "";
    part[field] = `${current}${delta}`;
    return { messageId: parentId, partId, field, part };
  }

  /** Applies a text delta directly to the mounted active part when a patchable target exists. */
  private patchPart(delta: AppliedPartDelta): boolean {
    if (delta.field !== "text") return false;
    const type = jsonHelpers.readString(delta.part, ["type"]);
    if (type !== "text" && type !== "reasoning") return false;
    const target = this.deps.findStreamingPartTarget(delta.messageId, delta.partId, type);
    if (!target) return false;
    const wasAtBottom = this.deps.shouldFollowLatest();
    this.deps.queueStreamingMarkdownPatch(`${delta.messageId}:${delta.partId}:${delta.field}`, target, jsonHelpers.readString(delta.part, ["text"]) ?? "");
    if (wasAtBottom) this.deps.scrollToBottom(false);
    this.deps.updateJumpButton();
    return true;
  }

  /** Queues a frame-bounded timeline render without postponing every token delta. */
  private scheduleRender(): void {
    if (this.disposed) return;
    this.renderPending = true;
    if (this.renderFrame !== undefined || this.renderInFlight) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = undefined;
      void this.flushRender();
    });
  }

  /** Renders the latest accumulated stream state and follows up when events arrive mid-render. */
  private async flushRender(): Promise<void> {
    if (!this.renderPending || !this.deps.model.currentSession || !this.deps.model.sessionId) {
      this.renderPending = false;
      return;
    }
    const version = this.workVersion;
    this.renderPending = false;
    this.renderInFlight = true;
    try {
      console.debug("[opencode-plugin:session-stream] render", { sessionId: this.deps.model.sessionId, messages: this.deps.model.loadedMessages.length });
      await this.deps.requestTimelineRender();
      if (this.disposed || version !== this.workVersion) return;
      await this.deps.requestDiffPanelRefresh(false);
      if (this.disposed || version !== this.workVersion) return;
      this.deps.requestComposerProgressRefresh();
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] render failed", error);
    } finally {
      this.renderInFlight = false;
      if (!this.disposed && this.renderPending) this.scheduleRender();
    }
  }

  /** Contains failures from the shell-owned canonical fetch invoked by the debounce timer. */
  private async requestCanonicalSyncSafely(): Promise<void> {
    try {
      await this.deps.requestCanonicalSync();
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] canonical sync request failed", error);
    }
  }
}
