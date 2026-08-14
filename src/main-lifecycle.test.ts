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
