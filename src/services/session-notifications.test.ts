import { describe, expect, it, vi } from "vitest";

import { SessionNotificationService, type SessionNotificationPreferences } from "./session-notifications";
import type { OpenCodeSession } from "./opencode-types";

interface FakeNotificationRecord {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  onclose: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

/** Builds an observable notification service around mutable settings and visibility. */
function setup(options: {
  permission?: NotificationPermission;
  visible?: boolean;
  muted?: boolean;
  lineage?: OpenCodeSession[];
  isMuted?: (sessionId: string) => boolean;
  isVisible?: (sessionId: string) => boolean;
  getLineage?: (sessionId: string) => Promise<OpenCodeSession[]>;
} = {}) {
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
  const getSession = vi.fn(async (sessionId: string) => options.lineage?.find((session) => session.id === sessionId)
    ?? { id: sessionId, title: "Refactor parser" });
  const getSessionLineage = vi.fn(async (sessionId: string) => options.getLineage?.(sessionId) ?? options.lineage ?? [await getSession(sessionId)]);
  const noticeClose = vi.fn();
  const notices: Array<{ message: string; onClick: () => void }> = [];
  const service = new SessionNotificationService({
    getPreferences: () => preferences,
    isSessionMuted: (session) => options.isMuted?.(session.id) ?? muted,
    isSessionVisible: (sessionId) => options.isVisible?.(sessionId) ?? visible,
    getSession,
    getSessionLineage,
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
    getSessionLineage,
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

  it("suppresses abort errors and the following idle completion notification", async () => {
    const { service, notifications } = setup();
    service.handleSessionEvent({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
    service.handleSessionEvent({
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "MessageAbortedError", data: { message: "Stopped" } } },
    });
    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "session-1" } });
    await Promise.resolve();
    expect(notifications).toHaveLength(0);
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

  it("groups permission and question alerts into one notification until the session queue settles", async () => {
    const { service, notifications, getSessionLineage } = setup();

    service.notifyPermission({ id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] }, "/repo");
    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] }, "/repo");

    await vi.waitFor(() => {
      expect(getSessionLineage).toHaveBeenCalledOnce();
      expect(notifications).toHaveLength(1);
    });
    service.settleRequest("permission-1");
    expect(notifications[0]?.close).not.toHaveBeenCalled();

