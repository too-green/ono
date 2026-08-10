import { MarkdownRenderer, type Component } from "obsidian";
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

  constructor(private readonly deps: MarkdownPatcherDeps) {}

  /** Queues the latest Markdown for one streamed part without stacking concurrent renders. */
  queue(key: string, element: HTMLElement, markdown: string): void {
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
    try {
      const scratch = document.createElement("div");
      scratch.classList.add("markdown-rendered");
      await MarkdownRenderer.renderMarkdown(markdown, scratch, `opencode-session/${this.deps.getSessionId() ?? "session"}.md`, this.deps.component);
      if (!element.isConnected || this.patches.get(key) !== patch) return;
      if (patch.pending && patch.markdown !== markdown) return;
      element.replaceChildren(...Array.from(scratch.childNodes));
      this.deps.restoreFollowLatest(followGeneration);
      this.deps.updateJumpButton();
    } catch (error) {
      console.warn("[opencode-plugin:session-stream] markdown patch failed", error);
    } finally {
      patch.inFlight = false;
      if (this.patches.get(key) !== patch) return;
      if (patch.pending && patch.element.isConnected) this.queue(key, patch.element, patch.markdown);
      else if (!patch.pending) this.patches.delete(key);
    }
  }
}
