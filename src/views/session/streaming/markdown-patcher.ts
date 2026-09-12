import { Component, MarkdownRenderer } from "obsidian";
import { logger } from "../../../logger";
import type { FollowLatestAnchor } from "../scroll-controller";
import { splitMarkdownBlocks } from "./markdown-blocks";

type StreamingMarkdownSource = string | (() => string);

interface StreamingMarkdownPatch {
  element: HTMLElement;
  source: StreamingMarkdownSource;
  revision: number;
  frame?: number;
  timer?: number;
  inFlight: boolean;
  pending: boolean;
  lastFlushedAt?: number;
  lastRendered?: string;
}

/** One committed block rendered directly into the target and frozen for the rest of the stream. */
interface MountedWrapper {
  /** Separator comment appended after this block's children. */
  endMarker: Comment;
  scope: Component;
}

/** Per-element mounted render state: frozen committed children plus the re-rendered tail children. */
interface MountedState {
  key: string;
  committedLength: number;
  wrappers: MountedWrapper[];
  tail?: { scope?: Component };
}

const DEFAULT_RENDER_INTERVAL_MS = 50;

/** Dependencies used by `MarkdownPatcher` while replacing a streamed Markdown part. */
export interface MarkdownPatcherDeps {
  contentEl: HTMLElement;
  component: Component;
  /** Minimum time between Obsidian MarkdownRenderer calls for one live target. */
  renderIntervalMs?: number;
  getSessionId: () => string | undefined;
  captureFollowLatest: () => FollowLatestAnchor | undefined;
  restoreFollowLatest: (anchor: FollowLatestAnchor | undefined) => boolean;
  updateJumpButton: () => void;
}

/** Owns frame-bounded, deduplicated, block-incremental Markdown rendering for active streamed parts. */
export class MarkdownPatcher {
  private readonly patches = new Map<string, StreamingMarkdownPatch>();
  /** Mounted wrapper/tail scopes per target element; multiple grouped part keys can share one element. */
  private readonly mounted = new Map<HTMLElement, MountedState>();
  private readonly renderIntervalMs: number;
  private disposed = false;

  constructor(private readonly deps: MarkdownPatcherDeps) {
    this.renderIntervalMs = Math.max(0, deps.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS);
  }

  /** Queues the latest Markdown for one streamed part without stacking concurrent renders. */
  queue(key: string, element: HTMLElement, source: StreamingMarkdownSource): void {
    if (this.disposed) return;
    const existing = this.patches.get(key);
    if (!existing) this.releaseDetached();
    const patch: StreamingMarkdownPatch = existing ?? { element, source, revision: 0, inFlight: false, pending: false };
    patch.element = element;
    patch.source = source;
    patch.revision += 1;
    patch.pending = true;
    this.patches.set(key, patch);

    if (patch.frame !== undefined || patch.timer !== undefined || patch.inFlight) return;
    this.scheduleFlush(key, patch);
  }

  /** Schedules one trailing frame while bounding expensive MarkdownRenderer calls to 20 Hz by default. */
  private scheduleFlush(key: string, patch: StreamingMarkdownPatch): void {
    const elapsed = patch.lastFlushedAt === undefined ? Number.POSITIVE_INFINITY : performance.now() - patch.lastFlushedAt;
    const delay = Math.max(0, this.renderIntervalMs - elapsed);
    if (delay > 0) {
      patch.timer = window.setTimeout(() => {
        patch.timer = undefined;
        if (this.patches.get(key) === patch && patch.pending) this.requestFlushFrame(key, patch);
      }, delay);
      return;
    }
    this.requestFlushFrame(key, patch);
  }

  /** Aligns a due patch with the browser paint cycle. */
  private requestFlushFrame(key: string, patch: StreamingMarkdownPatch): void {
    patch.frame = window.requestAnimationFrame(() => {
      patch.frame = undefined;
      void this.flush(key, patch);
    });
  }

