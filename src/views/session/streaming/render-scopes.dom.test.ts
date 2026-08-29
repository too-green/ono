import { Component } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { RenderScopeRegistry } from "./render-scopes";

/** Builds an owner component with spied child-management calls. */
function trackedOwner() {
  const owner = new Component();
  const addChild = vi.spyOn(owner, "addChild");
  const removeChild = vi.spyOn(owner, "removeChild");
  return { owner, addChild, removeChild };
}

describe("RenderScopeRegistry", () => {
  it("creates one scope per key and reuses it until retired", () => {
    const { owner, addChild } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);

    const first = registry.scope("a");
    const same = registry.scope("a");
    expect(same).toBe(first);
    expect(addChild).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it("release unloads the scope and detaches it from the owner", () => {
    const { owner, removeChild } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);
    const scope = registry.scope("a");
    const unload = vi.spyOn(scope, "unload");

    registry.release("a");
    expect(unload).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(scope);
    expect(registry.size).toBe(0);
  });

  it("releaseDetached drops only scopes whose bound element left the DOM", () => {
    const { owner } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);
    const mounted = document.createElement("div");
    const discarded = document.createElement("div");
    document.body.appendChild(mounted);

    registry.scope("mounted");
    registry.bind("mounted", mounted);
    registry.scope("discarded");
    registry.bind("discarded", discarded);

    registry.releaseDetached();
    expect(registry.size).toBe(1);
    expect(registry.scope("mounted")).toBeDefined();
    document.body.removeChild(mounted);
  });

  it("retire keeps the previous generation alive until its element is disconnected", () => {
    const { owner } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);
    const el = document.createElement("div");
    document.body.appendChild(el);

    const first = registry.scope("a");
    registry.bind("a", el);
    registry.retire("a");
    const el2 = document.createElement("div");
    document.body.appendChild(el2);
    const second = registry.scope("a");
    registry.bind("a", el2);
    expect(second).not.toBe(first);
    expect(registry.size).toBe(2);

    // The retired generation's element is still mounted, so it must survive the sweep.
    registry.releaseDetached();
    expect(registry.size).toBe(2);

    document.body.removeChild(el);
    document.body.removeChild(el2);
    registry.releaseDetached();
    expect(registry.size).toBe(0);
  });

  it("releaseDetached drops retired scopes whose element was never mounted", () => {
    const { owner } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);

    registry.retire("a");
    const second = registry.scope("a");
    expect(second).toBeDefined();

    // The retired generation (never mounted) goes; the fresh unbound live scope stays pending adoption.
    registry.releaseDetached();
    expect(registry.size).toBe(1);

    const el = document.createElement("div");
    registry.bind("a", el);
    el.remove();
    registry.releaseDetached();
    expect(registry.size).toBe(0);
  });

  it("releaseAll clears live and retired scopes", () => {
    const { owner } = trackedOwner();
    const registry = new RenderScopeRegistry(owner);

    registry.scope("live");
    const el = document.createElement("div");
    document.body.appendChild(el);
    registry.scope("doomed");
    registry.bind("doomed", el);
    registry.retire("doomed");

    registry.releaseAll();
    expect(registry.size).toBe(0);
    document.body.removeChild(el);
  });
});
