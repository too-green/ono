import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "obsidian";

import type OpenCodePlugin from "../../../../main";
import { defaultContextBarSettings, type ComposerAttachment } from "../../../settings";
import { SessionViewModel } from "../session-view-model";
import { ComposerController, type ComposerDeps } from "./composer-controller";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by composer rendering. */
function installObsidianDomMethods(): void {
  const create = function (this: HTMLElement, tag: string, options: DomOptions = {}): HTMLElement {
    const element = document.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.appendChild(element);
    return element;
  };
  Object.defineProperties(HTMLElement.prototype, {
    createDiv: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "div", options); } },
    createSpan: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "span", options); } },
    createEl: { configurable: true, value: function (this: HTMLElement, tag: string, options?: DomOptions) { return create.call(this, tag, options); } },
    setAttr: { configurable: true, value: function (this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); } },
    setText: { configurable: true, value: function (this: HTMLElement, text: string) { this.textContent = text; } },
    toggleClass: { configurable: true, value: function (this: HTMLElement, cls: string, force?: boolean) { this.classList.toggle(cls, force); } },
    addClass: { configurable: true, value: function (this: HTMLElement, cls: string) { this.classList.add(cls); } },
  });
}

/** Creates a mounted composer with observable callbacks and simple label renderers. */
function setup(options: { busy?: boolean } = {}) {
  const model = new SessionViewModel();
  model.sessionId = "session-1";
  model.sessionBusy = options.busy ?? false;
  const settings = {
    interruptConfirmSeconds: 3,
    contextBar: defaultContextBarSettings(),
  };
  const composerState: Record<string, { text?: string; attachments?: ComposerAttachment[] }> = {};
  const service = { sendPromptAsync: vi.fn(async (_sessionId: string, _input: unknown, _directory?: string) => undefined) };
  const plugin = {
    settings,
    getSessionDraft: vi.fn((key: string) => composerState[key]?.text ?? ""),
    getSessionAttachedFiles: vi.fn((key: string) => composerState[key]?.attachments ?? []),
    rememberSessionDraft: vi.fn(async (key: string, value: string) => {
      const state = composerState[key] ?? {};
      if (value.trim()) state.text = value;
      else delete state.text;
      composerState[key] = state;
    }),
    rememberSessionAttachedFiles: vi.fn(async (key: string, files: ComposerAttachment[]) => {
      const state = composerState[key] ?? {};
      if (files.length > 0) state.attachments = [...files];
      else delete state.attachments;
      composerState[key] = state;
    }),
    clearSessionComposer: vi.fn(async (key: string) => { delete composerState[key]; }),
    requireOpenCodeService: vi.fn(() => service),
  } as unknown as OpenCodePlugin;
  const contentEl = document.body.createDiv();
  const deps: ComposerDeps = {
    plugin,
    contentEl,
    model,
    register: { registerDomEvent: vi.fn() },
    onSlashUpdate: vi.fn(),
    onSlashKeydown: vi.fn(() => false),
    onBeforeRemount: vi.fn(),
    renderAgentLabel: (container) => container.createSpan({ text: "Plan", cls: "opencode-session-view__agent-label" }),
    renderModelPill: (container) => container.createSpan({ text: "GLM 5.2", cls: "opencode-session-view__model-pill" }),
    renderThinkingPill: (container) => container.createSpan({ text: "High", cls: "opencode-session-view__thinking-pill" }),
    isComposerBlocked: vi.fn(() => false),
    shouldAutoApprove: vi.fn(() => true),
    isAutoApproveInherited: vi.fn(() => false),
    enableFollowLatest: vi.fn(),
    disableFollowLatest: vi.fn(),
    scrollToBottom: vi.fn(),
    isSessionMuted: vi.fn(() => false),
    getMuteToggleTitle: vi.fn(() => "Mute notifications for this session"),
    onToggleMute: vi.fn(),
    onToggleAutoApprove: vi.fn(),
    requestDraftPromotion: vi.fn(),
    executeBuiltinCommand: vi.fn(),
  };
  const controller = new ComposerController(deps);
  controller.mount(contentEl, {}, false);
  return { contentEl, controller, deps, model, service, settings, composerState };
}

