import { Component } from "obsidian";

interface ScopedRenderEntry {
  scope: Component;
  el?: HTMLElement;
}

/**
 * Tracks one dedicated lifecycle `Component` per keyed markdown block.
 *
 * Obsidian's `MarkdownRenderer.renderMarkdown` permanently registers a
 * `MarkdownRenderChild` on the component passed to it, and those registrations
 * are only unloaded when that component unloads. Passing the long-lived
 * `SessionView` therefore accumulates registrations for every replaced or
 * discarded block until the view closes (the renderer memory ballooning bug).
 * This registry gives each rendered block its own child scope that can be
 * unloaded as soon as the block's DOM is gone.
 *
 * Referenced by `TimelineRenderer` (streaming/timeline-renderer.ts).
 */
export class RenderScopeRegistry {
  private readonly entries = new Map<string, ScopedRenderEntry>();
  private readonly retired: ScopedRenderEntry[] = [];

  constructor(private readonly owner: Component) {}

  /** Returns the live scope for a keyed block, creating one on first use; children registered on it unload with the owner as a safety net. */
  scope(key: string): Component {
    const existing = this.entries.get(key);
    if (existing) return existing.scope;
    const created = new Component();
    this.owner.addChild(created);
    this.entries.set(key, { scope: created });
    return created;
  }

  /** Parks a previous generation of a keyed block so it stays interactive until its mounted DOM is actually discarded. */
  retire(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.retired.push(entry);
  }

  /** Records the mounted element that owns a key's rendered markdown so detach sweeps can detect disposal. */
  bind(key: string, el: HTMLElement): void {
    const entry = this.entries.get(key);
    if (entry) entry.el = el;
  }

  /** Releases one key's scope outright; use only when the block is known to be discarded. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.unloadEntry(entry);
  }

  /** Unloads scopes whose rendered DOM is no longer connected; called after timeline reconciliation commits. */
  releaseDetached(): void {
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key);
      if (entry?.el && !entry.el.isConnected) this.release(key);
    }
    for (let index = this.retired.length - 1; index >= 0; index -= 1) {
      const entry = this.retired[index];
      if (!entry.el || !entry.el.isConnected) {
        this.retired.splice(index, 1);
        this.unloadEntry(entry);
      }
    }
  }

  /** Releases every live and retired scope; called on session rebind and view close. */
  releaseAll(): void {
    for (const key of [...this.entries.keys()]) this.release(key);
    for (const entry of this.retired.splice(0)) this.unloadEntry(entry);
  }

  /** Returns the number of tracked scopes; used by tests to assert boundedness. */
  get size(): number {
    return this.entries.size + this.retired.length;
  }

  /** Detaches one scope from the owning view and unloads its render children. */
  private unloadEntry(entry: ScopedRenderEntry): void {
    this.owner.removeChild(entry.scope);
    entry.scope.unload();
  }
}
