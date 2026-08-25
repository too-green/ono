import { Notice, Platform, setIcon } from "obsidian";
import { pathToFileURL } from "url";
import type OpenCodePlugin from "../../../../main";
import type { ComposerAttachment, ComposerImageAttachment } from "../../../settings";
import type { JsonObject } from "../../../services/opencode-types";
import type { SessionViewModel } from "../session-view-model";
import type { DomEventRegistrar } from "../dom-registrar";
import { commandName, visibleBuiltinCommands } from "./slash-menu";
import { ContextProgressBarController } from "./context-progress-bar";
import { readString } from "../json-helpers";
import { compactHomePath } from "../path-utils";
import { openImagePreview, type PreviewableImage } from "../image-preview";

/**
 * Composer cluster controller: textarea, send/abort, attachments, draft
 * persistence, slash-command parsing, Esc-then-Esc interrupt
 * state, and the inset/progress-bar mounting.
 *
 * Owns: `composerEl`, `composerTextarea`, draft + interrupt timers,
 * `pendingInterruptConfirm`, `abortingSession`, the
 * `ContextProgressBarController`, and the window-level Cmd+Enter listener.
 *
 * Calls into sibling surfaces (slash menu, model/agent variants, docks, scroll)
 * via declared callbacks so this module never imports sibling controller types
 * directly — that coupling lives only in `SessionView`'s constructor.
 *
 * Reference: `docs/tmp/SessionView Decomposition Plan.md` Phase 4b.
 */

interface ElectronDialogBridge {
  showOpenDialog(browserWindow: unknown, options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronClipboardBridge {
  readImage(): { isEmpty(): boolean; toDataURL(): string };
}

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const SUPPORTED_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

/** Snapshot of composer focus + selection captured before a timeline reconciliation and restored after. */
export interface ComposerDomState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  scrollTop: number;
  focused: boolean;
}

export interface ComposerDeps {
  /** Plugin facade for service + settings persistence. */
  plugin: OpenCodePlugin;
  /** Container the composer reads CSS custom property targets from (`--opencode-composer-height`). */
  contentEl: HTMLElement;
  /** Shared domain state. */
  model: SessionViewModel;
  /** DOM event registrar (window-level Cmd+Enter listener cleanup). */
  register: DomEventRegistrar;
  // ---- Sibling surfaces (callbacks, never typed sibling refs) ----
  /** `slash.update(textarea)` — refresh slash-command popover state. */
  onSlashUpdate: (textarea: HTMLTextAreaElement) => void;
  /** `slash.handleKeydown(event, textarea)` — returns true if the slash menu consumed the event. */
  onSlashKeydown: (event: KeyboardEvent, textarea: HTMLTextAreaElement) => boolean;
  /** Closes body-attached popovers before their composer anchors are replaced. */
  onBeforeRemount: () => void;
  /** `variants.renderAgentLabel(container, session)`. */
  renderAgentLabel: (container: HTMLElement, session: JsonObject) => void;
  /** `variants.renderModelPill(container)`. */
  renderModelPill: (container: HTMLElement) => void;
  /** `variants.renderThinkingPill(container)`. */
  renderThinkingPill: (container: HTMLElement) => void;
  /** `docks.isComposerBlocked()` — disables the textarea when a request is pending. */
  isComposerBlocked: () => boolean;
  /** `docks.shouldAutoApprove()` — initial state of the auto-approve toggle pill. */
  shouldAutoApprove: () => boolean;
  /** Whether the active auto-approve policy comes from an ancestor session. */
  isAutoApproveInherited: () => boolean;
  // ---- Scroll surface ----
  enableFollowLatest: () => void;
  disableFollowLatest: () => void;
  scrollToBottom: (smooth: boolean) => void;
  // ---- Shell orchestration ----
  /** Whether the mute toggle pill should render active. */
  isSessionMuted: () => boolean;
  /** User-facing action label that distinguishes default-muted subagents. */
  getMuteToggleTitle: () => string;
  /** Toggle-notification click handler; shell updates settings then calls `refresh()`. */
  onToggleMute: () => void;
  /** Auto-approve toggle click handler; shell updates settings + clears docks then calls `refresh()`. */
  onToggleAutoApprove: () => void;
  /** Promotes the draft leaf to a real session leaf (model mutation + leaf state). */
  requestDraftPromotion: (sessionId: string, sessionTitle?: string) => Promise<void>;
  /** Runs a built-in command via the v1 endpoint (compact/undo/redo/share/unshare/fork). */
  executeBuiltinCommand: (command: string, sessionId: string, directory?: string) => Promise<void>;
}

/** Renders and orchestrates the bottom composer cluster used to send prompts from a session tab. */
export class ComposerController {
  private composerEl?: HTMLElement;
  private mountContainerEl?: HTMLElement;
  private insetTargetEl?: HTMLElement;
  private insetObserver?: ResizeObserver;
  private composerTextarea?: HTMLTextAreaElement;
  private composerSendButtons: HTMLButtonElement[] = [];
  private abortingSession = false;
  private composing = false;
  private pendingInterruptConfirm = false;
  private interruptConfirmTimer?: number;
  private draftSaveTimer?: number;
  private readonly progressBar: ContextProgressBarController;
  private readonly deps: ComposerDeps;

