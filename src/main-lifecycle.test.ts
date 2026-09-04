import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";

import OpenCodePlugin, { LEGACY_DIFF_PANEL_VIEW_TYPE } from "../main.ts";
import { OpenCodeHttpError } from "./services/opencode-http";
import { OpenCodeService } from "./services/opencode-service";
import type { OpenCodeHealth } from "./services/opencode-types";
import { logger } from "./logger";
import { DEFAULT_OPENCODE_SETTINGS, OPENCODE_DATA_SCHEMA_VERSION, type OpenCodePluginData, type OpenCodePluginSettings, type PersistedSessionState } from "./settings";
import { VIEW_TYPE_OPENCODE_SESSIONS_PANEL } from "./views/SessionsPanelView";
import { VIEW_TYPE_OPENCODE_SESSION } from "./views/SessionView";
import * as WorktreeModals from "./views/WorktreeModals";

/** Returns isolated mutable settings records for plugin method tests. */
function pluginSettings(overrides: Partial<OpenCodePluginSettings> = {}): OpenCodePluginSettings {
  return {
    ...DEFAULT_OPENCODE_SETTINGS,
    ...overrides,
  };
}

/** Returns isolated session-centric persisted state for prototype-backed plugin tests. */
function pluginSessionState(sessions: Record<string, PersistedSessionState> = {}, drafts: Record<string, PersistedSessionState> = {}) {
  return { sessions, drafts };
}

afterEach(() => {
  logger.setDebugEnabled(false);
  (Notice as unknown as { history: unknown[] }).history = [];
  vi.restoreAllMocks();
});

