import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { JsonObject, OpenCodeMessageBundle } from "../../../services/opencode-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionViewModel } from "../session-view-model";
import { messageRenderSignature, TimelineRenderer } from "./timeline-renderer";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement convenience methods used by production renderers. */
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
    setText: { configurable: true, value: function (this: HTMLElement, text: string) { this.textContent = text; } },
    addClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); } },
    setAttr: { configurable: true, value: function (this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

/** Builds a compact bundle for timeline DOM tests. */
function bundle(id: string, role: string, created: number, parts: JsonObject[]): OpenCodeMessageBundle {
  return { info: { id, role, time: { created } }, parts };
}

describe("TimelineRenderer DOM", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    if (!globalThis.CSS) vi.stubGlobal("CSS", {});
    Object.defineProperty(globalThis.CSS, "escape", { configurable: true, value: (value: string) => value });
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      container.textContent = markdown;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Creates a mounted timeline renderer with mutable binding and rewind state. */
  function setup() {
    const contentEl = document.createElement("div");
    document.body.appendChild(contentEl);
    const model = new SessionViewModel();
    model.sessionId = "s1";
    model.currentSession = { id: "s1" };
    model.historyComplete = true;
    let bindingVersion = 1;
    let revertMessageId: string | undefined;
    const deps = {
      app: {} as App,
      component: {} as Component,
      contentEl,
      model,
      getShowReasoningBlocks: vi.fn(() => true),
      getGroupContextTools: vi.fn(() => true),
      getBindingVersion: () => bindingVersion,
      isCurrentBinding: (sessionId: string, version: number) => model.sessionId === sessionId && bindingVersion === version,
      getRevertMessageId: () => revertMessageId,
      requestShellRender: vi.fn(async () => undefined),
      shouldFollowLatest: vi.fn(() => false),
      markProgrammaticScroll: vi.fn(),
      scrollToBottom: vi.fn(),
      updateJumpButton: vi.fn(),
      onFork: vi.fn(),
      onRewind: vi.fn(),
      onRedo: vi.fn(),
    };
    return {
      contentEl,
      model,
      deps,
      renderer: new TimelineRenderer(deps),
      incrementBinding: () => { bindingVersion += 1; },
      setRevert: (messageId: string | undefined) => { revertMessageId = messageId; },
    };
  }

  it("renders sorted messages, history state, and final assistant metadata", async () => {
    const { contentEl, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const messages = [
      bundle("a1", "assistant", 2, [{ type: "text", text: "answer" }]),
      bundle("u1", "user", 1, [{ type: "text", text: "question" }]),
    ];

    const visibleCount = await renderer.renderInto(timeline, messages);

    expect(visibleCount).toBe(2);
    expect(Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId)).toEqual(["u1", "a1"]);
    expect(timeline.querySelector(".opencode-session-view__history-boundary")?.textContent).toBe("Beginning of loaded session");
    expect(timeline.querySelectorAll(".opencode-session-view__message-meta--assistant")).toHaveLength(1);
  });

  it("replaces a streaming timeline and preserves follow-latest scroll behavior", async () => {
    const { contentEl, model, deps, renderer } = setup();
    const current = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    current.textContent = "old";
    model.loadedMessages = [bundle("a1", "assistant", 1, [{ type: "text", text: "new" }])];
    deps.shouldFollowLatest.mockReturnValue(true);

    await renderer.renderStreaming();

    expect(current.isConnected).toBe(false);
    expect(contentEl.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("new");
    expect(deps.markProgrammaticScroll).toHaveBeenCalledWith(1200);
    expect(deps.scrollToBottom).toHaveBeenCalledWith(false);
    expect(deps.updateJumpButton).toHaveBeenCalledOnce();
  });

  it("does not commit a detached render after the session binding changes", async () => {
    const { contentEl, model, renderer, incrementBinding } = setup();
    const current = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    current.textContent = "current";
    model.loadedMessages = [bundle("a1", "assistant", 1, [{ type: "text", text: "stale" }])];
    let releaseRender: (() => void) | undefined;
    vi.mocked(MarkdownRenderer.renderMarkdown).mockImplementationOnce(async (_markdown, container) => {
      await new Promise<void>((resolve) => { releaseRender = resolve; });
      container.textContent = "stale";
    });

    const rendering = renderer.renderStreaming();
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));
    incrementBinding();
    releaseRender?.();
    await rendering;

    expect(current.isConnected).toBe(true);
    expect(current.textContent).toBe("current");
  });

  it("appends canonical messages and promotes metadata on the previous assistant", async () => {
    const { contentEl, deps, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const messages = [
      bundle("a1", "assistant", 1, [{ type: "text", text: "answer" }]),
      bundle("u1", "user", 2, [{ type: "text", text: "next" }]),
    ];
    const previousRow = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": "a1" } });
    previousRow.dataset.messageSignature = messageRenderSignature(messages[0]);
    deps.shouldFollowLatest.mockReturnValue(true);

    await renderer.reconcileAppendOnly(messages);

    expect(contentEl.querySelector(".opencode-session-view__timeline")).toBe(timeline);
    expect(timeline.querySelectorAll("[data-message-id]")).toHaveLength(2);
    expect(timeline.querySelector('[data-message-id="a1"] .opencode-session-view__message-meta--assistant')).not.toBeNull();
    expect(deps.scrollToBottom).toHaveBeenCalledWith(false);
  });

  it("removes previous final-turn metadata when appending another assistant message", async () => {
    const { contentEl, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const messages = [
      bundle("a1", "assistant", 1, [{ type: "text", text: "first" }]),
      bundle("a2", "assistant", 2, [{ type: "text", text: "second" }]),
    ];
    const previousRow = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": "a1" } });
    previousRow.dataset.messageSignature = messageRenderSignature(messages[0]);
    previousRow.createDiv({ cls: "opencode-session-view__message-meta opencode-session-view__message-meta--assistant" });

    await renderer.reconcileAppendOnly(messages);

    expect(timeline.querySelector('[data-message-id="a1"] .opencode-session-view__message-meta--assistant')).toBeNull();
    expect(timeline.querySelectorAll(".opencode-session-view__message-meta--assistant")).toHaveLength(1);
    expect(timeline.querySelector('.opencode-session-view__history-boundary')?.textContent).toBe("Beginning of loaded session");
  });

  it("rebuilds when canonical content changes for an existing message", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const stale = bundle("a1", "assistant", 1, [{ type: "text", text: "stale" }]);
    const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": "a1" } });
    row.dataset.messageSignature = messageRenderSignature(stale);
    const canonical = bundle("a1", "assistant", 1, [{ type: "text", text: "canonical" }]);
    model.loadedMessages = [canonical];

    await renderer.reconcileAppendOnly([canonical]);

    expect(timeline.isConnected).toBe(false);
    expect(contentEl.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("canonical");
  });

  it("rebuilds when mounted rows are not a contiguous canonical prefix", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const messages = [
      bundle("u1", "user", 1, [{ type: "text", text: "first" }]),
      bundle("u2", "user", 2, [{ type: "text", text: "second" }]),
    ];
    const laterRow = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": "u2" } });
    laterRow.dataset.messageSignature = messageRenderSignature(messages[1]);
    model.loadedMessages = messages;

    await renderer.reconcileAppendOnly(messages);

    expect(timeline.isConnected).toBe(false);
    expect(Array.from(contentEl.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId)).toEqual(["u1", "u2"]);
  });

  it("rebuilds when mounted rows outnumber visible canonical messages", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const first = bundle("u1", "user", 1, [{ type: "text", text: "first" }]);
    const removed = bundle("u2", "user", 2, [{ type: "text", text: "removed" }]);
    for (const message of [first, removed]) {
      const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": String(message.info.id) } });
      row.dataset.messageSignature = messageRenderSignature(message);
    }
    model.loadedMessages = [first];

    await renderer.reconcileAppendOnly([first]);

    expect(timeline.isConnected).toBe(false);
    expect(Array.from(contentEl.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId)).toEqual(["u1"]);
  });

  it("rebuilds same-id rewind boundaries when affected files change", async () => {
    const { contentEl, model, renderer, setRevert } = setup();
    const message = bundle("u1", "user", 1, [{ type: "text", text: "question" }]);
    model.loadedMessages = [message];
    model.revertDiffFiles = [{ file: "old.ts", additions: 1, deletions: 0 }];
    setRevert("u2");
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    await renderer.renderInto(timeline, [message]);

    model.revertDiffFiles = [{ file: "new.ts", additions: 2, deletions: 1 }];
    await renderer.reconcileAppendOnly([message]);

    expect(timeline.isConnected).toBe(false);
    expect(contentEl.querySelector(".opencode-session-view__rewind-file-path")?.textContent).toBe("new.ts");
  });

  it("requests a shell render when no timeline is mounted", async () => {
    const { deps, renderer } = setup();
    await renderer.renderStreaming();
    expect(deps.requestShellRender).toHaveBeenCalledOnce();
  });
});