  constructor(deps: ComposerDeps) {
    this.deps = deps;
    this.progressBar = new ContextProgressBarController({ model: deps.model });
    // Captures macOS Command+Enter before Obsidian's global hotkey layer consumes it.
    deps.register.registerDomEvent(window, "keydown", this.handleGlobalComposerSend, { capture: true });
  }

  // ---- Lifecycle ----

  /** Mounts the composer (textarea, controls, progress bar) into the given shell container. Replaces `renderComposer`. */
  mount(container: HTMLElement, session: JsonObject, shouldFocus: boolean): void {
    const composerKey = this.deps.model.composerStorageKey;
    if (!composerKey) return;
    const composer = container.createDiv({ cls: "opencode-session-view__composer" });
    this.mountContainerEl = container;
    this.observeInsetTarget(container.closest<HTMLElement>(".opencode-session-view__bottom-dock") ?? composer);
    this.composerEl = composer;
    this.composerSendButtons = [];
    this.renderAttachmentChips(composer, composerKey);
    const inputRow = composer.createDiv({ cls: "opencode-session-view__composer-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "opencode-session-view__composer-input",
      attr: { placeholder: "type message, @ to include files, / for commands", rows: "1" },
    });
    textarea.value = this.deps.plugin.settings.sessionDrafts[composerKey] ?? "";
    textarea.disabled = this.deps.isComposerBlocked();
    this.composerTextarea = textarea;
    this.resizeComposerInput(textarea);

    textarea.addEventListener("input", () => this.handleComposerInput(textarea));
    textarea.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    textarea.addEventListener("compositionend", () => {
      this.composing = false;
      this.handleComposerInput(textarea);
    });
    textarea.addEventListener("paste", (event) => void this.handleComposerPaste(event));
    textarea.addEventListener("keydown", (event) => this.handleComposerKeydown(event), { capture: true });
    if (shouldFocus) window.setTimeout(() => textarea.focus(), 0);

    const controls = composer.createDiv({ cls: "opencode-session-view__composer-controls" });
    const left = controls.createDiv({ cls: "opencode-session-view__composer-left" });
    const attach = left.createSpan({ cls: "opencode-session-view__composer-icon", attr: { role: "button", tabindex: "0", "aria-label": "Attach files" } });
    setIcon(attach, "paperclip");
    attach.addEventListener("click", () => void this.pickComposerFiles());
    const labels = left.createDiv({ cls: "opencode-session-view__composer-labels" });
    this.deps.renderAgentLabel(labels, session);
    this.deps.renderModelPill(labels);
    this.deps.renderThinkingPill(labels);

    const right = controls.createDiv({ cls: "opencode-session-view__composer-right" });
    this.renderTogglePill(
      right,
      "",
      this.deps.isSessionMuted() ? "bell-off" : "bell",
      this.deps.isSessionMuted(),
      () => this.deps.onToggleMute(),
      this.deps.getMuteToggleTitle(),
    );
    const inheritedAutoApprove = this.deps.isAutoApproveInherited();
    const autoApproveTitle = inheritedAutoApprove ? "Toggle auto-accept (inherited from an ancestor session)" : "Toggle auto-accept";
    const autoApprove = this.renderTogglePill(right, "", "shield-alert", this.deps.shouldAutoApprove(), () => this.deps.onToggleAutoApprove(), autoApproveTitle);
    autoApprove.classList.add("opencode-session-view__composer-toggle--auto-accept");
    this.renderSendButton(right, textarea);
    this.deps.onSlashUpdate(textarea);
    this.updateInsetSoon();
    this.progressBar.mount(composer);
  }