describe("OpenCodePlugin worktree workflows", () => {
  /** Builds the minimal plugin state shared by destructive worktree workflow tests. */
  function worktreePlugin(statuses: Record<string, unknown> = {}) {
    const remove = vi.fn(async () => true);
    const reset = vi.fn(async () => true);
    const create = vi.fn(async () => ({ name: "feature", branch: "feature", directory: "/repo/feature" }));
    const archiveSession = vi.fn(async (sessionId: string) => ({ id: sessionId }));
    const sessions = [{ id: "session-1", directory: "/repo/feature/packages/app", time: {} }];
    const getSessionStatus = vi.fn(async () => statuses);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
      settings: pluginSettings({ openedDirectories: ["/repo", "/repo/feature"] }),
      worktrees: { create, remove, reset },
      earlyReadyWorktreeKeys: new Set<string>(),
      pendingWorktreeCreateCount: 0,
      worktreeOperationKeys: new Set<string>(),
      worktreeOperationStates: new Map<string, string>(),
      worktreeStatuses: new Map<string, unknown>(),
      worktreeStatusTimers: new Map<string, number>(),
      directoryContexts: { invalidate: vi.fn() },
      requireOpenCodeService: () => ({
        listSessions: vi.fn(async () => sessions),
        getSessionStatus,
        archiveSession,
      }),
      forgetSessionState: vi.fn(async () => undefined),
      removeOpenedDirectories: vi.fn(async () => undefined),
      refreshSessionsPanels: vi.fn(async () => undefined),
    });
    const addOpenedDirectory = vi.fn(async (_directory: string, options: { showLoading?: boolean } = {}) => {
      await plugin.refreshSessionsPanels({ showLoading: options.showLoading });
    });
    Object.assign(plugin, { addOpenedDirectory });
    return { plugin, create, remove, reset, archiveSession, getSessionStatus, addOpenedDirectory };
  }

  it("keeps the panel interactive and reports server creation latency for five seconds", async () => {
    const { plugin, create, addOpenedDirectory } = worktreePlugin();
    (plugin as unknown as { earlyReadyWorktreeKeys: Set<string> }).earlyReadyWorktreeKeys.add("/repo/feature");
    vi.spyOn(WorktreeModals, "requestWorktreeCreation").mockResolvedValue({ name: "feature" });
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_500);

    await plugin.requestWorktreeCreate("/repo");

    expect(create).toHaveBeenCalledWith("/repo", { name: "feature" });
    expect(addOpenedDirectory).toHaveBeenCalledWith("/repo/feature", { notice: false, showLoading: false, backgroundRefresh: true });
    expect(plugin.refreshSessionsPanels).toHaveBeenCalledOnce();
    expect(plugin.refreshSessionsPanels).toHaveBeenCalledWith({ showLoading: false });
    expect((Notice as unknown as { history: unknown[] }).history.at(-1)).toEqual({ message: "Created worktree feature in 1.5s.", duration: 5_000 });
  });

  it("blocks destructive worktree actions while a directory session is active", async () => {
    const { plugin, remove } = worktreePlugin({ "session-1": { type: "busy" } });
    const confirm = vi.spyOn(WorktreeModals, "confirmWorktreeAction").mockResolvedValue(true);

    await plugin.requestWorktreeRemove("/repo", "/repo/feature");

    expect(confirm).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes worktrees only after confirmation and cleans their local registration", async () => {
    const { plugin, remove } = worktreePlugin({ "session-1": { type: "idle" } });
    vi.spyOn(WorktreeModals, "confirmWorktreeAction").mockResolvedValue(true);

    await plugin.requestWorktreeRemove("/repo", "/repo/feature");

    expect(remove).toHaveBeenCalledWith("/repo", "/repo/feature");
    expect(plugin.forgetSessionState).toHaveBeenCalledWith(new Set(["session-1"]));
    expect(plugin.removeOpenedDirectories).toHaveBeenCalledWith(["/repo/feature"]);
  });

  it("rechecks activity after confirmation before removing a worktree", async () => {
    const { plugin, remove, getSessionStatus } = worktreePlugin();
    getSessionStatus
      .mockResolvedValueOnce({ "session-1": { type: "idle" } })
      .mockResolvedValueOnce({ "session-1": { type: "busy" } });
    vi.spyOn(WorktreeModals, "confirmWorktreeAction").mockResolvedValue(true);

    await plugin.requestWorktreeRemove("/repo", "/repo/feature");

    expect(getSessionStatus).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it("exposes a removing status until the server operation settles", async () => {
    const { plugin, remove } = worktreePlugin();
    let finishRemove: ((removed: boolean) => void) | undefined;
    remove.mockImplementation(() => new Promise<boolean>((resolve) => { finishRemove = resolve; }));
    vi.spyOn(WorktreeModals, "confirmWorktreeAction").mockResolvedValue(true);

    const action = plugin.requestWorktreeRemove("/repo", "/repo/feature");
    await vi.waitFor(() => expect(plugin.getWorktreeStatus("/repo/feature")).toEqual({ state: "removing" }));

    finishRemove?.(true);
    await action;

    expect(plugin.getWorktreeStatus("/repo/feature")).toBeUndefined();
  });

  it("archives existing v1 sessions after a confirmed worktree reset", async () => {
    const { plugin, reset, archiveSession } = worktreePlugin({ "session-1": { type: "idle" } });
    vi.spyOn(WorktreeModals, "confirmWorktreeAction").mockResolvedValue(true);

    await plugin.requestWorktreeReset("/repo", "/repo/feature");

    expect(reset).toHaveBeenCalledWith("/repo", "/repo/feature");
    expect(archiveSession).toHaveBeenCalledWith("session-1", expect.any(Number), "/repo/feature/packages/app");
    expect(plugin.forgetSessionState).toHaveBeenCalledWith(new Set(["session-1"]));
  });
});