describe("ComposerController input stability", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes interrupt mode from the composer action", () => {
    const { contentEl } = setup({ busy: true });
    const actions = [...contentEl.querySelectorAll<HTMLButtonElement>(".opencode-session-view__composer-send")];

    expect(actions).toHaveLength(1);
    expect(actions.every((button) => button.classList.contains("is-stop"))).toBe(true);
    expect(actions.every((button) => button.getAttribute("aria-label") === "Interrupt session")).toBe(true);
  });

  it("keeps the send action synchronized with the draft", () => {
    const { contentEl } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "queued prompt";
    textarea.dispatchEvent(new Event("input"));

    const actions = [...contentEl.querySelectorAll<HTMLButtonElement>(".opencode-session-view__composer-send")];
    expect(actions.every((button) => !button.disabled)).toBe(true);
  });

  it("leaves arrow keys to native textarea navigation", () => {
    const { contentEl } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "first line\nsecond line";
    textarea.setSelectionRange(0, 0);

    const arrowUp = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    const arrowDown = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    textarea.dispatchEvent(arrowUp);
    textarea.dispatchEvent(arrowDown);

    expect(arrowUp.defaultPrevented).toBe(false);
    expect(arrowDown.defaultPrevented).toBe(false);
    expect(textarea.value).toBe("first line\nsecond line");
  });

  it("renders checkpoint marker labels for hover-pill reveal", () => {
    const { contentEl } = setup();
    const labels = [...contentEl.querySelectorAll<HTMLElement>(".opencode-session-view__composer-progress-marker-label")];
    // Five marker slots exist (max four thresholds + the limit); three are positioned/visible by default.
    expect(labels).toHaveLength(5);
    expect(labels.every((label) => !label.hidden)).toBe(true);
    expect(contentEl.querySelectorAll(".opencode-session-view__composer-progress-marker")).toHaveLength(5);
  });

  it("keeps the focused textarea mounted across chunked external input while busy", () => {
    const { contentEl } = setup({ busy: true });
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();

    textarea.value = "first transcription chunk ";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste" }));
    textarea.value += "and the rest";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));

    expect(contentEl.querySelector("textarea")).toBe(textarea);
    expect(textarea.isConnected).toBe(true);
    expect(textarea.value).toBe("first transcription chunk and the rest");
    expect(document.activeElement).toBe(textarea);
    const actions = [...contentEl.querySelectorAll<HTMLButtonElement>(".opencode-session-view__composer-send")];
    expect(actions.every((button) => !button.classList.contains("is-stop"))).toBe(true);
  });

  it("pastes an image as a v1 file part and sends it with the prompt", async () => {
    const { contentEl, service, composerState } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    const image = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        files: [image],
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      },
    });

    textarea.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(composerState["session-1"]?.attachments).toHaveLength(1));
    const preview = contentEl.querySelector<HTMLButtonElement>(".opencode-session-view__composer-attachment-preview")!;
    expect(preview.textContent).toContain("screenshot.png");
    expect(preview.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    const openModal = vi.spyOn(Modal.prototype, "open");
    preview.click();
    expect(openModal).toHaveBeenCalledOnce();

    const refreshedTextarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    refreshedTextarea.value = "Describe this image";
    refreshedTextarea.dispatchEvent(new Event("input"));
    contentEl.querySelector<HTMLButtonElement>(".opencode-session-view__composer-send")!.click();

    await vi.waitFor(() => expect(service.sendPromptAsync).toHaveBeenCalledOnce());
    expect(service.sendPromptAsync.mock.calls[0]?.[1]).toMatchObject({
      parts: [
        { type: "text", text: "Describe this image" },
        { type: "file", filename: "screenshot.png", mime: "image/png", url: expect.stringMatching(/^data:image\/png;base64,/) },
      ],
    });
    await vi.waitFor(() => expect(composerState["session-1"]).toBeUndefined());
  });

  it("leaves plain-text paste to the native textarea", () => {
    const { contentEl } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], getData: () => "plain text", items: [] },
    });

    textarea.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
  });

  it("uses Electron's native image for image-only clipboard content", async () => {
    const { contentEl, composerState } = setup();
    vi.stubGlobal("require", vi.fn(() => ({
      clipboard: {
        readImage: () => ({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AQID" }),
      },
    })));
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], getData: () => "", items: [] },
    });

    textarea.dispatchEvent(paste);

    await vi.waitFor(() => expect(composerState["session-1"]?.attachments).toHaveLength(1));
    expect(composerState["session-1"]?.attachments?.[0]).toMatchObject({ mime: "image/png", url: "data:image/png;base64,AQID" });
  });

  it("focuses the textarea after the Session Island reopens Prompt", async () => {
    const { contentEl, controller } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;

    controller.onPromptActivated();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.activeElement).toBe(textarea);
  });

  it("updates busy and idle controls without replacing textarea state", () => {
    const { contentEl, controller, model } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "draft";
    textarea.focus();
    textarea.setSelectionRange(1, 4, "backward");

    model.sessionBusy = true;
    controller.onSessionStatusChanged();
    model.sessionBusy = false;
    controller.onSessionStatusChanged();

    expect(contentEl.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("draft");
    expect(textarea.selectionStart).toBe(1);
    expect(textarea.selectionEnd).toBe(4);
    expect(textarea.selectionDirection).toBe("backward");
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps the textarea stable throughout composition input", () => {
    const { contentEl, controller, model } = setup({ busy: true });
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "composed transcript";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", isComposing: true }));
    model.sessionBusy = false;
    controller.onSessionStatusChanged();
    textarea.dispatchEvent(new CompositionEvent("compositionend"));

    expect(contentEl.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("composed transcript");
    expect(document.activeElement).toBe(textarea);
  });

  it("restores selection direction and textarea scroll after an unavoidable remount", async () => {
    const { contentEl, controller } = setup();
    const textarea = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "first line\nsecond line\nthird line";
    textarea.setSelectionRange(3, 18, "backward");
    textarea.scrollTop = 24;
    textarea.focus();
    await controller.refresh();
    const restored = contentEl.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(restored.value).toBe(textarea.value);
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(18);
    expect(restored.selectionDirection).toBe("backward");
    expect(restored.scrollTop).toBe(24);
    expect(document.activeElement).toBe(restored);
  });
});