  /** Drops the composer + progress bar so a closed view cannot leak; called by `SessionView.onClose`. */
  dispose(): void {
    if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.interruptConfirmTimer = undefined;
    this.draftSaveTimer = undefined;
    this.pendingInterruptConfirm = false;
    this.abortingSession = false;
    this.composerEl?.remove();
    this.insetObserver?.disconnect();
    this.composerEl = undefined;
    this.mountContainerEl = undefined;
    this.insetTargetEl = undefined;
    this.insetObserver = undefined;
    this.composerTextarea = undefined;
    this.composerSendButtons = [];
    this.composing = false;
    this.progressBar.dispose();
  }

  // ---- Public accessors used by the shell ----

  /** Returns true when the composer textarea is currently focused. */
  isFocused(): boolean {
    return !!this.composerTextarea && document.activeElement === this.composerTextarea;
  }

  // ---- Shell hook points (called by SessionView) ----

  /** Rebuilds the sticky composer while preserving draft text and the existing timeline. Replaces `refreshComposerOnly`. */
  async refresh(): Promise<void> {
    const container = this.mountContainerEl?.isConnected
      ? this.mountContainerEl
      : this.deps.contentEl.querySelector<HTMLElement>(".opencode-session-view__bottom-dock, .opencode-session-view__shell");
    if (!container) return;
    const state = this.captureDomState();
    this.persistDraft();
    this.deps.onBeforeRemount();
    this.composerEl?.remove();
    this.mount(container, this.deps.model.currentSession ?? {}, false);
    this.restoreDomState(state);
  }

  /** Saves the currently mounted composer text to plugin data. Replaces `persistComposerDraft`. */
  persistDraft(): void {
    const key = this.deps.model.composerStorageKey;
    if (!key || !this.composerTextarea) return;
    void this.deps.plugin.rememberSessionDraft(key, this.composerTextarea.value);
  }

  /** Schedules an inset recalculation on the next animation frame. Replaces `updateComposerInsetSoon`. */
  updateInsetSoon(): void {
    window.requestAnimationFrame(() => this.updateInset());
  }

  /** Recalculates token usage from the latest assistant message. Replaces `updateContextProgressBar`. */
  updateProgressBar(): void {
    this.progressBar.update();
  }

  /** Updates textarea disabled state + inset after the docks controller re-renders. Replaces the composer half of `onRequestDocksChanged`. */
  onDocksChanged(): void {
    if (this.composerTextarea?.isConnected) this.composerTextarea.disabled = this.deps.isComposerBlocked();
    this.syncSendButtons();
    this.updateInsetSoon();
  }

  /** Updates busy-state composer controls without replacing the focused textarea. */
  onSessionStatusChanged(): void {
    if (!this.deps.model.sessionBusy) this.clearInterruptConfirmation();
    if (this.composerTextarea?.isConnected) this.composerTextarea.disabled = this.deps.isComposerBlocked();
    this.syncSendButtons();
    this.updateInsetSoon();
  }

  /** Recalculates hidden-panel geometry when the Session Island returns to Prompt. */
  onPromptActivated(): void {
    if (this.composerTextarea) this.resizeComposerInput(this.composerTextarea);
    this.progressBar.update();
    this.updateInsetSoon();
    window.setTimeout(() => this.composerTextarea?.focus({ preventScroll: true }), 0);
  }

  /** Captures text selection and focus so token renders do not disrupt active drafting. */
  captureDomState(): ComposerDomState | undefined {
    const textarea = this.composerTextarea;
    if (!textarea?.isConnected) return undefined;
    return {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      selectionDirection: textarea.selectionDirection,
      scrollTop: textarea.scrollTop,
      focused: document.activeElement === textarea,
    };
  }

