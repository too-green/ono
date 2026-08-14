import { Notice } from "obsidian";
import type { NotificationMode } from "../settings";
import type { JsonObject, OpenCodeEvent, OpenCodePermissionRequest, OpenCodeQuestionRequest, OpenCodeSession } from "./opencode-types";

export type SessionNotificationKind = "attention" | "error" | "turn-complete";
export type SessionNotificationTestKind = "permission" | "question" | "turn-complete" | "error";

export interface SessionNotificationPreferences {
  mode: NotificationMode;
  attention: boolean;
  errors: boolean;
  turnComplete: boolean;
}

interface CloseableNotification {
  close(): void;
}

type NotificationRendererWindow = Window & { Notification?: typeof Notification };

export interface SessionNotificationServiceDeps {
  getPreferences(): SessionNotificationPreferences;
  isSessionMuted(sessionId: string): boolean;
  isSessionVisible(sessionId: string): boolean;
  getSession(sessionId: string, directory?: string): Promise<OpenCodeSession>;
  openSession(sessionId: string, title?: string): Promise<void>;
  getNotificationWindow?(): Window | undefined;
  getNotificationApi?(): typeof Notification | undefined;
  showNotice?(message: string, onClick: () => void): CloseableNotification;
}

interface NotificationContent {
  key: string;
  kind: SessionNotificationKind;
  sessionId: string;
  directory?: string;
  requestId?: string;
  body: string;
}

const RECENT_REQUEST_LIMIT = 1_000;
const ACTIVE_DELIVERY_LIMIT = 1_000;
const SESSION_STATE_LIMIT = 1_000;

/** Returns whether an element is rendered inside the currently focused Obsidian window. */
export function isElementVisibleInFocusedWindow(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const doc = element.doc ?? element.ownerDocument;
  if (!doc.hasFocus()) return false;
  if (typeof element.isShown === "function" && !element.isShown()) return false;
  const rect = element.getBoundingClientRect();
  const win = element.win ?? doc.defaultView;
  if (!win || rect.width <= 0 || rect.height <= 0) return false;
  return rect.right > 0 && rect.bottom > 0 && rect.left < win.innerWidth && rect.top < win.innerHeight;
}

/** Extracts a concise user-facing message from a v1 `session.error` payload. */
export function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "Session stopped with an error.";
  const value = error as JsonObject;
  if (value.name === "MessageAbortedError") return "Session was aborted.";
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const message = (data as JsonObject).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return "Session stopped with an error.";
}

/** Shows a clickable Obsidian Notice using only native Notice content and lifecycle APIs. */
function showObsidianNotice(message: string, onClick: () => void): CloseableNotification {
  const notice = new Notice(message, 8_000);
  const content = notice.messageEl ?? notice.noticeEl;
  content.tabIndex = 0;
  content.setAttribute("role", "button");
  content.addEventListener("click", onClick);
  content.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onClick();
  });
  return { close: () => notice.hide() };
}

/** Converts OpenCode session lifecycle and request events into deduplicated user notifications. */
export class SessionNotificationService {
  private readonly terminalStateBySessionKey = new Map<string, "error" | "idle">();
  private readonly seenRequestKeys = new Set<string>();
  private readonly settledRequestIds = new Set<string>();
  private readonly activeDeliveries = new Map<string, CloseableNotification>();
  private disposed = false;

  constructor(private readonly deps: SessionNotificationServiceDeps) {}

  /** Requests Web Notification permission from an explicit user action such as a settings change. */
  async requestSystemPermission(): Promise<boolean> {
    const NotificationApi = this.notificationApi();
    if (!NotificationApi) return false;
    if (NotificationApi.permission === "granted") return true;
    if (NotificationApi.permission !== "default") return false;
    try {
      return (await NotificationApi.requestPermission()) === "granted";
    } catch (error) {
      console.warn("[opencode-plugin:notifications] permission request failed", error);
      return false;
    }
  }

  /** Sends one event-specific dummy notification through the currently selected delivery mode. */
  async sendTestNotification(testKind: SessionNotificationTestKind): Promise<void> {
    const mode = this.deps.getPreferences().mode;
    if (mode === "none") return;
    if (mode === "system") await this.requestSystemPermission();
    const testContent: Record<SessionNotificationTestKind, { kind: SessionNotificationKind; body: string }> = {
      permission: { kind: "attention", body: "Permission required." },
      question: { kind: "attention", body: "Question needs your input." },
      "turn-complete": { kind: "turn-complete", body: "Agent turn finished." },
      error: { kind: "error", body: "Session stopped with an error." },
    };
    const content = testContent[testKind];
    this.deliver({
      key: `test:${testKind}`,
      kind: content.kind,
      sessionId: "test",
      body: content.body,
    }, "OpenCode notification test", () => undefined);
  }

