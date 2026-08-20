import { describe, expect, it, vi } from "vitest";

import { SessionHierarchy } from "./session-hierarchy";

describe("SessionHierarchy", () => {
  it("hydrates a cycle-safe owner-to-root lineage", async () => {
    const sessions = {
      child: { id: "child", parentID: "parent", directory: "/repo" },
      parent: { id: "parent", parentID: "root", directory: "/repo" },
      root: { id: "root", directory: "/repo" },
    };
    const getSession = vi.fn(async (sessionId: keyof typeof sessions) => sessions[sessionId]);
    const hierarchy = new SessionHierarchy({ getSession: getSession as never });

    await expect(hierarchy.lineage("child", "/repo")).resolves.toEqual([
      sessions.child,
      sessions.parent,
      sessions.root,
    ]);
    expect(getSession).toHaveBeenCalledTimes(3);
  });

  it("shares concurrent session hydration", async () => {
    const getSession = vi.fn(async () => ({ id: "root" }));
    const hierarchy = new SessionHierarchy({ getSession });

    await Promise.all([hierarchy.getSession("root"), hierarchy.getSession("root")]);

    expect(getSession).toHaveBeenCalledOnce();
  });

  it("heals non-authoritative parentless metadata before resolving lineage", async () => {
    const getSession = vi.fn(async (sessionId: string) => sessionId === "child"
      ? { id: "child", parentID: "root" }
      : { id: "root" });
    const hierarchy = new SessionHierarchy({ getSession });
    hierarchy.cache([{ id: "child", title: "Incomplete stream update" }]);

    await expect(hierarchy.lineage("child")).resolves.toEqual([
      { id: "child", parentID: "root" },
      { id: "root" },
    ]);
  });

  it("preserves known ancestry across partial live session updates", async () => {
    const hierarchy = new SessionHierarchy({ getSession: vi.fn() });
    hierarchy.cache([{ id: "child", title: "Original", parentID: "root" }, { id: "root" }], true);
    hierarchy.cache([{ id: "child", title: "Updated" }]);

    await expect(hierarchy.lineage("child")).resolves.toEqual([
      { id: "child", title: "Updated", parentID: "root" },
      { id: "root" },
    ]);
  });

  it("retains resolved lineage without fabricating an ancestor when an upper lookup fails", async () => {
    const getSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "child") return { id: "child", parentID: "missing-parent" };
      throw new Error("Parent unavailable");
    });
    const hierarchy = new SessionHierarchy({ getSession });

    await expect(hierarchy.lineage("child", "/repo")).resolves.toEqual([
      { id: "child", parentID: "missing-parent" },
    ]);
  });
});
