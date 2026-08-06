import { setIcon } from "obsidian";
import type OpenCodePlugin from "../../../main";
import type { SessionViewModel } from "./session-view-model";
import type { DomEventRegistrar } from "./dom-registrar";

/** Distance from the top of the timeline that triggers backward pagination. */
const LOAD_OLDER_THRESHOLD_PX = 320;
/** Distance from the bottom of the timeline below which auto-follow engages. */
const BOTTOM_THRESHOLD_PX = 220;

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
  onNearTop: () => void;
  onUnreadChange: (unread: boolean) => void;
}

/**
 * Owns scroll position, follow-latest state machine, jump-to-bottom button,
 * per-session scroll persistence, and backward-pagination edge detection.
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
  private programmaticScrollUntil = 0;
  private scrollSaveTimer?: number;

  constructor(private readonly deps: ScrollDeps) {}

  // ---- lifecycle

  /** Adds the floating jump-to-latest action; called by `renderSession`. */
  renderJumpToBottomButton(): void {
    const button = this.deps.contentEl.createEl("button", { attr: { "aria-label": "Jump to latest" }, cls: "opencode-session-view__jump-bottom" });
    setIcon(button, "arrow-down-to-line");
    button.addEventListener("click", () => this.scrollToBottom(true));
    this.jumpButton = button;
    this.updateJumpButton();
  }

  /** Registers one scroll listener on the Obsidian view root for pagination, state persistence, and jump button visibility. */
  bindScrollListener(): void {
    if (this.scrollBound) return;
    this.scrollBound = true;
    const { contentEl, register, model } = this.deps;
    register.registerDomEvent(contentEl, "scroll", () => {
      this.updateJumpButton();
      this.scheduleScrollStateSave();
      if (Date.now() > this.programmaticScrollUntil) this.markSessionReadIfAtBottom();
      if (model.followLatest && !this.isNearBottom() && Date.now() > this.programmaticScrollUntil) this.disableFollowLatest();
      if (contentEl.scrollTop < LOAD_OLDER_THRESHOLD_PX) this.deps.onNearTop();
    });
    register.registerDomEvent(contentEl, "wheel", () => {
      if (model.followLatest && Date.now() > this.programmaticScrollUntil) this.disableFollowLatest();
    });
  }

  /** Clears timers, cancels rAF handles, and persists final scroll position; called by `SessionView.onClose`. */
  dispose(): void {
    if (this.followLatestFrame !== undefined) window.cancelAnimationFrame(this.followLatestFrame);
    if (this.followLatestReleaseTimer) window.clearTimeout(this.followLatestReleaseTimer);
    if (this.scrollSaveTimer) window.clearTimeout(this.scrollSaveTimer);
    this.followLatestFrame = undefined;
    this.followLatestReleaseTimer = undefined;
    this.scrollSaveTimer = undefined;
    this.persistScrollState();
  }

  // ---- scroll restoration

  /** Restores bottom/default/current scroll after async markdown rendering settles. */
  async restoreScrollAfterRender(initialLoad: boolean, previousTop: number, wasAtBottom: boolean): Promise<void> {
    await this.nextFrame();
    const { contentEl, model, plugin } = this.deps;
    if (model.followLatest) {
      this.scrollToBottom(false);
    } else if (initialLoad) {
      const saved = model.sessionId ? plugin.settings.sessionScroll[model.sessionId] : undefined;
      if (saved && !saved.atBottom) contentEl.scrollTop = saved.top;
      else this.scrollToBottom(false);
    } else if (wasAtBottom) {
      this.scrollToBottom(false);
    } else {
      contentEl.scrollTop = previousTop;
    }
    this.updateJumpButton();
  }

  /** Captures the first visible timeline row before older messages are prepended. */
  capturePrependAnchor(): { id: string; offset: number } | undefined {
    const view = this.deps.contentEl.getBoundingClientRect();
    const visible = Array.from(this.deps.contentEl.querySelectorAll<HTMLElement>("[data-message-id]"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    const id = visible?.element.dataset.messageId;
    return id ? { id, offset: visible.rect.top - view.top } : undefined;
  }

  /** Re-applies a captured row offset after markdown/layout work from a prepend has settled. */
  async restorePrependAnchor(anchor: { id: string; offset: number } | undefined): Promise<void> {
    if (!anchor) return;
    for (let frame = 0; frame < 30; frame += 1) {
      await this.nextFrame();
      const element = this.deps.contentEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
      if (!element) continue;
      const delta = element.getBoundingClientRect().top - this.deps.contentEl.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) <= 0.5) return;
      this.deps.contentEl.scrollTop += delta;
    }
  }

  // ---- follow-latest state machine

  /** Returns true when the timeline is close enough to bottom to auto-follow streaming updates. */
  isNearBottom(): boolean {
    const el = this.deps.contentEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  /** Returns true when timeline renders should keep the latest turn visible above the sticky composer. */
  shouldFollowLatest(): boolean {
    return this.deps.model.followLatest || this.isNearBottom();
  }

  /** Enables chat-style auto-follow after the user sends a prompt; referenced by send and streaming renders. */
  enableFollowLatest(): void {
    this.deps.model.followLatest = true;
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
    this.deps.model.followLatest = false;
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
      this.deps.model.followLatest = false;
      this.followLatestUntil = 0;
    }, 2000);
  }

  // ---- imperative scroll

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
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }

  /** Shows the subdued jump button only while the user is reading away from latest. */
  updateJumpButton(): void {
    this.jumpButton?.toggleClass("is-visible", !this.isNearBottom());
  }

  // ---- persistence

  /** Debounces scroll-state persistence so normal scrolling does not thrash plugin data writes. */
  scheduleScrollStateSave(): void {
    if (this.scrollSaveTimer) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => {
      this.scrollSaveTimer = undefined;
      this.persistScrollState();
    }, 600);
  }

  /** Persists the current per-session scroll position through the plugin settings store. */
  persistScrollState(): void {
    if (!this.deps.model.sessionId) return;
    void this.deps.plugin.rememberSessionScroll(this.deps.model.sessionId, { top: this.deps.contentEl.scrollTop, atBottom: this.isNearBottom() });
  }

  // ---- helpers

  /** Clears a completed-turn marker only after the user reaches the latest session content. */
  private markSessionReadIfAtBottom(): void {
    const { model, plugin } = this.deps;
    if (this.isNearBottom() && model.sessionId && plugin.settings.sessionUnread[model.sessionId] === true) this.deps.onUnreadChange(false);
  }

  /** Waits for one animation frame so MarkdownRenderer-created DOM can affect layout. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}