describe("OpenCodePlugin session move workflow", () => {
  it("moves only the session, sends the CWD reminder, and refreshes open views", async () => {
    const moveSession = vi.fn(async () => undefined);
    const sendPromptAsync = vi.fn(async () => undefined);
    const getSessionStatus = vi.fn(async () => ({ ses_123: { type: "idle" } }));
    const invalidate = vi.fn();
    const refreshSessionsPanels = vi.fn(async () => undefined);
    const refreshSessionViews = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      opencode: { getSessionStatus, moveSession, sendPromptAsync },
      directoryContexts: { invalidate },
      refreshSessionsPanels,
      refreshSessionViews,
    });

    await plugin.moveSessionToDirectory("ses_123", "/repo", "/repo/feature");

    expect(moveSession).toHaveBeenCalledWith({
      sessionID: "ses_123",
      destination: { directory: "/repo/feature" },
      moveChanges: false,
    });
    expect(sendPromptAsync).toHaveBeenCalledWith("ses_123", expect.objectContaining({
      noReply: true,
      parts: [expect.objectContaining({ type: "text", synthetic: true })],
    }), "/repo/feature");
    expect(invalidate.mock.calls).toEqual([["/repo"], ["/repo/feature"]]);
    expect(refreshSessionsPanels).toHaveBeenCalledWith({ showLoading: false });
    expect(refreshSessionViews).toHaveBeenCalledOnce();
  });

  it("requires an active session to be aborted before moving", async () => {
    const moveSession = vi.fn(async () => undefined);
    const sendPromptAsync = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      opencode: {
        getSessionStatus: vi.fn(async () => ({ ses_123: { type: "busy" } })),
        moveSession,
        sendPromptAsync,
      },
    });

    await expect(plugin.moveSessionToDirectory("ses_123", "/repo", "/repo/feature"))
      .rejects.toThrow("Abort the session before moving it.");
    expect(moveSession).not.toHaveBeenCalled();
    expect(sendPromptAsync).not.toHaveBeenCalled();
  });
});

describe("OpenCodePlugin unload lifecycle", () => {
  it("detaches every plugin view before disposing the service", () => {
    const order: string[] = [];
    const detachLeavesOfType = vi.fn((viewType: string) => { order.push(viewType); });
    const closeSubscription = vi.fn(() => { order.push("close-subscription"); });
    const disposeNotifications = vi.fn(() => { order.push("dispose-notifications"); });
    const dispose = vi.fn(() => { order.push("dispose"); });
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { detachLeavesOfType } },
      notificationEventSubscriptions: new Map([["/repo", { close: closeSubscription }]]),
      notificationService: { dispose: disposeNotifications },
      opencode: { dispose },
    });

    plugin.onunload();

    expect(order).toEqual([
      VIEW_TYPE_OPENCODE_SESSIONS_PANEL,
      VIEW_TYPE_OPENCODE_SESSION,
      LEGACY_DIFF_PANEL_VIEW_TYPE,
      "close-subscription",
      "dispose-notifications",
      "dispose",
    ]);
  });
});

describe("OpenCodePlugin diagnostics settings", () => {
  it("persists and immediately applies debug logging changes", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const saveSettings = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { settings: pluginSettings(), saveSettings });

    await plugin.setDebugLogging(true);

    expect(plugin.settings.debugLogging).toBe(true);
    expect(logger.isDebugEnabled()).toBe(true);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith("[opencode-plugin:lifecycle] debug logging enabled");
  });

  it("keeps the previous runtime setting when persistence fails", async () => {
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      settings: pluginSettings(),
      saveSettings: vi.fn(async () => { throw new Error("save failed"); }),
    });

    await expect(plugin.setDebugLogging(true)).rejects.toThrow("save failed");

    expect(plugin.settings.debugLogging).toBe(false);
    expect(logger.isDebugEnabled()).toBe(false);
  });

  it("serializes rapid debug logging changes in user order", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const saveSettings = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstSave = resolve; }))
      .mockResolvedValueOnce(undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { settings: pluginSettings(), saveSettings });
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const enable = plugin.setDebugLogging(true);
    await Promise.resolve();
    const disable = plugin.setDebugLogging(false);
    releaseFirstSave?.();
    await Promise.all([enable, disable]);

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(plugin.settings.debugLogging).toBe(false);
    expect(logger.isDebugEnabled()).toBe(false);
  });
});