  /** Restores composer DOM state after a streaming timeline reconciliation. */
  restoreDomState(state: ComposerDomState | undefined): void {
    if (!state || !this.composerTextarea) return;
    this.composerTextarea.value = state.value;
    this.resizeComposerInput(this.composerTextarea);
    this.composerTextarea.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection);
    this.composerTextarea.scrollTop = state.scrollTop;
    if (state.focused) this.composerTextarea.focus({ preventScroll: true });
  }

  // ---- Composer rendering helpers ----

  /** Renders the send/stop button; click calls abort when busy + composer empty, otherwise sends. */
  private renderSendButton(container: HTMLElement, textarea: HTMLTextAreaElement): void {
    const send = container.createEl("button", { cls: "opencode-session-view__composer-send mod-cta" });
    this.composerSendButtons.push(send);
    this.paintSendButton(send, textarea);
    send.addEventListener("click", () => {
      if (this.deps.model.sessionBusy && !textarea.value.trim()) void this.abortCurrentSession();
      else void this.sendPrompt();
    });
  }

  /** Paints one send action from current model and textarea state without replacing either element. */
  private paintSendButton(send: HTMLButtonElement, textarea: HTMLTextAreaElement): void {
    const stopMode = this.deps.model.sessionBusy && !textarea.value.trim();
    send.toggleClass("is-stop", stopMode);
    send.toggleClass("is-loading", this.deps.model.submittingPrompt || this.abortingSession);
    send.toggleClass("is-confirming", this.pendingInterruptConfirm);
    if (stopMode) {
      setIcon(send, this.abortingSession ? "loader-2" : this.pendingInterruptConfirm ? "triangle-alert" : "square");
      const label = this.pendingInterruptConfirm ? "Press Esc again to interrupt" : "Interrupt session";
      send.setAttr("aria-label", label);
      send.disabled = this.deps.isComposerBlocked() || this.abortingSession;
    } else {
      setIcon(send, this.deps.model.submittingPrompt ? "loader-2" : "send");
      send.setAttr("aria-label", `Send prompt (${Platform.isMacOS ? "⌘" : "Ctrl"}+Enter · Shift+Enter for newline)`);
      send.disabled = this.deps.isComposerBlocked() || this.deps.model.submittingPrompt || !textarea.value.trim();
    }
  }

  /** Repaints the mounted send action from the stable live textarea. */
  private syncSendButtons(): void {
    const textarea = this.composerTextarea;
    if (!textarea) return;
    for (const send of this.composerSendButtons) this.paintSendButton(send, textarea);
  }

  /** Processes native, pasted, accessibility, and composition input without remounting the composer. */
  private handleComposerInput(textarea: HTMLTextAreaElement): void {
    this.resizeComposerInput(textarea);
    this.deps.onSlashUpdate(textarea);
    this.updateInsetSoon();
    this.scheduleDraftSave();
    if (textarea.value.trim()) this.clearInterruptConfirmation();
    this.syncSendButtons();
  }

  /** Clears the transient double-Esc confirmation before repainting stable controls. */
  private clearInterruptConfirmation(): void {
    this.pendingInterruptConfirm = false;
    if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
    this.interruptConfirmTimer = undefined;
  }

  /** Renders one compact boolean composer control; referenced by auto-approve and mute toggles. */
  private renderTogglePill(container: HTMLElement, label: string, icon: string, active: boolean, onClick: () => void, title: string): HTMLElement {
    const el = container.createSpan({ cls: "opencode-session-view__composer-toggle", attr: { role: "button", tabindex: "0", "aria-pressed": String(active), "aria-label": title } });
    el.toggleClass("is-active", active);
    el.toggleClass("is-icon-only", label.length === 0);
    setIcon(el, icon);
    if (label) el.createSpan({ text: label });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return el;
  }

