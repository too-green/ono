import { setIcon } from "obsidian";
import type OpenCodePlugin from "../../../main";
import type { SessionViewModel } from "./session-view-model";
import type { DomEventRegistrar } from "./dom-registrar";

/** Distance from the top of the timeline that triggers backward pagination. */
const LOAD_OLDER_THRESHOLD_PX = 320;
/** Distance from the bottom of the timeline below which auto-follow engages. */
const BOTTOM_THRESHOLD_PX = 220;
/** Maximum frames to wait for a relocated Obsidian leaf to regain measurable geometry. */
const RELOCATION_LAYOUT_RETRY_FRAMES = 30;
/** Frames to watch for Obsidian's delayed scroll reset after a measurable tab-group move. */
const RELOCATION_RESET_GRACE_FRAMES = 4;
/** Failsafe duration before a detached relocation mask is removed unconditionally. */
const RELOCATION_MASK_TIMEOUT_MS = 600;

/**
 * Deps injected by `SessionView` when constructing a `ScrollController`.
 *
 * `onNearTop` is emitted when the user scrolls within `LOAD_OLDER_THRESHOLD_PX`
 * of the top — the shell triggers `loadOlderMessages()`.
 * `onUnreadChange` is emitted when the user reaches the bottom while an unread
 * marker is set — the shell clears it via `setSessionUnread(false)` and refreshes
 * sidebar/panel UI.
 */
export interface ScrollDeps {
  plugin: OpenCodePlugin;
  contentEl: HTMLElement;
  model: SessionViewModel;
  register: DomEventRegistrar;
  relocationRootEl: HTMLElement;
  relocationContainerEl: HTMLElement;
  isActive: () => boolean;
  consumeTabGroupRelocation: () => boolean;
  onNearTop: () => void;
  onUnreadChange: (unread: boolean) => void;
}

/** Captured explicit bottom-follow intent guarded by user-interaction generation. */
export interface FollowLatestAnchor {
  generation: number;
}

/**
 * Owns in-memory scroll position, follow-latest state, the jump button, and
 * backward-pagination edge detection.
 *
 * Controller-private state (timers, rAF handles, jump-button DOM ref) lives here
 * and never leaks into `SessionViewModel`. Shared state (`model.followLatest`)
 * is read/written through the model so streaming + composer wiring stay in sync.
 *
 * Reference: Phase 2 of `docs/tmp/SessionView Decomposition Plan.md`.
 */
export class ScrollController {
  private jumpButton?: HTMLButtonElement;
  private scrollBound = false;
  private followLatestFrame?: number;
  private followLatestUntil = 0;
  private followLatestReleaseTimer?: number;
  private followGeneration = 0;
  private expectedProgrammaticTop?: number;
  private touchStart?: { x: number; y: number };
  private resumeFollowOnScroll = false;
  private programmaticScrollUntil = 0;
  private relocationFrame?: number;
  private relocationPending = false;
  private relocationObserver?: MutationObserver;
  private relocationMaskTimer?: number;

  constructor(private readonly deps: ScrollDeps) {}

  // ---- lifecycle

  /** Adds the floating jump-to-latest action; called by `renderSession`. */
  renderJumpToBottomButton(): void {
    const button = this.deps.contentEl.createEl("button", { attr: { "aria-label": "Jump to latest" }, cls: "opencode-session-view__jump-bottom" });
    setIcon(button, "arrow-down-to-line");
    button.addEventListener("click", () => {
      this.enableFollowLatest();
      this.scrollToBottom(false);
    });
    this.jumpButton = button;
    this.updateJumpButton();
  }

