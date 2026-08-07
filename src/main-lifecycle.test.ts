import { describe, expect, it, vi } from "vitest";

import OpenCodePlugin from "../main.ts";
import { VIEW_TYPE_OPENCODE_AGENT_PANEL } from "./views/AgentPanelView";
import { VIEW_TYPE_OPENCODE_DIFF_PANEL } from "./views/DiffPanelView";
import { VIEW_TYPE_OPENCODE_SESSION } from "./views/SessionView";

describe("OpenCodePlugin unload lifecycle", () => {
  it("detaches every plugin view before disposing the service", () => {
    const order: string[] = [];
    const detachLeavesOfType = vi.fn((viewType: string) => { order.push(viewType); });
    const dispose = vi.fn(() => { order.push("dispose"); });
    const plugin = Object.create(OpenCodePlugin.prototype) as OpenCodePlugin;
    Object.assign(plugin, {
      app: { workspace: { detachLeavesOfType } },
      opencode: { dispose },
    });

    plugin.onunload();

    expect(order).toEqual([
      VIEW_TYPE_OPENCODE_AGENT_PANEL,
      VIEW_TYPE_OPENCODE_SESSION,
      VIEW_TYPE_OPENCODE_DIFF_PANEL,
      "dispose",
    ]);
  });
});
