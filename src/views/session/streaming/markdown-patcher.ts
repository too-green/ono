import { Component, MarkdownRenderer } from "obsidian";
import { logger } from "../../../logger";
import type { FollowLatestAnchor } from "../scroll-controller";

interface StreamingMarkdownPatch {
  element: HTMLElement;
  markdown: string;
  frame?: number;
  inFlight: boolean;
  pending: boolean;
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

/** Owns frame-bounded, deduplicated Markdown rendering for active streamed parts. */
export class MarkdownPatcher {
  private readonly patches = new Map<string, StreamingMarkdownPatch>();
  /** Current render scope per mounted target; multiple grouped part keys can share one element. */
  private readonly mountedScopes = new Map<HTMLElement, Component>();

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
    this.releaseElementScope(patch.element);
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
    for (const scope of this.mountedScopes.values()) this.releaseScopeComponent(scope);
    this.mountedScopes.clear();
  }

  /** Releases mounted scopes whose target left the DOM; called after a full shell replacement. */
  releaseDetached(): void {
    for (const [key, patch] of [...this.patches]) {
      if (patch.element.isConnected) continue;
      if (patch.frame !== undefined) window.cancelAnimationFrame(patch.frame);
      patch.pending = false;
      this.patches.delete(key);
    }
    for (const element of [...this.mountedScopes.keys()]) {
      if (!element.isConnected) this.releaseElementScope(element);
    }
  }

  /** Renders one queued patch and schedules the newest value when a delta arrives mid-render. */
  private async flush(key: string, patch: StreamingMarkdownPatch): Promise<void> {
    if (!patch.pending || !patch.element.isConnected) {
      if (this.patches.get(key) === patch) this.patches.delete(key);
      return;
    }

    const markdown = patch.markdown;
    const element = patch.element;
    const followGeneration = this.deps.captureFollowLatest();
    patch.pending = false;
    patch.inFlight = true;
    // Render under a dedicated scope: MarkdownRenderer children must never register on the
    // long-lived view, or every streamed frame leaks a detached MarkdownRenderChild.
    const scope = new Component();
    this.deps.component.addChild(scope);
    try {
      const scratch = document.createElement("div");
      scratch.classList.add("markdown-rendered");
      await MarkdownRenderer.renderMarkdown(markdown, scratch, `opencode-session/${this.deps.getSessionId() ?? "session"}.md`, scope);
      if (!element.isConnected || this.patches.get(key) !== patch) {
        this.releaseScopeComponent(scope);
        return;
      }
      if (patch.pending && patch.markdown !== markdown) {
        this.releaseScopeComponent(scope);
        return;
      }
      element.replaceChildren(...Array.from(scratch.childNodes));
      const previous = this.mountedScopes.get(element);
      this.mountedScopes.set(element, scope);
      // The previous flush's DOM was just destroyed by replaceChildren; unload its render children.
      if (previous) this.releaseScopeComponent(previous);
      this.deps.restoreFollowLatest(followGeneration);
      this.deps.updateJumpButton();
    } catch (error) {
      this.releaseScopeComponent(scope);
      logger.warn("session-stream", "markdown patch failed", { error });
    } finally {
      patch.inFlight = false;
      if (this.patches.get(key) !== patch) return;
      if (patch.pending && patch.element.isConnected) this.queue(key, patch.element, patch.markdown);
    }
  }

  /** Drops one mounted target's scope after canonical reconciliation replaces its DOM. */
  private releaseElementScope(element: HTMLElement): void {
    const scope = this.mountedScopes.get(element);
    if (!scope) return;
    this.mountedScopes.delete(element);
    this.releaseScopeComponent(scope);
  }

  /** Detaches a render scope from the view and unloads its children. */
  private releaseScopeComponent(scope: Component): void {
    this.deps.component.removeChild(scope);
    scope.unload();
  }
}
