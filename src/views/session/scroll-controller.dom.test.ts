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
    const contentEl = document.createElement("div");
    document.body.appendChild(contentEl);
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
      isActive: () => true,
      onNearTop: vi.fn(),
      onUnreadChange: vi.fn(),
    });
    controller.bindScrollListener();
    return {
      contentEl,
      controller,
      model,
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

  it("rejects a stale asynchronous bottom anchor after user interaction", () => {
    const { contentEl, controller } = setup();
    const generation = controller.captureFollowLatest();
    contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
    contentEl.scrollTop = 300;

    controller.restoreFollowLatest(generation);

    expect(contentEl.scrollTop).toBe(300);
  });

  it("restores an unchanged near-bottom anchor after a large content growth", () => {
    const { contentEl, controller, setGeometry } = setup();
    const anchor = controller.captureFollowLatest();
    setGeometry(1_400, 200);

    controller.restoreFollowLatest(anchor);

    expect(contentEl.scrollTop).toBe(1_200);
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
});
