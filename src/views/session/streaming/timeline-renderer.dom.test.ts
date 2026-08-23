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
function bundle(id: string, role: string, created: number, parts: JsonObject[], extraInfo: JsonObject = {}): OpenCodeMessageBundle {
  return { info: { id, role, time: { created }, ...extraInfo }, parts };
}

/** Records nodes transiently removed beneath a container during DOM reconciliation. */
function recordRemovedNodes(container: Node): { removedNodes: Node[]; finish: () => void } {
  const removedNodes: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) removedNodes.push(...Array.from(record.removedNodes));
  });
  observer.observe(container, { childList: true, subtree: true });
  return {
    removedNodes,
    finish: () => {
      for (const record of observer.takeRecords()) removedNodes.push(...Array.from(record.removedNodes));
      observer.disconnect();
    },
  };
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
      getWorkingAnimation: vi.fn(() => "bounce" as const),
      getGroupContextTools: vi.fn(() => true),
      getCustomToolDisplays: vi.fn(() => []),
      getBindingVersion: () => bindingVersion,
      isCurrentBinding: (sessionId: string, version: number) => model.sessionId === sessionId && bindingVersion === version,
      getRevertMessageId: () => revertMessageId,
      requestShellRender: vi.fn(async () => undefined),
      cancelStreamingMarkdownPatch: vi.fn(),
      captureFollowLatest: vi.fn(() => undefined as { generation: number; scrollTop: number; explicit: boolean } | undefined),
      restoreFollowLatest: vi.fn(() => false),
      updateJumpButton: vi.fn(),
      onFork: vi.fn(),
      onRewind: vi.fn(),
      onRedo: vi.fn(),
      onOpenSession: vi.fn(),
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

  it("renders a static compaction divider followed by the summary assistant turn", async () => {
    const { contentEl, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const messages = [
      bundle("c1", "user", 1, [{ type: "compaction", auto: false }]),
      bundle("a1", "assistant", 2, [{ type: "text", text: "Retained session context" }], {
        parentID: "c1",
        mode: "compaction",
        summary: true,
      }),
    ];

    const visibleCount = await renderer.renderInto(timeline, messages);
    const divider = timeline.querySelector<HTMLElement>(".opencode-session-view__compaction")!;

    expect(visibleCount).toBe(2);
    expect(divider.tagName).toBe("DIV");
    expect(divider.querySelector(".opencode-session-view__compaction-label")?.textContent).toBe("Session compacted");
    expect(divider.querySelector(".opencode-session-view__compaction-body")).toBeNull();
    expect(timeline.querySelector('[data-message-id="a1"] .opencode-session-view__assistant-markdown')?.textContent).toBe("Retained session context");
    expect(timeline.querySelector('[data-message-id="a1"] .opencode-session-view__message-meta--assistant')).not.toBeNull();
  });

  it("renders live assistant metadata immediately before the first assistant message", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const user = bundle("u1", "user", 2_000, [{ type: "text", text: "question" }], { agent: "build", model: { modelID: "test-model" }, time: {} });
    model.loadedMessages = [user];
    model.sessionBusy = true;
    model.activeTurnStartedAt = 2_000;
    vi.spyOn(Date, "now").mockReturnValue(5_000);

    await renderer.renderInto(timeline, model.loadedMessages);

    const meta = timeline.querySelector<HTMLElement>(".opencode-session-view__message-meta--working");
    const actions = Array.from(meta?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(meta?.textContent).toContain("Build · test-model · 3.0s");
    expect(meta?.getAttribute("aria-busy")).toBe("true");
    expect(meta?.querySelector(".opencode-status-badge--working")?.getAttribute("aria-hidden")).toBe("true");
    expect(actions).toHaveLength(0);

    renderer.refreshActiveTurnDuration(7_500);
    expect(meta?.textContent).toContain("5.5s");
  });

  it("keeps live metadata on the current assistant and enables actions after idle", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const messages = [
      bundle("u1", "user", 1_000, [{ type: "text", text: "question" }]),
      bundle("a1", "assistant", 2_000, [{ type: "tool", tool: "read", state: { status: "completed" } }], { parentID: "u1", time: { created: 2_000, completed: 4_000 } }),
      bundle("a2", "assistant", 5_000, [{ type: "text", text: "answer" }], { parentID: "u1", time: { created: 5_000, completed: 9_000 } }),
    ];
    model.loadedMessages = messages;
    model.sessionBusy = true;
    model.activeTurnStartedAt = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(11_000);

    await renderer.renderInto(timeline, messages);

    const workingMeta = timeline.querySelector<HTMLElement>('[data-message-id="a2"] .opencode-session-view__message-meta--working');
    const workingActions = Array.from(workingMeta?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(workingMeta?.textContent).toContain("10s");
    expect(timeline.querySelector(".opencode-session-view__assistant-meta-placeholder")).toBeNull();
    expect(workingActions).toHaveLength(0);

    model.sessionBusy = false;
    model.activeTurnCompletedAt = 10_000;
    await renderer.renderStreaming();

    const settledMeta = contentEl.querySelector<HTMLElement>('[data-message-id="a2"] .opencode-session-view__message-meta--assistant');
    const settledActions = Array.from(settledMeta?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(settledMeta?.textContent).toContain("9.0s");
    expect(settledMeta?.classList.contains("opencode-session-view__message-meta--working")).toBe(false);
    expect(settledActions).toHaveLength(2);
    expect(settledActions.every((action) => !action.disabled)).toBe(true);
  });

  it("preserves the working indicator while streamed assistant content changes", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const assistant = bundle("a1", "assistant", 2_000, [{ id: "p1", messageID: "a1", type: "text", text: "first" }]);
    model.loadedMessages = [assistant];
    model.sessionBusy = true;
    model.activeTurnStartedAt = 1_000;
    await renderer.renderInto(timeline, model.loadedMessages);
    const row = timeline.querySelector<HTMLElement>('[data-message-id="a1"]')!;
    const meta = row.querySelector<HTMLElement>(".opencode-session-view__message-meta--working")!;
    const indicator = row.querySelector<HTMLElement>(".opencode-status-badge--working")!;
    const removals = recordRemovedNodes(row);

    assistant.parts[0].text = "second";
    await renderer.renderStreaming();
    removals.finish();

    expect(timeline.querySelector('[data-message-id="a1"]')).toBe(row);
    expect(row.querySelector(".opencode-session-view__message-meta--working")).toBe(meta);
    expect(row.querySelector(".opencode-status-badge--working")).toBe(indicator);
    expect(removals.removedNodes).not.toContain(meta);
    expect(removals.removedNodes).not.toContain(indicator);
    expect(row.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("second");
  });

  it("preserves expanded disclosures and unchanged tool blocks across streamed updates", async () => {
    const { contentEl, model, deps, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const assistant = bundle("a1", "assistant", 2_000, [
      { id: "r1", messageID: "a1", type: "reasoning", text: "thinking", time: {} },
      { id: "t1", messageID: "a1", type: "tool", tool: "read", state: { status: "running", input: { filePath: "a.ts" } } },
    ]);
    model.loadedMessages = [assistant];
    model.sessionBusy = true;
    await renderer.renderInto(timeline, model.loadedMessages);
    const reasoning = timeline.querySelector<HTMLDetailsElement>(".opencode-session-view__reasoning")!;
    const reasoningSummary = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-summary")!;
    const reasoningIcon = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-icon")!;
    const reasoningBody = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-body")!;
    const tool = timeline.querySelector<HTMLDetailsElement>(".opencode-session-view__tool")!;
    const row = timeline.querySelector<HTMLElement>('[data-message-id="a1"]')!;
    reasoning.open = true;
    reasoning.dispatchEvent(new Event("toggle"));
    tool.open = true;
    tool.dispatchEvent(new Event("toggle"));
    const removals = recordRemovedNodes(row);

    assistant.parts[0].text = "still thinking";
    await renderer.renderStreaming();
    removals.finish();

    expect(timeline.querySelector(".opencode-session-view__reasoning")).toBe(reasoning);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-summary")).toBe(reasoningSummary);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-icon")).toBe(reasoningIcon);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-body")).toBe(reasoningBody);
    expect(reasoning.open).toBe(true);
    expect(removals.removedNodes).not.toContain(reasoning);
    expect(deps.cancelStreamingMarkdownPatch).toHaveBeenCalledWith("a1:r1:text");
    expect(timeline.querySelector<HTMLDetailsElement>(".opencode-session-view__tool")).toBe(tool);
    expect(removals.removedNodes).not.toContain(tool);
    expect(tool.open).toBe(true);
  });

  it("completes reasoning without remounting its disclosure, icon, or body", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const assistant = bundle("a1", "assistant", 2_000, [
      { id: "r1", messageID: "a1", type: "reasoning", text: "thinking", time: {} },
    ]);
    model.loadedMessages = [assistant];
    model.sessionBusy = true;
    await renderer.renderInto(timeline, model.loadedMessages);
    const reasoning = timeline.querySelector<HTMLDetailsElement>(".opencode-session-view__reasoning")!;
    const summary = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-summary")!;
    const icon = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-icon")!;
    const body = reasoning.querySelector<HTMLElement>(".opencode-session-view__reasoning-body")!;

    assistant.parts[0].time = { end: 3_000 };
    await renderer.renderStreaming();

    expect(timeline.querySelector(".opencode-session-view__reasoning")).toBe(reasoning);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-summary")).toBe(summary);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-icon")).toBe(icon);
    expect(reasoning.querySelector(".opencode-session-view__reasoning-body")).toBe(body);
    expect(reasoning.classList).toContain("opencode-session-view__reasoning--complete");
    expect(summary.textContent).toContain("Thought");
  });

  it("completes a tool without remounting its disclosure or animated icon", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const assistant = bundle("a1", "assistant", 2_000, [
      { id: "t1", messageID: "a1", type: "tool", tool: "bash", state: { status: "running", input: { command: "pwd" } } },
    ]);
    model.loadedMessages = [assistant];
    model.sessionBusy = true;
    await renderer.renderInto(timeline, model.loadedMessages);
    const tool = timeline.querySelector<HTMLDetailsElement>(".opencode-session-view__tool")!;
    const summary = tool.querySelector<HTMLElement>(".opencode-session-view__tool-summary")!;
    const icon = tool.querySelector<HTMLElement>(".opencode-session-view__tool-icon")!;
    tool.open = true;
    tool.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(tool.querySelector(".opencode-session-view__raw-toggle")).not.toBeNull());
    tool.querySelector<HTMLButtonElement>(".opencode-session-view__raw-toggle")!.click();
    await vi.waitFor(() => expect(tool.dataset.toolRaw).toBe("true"));

    assistant.parts[0].state = { status: "completed", input: { command: "pwd" }, output: "/workspace" };
    await renderer.renderStreaming();

    expect(timeline.querySelector(".opencode-session-view__tool")).toBe(tool);
    expect(tool.querySelector(".opencode-session-view__tool-summary")).toBe(summary);
    expect(tool.querySelector(".opencode-session-view__tool-icon")).toBe(icon);
    expect(tool.classList).toContain("opencode-session-view__tool--completed");
    expect(tool.open).toBe(true);
    await vi.waitFor(() => expect(tool.querySelector(".opencode-session-view__raw-toggle")?.textContent).toBe("Show formatted"));
    expect(tool.querySelector(".opencode-session-view__tool-body-content")?.textContent).toContain("/workspace");
  });

  it("reconciles a streaming timeline in place and preserves follow-latest behavior", async () => {
    const { contentEl, model, deps, renderer } = setup();
    const current = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    current.textContent = "old";
    model.loadedMessages = [bundle("a1", "assistant", 1, [{ type: "text", text: "new" }])];
    const followAnchor = { generation: 4, scrollTop: 0, explicit: true };
    deps.captureFollowLatest.mockReturnValue(followAnchor);

    await renderer.renderStreaming();

    expect(current.isConnected).toBe(true);
    expect(contentEl.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("new");
    expect(deps.restoreFollowLatest).toHaveBeenCalledWith(followAnchor);
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

  it("retries instead of committing a row snapshot made stale by a concurrent delta", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    const assistant = bundle("a1", "assistant", 1, [{ id: "p1", messageID: "a1", type: "text", text: "first" }]);
    model.loadedMessages = [assistant];
    await renderer.renderInto(timeline, model.loadedMessages);
    assistant.parts[0].text = "snapshot";
    let releaseSnapshot: (() => void) | undefined;
    vi.mocked(MarkdownRenderer.renderMarkdown).mockImplementation(async (markdown, container) => {
      if (markdown === "snapshot") await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      container.textContent = markdown;
    });

    const rendering = renderer.renderStreaming();
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));
    assistant.parts[0].text = "latest";
    releaseSnapshot?.();
    await rendering;

    expect(timeline.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("latest");
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
    const followAnchor = { generation: 3, scrollTop: 0, explicit: true };
    deps.captureFollowLatest.mockReturnValue(followAnchor);

    await renderer.reconcileAppendOnly(messages);

    expect(contentEl.querySelector(".opencode-session-view__timeline")).toBe(timeline);
    expect(timeline.querySelectorAll("[data-message-id]")).toHaveLength(2);
    expect(timeline.querySelector('[data-message-id="a1"] .opencode-session-view__message-meta--assistant')).not.toBeNull();
    expect(deps.restoreFollowLatest).toHaveBeenCalledWith(followAnchor);
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

  it("updates canonical content without replacing its message row", async () => {
    const { contentEl, model, renderer } = setup();
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    timeline.createDiv({ cls: "opencode-session-view__history-boundary" });
    const stale = bundle("a1", "assistant", 1, [{ type: "text", text: "stale" }]);
    const row = timeline.createDiv({ cls: "opencode-session-view__message-row", attr: { "data-message-id": "a1" } });
    row.dataset.messageSignature = messageRenderSignature(stale);
    const canonical = bundle("a1", "assistant", 1, [{ type: "text", text: "canonical" }]);
    model.loadedMessages = [canonical];

    await renderer.reconcileAppendOnly([canonical]);

    expect(timeline.isConnected).toBe(true);
    expect(contentEl.querySelector('[data-message-id="a1"]')).toBe(row);
    expect(contentEl.querySelector(".opencode-session-view__assistant-markdown")?.textContent).toBe("canonical");
  });

  it("inserts missing canonical rows without replacing the timeline", async () => {
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

    expect(timeline.isConnected).toBe(true);
    expect(Array.from(contentEl.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId)).toEqual(["u1", "u2"]);
  });

  it("removes stale canonical rows without replacing the timeline", async () => {
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

    expect(timeline.isConnected).toBe(true);
    expect(Array.from(contentEl.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => row.dataset.messageId)).toEqual(["u1"]);
  });

  it("updates same-id rewind boundaries without replacing the timeline", async () => {
    const { contentEl, model, renderer, setRevert } = setup();
    const message = bundle("u1", "user", 1, [{ type: "text", text: "question" }]);
    model.loadedMessages = [message];
    model.revertDiffFiles = [{ file: "old.ts", additions: 1, deletions: 0 }];
    setRevert("u2");
    const timeline = contentEl.createDiv({ cls: "opencode-session-view__timeline" });
    await renderer.renderInto(timeline, [message]);

    model.revertDiffFiles = [{ file: "new.ts", additions: 2, deletions: 1 }];
    await renderer.reconcileAppendOnly([message]);

    expect(timeline.isConnected).toBe(true);
    expect(contentEl.querySelector(".opencode-session-view__rewind-file-path")?.textContent).toBe("new.ts");
  });

  it("requests a shell render when no timeline is mounted", async () => {
    const { deps, renderer } = setup();
    await renderer.renderStreaming();
    expect(deps.requestShellRender).toHaveBeenCalledOnce();
  });
});