    service.settleRequest("question-1");
    expect(notifications[0]?.close).toHaveBeenCalledOnce();
  });

  it("does not notify again when the first request settles during a queued request lookup", async () => {
    const session = { id: "session-1", title: "Refactor parser" };
    let lookupCount = 0;
    let resolveLookup: ((sessions: OpenCodeSession[]) => void) | undefined;
    const { service, notifications } = setup({
      getLineage: async () => {
        lookupCount += 1;
        return new Promise((resolve) => { resolveLookup = resolve; });
      },
    });

    service.notifyPermission({ id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] });
    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] });
    await vi.waitFor(() => expect(lookupCount).toBe(1));

    service.settleRequest("permission-1");
    resolveLookup?.([session]);
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.close).not.toHaveBeenCalled();
  });

  it("allows a dismissed stale alert to be replaced by a later request", async () => {
    const { service, notifications } = setup();
    service.notifyPermission({ id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    notifications[0]?.onclose?.();

    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] });

    await vi.waitFor(() => expect(notifications).toHaveLength(2));
  });

  it("ignores an obsolete lookup after a settled queue is replaced", async () => {
    const session = { id: "session-1", title: "Refactor parser" };
    let lookupCount = 0;
    let resolveObsoleteLookup: ((sessions: OpenCodeSession[]) => void) | undefined;
    const { service, notifications } = setup({
      getLineage: async () => {
        lookupCount += 1;
        if (lookupCount > 1) return [session];
        return new Promise((resolve) => { resolveObsoleteLookup = resolve; });
      },
    });

    service.notifyPermission({ id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] });
    await vi.waitFor(() => expect(lookupCount).toBe(1));
    service.settleRequest("permission-1");
    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    resolveObsoleteLookup?.([session]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.close).not.toHaveBeenCalled();
  });

  it("keeps the replacement queue locked when an obsolete lookup finishes first", async () => {
    const session = { id: "session-1", title: "Refactor parser" };
    const lookupResolvers: Array<(sessions: OpenCodeSession[]) => void> = [];
    const { service, notifications, getSessionLineage } = setup({
      getLineage: async () => new Promise((resolve) => { lookupResolvers.push(resolve); }),
    });

    service.notifyPermission({ id: "permission-1", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] });
    await vi.waitFor(() => expect(getSessionLineage).toHaveBeenCalledOnce());
    service.settleRequest("permission-1");
    service.notifyQuestion({ id: "question-1", sessionID: "session-1", questions: [] });
    await vi.waitFor(() => expect(getSessionLineage).toHaveBeenCalledTimes(2));

    lookupResolvers[0]?.([session]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.notifyPermission({ id: "permission-2", sessionID: "session-1", permission: "edit", patterns: [], metadata: {}, always: [] });
    expect(getSessionLineage).toHaveBeenCalledTimes(2);

    lookupResolvers[1]?.([session]);
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
  });

  it("routes child attention to the nearest enabled ancestor and opens that session", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "parent" },
      { id: "parent", title: "Implement authentication", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, openSession } = setup({
      lineage,
      isMuted: (sessionId) => sessionId === "child",
    });

    service.notifyPermission({ id: "permission-1", sessionID: "child", permission: "bash", patterns: [], metadata: {}, always: [] });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.title).toBe("Implement authentication");
    expect(notifications[0]?.options?.body).toBe("Research JWT: OpenCode needs your input.");
    notifications[0]?.onclick?.();
    expect(openSession).toHaveBeenCalledWith("parent", "Implement authentication");
  });

  it("walks past muted intermediate subagents to the first enabled ancestor", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "parent" },
      { id: "parent", title: "Implement authentication", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, openSession } = setup({
      lineage,
      isMuted: (sessionId) => sessionId !== "root",
    });

    service.notifyQuestion({ id: "question-1", sessionID: "child", questions: [] });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.title).toBe("Application work");
    notifications[0]?.onclick?.();
    expect(openSession).toHaveBeenCalledWith("root", "Application work");
  });

  it("lets an explicitly enabled child own its attention notification", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, openSession } = setup({ lineage, isMuted: (sessionId) => sessionId !== "child" });

    service.notifyQuestion({ id: "question-1", sessionID: "child", questions: [] });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.title).toBe("Research JWT");
    notifications[0]?.onclick?.();
    expect(openSession).toHaveBeenCalledWith("child", "Research JWT");
  });

  it("delivers completion events for an explicitly enabled child", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications } = setup({
      lineage,
      isMuted: (sessionId) => sessionId !== "child",
    });

    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "child" } });

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]?.title).toBe("Research JWT");
    expect(notifications[0]?.options?.body).toBe("Agent turn finished.");
  });

  it("does not bubble child completion events to an enabled ancestor", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, getSession } = setup({
      lineage,
      isMuted: (sessionId) => sessionId === "child",
    });

    service.handleSessionEvent({ type: "session.idle", properties: { sessionID: "child" } });
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith("child", undefined));

    expect(notifications).toHaveLength(0);
  });

  it("suppresses routed attention when any owner or ancestor session is visible", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, getSessionLineage } = setup({
      lineage,
      isMuted: (sessionId) => sessionId === "child",
      isVisible: (sessionId) => sessionId === "root",
    });

    service.notifyQuestion({ id: "question-1", sessionID: "child", questions: [] });
    await vi.waitFor(() => expect(getSessionLineage).toHaveBeenCalledWith("child", undefined));

    expect(notifications).toHaveLength(0);
  });

  it("suppresses routed attention when every session in the lineage is muted", async () => {
    const lineage = [
      { id: "child", title: "Research JWT", parentID: "root" },
      { id: "root", title: "Application work" },
    ];
    const { service, notifications, getSessionLineage } = setup({ lineage, isMuted: () => true });

    service.notifyPermission({ id: "permission-1", sessionID: "child", permission: "bash", patterns: [], metadata: {}, always: [] });
    await vi.waitFor(() => expect(getSessionLineage).toHaveBeenCalledWith("child", undefined));

    expect(notifications).toHaveLength(0);
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
    expect(notices[0]?.message).toBe("Refactor parser: OpenCode needs your input.");
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
