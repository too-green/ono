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

  /** Drains the microtask queue so a queued animation frame's async flush fully settles. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  /** Streams cumulative Markdown deltas through the patcher, settling every flush. */
  async function streamDeltas(patcher: MarkdownPatcher, target: HTMLElement, deltas: string[], key = "part"): Promise<void> {
    for (const markdown of deltas) {
      patcher.queue(key, target, markdown);
      runNextFrame();
      await settle();
    }
  }

  /** Builds N cumulative deltas covering the full text. */
  function cumulativeDeltas(full: string, steps: number): string[] {
    const deltas: string[] = [];
    for (let i = 1; i <= steps; i++) deltas.push(full.slice(0, Math.ceil((i / steps) * full.length)));
    return deltas;
  }

  /** Installs a block-aware mock renderer emitting one paragraph per blank-line-separated part. */
  function installBlockRenderer(created: Array<{ source: string; node: HTMLElement }> = []) {
    return vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown: string, container: HTMLElement) => {
      for (const part of markdown.split(/\n[ \t\r]*\n/)) {
        if (!part.trim()) continue;
        const paragraph = document.createElement("p");
        paragraph.textContent = part;
        container.appendChild(paragraph);
        created.push({ source: markdown, node: paragraph });
      }
    });
  }

  it("renders committed blocks once and only re-renders the tail per flush", async () => {
    const { patcher, target } = setup();
    const created: Array<{ source: string; node: HTMLElement }> = [];
    const render = installBlockRenderer(created);
    const full = "alpha one\n\nbeta two\n\ngamma three";

    await streamDeltas(patcher, target, cumulativeDeltas(full, 30));

    expect(render).toHaveBeenCalledTimes(32);
    const sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources).not.toContain(full);
    const tailOnlyArgs = sources.slice(-11);
    for (const source of tailOnlyArgs) expect("gamma three".startsWith(source) || source === "beta two").toBe(true);

    expect(target.children).toHaveLength(3);
    expect(target.children[0].textContent).toBe("alpha one");
    expect(target.children[1].textContent).toBe("beta two");
    expect(target.children[2].textContent).toBe("gamma three");
    for (const wrapperParagraph of [target.children[0].children[0], target.children[1].children[0]]) {
      expect(created.filter((entry) => entry.node === wrapperParagraph)).toHaveLength(1);
    }

    patcher.queue("part", target, full);
    runNextFrame();
    await settle();
    expect(render).toHaveBeenCalledTimes(32);
  });

  it("keeps an unterminated fence in the tail and commits it once it closes", async () => {
    const { patcher, target } = setup();
    const created: Array<{ source: string; node: HTMLElement }> = [];
    const render = installBlockRenderer(created);
    const full = "code incoming\n\n```js\nconst a = 1;\n```\n\ndone";
    const deltas = cumulativeDeltas(full, 24);

    await streamDeltas(patcher, target, deltas.slice(0, 16));
    let sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources.some((source) => source.startsWith("```js") && source.endsWith("```"))).toBe(false);
    const committedParagraph = target.children[0].children[0];
    expect(target.children[0].textContent).toBe("code incoming");
    expect(created.filter((entry) => entry.node === committedParagraph)).toHaveLength(1);

    await streamDeltas(patcher, target, deltas.slice(16));
    sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources.filter((source) => source === "```js\nconst a = 1;\n```")).toHaveLength(1);
    expect(target.children).toHaveLength(3);
    expect(target.children[2].textContent).toBe("done");
    expect(created.filter((entry) => entry.node === target.children[1].children[0])).toHaveLength(1);
  });

  it("never splits loose lists or blockquotes mid-construct", async () => {
    const { patcher, target } = setup();
    const render = installBlockRenderer();
    const list = "- one\n\n- two\n\n- three";

    await streamDeltas(patcher, target, cumulativeDeltas(list, 12));
    let sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources).not.toContain("- two");
    expect(sources).not.toContain("- three");
    expect(target.textContent).toBe(list.replace(/\n\n/g, ""));

    render.mockClear();
    const quotes = "> q one\n\n> q two\n\nafter";

    await streamDeltas(patcher, target, cumulativeDeltas(quotes, 12), "quoted");
    sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources).not.toContain("> q one");
    expect(sources).not.toContain("> q two");
  });

  it("falls back to a full rebuild when the committed prefix changes canonically", async () => {
    const { patcher, target } = setup();
    const render = installBlockRenderer();

    await streamDeltas(patcher, target, ["one", "one\n\ntwo"]);

    expect(target.children).toHaveLength(2);
    const staleWrapper = target.children[0];

    patcher.queue("part", target, "CHANGED\n\ntwo");
    runNextFrame();
    await settle();

    const sources = render.mock.calls.map((call) => call[0] as string);
    expect(sources.filter((source) => source === "CHANGED")).toHaveLength(1);
    expect(sources.filter((source) => source === "two")).toHaveLength(2);
    expect(target.children).toHaveLength(2);
    expect(target.children[0]).not.toBe(staleWrapper);
    expect(target.textContent).toContain("CHANGED");
    expect(target.textContent).toContain("two");
  });

  it("preserves committed wrapper nodes across later flushes and swaps only tail children", async () => {
    const { patcher, target } = setup();
    installBlockRenderer();

    await streamDeltas(patcher, target, ["one\n\ntail", "one\n\ntail longer"]);

    expect(target.children).toHaveLength(2);
    const wrapper = target.children[0];
    const tailEl = target.children[1];
    const wrapperParagraph = wrapper.children[0];

    await streamDeltas(patcher, target, ["one\n\ntail longer still", "one\n\ntail final"]);

    expect(target.children[0]).toBe(wrapper);
    expect(target.children[1]).toBe(tailEl);
    expect(wrapper.children[0]).toBe(wrapperParagraph);
    expect(tailEl.textContent).toBe("tail final");
  });

  it("keeps mounted scope counts bounded across many flushes", async () => {
    const { patcher, target, component } = setup(false);
    installBlockRenderer();
    const addChild = vi.spyOn(component, "addChild");
    const removeChild = vi.spyOn(component, "removeChild");

    await streamDeltas(patcher, target, cumulativeDeltas("growing tail text", 10));

    expect(addChild).toHaveBeenCalledTimes(10);
    expect(removeChild).toHaveBeenCalledTimes(9);

    target.remove();
    patcher.releaseDetached();
    expect(removeChild).toHaveBeenCalledTimes(10);
  });

  it("matches a one-shot full render once the stream quiesces", async () => {
    const { patcher, target } = setup();
    installBlockRenderer();
    const full = "# Heading\n\nfirst para\n\nsecond para\n\n- item\n\n- second item";

    await streamDeltas(patcher, target, cumulativeDeltas(full, 30));

    const reference = document.createElement("div");
    await MarkdownRenderer.renderMarkdown(full, reference, "ref.md", new Component());
    const renderedBlocks = Array.from(target.querySelectorAll("p")).map((p) => p.textContent);
    const referenceBlocks = Array.from(reference.querySelectorAll("p")).map((p) => p.textContent);
    expect(renderedBlocks).toEqual(referenceBlocks);
    expect(target.textContent).toBe(reference.textContent);
  });
});
