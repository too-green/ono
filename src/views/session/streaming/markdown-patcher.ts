import { Component, MarkdownRenderer } from "obsidian";
import { logger } from "../../../logger";
import type { FollowLatestAnchor } from "../scroll-controller";
import { splitMarkdownBlocks } from "./markdown-blocks";

interface StreamingMarkdownPatch {
  element: HTMLElement;
  markdown: string;
  frame?: number;
  inFlight: boolean;
  pending: boolean;
  lastRendered?: string;
}

/** One committed block rendered once and frozen for the rest of the stream. */
interface MountedWrapper {
  source: string;
  el: HTMLElement;
  scope: Component;
}

/** Per-element mounted render state: frozen committed wrappers plus the re-rendered tail. */
interface MountedState {
  wrappers: MountedWrapper[];
  tail?: { el: HTMLElement; scope?: Component };
}

/** Dependencies used by `MarkdownPatcher` while replacing a streamed Markdown part. */
export interface MarkdownPatcherDeps {
  contentEl: HTMLElement;
  component: Component;
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

  constructor(private readonly deps: MarkdownPatcherDeps) {}

  /** Queues the latest Markdown for one streamed part without stacking concurrent renders. */
  queue(key: string, element: HTMLElement, markdown: string): void {
    this.releaseDetached();
    const existing = this.patches.get(key);
    const patch: StreamingMarkdownPatch = existing ?? { element, markdown, inFlight: false, pending: false };
    patch.element = element;
    patch.markdown = markdown;
    patch.pending = true;
    this.patches.set(key, patch);

    if (patch.frame !== undefined || patch.inFlight) return;
    patch.frame = window.requestAnimationFrame(() => {
      patch.frame = undefined;
      void this.flush(key, patch);
    });
  }

  /** Cancels queued or in-flight work before canonical reconciliation patches the same target. */
  cancel(key: string): void {
    const patch = this.patches.get(key);
    if (!patch) return;
    if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
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
    for (const patch of this.patches.values()) {
      if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
      patch.pending = false;
    }
    this.patches.clear();
    for (const element of [...this.mounted.keys()]) this.teardownMounted(element);
  }

  /** Releases mounted scopes whose target left the DOM; called after a full shell replacement. */
  releaseDetached(): void {
    for (const [key, patch] of [...this.patches]) {
      if (patch.element.isConnected) continue;
      if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
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
      return;
    }
    const markdown = patch.markdown;
    if (patch.lastRendered === markdown) {
      patch.pending = false;
      return;
    }
    const followGeneration = this.deps.captureFollowLatest();
    patch.pending = false;
    patch.inFlight = true;
    const sourcePath = `opencode-session/${this.deps.getSessionId() ?? "session"}.md`;
    let activeScope: Component | undefined;
    try {
      const { committed, tail } = splitMarkdownBlocks(markdown);
      if (!committed.length && !tail) {
        this.teardownMounted(element);
        element.replaceChildren();
        patch.lastRendered = markdown;
        this.deps.restoreFollowLatest(followGeneration);
        this.deps.updateJumpButton();
        return;
      }
      let state = this.mounted.get(element);
      if (!state || !prefixMatches(state, committed)) {
        this.teardownMounted(element);
        element.replaceChildren();
        state = { wrappers: [] };
        this.mounted.set(element, state);
      }
      for (let i = state.wrappers.length; i < committed.length; i++) {
        const scope = new Component();
        this.deps.component.addChild(scope);
        activeScope = scope;
        const scratch = document.createElement("div");
        scratch.classList.add("markdown-rendered");
        await MarkdownRenderer.renderMarkdown(committed[i], scratch, sourcePath, scope);
        if (!element.isConnected || this.patches.get(key) !== patch || this.mounted.get(element) !== state || (patch.pending && patch.markdown !== markdown)) {
          this.releaseScopeComponent(scope);
          activeScope = undefined;
          return;
        }
        const el = document.createElement("div");
        el.append(...Array.from(scratch.childNodes));
        element.insertBefore(el, state.tail?.el ?? null);
        state.wrappers.push({ source: committed[i], el, scope });
        activeScope = undefined;
      }
      const previousTailScope = state.tail?.scope;
      const scope = new Component();
      this.deps.component.addChild(scope);
      activeScope = scope;
      const scratch = document.createElement("div");
      scratch.classList.add("markdown-rendered");
      await MarkdownRenderer.renderMarkdown(tail, scratch, sourcePath, scope);
      if (!element.isConnected || this.patches.get(key) !== patch || this.mounted.get(element) !== state || (patch.pending && patch.markdown !== markdown)) {
        this.releaseScopeComponent(scope);
        activeScope = undefined;
        return;
      }
      if (!state.tail) {
        const el = document.createElement("div");
        element.appendChild(el);
        state.tail = { el };
      }
      state.tail.el.replaceChildren(...Array.from(scratch.childNodes));
      // The previous tail DOM was just destroyed by replaceChildren; unload its render children.
      if (previousTailScope) this.releaseScopeComponent(previousTailScope);
      state.tail.scope = scope;
      activeScope = undefined;
      patch.lastRendered = markdown;
      this.deps.restoreFollowLatest(followGeneration);
      this.deps.updateJumpButton();
    } catch (error) {
      if (activeScope) this.releaseScopeComponent(activeScope);
      logger.warn("session-stream", "markdown patch failed", { error });
    } finally {
      patch.inFlight = false;
      if (this.patches.get(key) !== patch) return;
      if (patch.pending && patch.element.isConnected) this.queue(key, patch.element, patch.markdown);
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
}

/** Returns true when mounted committed wrappers exactly prefix the freshly split blocks. */
function prefixMatches(state: MountedState, committed: string[]): boolean {
  if (state.wrappers.length > committed.length) return false;
  return state.wrappers.every((wrapper, index) => wrapper.source === committed[index]);
}