describe("OpenCodePlugin server connection settings", () => {
  it("applies server changes, resolves the named secret, and reconnects the service", async () => {
    const getSecret = vi.fn(() => "hunter2");
    const updateConfig = vi.fn();
    const saveSettings = vi.fn(async () => undefined);
    const refreshSessionsPanels = vi.fn(async () => undefined);
    const refreshSessionViews = vi.fn(async () => undefined);
    const clearDirectoryContexts = vi.fn();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret } },
      settings: pluginSettings(),
      sessionState: pluginSessionState({ stale: { composer: { text: "old server" } } }, { draft: { composer: { text: "keep" } } }),
      forgottenSessionIds: new Set(["stale"]),
      opencode: { updateConfig },
      directoryContexts: { clear: clearDirectoryContexts },
      saveSettings,
      refreshSessionsPanels,
      refreshSessionViews,
    });

    await plugin.applyServerConfig("http://10.0.0.5:4096/", "  admin ", "  opencode-pw ");

    expect(plugin.settings.server).toEqual({
      baseUrl: "http://10.0.0.5:4096",
      username: "admin",
      passwordSecretName: "opencode-pw",
      password: "hunter2",
    });
    expect(getSecret).toHaveBeenCalledWith("opencode-pw");
    expect(updateConfig).toHaveBeenCalledWith(plugin.settings.server);
    expect(clearDirectoryContexts).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledOnce();
    expect((plugin as unknown as { sessionState: ReturnType<typeof pluginSessionState> }).sessionState).toEqual(
      pluginSessionState({}, { draft: { composer: { text: "keep" } } }),
    );
    expect((plugin as unknown as { forgottenSessionIds: Set<string> }).forgottenSessionIds.size).toBe(0);
    expect(refreshSessionsPanels).toHaveBeenCalledOnce();
    expect(refreshSessionViews).toHaveBeenCalledOnce();
  });

  it("clears the resolved password when the secret name is removed", async () => {
    const getSecret = vi.fn(() => "hunter2");
    const updateConfig = vi.fn();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret } },
      settings: pluginSettings({ server: { baseUrl: "http://127.0.0.1:4096", username: "admin", passwordSecretName: "opencode-pw", password: "hunter2" } }),
      opencode: { updateConfig },
      saveSettings: vi.fn(async () => undefined),
      refreshSessionsPanels: vi.fn(async () => undefined),
      refreshSessionViews: vi.fn(async () => undefined),
    });

    await plugin.applyServerConfig("http://127.0.0.1:4096", "admin", "   ");

    expect(plugin.settings.server).toEqual({ baseUrl: "http://127.0.0.1:4096", username: "admin" });
    expect(getSecret).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:4096", username: "admin" });
  });

  it("keeps the secret name but drops the password when the stored secret is missing", async () => {
    const getSecret = vi.fn(() => null);
    const updateConfig = vi.fn();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret } },
      settings: pluginSettings(),
      opencode: { updateConfig },
      saveSettings: vi.fn(async () => undefined),
      refreshSessionsPanels: vi.fn(async () => undefined),
      refreshSessionViews: vi.fn(async () => undefined),
    });

    await plugin.applyServerConfig("http://127.0.0.1:4096", undefined, "deleted-secret");

    expect(plugin.settings.server).toEqual({ baseUrl: "http://127.0.0.1:4096", passwordSecretName: "deleted-secret" });
  });

  it("keeps the server password out of the persisted plugin data file", async () => {
    const saveData = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      settings: pluginSettings({ server: { baseUrl: "http://10.0.0.5:4096", username: "admin", passwordSecretName: "opencode-pw", password: "hunter2" } }),
      sessionState: pluginSessionState(),
      saveData,
    });

    await plugin.saveSettings();

    expect(saveData).toHaveBeenCalledWith({
      schemaVersion: OPENCODE_DATA_SCHEMA_VERSION,
      preferences: expect.objectContaining({
        server: { baseUrl: "http://10.0.0.5:4096", username: "admin", passwordSecretName: "opencode-pw" },
      }),
      sessions: {},
      drafts: {},
    });
    expect(JSON.stringify(saveData.mock.calls)).not.toContain("hunter2");
  });

  it("probes drafted server values without applying them to plugin settings", async () => {
    const health = vi.spyOn(OpenCodeService.prototype, "health")
      .mockResolvedValue({ healthy: true, version: "1.2.3" } as OpenCodeHealth);
    const settings = pluginSettings();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { settings, app: { secretStorage: { getSecret: vi.fn(() => "hunter2") } } });

    const result = await plugin.testServerConnection("http://10.0.0.5:4096", "admin", "opencode-pw");

    expect(result).toEqual({ healthy: true, version: "1.2.3" });
    expect(health).toHaveBeenCalledOnce();
    expect(settings.server).toEqual({ baseUrl: "http://127.0.0.1:4096" });
  });

  it("propagates probe failures after disposing the temporary service", async () => {
    vi.spyOn(OpenCodeService.prototype, "health").mockRejectedValue(new Error("refused"));
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { settings: pluginSettings() });

    await expect(plugin.testServerConnection("http://127.0.0.1:4096", undefined, undefined)).rejects.toThrow("refused");
  });
});

