import { describe, expect, it, vi } from "vitest";

import { SessionNotificationService, type SessionNotificationPreferences } from "./session-notifications";

interface FakeNotificationRecord {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  onclose: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

/** Builds an observable notification service around mutable settings and visibility. */
function setup(options: { permission?: NotificationPermission; visible?: boolean; muted?: boolean } = {}) {
  const notifications: FakeNotificationRecord[] = [];
  const focus = vi.fn();
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = options.permission ?? "granted";
    static requestPermission = requestPermission;
    readonly title: string;
    readonly options?: NotificationOptions;
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly close = vi.fn(() => this.onclose?.());

    /** Records one Web Notification construction for assertions. */
    constructor(title: string, notificationOptions?: NotificationOptions) {
      this.title = title;
      this.options = notificationOptions;
      notifications.push(this);
    }
  }
  const notificationWindow = { focus } as unknown as Window;
  const preferences: SessionNotificationPreferences = {
    mode: "system",
    attention: true,
    errors: true,
    turnComplete: true,
  };
  let visible = options.visible ?? false;
  let muted = options.muted ?? false;
  const openSession = vi.fn(async () => undefined);
  const getSession = vi.fn(async (sessionId: string) => ({ id: sessionId, title: "Refactor parser" }));
  const noticeClose = vi.fn();
  const notices: Array<{ message: string; onClick: () => void }> = [];
  const service = new SessionNotificationService({
    getPreferences: () => preferences,
    isSessionMuted: () => muted,
    isSessionVisible: () => visible,
    getSession,
    openSession,
    getNotificationWindow: () => notificationWindow,
    getNotificationApi: () => FakeNotification as unknown as typeof Notification,
    showNotice: (message, onClick) => {
      notices.push({ message, onClick });
      return { close: noticeClose };
    },
  });
  return {
    service,
    notifications,
    notices,
    preferences,
    getSession,
    openSession,
    focus,
    requestPermission,
    noticeClose,
    setVisible: (value: boolean) => { visible = value; },
    setMuted: (value: boolean) => { muted = value; },
  };
}

describe("SessionNotificationService", () => {
  it("notifies once when an active turn becomes idle and opens its session on click", async () => {
    const { service, notifications, openSession, focus } = setup();

    service.handleSessionEvent({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } }, "/repo");
    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } }, "/repo");

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.title).toBe("Refactor parser");
    expect(notifications[0]?.options).toMatchObject({ body: "Agent turn finished." });
    notifications[0]?.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(openSession).toHaveBeenCalledWith("session-1", "Refactor parser");
  });

  it("suppresses events for a session visible in the focused Obsidian window", async () => {
    const { service, notifications, getSession } = setup({ visible: true });

    service.handleSessionEvent({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
    await Promise.resolve();

    expect(getSession).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("notifies for an idle event when startup or reconnect missed the preceding busy event", async () => {
    const { service, notifications } = setup();

    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } }, "/repo");
    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } }, "/repo");

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.options).toMatchObject({ body: "Agent turn finished." });
  });

  it("reports an active-session error without also reporting the following idle event", async () => {
    const { service, notifications } = setup();

    service.handleSessionEvent({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
    service.handleSessionEvent({
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "ApiError", data: { message: "Provider unavailable" } } },
    });
    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.options).toMatchObject({ body: "Provider unavailable" });
  });

  it("deduplicates repeated permission events and honors per-session muting", async () => {
    const { service, notifications, setMuted } = setup();
    const request = { id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] };

    service.notifyPermission(request, "/repo");
    service.notifyPermission(request, "/repo");
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    setMuted(true);
    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] }, "/repo");
    await Promise.resolve();
    expect(notifications).toHaveLength(1);
  });

  it("cancels a pending request notification when the request settles during lookup", async () => {
    const { service, notifications, getSession } = setup();
    let resolveSession: ((value: { id: string; title: string }) => void) | undefined;
    getSession.mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; }));

    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] }, "/repo");
    service.settleRequest("question-1");
    resolveSession?.({ id: "session-1", title: "Refactor parser" });
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications).toHaveLength(0);
  });

  it("falls back to a clickable Obsidian Notice when system permission is denied", async () => {
    const { service, notices, openSession, noticeClose } = setup({ permission: "denied" });

    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] });

    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]?.message).toBe("Refactor parser: Question needs your input.");
    notices[0]?.onClick();
    expect(openSession).toHaveBeenCalledWith("session-1", "Refactor parser");
    expect(noticeClose).toHaveBeenCalledOnce();
  });

  it("requests system permission only while the renderer reports the default state", async () => {
    const { service, requestPermission } = setup({ permission: "default" });

    expect(await service.requestSystemPermission()).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("sends distinct dummy notifications for every user-selectable event type", async () => {
    const { service, notifications } = setup();

    await service.sendTestNotification("permission");
    await service.sendTestNotification("question");
    await service.sendTestNotification("turn-complete");
    await service.sendTestNotification("error");

    expect(notifications.map((notification) => notification.options?.body)).toEqual([
      "Permission required.",
      "Question needs your input.",
      "Agent turn finished.",
      "Session stopped with an error.",
    ]);
  });

  it("does not emit any test notification when delivery mode is none", async () => {
    const { service, notifications, notices, preferences } = setup();
    preferences.mode = "none";

    await service.sendTestNotification("permission");

    expect(notifications).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });
});
