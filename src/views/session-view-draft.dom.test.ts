import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";
import { SessionViewModel } from "./session/session-view-model";
import { ComposerController, type ComposerDeps } from "./session/composer/composer-controller";
import type OpenCodePlugin from "../../main";
import * as gitInfo from "../utils/git-info";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the draft shell and composer. */
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
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

interface DraftViewHarness {
  model: SessionViewModel;
  contentEl: HTMLElement;
  composer: ComposerController;
  plugin: { requireOpenCodeService: ReturnType<typeof vi.fn> };
  renderDraftSession(): Promise<void>;
}

/** Builds a prototype-backed SessionView around a real ComposerController for draft remount tests. */
function setup(): DraftViewHarness {
  const model = new SessionViewModel();
  model.draftId = "draft-1";
  model.draftDirectory = "/workspace";
  const settings = {
    interruptConfirmSeconds: 3,
  };
  const composerState: Record<string, { text?: string; attachments?: unknown[] }> = {};
  const service = {
    listAgents: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listCommands: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({})),
    getCurrentProject: vi.fn(async () => ({ id: "project-1", worktree: "/workspace", vcs: "git" })),
  };
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
    rememberSessionAttachedFiles: vi.fn(async () => undefined),
    clearSessionComposer: vi.fn(async (key: string) => { delete composerState[key]; }),
    requireOpenCodeService: vi.fn(() => service),
  } as unknown as OpenCodePlugin;
  const contentEl = document.body.createDiv();
  const composerDeps: ComposerDeps = {
    plugin,
    contentEl,
    model,
    register: { registerDomEvent: vi.fn() },
    onSlashUpdate: vi.fn(),
    onSlashKeydown: vi.fn(() => false),
    onBeforeRemount: vi.fn(),
    renderAgentLabel: (container) => container.createSpan({ text: "Build" }),
    renderModelPill: (container) => container.createSpan({ text: "Model" }),
    renderThinkingPill: (container) => container.createSpan({ text: "High" }),
    isComposerBlocked: vi.fn(() => false),
    shouldAutoApprove: vi.fn(() => false),
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
  const view = Object.create(SessionView.prototype) as DraftViewHarness;
  Object.assign(view, {
    model,
    contentEl,
    composer: new ComposerController(composerDeps),
    plugin,
    variants: { resolveAgentForSession: vi.fn(() => "build"), resolveModelForSession: vi.fn(() => undefined) },
    stream: { subscribe: vi.fn() },
    docks: { mount: vi.fn() },
    island: { mount: (parent: HTMLElement) => parent.createDiv() },
    refreshLeafTitle: vi.fn(),
    sessionBindingVersion: 1,
  });
  return view;
}

/** Flushes the focus timers scheduled by composer mounting. */
async function flushMountTimers(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("SessionView draft composer stability", () => {
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

  it("preserves an active caret and selection across a background draft remount", async () => {
    const view = setup();
    await view.renderDraftSession();
    await flushMountTimers();
    const textarea = view.contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "fix the caret bug";
    textarea.focus();
    textarea.setSelectionRange(4, 9, "backward");

    await view.renderDraftSession();

    const remounted = view.contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(remounted).not.toBe(textarea);
    expect(remounted.value).toBe("fix the caret bug");
    expect(remounted.selectionStart).toBe(4);
    expect(remounted.selectionEnd).toBe(9);
    expect(remounted.selectionDirection).toBe("backward");
    expect(document.activeElement).toBe(remounted);
  });

  it("shows the target directory and GitHub context before the session starts", async () => {
    vi.spyOn(gitInfo, "readGitInfo").mockReturnValue({
      branch: "feature/new-session-context",
      githubRepository: "owner/obsidian-opencode-plugin",
    });
    const view = setup();

    await view.renderDraftSession();

    const rows = new Map(Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-session-view__draft-context-row"), (row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]));
    expect(rows).toEqual(new Map([
      ["Directory", "/workspace"],
      ["Repository", "owner/obsidian-opencode-plugin"],
      ["Branch", "feature/new-session-context"],
    ]));
    expect(view.contentEl.querySelector(".opencode-session-view__draft-context-value.is-path")?.getAttribute("title")).toBe("/workspace");
  });

  it("focuses the draft composer only on the first mount", async () => {
    const view = setup();
    await view.renderDraftSession();
    await flushMountTimers();
    expect(document.activeElement).toBe(view.contentEl.querySelector("textarea"));

    view.contentEl.querySelector<HTMLTextAreaElement>("textarea")!.blur();
    await view.renderDraftSession();
    await flushMountTimers();

    expect(document.activeElement).not.toBe(view.contentEl.querySelector("textarea"));
  });

  it("preserves an unsent in-memory agent and model across background remounts", async () => {
    const view = setup();
    view.model.selectedAgent = "plan";
    view.model.selectedModel = { providerID: "openai", modelID: "gpt", variant: "high" };
    view.model.composerSelectionDirty = true;

    await view.renderDraftSession();

    expect(view.model.selectedAgent).toBe("plan");
    expect(view.model.selectedModel).toEqual({ providerID: "openai", modelID: "gpt", variant: "high" });
    expect(view.model.composerSelectionDirty).toBe(true);
  });
});