describe("OpenCodePlugin fork workflow", () => {
  it("renames a duplicate parallel fork to the next sibling ordinal", async () => {
    const service = {
      listSessions: vi.fn(async () => [{ id: "fork-1", title: "Research (fork #1)" }]),
      forkSession: vi.fn(async () => ({ id: "fork-2", title: "Research (fork #1)" })),
      updateSession: vi.fn(async (_id: string, input: { title?: string }) => ({ id: "fork-2", title: input.title })),
    };
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { opencode: service });

    const forked = await plugin.forkSession("root", "/workspace", "next-message");

    expect(service.listSessions).toHaveBeenCalledWith({ directory: "/workspace", limit: 1_000 });
    expect(service.forkSession).toHaveBeenCalledWith("root", "/workspace", "next-message");
    expect(service.updateSession).toHaveBeenCalledWith("fork-2", { title: "Research (fork #2)" }, "/workspace");
    expect(forked.title).toBe("Research (fork #2)");
  });

  it("keeps an already-unique server-generated fork title", async () => {
    const forked = { id: "fork-2", title: "Research (fork #2)" };
    const service = {
      listSessions: vi.fn(async () => [{ id: "fork-1", title: "Research (fork #1)" }]),
      forkSession: vi.fn(async () => forked),
      updateSession: vi.fn(),
    };
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { opencode: service });

    await expect(plugin.forkSession("root", "/workspace")).resolves.toBe(forked);
    expect(service.updateSession).not.toHaveBeenCalled();
  });

  it("opens every successful fork in its session tab", async () => {
    const forked = { id: "fork-2", title: "Research (fork #2)" };
    const forkSession = vi.fn(async () => forked);
    const openSessionTab = vi.fn(async () => undefined);
    const refreshSessionsPanels = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { forkSession, openSessionTab, refreshSessionsPanels });

    await expect(plugin.forkSessionAndOpen("root", "/workspace", "next-message")).resolves.toBe(forked);

    expect(forkSession).toHaveBeenCalledWith("root", "/workspace", "next-message");
    expect(openSessionTab).toHaveBeenCalledWith("fork-2", "Research (fork #2)");
    expect(refreshSessionsPanels).toHaveBeenCalledWith({ showLoading: false });
    expect(openSessionTab.mock.invocationCallOrder[0]).toBeLessThan(refreshSessionsPanels.mock.invocationCallOrder[0]);
  });
});

