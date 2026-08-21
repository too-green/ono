import { describe, expect, it, vi } from "vitest";

import OpenCodePlugin, { LEGACY_DIFF_PANEL_VIEW_TYPE } from "../main.ts";
import { VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./views/AgentPanelView";
import { VIEW_TYPE_OPENCODE_SESSION } from "./views/SessionView";

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
