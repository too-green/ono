import { describe, expect, it, vi } from "vitest";

import { PermissionCoordinator } from "./permission-coordinator";
import { SessionHierarchy } from "./session-hierarchy";

/** Builds an observable coordinator around a mutable explicit-policy map. */
function setup(settings: Record<string, boolean> = {}) {
  const replyPermission = vi.fn(async () => true);
  const getSession = vi.fn(async (sessionId: string) => sessionId === "child"
    ? { id: "child", parentID: "root", directory: "/workspace" }
    : { id: "root", directory: "/workspace" });
  const onSurface = vi.fn();
  const onSettled = vi.fn();
  const onError = vi.fn();
  const hierarchy = new SessionHierarchy({ getSession });
  const coordinator = new PermissionCoordinator({
    getSettings: () => settings,
    getService: () => ({ replyPermission }) as never,
    hierarchy,
    onSurface,
    onSettled,
    onRespondingChanged: vi.fn(),
    onError,
  });
  return { coordinator, settings, replyPermission, getSession, onSurface, onSettled, onError };
}

describe("PermissionCoordinator", () => {
  it("inherits a parent policy and replies only once for duplicate stream events", async () => {
    const { coordinator, replyPermission, getSession } = setup({ root: true });
    const request = { id: "permission-1", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] };

    coordinator.route(request, "/workspace");
    coordinator.route(request, "/workspace");

    await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledWith("permission-1", "once", "/workspace"));
    expect(replyPermission).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledOnce();
    expect(coordinator.shouldSuppress("permission-1")).toBe(true);
  });

  it("fails closed when a child explicitly disables an enabled parent", async () => {
    const { coordinator, replyPermission, onSurface } = setup({ root: true, child: false });
    coordinator.cacheSessionHierarchy([{ id: "root" }, { id: "child", parentID: "root", directory: "/workspace" }], true);

    coordinator.route({ id: "permission-2", sessionID: "child", permission: "edit", patterns: [], metadata: {}, always: [] }, "/workspace");

    await vi.waitFor(() => expect(onSurface).toHaveBeenCalledOnce());
    expect(onSurface).toHaveBeenCalledWith(expect.objectContaining({ id: "permission-2" }), "/workspace");
    expect(replyPermission).not.toHaveBeenCalled();
    expect(coordinator.shouldSuppress("permission-2")).toBe(false);
  });

  it("computes child overrides without mutating its parent's setting", async () => {
    const { coordinator, settings } = setup({ root: true });
    coordinator.cacheSessionHierarchy([{ id: "root" }, { id: "child", parentID: "root", directory: "/workspace" }], true);

    expect(await coordinator.overrideForToggle("child", "/workspace")).toBe(false);
    settings.child = false;
    expect(await coordinator.overrideForToggle("child", "/workspace")).toBeUndefined();
    delete settings.child;
    expect(coordinator.getState("child")).toEqual({ enabled: true, inherited: true, sourceSessionId: "root" });
  });

  it("clears surfaced state when another client replies", async () => {
    const { coordinator, onSurface, onSettled } = setup();
    coordinator.cacheSessionHierarchy([{ id: "child", directory: "/workspace" }], true);
    coordinator.route({ id: "permission-3", sessionID: "child", permission: "bash", patterns: [], metadata: {}, always: [] });
    await vi.waitFor(() => expect(onSurface).toHaveBeenCalledOnce());

    coordinator.settle("permission-3");

    expect(onSettled).toHaveBeenCalledWith("permission-3");
    expect(coordinator.shouldSuppress("permission-3")).toBe(true);
  });
});
