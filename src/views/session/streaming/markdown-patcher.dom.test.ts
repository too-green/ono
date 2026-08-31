import { Component, MarkdownRenderer } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownPatcher } from "./markdown-patcher";

describe("MarkdownPatcher", () => {
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let requestFrame: ReturnType<typeof vi.fn>;
  let cancelFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    frameId = 0;
    frames = new Map();
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    cancelFrame = vi.fn((id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    if (!globalThis.CSS) vi.stubGlobal("CSS", {});
    Object.defineProperty(globalThis.CSS, "escape", { configurable: true, value: (value: string) => value });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Creates a patcher and mounted target with observable scroll callbacks. */
  function setup(followLatest = true) {
    const contentEl = document.createElement("div");
    const target = document.createElement("div");
    contentEl.appendChild(target);
    document.body.appendChild(contentEl);
    const scrollToBottom = vi.fn();
    const followAnchor = followLatest ? { generation: 1 } : undefined;
    const restoreFollowLatest = vi.fn((anchor: typeof followAnchor) => {
      if (anchor) scrollToBottom(false);
      return !!anchor;
    });
    const updateJumpButton = vi.fn();
    const component = new Component();
    const patcher = new MarkdownPatcher({
      contentEl,
      component,
      getSessionId: () => "session-1",
      captureFollowLatest: () => followAnchor,
      restoreFollowLatest,
      updateJumpButton,
    });
    return { contentEl, target, patcher, component, followAnchor, scrollToBottom, restoreFollowLatest, updateJumpButton };
  }

  /** Runs the oldest queued animation frame, matching browser one-shot frame behavior. */
  function runNextFrame(): void {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) throw new Error("Expected a queued animation frame");
    frames.delete(next[0]);
    next[1](performance.now());
  }

  it("finds mounted text and reasoning targets", () => {
    const { contentEl, patcher } = setup();
    contentEl.innerHTML = `
      <div data-message-id="message-1">
        <div class="opencode-session-view__assistant-markdown" data-part-id="text-1" data-stream-field="text"></div>
        <div class="opencode-session-view__reasoning-body" data-part-id="reasoning-1" data-part-ids="reasoning-1 reasoning-2" data-stream-field="text"></div>
      </div>`;

    expect(patcher.findPartTarget("message-1", "text-1", "text")).toBeInstanceOf(HTMLElement);
    expect(patcher.findPartTarget("message-1", "reasoning-1", "reasoning")).toBeInstanceOf(HTMLElement);
    expect(patcher.findPartTarget("message-1", "reasoning-2", "reasoning")).toBeInstanceOf(HTMLElement);
    expect(patcher.findPartTarget("missing", "text-1", "text")).toBeUndefined();
  });

  it("deduplicates queued deltas and renders only the latest Markdown", async () => {
    const { patcher, target, followAnchor, scrollToBottom, restoreFollowLatest, updateJumpButton } = setup();
    const render = vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      container.textContent = markdown;
    });

    patcher.queue("part", target, "first");
    patcher.queue("part", target, "latest");

    expect(requestFrame).toHaveBeenCalledTimes(1);
    runNextFrame();
    await vi.waitFor(() => expect(target.textContent).toBe("latest"));
    expect(render).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith(false);
    expect(restoreFollowLatest).toHaveBeenCalledWith(followAnchor);
    expect(updateJumpButton).toHaveBeenCalledOnce();
  });

  it("follows up with the newest delta when rendering is already in flight", async () => {
    const { patcher, target } = setup(false);
    let releaseFirst: (() => void) | undefined;
    const firstRender = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let renderCount = 0;
    const render = vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      renderCount += 1;
      if (renderCount === 1) await firstRender;
      container.textContent = markdown;
    });

    patcher.queue("part", target, "first");
    runNextFrame();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    patcher.queue("part", target, "latest");
    expect(requestFrame).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await vi.waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(2));
    expect(target.textContent).toBe("");
    runNextFrame();
    await vi.waitFor(() => expect(target.textContent).toBe("latest"));
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("keeps only one mounted render scope when grouped part keys patch the same target", async () => {
    const { patcher, target, component } = setup(false);
    const addChild = vi.spyOn(component, "addChild");
    const removeChild = vi.spyOn(component, "removeChild");
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      container.textContent = markdown;
    });

    patcher.queue("message:part-1:text", target, "first");
    runNextFrame();
    await vi.waitFor(() => expect(target.textContent).toBe("first"));
    const firstScope = addChild.mock.calls[0]?.[0];

    patcher.queue("message:part-2:text", target, "second");
    runNextFrame();
    await vi.waitFor(() => expect(target.textContent).toBe("second"));

    expect(addChild).toHaveBeenCalledTimes(2);
    expect(removeChild).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledWith(firstScope);

    target.remove();
    patcher.releaseDetached();
    expect(removeChild).toHaveBeenCalledTimes(2);
  });

  it("cancels queued and in-flight work on disposal", async () => {
    const { patcher, target } = setup();
    let releaseRender: (() => void) | undefined;
    const blockedRender = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const render = vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (_markdown, container) => {
      await blockedRender;
      container.textContent = "stale";
    });

    patcher.queue("queued", target, "queued");
    patcher.dispose();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(render).not.toHaveBeenCalled();

    patcher.queue("active", target, "active");
    runNextFrame();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    patcher.dispose();
    releaseRender?.();
    await vi.waitFor(() => expect(frames.size).toBe(0));
    expect(target.textContent).toBe("");
  });

  it("cancels a stale part patch before canonical reconciliation commits", async () => {
    const { patcher, target } = setup();
    let releaseRender: (() => void) | undefined;
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementationOnce(async (_markdown, container) => {
      await new Promise<void>((resolve) => { releaseRender = resolve; });
      container.textContent = "stale";
    });
    patcher.queue("message:part:text", target, "stale");
    runNextFrame();
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));

    patcher.cancel("message:part:text");
    target.textContent = "canonical";
    releaseRender?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(target.textContent).toBe("canonical");
  });

  it("cancels a queued part patch before its animation frame", () => {
    const { patcher, target } = setup();
    patcher.queue("message:part:text", target, "stale");

    patcher.cancel("message:part:text");

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(frames.size).toBe(0);
    expect(target.textContent).toBe("");
  });
});
