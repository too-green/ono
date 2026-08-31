import { afterEach, describe, expect, it, vi } from "vitest";

import OpenCodePlugin, { LEGACY_DIFF_PANEL_VIEW_TYPE } from "../main.ts";
import { OpenCodeService } from "./services/opencode-service";
import type { OpenCodeHealth } from "./services/opencode-types";
import { logger } from "./logger";
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodePluginSettings } from "./settings";
import { VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./views/AgentPanelView";
import { VIEW_TYPE_OPENCODE_SESSION } from "./views/SessionView";

/** Returns isolated mutable settings records for plugin method tests. */
function pluginSettings(overrides: Partial<OpenCodePluginSettings> = {}): OpenCodePluginSettings {
  return {
    ...DEFAULT_OPENCODE_SETTINGS,
    sessionDrafts: {},
    sessionAgentChoices: {},
    sessionModelChoices: {},
    sessionAutoApprove: {},
    sessionAutoApproveDefaultApplied: {},
    sessionMute: {},
    sessionAttachedFiles: {},
    ...overrides,
  };
}

afterEach(() => {
  logger.setDebugEnabled(false);
  vi.restoreAllMocks();
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
      VIEW_TYPE_OPENCODE_AGENT_PANEL,
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
    const refreshAgentPanels = vi.fn(async () => undefined);
    const refreshSessionViews = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { secretStorage: { getSecret } },
      settings: pluginSettings(),
      opencode: { updateConfig },
      saveSettings,
      refreshAgentPanels,
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
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(refreshAgentPanels).toHaveBeenCalledOnce();
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
      refreshAgentPanels: vi.fn(async () => undefined),
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
      refreshAgentPanels: vi.fn(async () => undefined),
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
      saveData,
    });

    await plugin.saveSettings();

    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      server: { baseUrl: "http://10.0.0.5:4096", username: "admin", passwordSecretName: "opencode-pw" },
    }));
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
    const refreshAgentPanels = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, { forkSession, openSessionTab, refreshAgentPanels });

    await expect(plugin.forkSessionAndOpen("root", "/workspace", "next-message")).resolves.toBe(forked);

    expect(forkSession).toHaveBeenCalledWith("root", "/workspace", "next-message");
    expect(openSessionTab).toHaveBeenCalledWith("fork-2", "Research (fork #2)");
    expect(refreshAgentPanels).toHaveBeenCalledWith({ showLoading: false });
    expect(openSessionTab.mock.invocationCallOrder[0]).toBeLessThan(refreshAgentPanels.mock.invocationCallOrder[0]);
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
      saveSettings,
      permissionCoordinator: { reconcile },
    });

    await plugin.ensureSessionAutoApproveDefault("session-1");
    plugin.settings.defaultSessionAutoApprove = false;
    await plugin.ensureSessionAutoApproveDefault("session-1");

    expect(plugin.settings.sessionAutoApprove).toEqual({ "session-1": true });
    expect(plugin.settings.sessionAutoApproveDefaultApplied).toEqual({ "session-1": true });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("moves draft default state to the created server session", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { getLeavesOfType: () => [] } },
      settings: pluginSettings({
        sessionAutoApprove: { "draft:draft-1": false },
        sessionAutoApproveDefaultApplied: { "draft:draft-1": true },
      }),
      saveSettings,
      permissionCoordinator: { reconcile },
    });

    await plugin.promoteSessionDraft("draft:draft-1", "session-1");

    expect(plugin.settings.sessionAutoApprove).toEqual({ "session-1": false });
    expect(plugin.settings.sessionAutoApproveDefaultApplied).toEqual({ "session-1": true });
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