  /** Renders image previews and non-image file chips above the composer textarea. */
  private renderAttachmentChips(container: HTMLElement, composerKey: string): void {
    const files = this.deps.plugin.settings.sessionAttachedFiles[composerKey] ?? [];
    if (files.length === 0) return;
    const attachments = files.map((file) => ({ file, image: this.composerImagePreview(file) }));
    this.renderComposerImagePreviews(container, attachments.flatMap(({ file, image }) => image ? [{ file, image }] : []));
    const nonImages = attachments.filter(({ image }) => !image).map(({ file }) => file);
    if (nonImages.length === 0) return;
    const chips = container.createDiv({ cls: "opencode-session-view__attachment-chips" });
    for (const file of nonImages) {
      const name = typeof file === "string" ? compactHomePath(file) : file.filename;
      const chip = chips.createEl("button", { cls: "opencode-session-view__attachment-chip", attr: { "aria-label": `Remove ${name}` } });
      setIcon(chip, "file-text");
      chip.createSpan({ text: name });
      const remove = chip.createSpan({ cls: "opencode-session-view__attachment-chip-remove" });
      setIcon(remove, "x");
      chip.addEventListener("click", () => void this.removeComposerAttachment(file));
    }
  }

  /** Renders compact image cards whose preview and removal actions stay independent. */
  private renderComposerImagePreviews(container: HTMLElement, images: Array<{ file: ComposerAttachment; image: PreviewableImage }>): void {
    if (images.length === 0) return;
    const grid = container.createDiv({ cls: "opencode-session-view__composer-attachments" });
    for (const { file, image } of images) {
      const card = grid.createDiv({ cls: "opencode-session-view__composer-attachment" });
      const preview = card.createEl("button", { cls: "opencode-session-view__attachment opencode-session-view__composer-attachment-preview", attr: { "aria-label": `Open image ${image.name}` } });
      preview.createEl("img", { cls: "opencode-session-view__attachment-image", attr: { src: image.url, alt: image.name } });
      preview.createSpan({ text: image.name, cls: "opencode-session-view__attachment-name" });
      preview.addEventListener("click", () => openImagePreview(this.deps.plugin.app, image));
      const remove = card.createEl("button", { cls: "opencode-session-view__composer-attachment-remove clickable-icon", attr: { "aria-label": `Remove ${image.name}` } });
      setIcon(remove, "x");
      remove.addEventListener("click", () => void this.removeComposerAttachment(file));
    }
  }

  /** Resolves persisted image data or a selected image path into preview metadata. */
  private composerImagePreview(file: ComposerAttachment): PreviewableImage | undefined {
    if (typeof file !== "string") return { name: file.filename, url: file.url };
    if (!this.fileMime(file).startsWith("image/")) return undefined;
    return { name: compactHomePath(file), url: pathToFileURL(file).href };
  }

  /** Updates the CSS custom property that prevents latest messages from hiding behind the composer. */
  private updateInset(): void {
    if (!this.insetTargetEl?.isConnected) {
      this.deps.contentEl.style.removeProperty("--opencode-composer-height");
      return;
    }
    const height = Math.ceil(this.insetTargetEl.getBoundingClientRect().height);
    if (height > 0) this.deps.contentEl.style.setProperty("--opencode-composer-height", `${height}px`);
  }

  /** Observes the complete sticky bottom dock so island-panel and request changes share one inset. */
  private observeInsetTarget(target: HTMLElement): void {
    this.insetObserver?.disconnect();
    this.insetTargetEl = target;
    if (typeof ResizeObserver === "undefined") return;
    this.insetObserver = new ResizeObserver(() => this.updateInset());
    this.insetObserver.observe(target);
  }

  // ---- Attachments ----

  /** Adds image files from a browser or Electron-native clipboard to the active draft. */
  private async handleComposerPaste(event: ClipboardEvent): Promise<void> {
    const clipboard = event.clipboardData;
    const composerKey = this.deps.model.composerStorageKey;
    if (!clipboard || !composerKey) return;

    const itemFiles = Array.from(clipboard.items).flatMap((item) => {
      if (item.kind !== "file") return [];
      const file = item.getAsFile();
      const mime = file ? this.imageMime(item.type, file.name) : undefined;
      return file && mime ? [{ file, mime }] : [];
    });
    const imageFiles = itemFiles.length > 0
      ? itemFiles
      : Array.from(clipboard.files).flatMap((file) => {
        const mime = this.imageMime(file.type, file.name);
        return mime ? [{ file, mime }] : [];
      });
    if (imageFiles.length === 0 && clipboard.getData("text/plain")) return;

    event.preventDefault();
    event.stopPropagation();
    try {
      const images = imageFiles.length > 0
        ? await Promise.all(imageFiles.map(({ file, mime }) => this.composerImageFromFile(file, mime)))
        : this.nativeClipboardImage();
      if (!images) return;
      await this.rememberPastedImages(composerKey, Array.isArray(images) ? images : [images]);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to paste image.");
    }
  }

