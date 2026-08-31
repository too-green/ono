import type OpenCodePlugin from "../../../main";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DomEventRegistrar } from "./dom-registrar";
import { ScrollController } from "./scroll-controller";
import { SessionViewModel } from "./session-view-model";

describe("ScrollController", () => {
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    frameId = 0;
    frames = new Map();
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Creates a mounted scroll controller with deterministic viewport geometry. */
  function setup() {
    const relocationRootEl = document.createElement("div");
    const relocationContainerEl = document.createElement("div");
    const contentEl = document.createElement("div");
    relocationContainerEl.appendChild(contentEl);
    relocationRootEl.appendChild(relocationContainerEl);
    document.body.appendChild(relocationRootEl);
    let scrollHeight = 1_000;
    let clientHeight = 200;
    Object.defineProperties(contentEl, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });
    contentEl.scrollTop = 800;
    const model = new SessionViewModel();
    model.sessionId = "s1";
    const plugin = {
      settings: { sessionScroll: {}, sessionUnread: {} },
      rememberSessionScroll: vi.fn(async () => undefined),
    } as unknown as OpenCodePlugin;
    let tabGroupRelocated = false;
    const onNearTop = vi.fn();
    const register = {
      registerDomEvent: (target: Window | Document | HTMLElement, type: string, callback: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
        target.addEventListener(type, callback, options);
      },
    } as unknown as DomEventRegistrar;
    const controller = new ScrollController({
      plugin,
      contentEl,
      model,
      register,
      relocationRootEl,
      relocationContainerEl,
      isActive: () => true,
      consumeTabGroupRelocation: () => {
        const relocated = tabGroupRelocated;
        tabGroupRelocated = false;
        return relocated;
      },
      onNearTop,
      onUnreadChange: vi.fn(),
    });
    controller.bindScrollListener();
    controller.observeTabGroupRelocations();
    return {
      contentEl,
      controller,
      model,
      onNearTop,
      plugin,
      relocationContainerEl,
      relocationRootEl,
      triggerTabGroupRelocation: () => {
        tabGroupRelocated = true;
      },
      setGeometry: (height: number, viewport: number) => {
        scrollHeight = height;
        clientHeight = viewport;
      },
      runNextFrame: () => {
        const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (!next) throw new Error("Expected a queued animation frame");
        frames.delete(next[0]);
        next[1](performance.now());
      },
    };
  }

  it("cancels active follow immediately when the user wheels upward", () => {
    const { contentEl, controller, model } = setup();
    controller.enableFollowLatest();
    expect(model.followLatest).toBe(true);
    expect(frames.size).toBe(1);

    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));

    expect(model.followLatest).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("lets scrollbar movement away from latest override programmatic suppression", () => {
    const { contentEl, controller, model } = setup();
    controller.enableFollowLatest();
    controller.markProgrammaticScroll(2_000);
    contentEl.scrollTop = 300;

    contentEl.dispatchEvent(new Event("scroll"));

    expect(model.followLatest).toBe(false);
  });

  it("releases follow after a small upward scrollbar movement inside the near-bottom zone", () => {
    const { contentEl, controller, model } = setup();
    controller.enableFollowLatest();
    contentEl.scrollTop = 780;

    contentEl.dispatchEvent(new Event("scroll"));

    expect(model.followLatest).toBe(false);
  });

  it("rejects a stale asynchronous bottom anchor after user interaction", () => {
    const { contentEl, controller } = setup();
    const generation = controller.captureFollowLatest();
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
    contentEl.scrollTop = 300;

    controller.restoreFollowLatest(generation);

    expect(contentEl.scrollTop).toBe(300);
  });

  it("does not infer follow intent from an unchanged near-bottom position", () => {
    const { contentEl, controller, setGeometry } = setup();
    const anchor = controller.captureFollowLatest();
    setGeometry(1_400, 200);

    controller.restoreFollowLatest(anchor);

    expect(anchor).toBeUndefined();
    expect(contentEl.scrollTop).toBe(800);
  });

  it("keeps a small upward scroll released during later renders", () => {
    const { contentEl, controller, model, setGeometry } = setup();
    controller.enableFollowLatest();
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
    contentEl.scrollTop = 760;

    const anchor = controller.captureFollowLatest();
    setGeometry(1_100, 200);
    controller.restoreFollowLatest(anchor);

    expect(model.followLatest).toBe(false);
    expect(anchor).toBeUndefined();
    expect(contentEl.scrollTop).toBe(760);
  });

  it("explicitly resumes follow when jumping to latest", () => {
    const { contentEl, controller, model } = setup();
    contentEl.scrollTop = 300;
    Object.defineProperty(contentEl, "createEl", {
      configurable: true,
      value: (tagName: string, options?: { attr?: Record<string, string>; cls?: string }) => {
        const element = document.createElement(tagName);
        if (options?.cls) element.className = options.cls;
        for (const [name, value] of Object.entries(options?.attr ?? {})) element.setAttribute(name, value);
        Object.defineProperty(element, "toggleClass", { value: (name: string, force: boolean) => element.classList.toggle(name, force) });
        contentEl.appendChild(element);
        return element;
      },
    });
    controller.renderJumpToBottomButton();

    contentEl.querySelector<HTMLButtonElement>(".opencode-session-view__jump-bottom")?.click();

    expect(model.followLatest).toBe(true);
    expect(contentEl.scrollTop).toBe(800);
  });

  it("resumes follow after deliberate downward navigation reaches the physical bottom", () => {
    const { contentEl, controller, model } = setup();
    contentEl.scrollTop = 760;
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 20 }));
    contentEl.scrollTop = 800;
    contentEl.dispatchEvent(new Event("scroll"));

    expect(model.followLatest).toBe(true);
  });

  it("enables explicit follow when an active session initially opens at the bottom", async () => {
    const { controller, model, runNextFrame } = setup();
    model.sessionBusy = true;
    const restoring = controller.restoreScrollAfterRender(true, 0, undefined, controller.captureInteractionGeneration());
    runNextFrame();

    await restoring;

    expect(model.followLatest).toBe(true);
  });

  it("does not enable follow when an active session restores a saved reading position", async () => {
    const { contentEl, controller, model, plugin, runNextFrame } = setup();
    plugin.settings.sessionScroll.s1 = { top: 300, atBottom: false };
    model.sessionBusy = true;
    const restoring = controller.restoreScrollAfterRender(true, 0, undefined, controller.captureInteractionGeneration());
    runNextFrame();

    await restoring;

    expect(model.followLatest).toBe(false);
    expect(contentEl.scrollTop).toBe(300);
  });

  it("does not restore a full-shell position after user interaction", async () => {
    const { contentEl, controller, runNextFrame } = setup();
    const anchor = controller.captureFollowLatest();
    const interactionGeneration = controller.captureInteractionGeneration();
    const restoring = controller.restoreScrollAfterRender(false, 800, anchor, interactionGeneration);
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
    contentEl.scrollTop = 300;
    runNextFrame();

    await restoring;

    expect(contentEl.scrollTop).toBe(300);
  });

  it("replaces a relocation-induced top reset with bottom state without loading older messages", () => {
    const { contentEl, onNearTop, plugin, triggerTabGroupRelocation } = setup();
    triggerTabGroupRelocation();
    contentEl.scrollTop = 0;

    contentEl.dispatchEvent(new Event("scroll"));

    expect(onNearTop).not.toHaveBeenCalled();
    expect(plugin.rememberSessionScroll).not.toHaveBeenCalled();
    expect(contentEl.scrollTop).toBe(800);
  });

  it("preserves scroll when Obsidian relocates a tab without resetting it", () => {
    const { contentEl, controller, plugin, runNextFrame, triggerTabGroupRelocation } = setup();
    contentEl.scrollTop = 350;
    triggerTabGroupRelocation();

    contentEl.dispatchEvent(new Event("scroll"));
    for (let frame = 0; frame < 4; frame += 1) runNextFrame();
    controller.persistScrollState();

    expect(contentEl.scrollTop).toBe(350);
    expect(plugin.rememberSessionScroll).toHaveBeenCalledWith("s1", { top: 350, atBottom: false });
  });

  it("catches a top reset that lands after the first relocation frame", () => {
    const { contentEl, onNearTop, runNextFrame, triggerTabGroupRelocation } = setup();
    contentEl.scrollTop = 350;
    triggerTabGroupRelocation();
    contentEl.dispatchEvent(new Event("scroll"));
    runNextFrame();

    contentEl.scrollTop = 0;
    contentEl.dispatchEvent(new Event("scroll"));
    expect(onNearTop).not.toHaveBeenCalled();
    runNextFrame();

    expect(contentEl.scrollTop).toBe(800);
  });

  it("lets user scroll input cancel relocation recovery", () => {
    const { contentEl, onNearTop, triggerTabGroupRelocation } = setup();
    contentEl.scrollTop = 350;
    triggerTabGroupRelocation();
    contentEl.dispatchEvent(new Event("scroll"));
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));

    contentEl.scrollTop = 0;
    contentEl.dispatchEvent(new Event("scroll"));

    expect(contentEl.scrollTop).toBe(0);
    expect(onNearTop).toHaveBeenCalledOnce();
  });

  it("does not persist transient geometry from a detached tab group", () => {
    const { contentEl, controller, plugin } = setup();
    contentEl.remove();

    controller.persistScrollState();

    expect(plugin.rememberSessionScroll).not.toHaveBeenCalled();
  });

  it("waits for a relocated tab group to regain measurable geometry", () => {
    const { contentEl, controller, runNextFrame } = setup();
    contentEl.scrollTop = 0;
    contentEl.remove();

    controller.handleTabGroupRelocation();
    runNextFrame();
    expect(contentEl.scrollTop).toBe(0);

    document.body.appendChild(contentEl);
    runNextFrame();
    expect(contentEl.scrollTop).toBe(800);
  });

  it("ignores ordinary timeline mutations", async () => {
    const { contentEl } = setup();
    contentEl.scrollTop = 0;

    contentEl.appendChild(document.createElement("div"));
    await Promise.resolve();

    expect(contentEl.scrollTop).toBe(0);
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(false);
  });

  it("corrects a same-task leaf reparent before the next animation frame", async () => {
    const { contentEl, relocationContainerEl, relocationRootEl } = setup();
    const destination = relocationRootEl.appendChild(document.createElement("div"));

    relocationContainerEl.remove();
    contentEl.scrollTop = 0;
    destination.appendChild(relocationContainerEl);
    await Promise.resolve();

    expect(contentEl.scrollTop).toBe(800);
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("masks a detached leaf until its reattach mutation is corrected", async () => {
    const { contentEl, relocationContainerEl, relocationRootEl } = setup();
    relocationContainerEl.remove();
    await Promise.resolve();

    expect(contentEl.classList.contains("is-relocation-masked")).toBe(true);

    contentEl.scrollTop = 0;
    relocationRootEl.appendChild(relocationContainerEl);
    await Promise.resolve();

    expect(contentEl.scrollTop).toBe(800);
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(false);
  });

  it("removes a relocation mask after the failsafe timeout", async () => {
    const { contentEl, relocationContainerEl } = setup();
    relocationContainerEl.remove();
    await Promise.resolve();

    expect(contentEl.classList.contains("is-relocation-masked")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(false);
  });

  it("removes the mask when frame recovery completes outside the observed workspace root", async () => {
    const { contentEl, relocationContainerEl, runNextFrame } = setup();
    relocationContainerEl.remove();
    await Promise.resolve();
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(true);

    contentEl.scrollTop = 0;
    document.body.appendChild(relocationContainerEl);
    runNextFrame();

    expect(contentEl.scrollTop).toBe(800);
    expect(contentEl.classList.contains("is-relocation-masked")).toBe(false);
  });

  it("disconnects relocation observation when disposed", async () => {
    const { contentEl, controller, relocationContainerEl, relocationRootEl } = setup();
    controller.dispose();
    relocationContainerEl.remove();
    contentEl.scrollTop = 0;
    relocationRootEl.appendChild(relocationContainerEl);
    await Promise.resolve();

    expect(contentEl.scrollTop).toBe(0);
  });
});