  /** Tracks active turns and emits completion or error notifications from v1 session events. */
  handleSessionEvent(event: OpenCodeEvent, directory?: string): void {
    if (this.disposed || !event.properties) return;
    const sessionId = this.readString(event.properties, ["sessionID", "sessionId"]);
    if (!sessionId) return;
    const sessionKey = this.sessionKey(sessionId, directory);

    if (event.type === "session.status") {
      const status = this.readObject(event.properties, "status");
      const type = status ? this.readString(status, ["type", "status", "state"]) : undefined;
      if (type === "busy" || type === "retry" || type === "working" || type === "running" || type === "active") {
        this.terminalStateBySessionKey.delete(sessionKey);
      }
      return;
    }

    if (event.type === "session.error") {
      if (this.terminalStateBySessionKey.get(sessionKey) === "error") return;
      this.rememberTerminalState(sessionKey, "error");
      this.queue({
        key: `error:${sessionKey}`,
        kind: "error",
        sessionId,
        directory,
        body: sessionErrorMessage(event.properties.error),
      });
      return;
    }

    if (event.type !== "session.idle") return;
    const terminalState = this.terminalStateBySessionKey.get(sessionKey);
    if (terminalState === "idle") return;
    this.rememberTerminalState(sessionKey, "idle");
    if (terminalState === "error") return;
    this.queue({
      key: `turn:${sessionKey}`,
      kind: "turn-complete",
      sessionId,
      directory,
      body: "Agent turn finished.",
    });
  }

  /** Emits one notification after a permission request survives auto-approval policy evaluation. */
  notifyPermission(request: OpenCodePermissionRequest, directory?: string): void {
    this.notifyRequest("permission", request.id, request.sessionID, directory, "Permission required.");
  }

  /** Emits one notification for a question request regardless of duplicate view subscriptions. */
  notifyQuestion(request: OpenCodeQuestionRequest, directory?: string): void {
    this.notifyRequest("question", request.id, request.sessionID, directory, "Question needs your input.");
  }

  /** Cancels pending or displayed request notifications once another client settles the request. */
  settleRequest(requestId: string): void {
    this.rememberSettledRequest(requestId);
    for (const [key, delivery] of this.activeDeliveries) {
      if (!key.endsWith(`:${requestId}`)) continue;
      delivery.close();
      this.activeDeliveries.delete(key);
    }
  }

  /** Closes live notifications and prevents async lookups from delivering after plugin unload. */
  dispose(): void {
    this.disposed = true;
    for (const delivery of this.activeDeliveries.values()) delivery.close();
    this.activeDeliveries.clear();
    this.terminalStateBySessionKey.clear();
  }

  /** Deduplicates one request before scheduling its session lookup and delivery. */
  private notifyRequest(type: "permission" | "question", requestId: string, sessionId: string, directory: string | undefined, body: string): void {
    if (!requestId || !sessionId || this.settledRequestIds.has(requestId)) return;
    const key = `${type}:${requestId}`;
    if (this.seenRequestKeys.has(key)) return;
    this.rememberRequest(key);
    this.queue({ key, kind: "attention", sessionId, directory, requestId, body });
  }

  /** Runs asynchronous notification preparation without exposing unhandled promise rejections. */
  private queue(content: NotificationContent): void {
    void this.show(content).catch((error) => console.warn("[opencode-plugin:notifications] delivery failed", error));
  }

  /** Resolves the canonical session title, then rechecks visibility before delivering. */
  private async show(content: NotificationContent): Promise<void> {
    if (!this.shouldDeliver(content)) return;
    const session = await this.deps.getSession(content.sessionId, content.directory).catch(() => undefined);
    if (!session || !this.shouldDeliver(content)) return;
    const title = session.title?.trim() || content.sessionId;
    this.deliver(content, title, () => {
      void this.deps.openSession(content.sessionId, title);
    });
  }

  /** Applies user preferences, per-session muting, request settlement, and current view visibility. */
  private shouldDeliver(content: NotificationContent): boolean {
    if (this.disposed || this.deps.isSessionMuted(content.sessionId) || this.deps.isSessionVisible(content.sessionId)) return false;
    if (content.requestId && this.settledRequestIds.has(content.requestId)) return false;
    const preferences = this.deps.getPreferences();
    if (preferences.mode === "none") return false;
    if (content.kind === "attention") return preferences.attention;
    if (content.kind === "error") return preferences.errors;
    return preferences.turnComplete;
  }