describe("OpenCodePlugin auto-accept defaults", () => {
  it("applies the configured value only once per session", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [] } },
      settings: pluginSettings({ defaultSessionAutoApprove: true }),
      sessionState: pluginSessionState(),
      saveSettings,
      permissionCoordinator: { reconcile },
    });

    await plugin.ensureSessionAutoApproveDefault("session-1");
    plugin.settings.defaultSessionAutoApprove = false;
    await plugin.ensureSessionAutoApproveDefault("session-1");

    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState> } }).sessionState.sessions).toEqual({
      "session-1": { autoApprove: true },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("moves draft default state to the created server session", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [] } },
      settings: pluginSettings(),
      sessionState: pluginSessionState({}, { "draft-1": { autoApprove: false } }),
      saveSettings,
      permissionCoordinator: { reconcile },
    });

    await plugin.promoteSessionDraft("draft:draft-1", "session-1");

    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState>; drafts: Record<string, PersistedSessionState> } }).sessionState).toEqual({
      sessions: { "session-1": { autoApprove: false } },
      drafts: {},
    });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("does not let a delayed draft save recreate a promoted draft", async () => {
    let releasePromotionSave: (() => void) | undefined;
    const saveSettings = vi.fn(() => new Promise<void>((resolve) => { releasePromotionSave = resolve; }));
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      sessionState: pluginSessionState({}, { "draft-1": { composer: { text: "send this" } } }),
      saveSettings,
    });

    const promotion = plugin.promoteSessionDraft("draft:draft-1", "session-1");
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    await plugin.rememberSessionDraft("draft:draft-1", "late timer write");
    releasePromotionSave?.();
    await promotion;

    expect((plugin as unknown as { sessionState: ReturnType<typeof pluginSessionState> }).sessionState).toEqual({
      sessions: { "session-1": { composer: { text: "send this" } } },
      drafts: {},
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("retains explicit inheritance without reapplying the default", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [] } },
      settings: pluginSettings({ defaultSessionAutoApprove: true }),
      sessionState: pluginSessionState({ "session-1": { autoApprove: true } }),
      saveSettings,
      permissionCoordinator: { reconcile },
    });

    await plugin.rememberSessionAutoApprove("session-1", undefined);
    await plugin.ensureSessionAutoApproveDefault("session-1");

    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState> } }).sessionState.sessions).toEqual({
      "session-1": { autoApprove: "inherit" },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

describe("OpenCodePlugin session-state retention", () => {
  it("forgets a successfully archived session tree in one save", async () => {
    const archiveSession = vi.fn(async (_sessionId: string) => ({ id: "archived" }));
    const saveSettings = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [] } },
      settings: pluginSettings({ archiveConfirmation: false }),
      sessionState: pluginSessionState({
        root: { unread: true },
        child: { composer: { text: "unsent" } },
        active: { autoApprove: false },
      }),
      archivingSessionIds: new Set(),
      opencode: {
        getSession: vi.fn(async () => ({ id: "root", title: "Root", directory: "/workspace" })),
        listSessionChildren: vi.fn(async (sessionId: string) => sessionId === "root" ? [{ id: "child", title: "Child", directory: "/workspace" }] : []),
        archiveSession,
      },
      saveSettings,
      refreshSessionsPanels: vi.fn(async () => undefined),
    });

    await plugin.requestSessionArchive("root", "/workspace");
    await plugin.rememberSessionDraft("root", "must not return");

    expect(archiveSession.mock.calls.map(([sessionId]) => sessionId)).toEqual(["child", "root"]);
    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState> } }).sessionState.sessions).toEqual({
      active: { autoApprove: false },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("serializes snapshots so an older save cannot overwrite cleanup", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const saveData = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstSave = resolve; }))
      .mockResolvedValueOnce(undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      settings: pluginSettings(),
      sessionState: pluginSessionState({ stale: { composer: { text: "remove" } } }),
      saveData,
    });

    const staleSave = plugin.saveSettings();
    await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce());
    const cleanupSave = plugin.forgetSessionState(["stale"]);
    releaseFirstSave?.();
    await Promise.all([staleSave, cleanupSave]);

    expect((saveData.mock.calls[0]?.[0] as OpenCodePluginData).sessions).toEqual({ stale: { composer: { text: "remove" } } });
    expect((saveData.mock.calls[1]?.[0] as OpenCodePluginData).sessions).toEqual({});
  });

  it("forgets state when a remote archive event arrives", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const handleDirectoryEvent = vi.fn();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      settings: pluginSettings(),
      sessionState: pluginSessionState({ archived: { composer: { text: "stale" }, unread: true } }),
      saveSettings,
      notificationService: { handleSessionEvent: vi.fn() },
      directoryContexts: { handleEvent: handleDirectoryEvent },
    });

    (plugin as unknown as { handleNotificationEvent(event: { type: string; properties: Record<string, unknown> }, directory: string): void })
      .handleNotificationEvent({ type: "session.updated", properties: { info: { id: "archived", time: { archived: 123 } } } }, "/workspace");

    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    expect(handleDirectoryEvent).toHaveBeenCalledWith("/workspace", expect.objectContaining({ type: "session.updated" }));
    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState> } }).sessionState.sessions).toEqual({});
  });

  it("prunes orphan drafts and canonically stale sessions at startup", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [{ getViewState: () => ({ state: { draftId: "live-draft" } }) }] } },
      settings: pluginSettings(),
      sessionState: pluginSessionState({
        active: { autoApprove: true },
        archived: { unread: true },
        deleted: { muted: true },
      }, {
        "live-draft": { composer: { text: "keep" } },
        "closed-draft": { composer: { text: "remove" } },
      }),
      opencode: {
        getSession: vi.fn(async (sessionId: string) => {
          if (sessionId === "archived") return { id: sessionId, time: { archived: 123 } };
          if (sessionId === "deleted") throw new OpenCodeHttpError("missing", 404, "");
          return { id: sessionId };
        }),
      },
      saveSettings,
    });

    await (plugin as unknown as { pruneStaleSessionState(): Promise<void> }).pruneStaleSessionState();

    expect((plugin as unknown as { sessionState: { sessions: Record<string, PersistedSessionState>; drafts: Record<string, PersistedSessionState> } }).sessionState).toEqual({
      sessions: { active: { autoApprove: true } },
      drafts: { "live-draft": { composer: { text: "keep" } } },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("schedules canonical pruning when a directory event stream reconnects", () => {
    let onOpen: (() => void) | undefined;
    const scheduleSessionStatePrune = vi.fn();
    const invalidateDirectoryContext = vi.fn();
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      settings: pluginSettings({ openedDirectories: ["/workspace"] }),
      notificationEventSubscriptions: new Map(),
      layoutReady: true,
      scheduleSessionStatePrune,
      directoryContexts: { invalidate: invalidateDirectoryContext },
      opencode: {
        subscribeToEvents: vi.fn((handlers: { onOpen?: () => void }) => {
          onOpen = handlers.onOpen;
          return { close: vi.fn() };
        }),
      },
    });

    (plugin as unknown as { syncNotificationEventSubscriptions(): void }).syncNotificationEventSubscriptions();
    onOpen?.();

    expect(scheduleSessionStatePrune).toHaveBeenCalledOnce();
    expect(invalidateDirectoryContext).toHaveBeenCalledWith("/workspace");
  });
});