  /** Registers one scroll listener on the Obsidian view root for pagination and jump-button visibility. */
  bindScrollListener(): void {
    if (this.scrollBound) return;
    this.scrollBound = true;
    const { contentEl, register, model } = this.deps;
    let previousScrollTop = contentEl.scrollTop;
    register.registerDomEvent(contentEl, "scroll", () => {
      if (this.deps.consumeTabGroupRelocation()) this.handleTabGroupRelocation();
      if (this.relocationPending) return;
      const matchedProgrammaticTarget = this.expectedProgrammaticTop !== undefined && Math.abs(contentEl.scrollTop - this.expectedProgrammaticTop) <= 1;
      const movedUp = contentEl.scrollTop < previousScrollTop - 1;
      previousScrollTop = contentEl.scrollTop;
      this.expectedProgrammaticTop = undefined;
      this.updateJumpButton();
      if (Date.now() > this.programmaticScrollUntil) this.markSessionReadIfAtBottom();
      if (model.followLatest && movedUp && !matchedProgrammaticTarget) this.disableFollowLatest();
      if (!model.followLatest && this.resumeFollowOnScroll && this.isAtBottom()) this.enableFollowLatest();
      if (contentEl.scrollTop < LOAD_OLDER_THRESHOLD_PX) this.deps.onNearTop();
    });
    register.registerDomEvent(contentEl, "wheel", (event) => {
      this.cancelTabGroupRelocation();
      this.followGeneration += 1;
      if (event.deltaY < 0) this.disableFollowLatest();
      else if (event.deltaY > 0) this.resumeFollowOnScroll = true;
    });
    register.registerDomEvent(contentEl, "touchstart", (event) => {
      this.cancelTabGroupRelocation();
      this.followGeneration += 1;
      const touch = event.touches[0];
      this.touchStart = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
    });
    register.registerDomEvent(contentEl, "pointerdown", (event) => {
      this.cancelTabGroupRelocation();
      this.followGeneration += 1;
      this.resumeFollowOnScroll = true;
    });
    register.registerDomEvent(contentEl, "touchmove", (event) => {
      const touch = event.touches[0];
      if (!touch || !this.touchStart) return;
      const deltaX = touch.clientX - this.touchStart.x;
      const deltaY = touch.clientY - this.touchStart.y;
      if (deltaY > 4 && Math.abs(deltaY) > Math.abs(deltaX)) this.disableFollowLatest();
      else if (deltaY < -4 && Math.abs(deltaY) > Math.abs(deltaX)) this.resumeFollowOnScroll = true;
    });
    register.registerDomEvent(window, "keydown", (event) => {
      if (!this.deps.isActive()) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) {
        this.cancelTabGroupRelocation();
        this.disableFollowLatest();
      } else if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || event.key === " ") {
        this.followGeneration += 1;
        this.resumeFollowOnScroll = true;
      }
    });
  }

  /** Observes only workspace mutations that add or remove this view container, allowing correction before paint. */
  observeTabGroupRelocations(): void {
    if (this.relocationObserver || typeof MutationObserver === "undefined") return;
    const relocationContainer = this.deps.relocationContainerEl;
    this.relocationObserver = new MutationObserver((records) => {
      const includesRelocation = records.some((record) =>
        [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
          .some((node) => node === relocationContainer || (node instanceof Element && node.contains(relocationContainer))),
      );
      if (includesRelocation) this.handleObservedTabGroupRelocation();
    });
    this.relocationObserver.observe(this.deps.relocationRootEl, { childList: true, subtree: true });
  }

  /** Clears timers and cancels relocation/follow handles; called by `SessionView.onClose`. */
  dispose(): void {
    this.relocationObserver?.disconnect();
    this.relocationObserver = undefined;
    this.clearRelocationMask();
    if (this.followLatestFrame !== undefined) window.cancelAnimationFrame(this.followLatestFrame);
    if (this.relocationFrame !== undefined) window.cancelAnimationFrame(this.relocationFrame);
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestFrame = undefined;
    this.relocationFrame = undefined;
    this.relocationPending = false;
    this.followLatestReleaseTimer = undefined;
  }

  // ---- scroll restoration

  /** Restores bottom/default/current scroll after async markdown rendering settles. */
  async restoreScrollAfterRender(
    initialLoad: boolean,
    previousTop: number,
    followAnchor: FollowLatestAnchor | undefined,
    interactionGeneration: number,
  ): Promise<void> {
    await this.nextFrame();
    const { contentEl, model } = this.deps;
    if (interactionGeneration !== this.followGeneration) {
      this.updateJumpButton();
      return;
    }
    if (this.restoreFollowLatest(followAnchor)) {
      // `restoreFollowLatest` performs the guarded write.
    } else if (initialLoad) {
      if (model.sessionBusy) this.enableFollowLatest();
      this.scrollToBottom(false);
    } else {
      contentEl.scrollTop = previousTop;
    }
    this.updateJumpButton();
  }

  /** Captures the first visible timeline row before older messages are prepended. */
  capturePrependAnchor(): { id: string; offset: number; generation: number; scrollTop: number } | undefined {
    const view = this.deps.contentEl.getBoundingClientRect();
    const visible = Array.from(this.deps.contentEl.querySelectorAll<HTMLElement>("[data-message-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    const id = visible?.element.dataset.messageId;
    return id ? { id, offset: visible.rect.top - view.top, generation: this.followGeneration, scrollTop: this.deps.contentEl.scrollTop } : undefined;
  }

  /** Re-applies a captured row offset after markdown/layout work from a prepend has settled. */
  async restorePrependAnchor(anchor: { id: string; offset: number; generation: number; scrollTop: number } | undefined): Promise<void> {
    if (!anchor) return;
    let expectedTop = anchor.scrollTop;
    for (let frame = 0; frame < 30; frame += 1) {
      await this.nextFrame();
      if (anchor.generation !== this.followGeneration || Math.abs(this.deps.contentEl.scrollTop - expectedTop) > 1) return;
      const element = this.deps.contentEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
      if (!element) continue;
      const delta = element.getBoundingClientRect().top - this.deps.contentEl.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) <= 0.5) return;
      this.deps.contentEl.scrollTop += delta;
      expectedTop = this.deps.contentEl.scrollTop;
    }
  }

  // ---- follow-latest state machine

  /** Returns true when the timeline is close enough to bottom to auto-follow streaming updates. */
  isNearBottom(): boolean {
    const el = this.deps.contentEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  /**
   * Returns true only when bottom-follow was explicitly enabled.
   * Do not infer intent from `isNearBottom()`: an upward user scroll can remain
   * inside that UI threshold and must not be re-anchored by the next streamed render.
   */
  shouldFollowLatest(): boolean {
    return this.deps.model.followLatest;
  }

  /** Captures user-interaction generation for guarding non-follow scroll restoration. */
  captureInteractionGeneration(): number {
    return this.followGeneration;
  }

  /** Captures follow intent so asynchronous rendering cannot override later user scrolling. */
  captureFollowLatest(): FollowLatestAnchor | undefined {
    if (!this.shouldFollowLatest()) return undefined;
    return {
      generation: this.followGeneration,
    };
  }

  /** Restores a captured bottom anchor only while explicit follow remains enabled and no user interaction invalidated it. */
  restoreFollowLatest(anchor: FollowLatestAnchor | undefined): boolean {
    if (!anchor || anchor.generation !== this.followGeneration || !this.deps.model.followLatest) return false;
    this.scrollToBottom(false);
    return true;
  }

  /** Enables chat-style auto-follow after the user sends a prompt; referenced by send and streaming renders. */
  enableFollowLatest(): void {
    this.followGeneration += 1;
    this.deps.model.followLatest = true;
    this.resumeFollowOnScroll = false;
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = undefined;
    this.extendFollowLatest(8000);
  }

  /** Extends the multi-frame bottom alignment window used while a run is active. */
  extendFollowLatest(durationMs = 1200): void {
    if (!this.deps.model.followLatest) return;
    this.followLatestUntil = Math.max(this.followLatestUntil, Date.now() + durationMs);
    this.runFollowLatestPump();
  }

  /** Re-applies bottom alignment across frames so late Markdown/layout passes cannot restore stale scroll. */
  runFollowLatestPump(): void {
    const { contentEl, model } = this.deps;
    if (!model.followLatest || this.followLatestFrame !== undefined) return;
    this.followLatestFrame = window.requestAnimationFrame(() => {
      this.followLatestFrame = undefined;
      if (!model.followLatest || !contentEl.isConnected) return;
      this.alignToBottom();
      if (Date.now() < this.followLatestUntil) this.runFollowLatestPump();
    });
  }

  /** Stops explicit auto-follow when the run settles or the user manually scrolls away. */
  disableFollowLatest(): void {
    this.followGeneration += 1;
    this.deps.model.followLatest = false;
    this.resumeFollowOnScroll = false;
    this.followLatestUntil = 0;
    if (this.followLatestFrame !== undefined) window.cancelAnimationFrame(this.followLatestFrame);
    this.followLatestFrame = undefined;
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = undefined;
  }

  /** Keeps auto-follow through the final idle refresh, then returns to normal near-bottom anchoring. */
  releaseFollowLatestAfterIdle(): void {
    if (!this.deps.model.followLatest) return;
    this.extendFollowLatest(2200);
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    this.followLatestReleaseTimer = window.setTimeout(() => {
      this.followLatestReleaseTimer = undefined;
      this.disableFollowLatest();
    }, 2000);
  }

  // ---- imperative scroll

  /** Corrects a connected reparent before paint, or masks a detached view until its matching reattach mutation. */
  private handleObservedTabGroupRelocation(): void {
    const { contentEl } = this.deps;
    if (!contentEl.isConnected || contentEl.clientHeight <= 0) {
      contentEl.classList.add("is-relocation-masked");
      if (this.relocationMaskTimer) window.clearTimeout(this.relocationMaskTimer);
      this.relocationMaskTimer = window.setTimeout(() => {
        this.relocationMaskTimer = undefined;
        contentEl.classList.remove("is-relocation-masked");
        this.cancelTabGroupRelocation();
      }, RELOCATION_MASK_TIMEOUT_MS);
      this.handleTabGroupRelocation();
      return;
    }
    this.handleTabGroupRelocation();
    this.clearRelocationMask();
  }

  /** Recovers a sole-tab group move that reset the scroll owner, while preserving successful native relocation. */
  handleTabGroupRelocation(): void {
    this.relocationPending = true;
    if (this.relocationFrame !== undefined) window.cancelAnimationFrame(this.relocationFrame);
    this.relocationFrame = undefined;
    if (this.finishTabGroupRelocationIfReset()) return;
    this.restoreAfterTabGroupRelocation(0, RELOCATION_RESET_GRACE_FRAMES);
  }

  /** Waits for the relocated leaf to become measurable, then replaces only an actual top reset with bottom state. */
  private restoreAfterTabGroupRelocation(layoutAttempt: number, graceFramesRemaining: number): void {
    this.relocationFrame = window.requestAnimationFrame(() => {
      this.relocationFrame = undefined;
      const { contentEl } = this.deps;
      if (!contentEl.isConnected || contentEl.clientHeight <= 0) {
        if (layoutAttempt < RELOCATION_LAYOUT_RETRY_FRAMES) {
          this.restoreAfterTabGroupRelocation(layoutAttempt + 1, graceFramesRemaining);
          return;
        }
        this.relocationPending = false;
        this.clearRelocationMask();
        return;
      }
      if (this.finishTabGroupRelocationIfReset()) return;
      if (graceFramesRemaining > 1) {
        this.restoreAfterTabGroupRelocation(layoutAttempt + 1, graceFramesRemaining - 1);
        return;
      }
      this.relocationPending = false;
      this.clearRelocationMask();
      this.updateJumpButton();
    });
  }

  /** Aligns a relocation-induced top reset before paint and completes the relocation transaction. */
  private finishTabGroupRelocationIfReset(): boolean {
    const { contentEl } = this.deps;
    if (!contentEl.isConnected || contentEl.clientHeight <= 0 || contentEl.scrollTop > 1 || contentEl.scrollHeight <= contentEl.clientHeight) return false;
    this.alignToBottom();
    this.relocationPending = false;
    this.clearRelocationMask();
    this.updateJumpButton();
    return true;
  }

  /** Stops pending relocation recovery when the user deliberately navigates the timeline. */
  private cancelTabGroupRelocation(): void {
    if (!this.relocationPending) return;
    if (this.relocationFrame !== undefined) window.cancelAnimationFrame(this.relocationFrame);
    this.relocationFrame = undefined;
    this.relocationPending = false;
  }

  /** Removes the transient relocation mask and its failsafe timer. */
  private clearRelocationMask(): void {
    if (this.relocationMaskTimer) window.clearTimeout(this.relocationMaskTimer);
    this.relocationMaskTimer = undefined;
    this.deps.contentEl.classList.remove("is-relocation-masked");
  }

  /** Marks the next `durationMs` as programmatic so scroll-event handlers ignore them; used by the shell around DOM reflows. */
  markProgrammaticScroll(durationMs: number): void {
    this.programmaticScrollUntil = Math.max(this.programmaticScrollUntil, Date.now() + durationMs);
  }

  /** Drops the cached jump-button reference so stale toggleClass calls don't target orphaned DOM after a session switch. */
  clearJumpButtonReference(): void {
    this.jumpButton = undefined;
  }

  /** Scrolls the session view to the latest loaded message. */
  scrollToBottom(smooth: boolean): void {
    const el = this.deps.contentEl;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else this.alignToBottom();
    if (!smooth && this.deps.model.followLatest) this.extendFollowLatest(600);
    window.setTimeout(() => this.updateJumpButton(), smooth ? 220 : 0);
  }

  /** Sets the scroll container to its maximum scrollTop and marks resulting scroll events as programmatic. */
  alignToBottom(): void {
    this.programmaticScrollUntil = Date.now() + 600;
    const el = this.deps.contentEl;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    this.expectedProgrammaticTop = top;
    el.scrollTop = top;
  }

  /** Shows the subdued jump button only while the user is reading away from latest. */
  updateJumpButton(): void {
    this.jumpButton?.toggleClass("is-visible", !this.isNearBottom());
  }

  /** Returns true only at the physical bottom, where deliberate downward navigation may resume follow mode. */
  private isAtBottom(): boolean {
    const el = this.deps.contentEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  }

  // ---- helpers

  /** Clears a completed-turn marker only after the user reaches the latest session content. */
  private markSessionReadIfAtBottom(): void {
    const { model, plugin } = this.deps;
    if (this.isNearBottom() && model.sessionId && plugin.isSessionUnread(model.sessionId)) this.deps.onUnreadChange(false);
  }

  /** Waits for one animation frame so MarkdownRenderer-created DOM can affect layout. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

/** Returns whether keyboard scrolling originated inside an editable composer control. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [contenteditable='true']");
}