  /** Delivers through Web Notifications and falls back to an Obsidian Notice when unavailable. */
  private deliver(content: NotificationContent, title: string, onClick: () => void): void {
    const mode = this.deps.getPreferences().mode;
    if (mode === "none") return;
    this.closeDelivery(content.key);
    if (mode === "system") {
      const NotificationApi = this.notificationApi();
      if (NotificationApi?.permission === "granted") {
        try {
          const notification = new NotificationApi(title, { body: content.body, tag: `opencode-${encodeURIComponent(content.key)}` });
          const handle = { close: () => notification.close() };
          notification.onclick = () => {
            this.notificationWindow()?.focus();
            onClick();
            notification.close();
          };
          notification.onclose = () => {
            if (this.activeDeliveries.get(content.key) === handle) this.activeDeliveries.delete(content.key);
          };
          this.trackDelivery(content.key, handle);
          return;
        } catch (error) {
          console.warn("[opencode-plugin:notifications] system notification failed", error);
        }
      }
    }
    let handle: CloseableNotification | undefined;
    const activate = () => {
      onClick();
      handle?.close();
      this.activeDeliveries.delete(content.key);
    };
    handle = this.showNotice(`${title}: ${content.body}`, activate);
    this.trackDelivery(content.key, handle);
  }

  /** Returns the focused Obsidian window's renderer Notification constructor when available. */
  private notificationApi(): typeof Notification | undefined {
    // Match TaskNotes' proven renderer path: system notifications live on Obsidian's main window.
    const NotificationApi = this.deps.getNotificationApi?.() ?? (window as NotificationRendererWindow).Notification;
    return typeof NotificationApi === "function" ? NotificationApi : undefined;
  }

  /** Returns the active Obsidian window while allowing deterministic test injection. */
  private notificationWindow(): Window | undefined {
    return this.deps.getNotificationWindow?.() ?? window.activeWindow ?? window;
  }

  /** Shows an Obsidian Notice through the production implementation or a test adapter. */
  private showNotice(message: string, onClick: () => void): CloseableNotification {
    return this.deps.showNotice?.(message, onClick) ?? showObsidianNotice(message, onClick);
  }

  /** Replaces any existing delivery for the same event and bounds retained notification handles. */
  private trackDelivery(key: string, delivery: CloseableNotification): void {
    this.closeDelivery(key);
    this.activeDeliveries.set(key, delivery);
    while (this.activeDeliveries.size > ACTIVE_DELIVERY_LIMIT) {
      const oldest = this.activeDeliveries.entries().next().value as [string, CloseableNotification] | undefined;
      if (!oldest) break;
      oldest[1].close();
      this.activeDeliveries.delete(oldest[0]);
    }
  }

  /** Closes and forgets an existing delivery for one notification key. */
  private closeDelivery(key: string): void {
    this.activeDeliveries.get(key)?.close();
    this.activeDeliveries.delete(key);
  }

  /** Keeps a bounded recent request-key window so duplicated SSE events notify only once. */
  private rememberRequest(key: string): void {
    this.seenRequestKeys.add(key);
    while (this.seenRequestKeys.size > RECENT_REQUEST_LIMIT) {
      const oldest = this.seenRequestKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenRequestKeys.delete(oldest);
    }
  }

  /** Keeps settled request IDs bounded while preventing delayed events from notifying again. */
  private rememberSettledRequest(requestId: string): void {
    this.settledRequestIds.add(requestId);
    while (this.settledRequestIds.size > RECENT_REQUEST_LIMIT) {
      const oldest = this.settledRequestIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.settledRequestIds.delete(oldest);
    }
  }

  /** Records one terminal state while bounding sessions retained across long plugin lifetimes. */
  private rememberTerminalState(sessionKey: string, state: "error" | "idle"): void {
    this.terminalStateBySessionKey.delete(sessionKey);
    this.terminalStateBySessionKey.set(sessionKey, state);
    while (this.terminalStateBySessionKey.size > SESSION_STATE_LIMIT) {
      const oldest = this.terminalStateBySessionKey.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalStateBySessionKey.delete(oldest);
    }
  }

  /** Namespaces per-session state by directory so independent OpenCode projects cannot collide. */
  private sessionKey(sessionId: string, directory?: string): string {
    return `${directory ?? ""}\u0000${sessionId}`;
  }

  /** Reads a nested object from a loosely typed v1 event payload. */
  private readObject(source: JsonObject, key: string): JsonObject | undefined {
    const value = source[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
  }

  /** Reads the first non-empty string from a loosely typed v1 event payload. */
  private readString(source: JsonObject, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  }
}