describe("OpenCodePlugin data schema", () => {
  it("migrates the legacy agents-panel sort preference without reserializing its old key", async () => {
    const saveData = vi.fn(async () => undefined);
    const preferences = { ...pluginSettings() } as Record<string, unknown>;
    delete preferences.sessionsPanelSessionSort;
    preferences.agentPanelSessionSort = "title-asc";
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret: vi.fn() } },
      loadData: vi.fn(async () => ({
        schemaVersion: OPENCODE_DATA_SCHEMA_VERSION,
        preferences,
        sessions: {},
        drafts: {},
      })),
      saveData,
    });

    await (plugin as unknown as { loadSettings(): Promise<void> }).loadSettings();
    await plugin.saveSettings();

    expect(plugin.settings.sessionsPanelSessionSort).toBe("title-asc");
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      preferences: expect.objectContaining({ sessionsPanelSessionSort: "title-asc" }),
    }));
    expect(JSON.stringify(saveData.mock.calls)).not.toContain("agentPanelSessionSort");
  });

  it("replaces unversioned plugin data instead of retaining legacy maps", async () => {
    const saveData = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret: vi.fn() } },
      loadData: vi.fn(async () => ({
        openedDirectories: ["/legacy"],
        sessionDrafts: { stale: "legacy" },
      })),
      saveData,
    });

    await (plugin as unknown as { loadSettings(): Promise<void> }).loadSettings();

    expect(plugin.settings.openedDirectories).toEqual([]);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: OPENCODE_DATA_SCHEMA_VERSION,
      sessions: {},
      drafts: {},
    }));
    expect(JSON.stringify(saveData.mock.calls)).not.toContain("sessionDrafts");
  });
});