  /** Cancels queued or in-flight work before canonical reconciliation patches the same target. */
  cancel(key: string): void {
    const patch = this.patches.get(key);
    if (!patch) return;
    this.cancelScheduledFlush(patch);
    patch.pending = false;
    this.teardownMounted(patch.element);
    this.patches.delete(key);
  }

  /** Finds the mounted DOM node that owns a streamed text or reasoning part. */
  findPartTarget(messageId: string, partId: string, type: string): HTMLElement | undefined {
    const row = this.deps.contentEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!row) return undefined;
    const selector = type === "reasoning" ? ".opencode-session-view__reasoning-body" : ".opencode-session-view__assistant-markdown";
    return Array.from(row.querySelectorAll<HTMLElement>(`${selector}[data-stream-field="text"]`))
      .find((element) => (element.dataset.partIds ?? element.dataset.partId ?? "").split(" ").includes(partId));
  }

  /** Cancels queued frames and prevents in-flight renders from mutating the disposed view. */
  dispose(): void {
    this.disposed = true;
    for (const patch of this.patches.values()) {
      this.cancelScheduledFlush(patch);
      patch.pending = false;
    }
    this.patches.clear();
    for (const element of [...this.mounted.keys()]) this.teardownMounted(element);
  }

  /** Releases mounted scopes whose target left the DOM; called after a full shell replacement. */
  releaseDetached(): void {
    for (const [key, patch] of [...this.patches]) {
      if (patch.element.isConnected) continue;
      this.cancelScheduledFlush(patch);
      patch.pending = false;
      this.patches.delete(key);
    }
    for (const element of [...this.mounted.keys()]) {
      if (!element.isConnected) this.teardownMounted(element);
    }
  }

  /** Renders one queued patch incrementally: commits stable blocks once, re-renders only the tail. */
  private async flush(key: string, patch: StreamingMarkdownPatch): Promise<void> {
    const element = patch.element;
    if (!patch.pending || !element.isConnected) {
      if (this.patches.get(key) === patch) this.patches.delete(key);
      if (!element.isConnected) this.teardownMounted(element);
      return;
    }
    const revision = patch.revision;
    let markdown: string;
    try {
      markdown = typeof patch.source === "function" ? patch.source() : patch.source;
    } catch (error) {
      patch.pending = false;
      logger.warn("session-stream", "markdown source failed", { error });
      return;
    }
    if (patch.lastRendered === markdown) {
      patch.pending = false;
      return;
    }
    const followGeneration = this.deps.captureFollowLatest();
    patch.pending = false;
    patch.inFlight = true;
    const sourcePath = `opencode-session/${this.deps.getSessionId() ?? "session"}.md`;
    try {
      let state = this.mounted.get(element);
      const appendOnly = !!state
        && state.key === key
        && patch.lastRendered !== undefined
        && markdown.startsWith(patch.lastRendered);
      const prefixStable = appendOnly || (!!state
        && state.key === key
        && patch.lastRendered !== undefined
        && markdown.startsWith(patch.lastRendered.slice(0, state.committedLength)));
      const source = prefixStable ? markdown.slice(state!.committedLength) : markdown;
      const { committed, tail } = splitMarkdownBlocks(source);
      if (!prefixStable && !committed.length && !tail) {
        this.teardownMounted(element);
        element.replaceChildren();
        patch.lastRendered = markdown;
        this.deps.restoreFollowLatest(followGeneration);
        this.deps.updateJumpButton();
        return;
      }
      if (!state || !prefixStable) {
        this.teardownMounted(element);
        element.replaceChildren();
        state = { key, committedLength: 0, wrappers: [] };
        this.mounted.set(element, state);
      }
      const pending: Array<{ source: string; scope: Component; nodes: Node[] }> = [];
      let tailScope: Component | undefined;
      let tailNodes: Node[] = [];
      let mounted = false;
      try {
        // Render every new committed block off-DOM so staleness never mutates the target.
        for (let i = 0; i < committed.length; i++) {
          const scope = new Component();
          this.deps.component.addChild(scope);
          const block: { source: string; scope: Component; nodes: Node[] } = { source: committed[i], scope, nodes: [] };
          pending.push(block);
          const scratch = document.createElement("div");
          scratch.classList.add("markdown-rendered");
          await MarkdownRenderer.renderMarkdown(committed[i], scratch, sourcePath, scope);
          if (this.flushStale(key, patch, state, revision, markdown)) return;
          block.nodes = Array.from(scratch.childNodes);
        }
        // Render the fresh tail off-DOM so the old tail children stay visible until the swap.
        if (tail) {
          tailScope = new Component();
          this.deps.component.addChild(tailScope);
          const scratch = document.createElement("div");
          scratch.classList.add("markdown-rendered");
          await MarkdownRenderer.renderMarkdown(tail, scratch, sourcePath, tailScope);
          if (this.flushStale(key, patch, state, revision, markdown)) return;
          tailNodes = Array.from(scratch.childNodes);
        }

        // Swap the old tail out, then mount committed children plus their separators and the fresh tail.
        const previousTailScope = state.tail?.scope;
        this.removeTailNodes(element, state);
        if (previousTailScope) this.releaseScopeComponent(previousTailScope);
        state.tail = undefined;
        for (const block of pending) {
          element.append(...block.nodes);
          const endMarker = document.createComment("stream-block");
          element.append(endMarker);
          state.wrappers.push({ endMarker, scope: block.scope });
        }
        element.append(...tailNodes);
        state.tail = tailScope ? { scope: tailScope } : undefined;
        state.committedLength = markdown.length - tail.length;
        mounted = true;
        patch.lastRendered = markdown;
        this.deps.restoreFollowLatest(followGeneration);
        this.deps.updateJumpButton();
      } finally {
        if (!mounted) {
          for (const block of pending) this.releaseScopeComponent(block.scope);
          if (tailScope) this.releaseScopeComponent(tailScope);
        }
      }
    } catch (error) {
      logger.warn("session-stream", "markdown patch failed", { error });
    } finally {
      patch.lastFlushedAt = performance.now();
      patch.inFlight = false;
      if (this.patches.get(key) !== patch) return;
      if (patch.pending && patch.element.isConnected) this.scheduleFlush(key, patch);
    }
  }

  /** Returns true when this flush no longer owns the element or newer markdown superseded it. */
  private flushStale(key: string, patch: StreamingMarkdownPatch, state: MountedState, revision: number, markdown: string): boolean {
    if (!patch.element.isConnected || this.patches.get(key) !== patch || this.mounted.get(patch.element) !== state) return true;
    if (patch.revision === revision) return false;
    try {
      const latest = typeof patch.source === "function" ? patch.source() : patch.source;
      if (latest === markdown) {
        patch.pending = false;
        return false;
      }
    } catch (error) {
      patch.pending = false;
      logger.warn("session-stream", "markdown source failed", { error });
    }
    return true;
  }

  /** Removes the tail children mounted after the last committed separator comment. */
  private removeTailNodes(element: HTMLElement, state: MountedState): void {
    const lastMarker = state.wrappers.at(-1)?.endMarker;
    let node = lastMarker ? lastMarker.nextSibling : element.firstChild;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
  }

  /** Releases every wrapper and tail scope mounted for one target element. */
  private teardownMounted(element: HTMLElement): void {
    const state = this.mounted.get(element);
    if (!state) return;
    this.mounted.delete(element);
    for (const wrapper of state.wrappers) this.releaseScopeComponent(wrapper.scope);
    if (state.tail?.scope) this.releaseScopeComponent(state.tail.scope);
  }

  /** Detaches a render scope from the view and unloads its children. */
  private releaseScopeComponent(scope: Component): void {
    this.deps.component.removeChild(scope);
    scope.unload();
  }

  /** Cancels either stage of a delayed patch paint. */
  private cancelScheduledFlush(patch: StreamingMarkdownPatch): void {
    if (patch.timer !== undefined) window.clearTimeout(patch.timer);
    if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
    patch.timer = undefined;
    patch.frame = undefined;
  }
}