  /** Converts one browser clipboard image into the v1 data-URL attachment shape. */
  private composerImageFromFile(file: File, mime: string): Promise<ComposerImageAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Unable to read pasted image."));
          return;
        }
        const comma = reader.result.indexOf(",");
        const url = comma < 0 ? reader.result : `data:${mime};base64,${reader.result.slice(comma + 1)}`;
        resolve({ filename: file.name || `pasted-image-${Date.now()}.${this.imageExtension(mime)}`, mime, url });
      };
      reader.onerror = () => reject(reader.error ?? new Error("Unable to read pasted image."));
      reader.onabort = () => reject(new Error("Pasted image read was cancelled."));
      reader.readAsDataURL(file);
    });
  }

  /** Reads image-only clipboard content through Electron when Chromium exposes no file item. */
  private nativeClipboardImage(): ComposerImageAttachment | undefined {
    try {
      const electronRequire = (window as unknown as { require?: NodeRequire }).require ?? require;
      const clipboard = (electronRequire("electron") as { clipboard?: ElectronClipboardBridge }).clipboard;
      const image = clipboard?.readImage();
      if (!image || image.isEmpty()) return undefined;
      return { filename: `pasted-image-${Date.now()}.png`, mime: "image/png", url: image.toDataURL() };
    } catch {
      return undefined;
    }
  }

  /** Merges pasted images into the captured draft and refreshes its mounted chips. */
  private async rememberPastedImages(composerKey: string, images: ComposerImageAttachment[]): Promise<void> {
    const existing = this.deps.plugin.settings.sessionAttachedFiles[composerKey] ?? [];
    const existingUrls = new Set(existing.flatMap((file) => typeof file === "string" ? [] : [file.url]));
    const additions = images.filter((image) => {
      if (existingUrls.has(image.url)) return false;
      existingUrls.add(image.url);
      return true;
    });
    if (additions.length === 0) return;
    await this.deps.plugin.rememberSessionAttachedFiles(composerKey, [...existing, ...additions]);
    if (this.deps.model.composerStorageKey === composerKey) await this.refresh();
  }

  /** Opens Electron's native picker and stores selected absolute file paths as composer chips. */
  private async pickComposerFiles(): Promise<void> {
    const composerKey = this.deps.model.composerStorageKey;
    if (!composerKey) return;
    try {
      const electronRequire = (window as unknown as { require?: NodeRequire }).require ?? require;
      const electron = electronRequire("electron") as { remote?: { dialog?: ElectronDialogBridge; getCurrentWindow?: () => unknown }; dialog?: ElectronDialogBridge };
      const dialog = electron.remote?.dialog ?? electron.dialog;
      if (!dialog) throw new Error("Electron file picker is unavailable in this Obsidian window.");
      const options = { properties: ["openFile", "multiSelections"] };
      const result = electron.remote?.getCurrentWindow
        ? await dialog.showOpenDialog(electron.remote.getCurrentWindow(), options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return;
      const existing = this.deps.plugin.settings.sessionAttachedFiles[composerKey] ?? [];
      await this.deps.plugin.rememberSessionAttachedFiles(composerKey, [...new Set([...existing, ...result.filePaths])]);
      await this.refresh();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to attach files.");
    }
  }

  /** Removes one selected file chip and re-renders only the composer shell. */
  private async removeComposerAttachment(file: ComposerAttachment): Promise<void> {
    const composerKey = this.deps.model.composerStorageKey;
    if (!composerKey) return;
    const files = (this.deps.plugin.settings.sessionAttachedFiles[composerKey] ?? []).filter((item) => item !== file);
    await this.deps.plugin.rememberSessionAttachedFiles(composerKey, files);
    await this.refresh();
  }

  // ---- Draft persistence ----

  /** Debounces draft persistence for normal typing. */
  scheduleDraftSave(): void {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = undefined;
      this.persistDraft();
    }, 400);
  }

  // ---- Keydown handlers ----

  /** Handles keyboard send and interrupt shortcuts in the composer textarea. */
  private handleComposerKeydown(event: KeyboardEvent): void {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    if (this.composing || event.isComposing) return;
    if (this.deps.onSlashKeydown(event, textarea)) return;
    // Stop-button Esc confirmation: only active when agent is running and composer is empty.
    if (event.key === "Escape" && this.deps.model.sessionBusy && !textarea.value.trim() && !this.abortingSession) {
      event.preventDefault();
      event.stopPropagation();
      if (this.pendingInterruptConfirm) {
        void this.abortCurrentSession();
      } else {
        this.pendingInterruptConfirm = true;
        const seconds = Math.max(1, Math.floor(this.deps.plugin.settings.interruptConfirmSeconds ?? 3));
        this.interruptConfirmTimer = window.setTimeout(() => {
          this.pendingInterruptConfirm = false;
          this.interruptConfirmTimer = undefined;
          void this.refresh();
        }, seconds * 1000);
        void this.refresh();
      }
      return;
    }
    const sendModifier = Platform.isMacOS ? event.metaKey : event.ctrlKey;
    if (sendModifier && (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")) {
      event.preventDefault();
      event.stopPropagation();
      void this.sendPrompt();
      return;
    }
  }

  /** Captures macOS Command+Enter before Obsidian's global hotkey layer consumes it. */
  private handleGlobalComposerSend = (event: KeyboardEvent): void => {
    if (this.composing || event.isComposing || !Platform.isMacOS || !event.metaKey) return;
    if (document.activeElement !== this.composerTextarea) return;
    if (event.key !== "Enter" && event.code !== "Enter" && event.code !== "NumpadEnter") return;
    event.preventDefault();
    event.stopPropagation();
    void this.sendPrompt();
  };

  // ---- Send / abort ----

  /** Aborts the current session via `POST /session/:id/abort`; clears any pending Esc-confirm state. */
  private async abortCurrentSession(): Promise<void> {
    const model = this.deps.model;
    if (this.abortingSession || !model.sessionId) return;
    this.abortingSession = true;
    this.pendingInterruptConfirm = false;
    if (this.interruptConfirmTimer) window.clearTimeout(this.interruptConfirmTimer);
    this.interruptConfirmTimer = undefined;
    await this.refresh();
    try {
      await this.deps.plugin.requireOpenCodeService().abortSession(model.sessionId, model.sessionDirectory ?? model.draftDirectory);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to interrupt OpenCode session.");
    } finally {
      this.abortingSession = false;
      await this.refresh();
    }
  }

  /** Sends the current composer prompt through OpenCode prompt/command endpoints. Replaces `sendComposerPrompt`. */
  private async sendPrompt(): Promise<void> {
    const model = this.deps.model;
    const composerKey = model.composerStorageKey;
    if (!composerKey || model.submittingPrompt || model.rewindInFlight || this.deps.isComposerBlocked()) return;
    const text = this.composerTextarea?.value.trim() ?? "";
    if (!text) return;
    const submissionDirectory = model.sessionDirectory ?? model.draftDirectory;
    const submissionAgent = model.selectedAgent;
    const submissionModel = model.selectedModel ? { ...model.selectedModel } : undefined;
    const builtinName = text.match(/^\/(\w+)$/)?.[1];
    const isBuiltin = !!builtinName && visibleBuiltinCommands(model.currentSession, model.serverConfig).some((command) => command.name === builtinName);
    // Per spec: while streaming, the composer stays enabled and prompts queue server-side.
    this.deps.enableFollowLatest();
    model.submittingPrompt = true;
    let targetSessionId = model.sessionId;
    let createdTitle: string | undefined;
    const isSubmissionBound = (): boolean => model.composerStorageKey === composerKey || (!!targetSessionId && model.composerStorageKey === targetSessionId);
    try {
      if (!targetSessionId) {
        const created = await this.deps.plugin.requireOpenCodeService().createSession(
          {
            agent: submissionAgent,
            model: submissionModel
              ? { providerID: submissionModel.providerID, id: submissionModel.modelID, variant: submissionModel.variant }
              : undefined,
          },
          submissionDirectory,
        );
        targetSessionId = created.id;
        createdTitle = created.title;
        await this.deps.plugin.rememberSessionDraft(composerKey, this.composerTextarea?.value ?? text);
        await this.deps.plugin.promoteSessionDraft(composerKey, targetSessionId);
        if (model.composerStorageKey === composerKey) await this.deps.requestDraftPromotion(targetSessionId, createdTitle);
        await this.deps.plugin.refreshAgentPanels({ showLoading: false });
      }

      const fileParts = this.composerFileParts(targetSessionId);
      if (builtinName && isBuiltin) {
        await this.deps.executeBuiltinCommand(builtinName, targetSessionId, submissionDirectory);
      } else {
        const slash = this.parseSlashCommand(text);
        if (slash) {
          await this.deps.plugin.requireOpenCodeService().runCommand(
            targetSessionId,
            {
              agent: submissionAgent,
              model: submissionModel ? `${submissionModel.providerID}/${submissionModel.modelID}` : undefined,
              variant: submissionModel?.variant,
              command: slash.command,
              arguments: slash.arguments,
              parts: fileParts,
            },
            submissionDirectory,
          );
        } else {
          await this.deps.plugin.requireOpenCodeService().sendPromptAsync(
            targetSessionId,
            {
              agent: submissionAgent,
              model: submissionModel
                ? { providerID: submissionModel.providerID, modelID: submissionModel.modelID }
                : undefined,
              variant: submissionModel?.variant,
              parts: [{ type: "text", text }, ...fileParts],
            },
            submissionDirectory,
          );
        }
      }
      if (isSubmissionBound() && this.composerTextarea) {
        this.composerTextarea.value = "";
        this.resizeComposerInput(this.composerTextarea);
        this.updateInsetSoon();
      }
      await this.deps.plugin.rememberSessionDraft(targetSessionId, "");
      await this.deps.plugin.rememberSessionAttachedFiles(targetSessionId, []);
      if (isSubmissionBound()) {
        model.submittingPrompt = false;
        await this.refresh();
        this.deps.scrollToBottom(false);
      }
    } catch (error) {
      if (isSubmissionBound()) {
        this.deps.disableFollowLatest();
      }
      if (targetSessionId && model.composerStorageKey === composerKey && model.draftId) await this.deps.requestDraftPromotion(targetSessionId, createdTitle);
      new Notice(error instanceof Error ? error.message : "Unable to send OpenCode prompt.");
    } finally {
      if (isSubmissionBound()) {
        model.submittingPrompt = false;
        if (this.composerTextarea) this.composerTextarea.disabled = false;
        this.composerTextarea?.focus();
      }
    }
  }

  /** Parses a composer buffer as a known slash command submission. */
  private parseSlashCommand(text: string): { command: string; arguments: string } | undefined {
    const match = text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    if (!match) return undefined;
    const command = match[1];
    if (!this.deps.model.availableCommands.some((item) => commandName(item) === command && readString(item, ["source"]) !== "skill")) return undefined;
    return { command, arguments: match[2] ?? "" };
  }

  /** Converts selected composer attachment paths to prompt file parts. */
  private composerFileParts(key: string): Array<{ type: "file"; url: string; filename: string; mime: string }> {
    return (this.deps.plugin.settings.sessionAttachedFiles[key] ?? []).map((file) => typeof file === "string"
      ? {
        type: "file" as const,
        url: pathToFileURL(file).href,
        filename: file,
        mime: this.fileMime(file),
      }
      : { type: "file" as const, url: file.url, filename: file.filename, mime: file.mime });
  }

  /** Infers image MIME for picker paths while retaining text context-file behavior. */
  private fileMime(filename: string): string {
    const extension = filename.split(".").pop()?.toLowerCase();
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] ?? "text/plain" : "text/plain";
  }

  /** Resolves one first-party-supported image MIME from clipboard metadata or its filename. */
  private imageMime(mime: string, filename: string): string | undefined {
    const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (SUPPORTED_IMAGE_MIMES.has(normalized)) return normalized;
    const inferred = this.fileMime(filename);
    return inferred.startsWith("image/") ? inferred : undefined;
  }

  /** Returns a stable filename extension for pasted image MIME types. */
  private imageExtension(mime: string): string {
    return mime === "image/jpeg" ? "jpg" : mime.split("/")[1]?.replace("+xml", "") || "png";
  }

  /** Autosizes the composer textarea while keeping it bounded. */
  resizeComposerInput(textarea: HTMLTextAreaElement): void {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }
}
