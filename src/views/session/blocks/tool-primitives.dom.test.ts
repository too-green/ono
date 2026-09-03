import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adoptLazyDetailsBody, hydrateLazyDetails, renderLazyDetailsBody } from "./tool-primitives";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Minimal IntersectionObserver stub whose callbacks tests drive manually. */
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  readonly observed: Element[] = [];
  readonly options: unknown;
  disconnected = false;

  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void, options?: unknown) {
    this.options = options;
    IntersectionObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }]);
  }
}

/** Installs the Obsidian HTMLElement helpers used by lazy details hydration. */
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
    setText: { configurable: true, value: function (this: HTMLElement, text: string) { this.textContent = text; } },
  });
}

describe("lazy details hydration", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    IntersectionObserverStub.instances = [];
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not hydrate an off-DOM restored-open details", () => {
    const details = document.createElement("details");
    details.open = true;
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));

    expect(details.querySelector(".lazy-body")).toBeNull();
  });

  it("hydrates after the row commits and hydrateLazyDetails runs", async () => {
    const details = document.createElement("details");
    details.open = true;
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));
    const row = document.createElement("div");
    row.appendChild(details);
    document.body.appendChild(row);

    hydrateLazyDetails(row);

    expect(details.querySelector(".lazy-body")).not.toBeNull();
    await vi.waitFor(() => expect(details.querySelector(".lazy-body")?.textContent).toBe("content"));
  });

  it("defers a committed open details until the IntersectionObserver reports it visible", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const details = document.createElement("details");
    details.open = true;
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));
    document.body.appendChild(details);

    hydrateLazyDetails(details);

    expect(details.querySelector(".lazy-body")).toBeNull();
    const observer = IntersectionObserverStub.instances.at(-1)!;
    expect(observer.observed).toContain(details);
    expect(observer.options).toEqual({ rootMargin: "200px" });

    observer.trigger(true);

    await vi.waitFor(() => expect(details.querySelector(".lazy-body")?.textContent).toBe("content"));
    expect(observer.disconnected).toBe(true);
  });

  it("keeps the observer alive through an offscreen callback and hydrates once intersection fires", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const details = document.createElement("details");
    details.open = true;
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));
    document.body.appendChild(details);
    hydrateLazyDetails(details);
    const observer = IntersectionObserverStub.instances.at(-1)!;

    observer.trigger(false);

    expect(observer.disconnected).toBe(false);
    expect(details.querySelector(".lazy-body")).toBeNull();

    observer.trigger(true);

    await vi.waitFor(() => expect(details.querySelector(".lazy-body")?.textContent).toBe("content"));
    expect(observer.disconnected).toBe(true);
  });

  it("does not hydrate on a toggle dispatched while disconnected and hydrates once committed", async () => {
    const details = document.createElement("details");
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(details.querySelector(".lazy-body")).toBeNull();

    document.body.appendChild(details);
    hydrateLazyDetails(details);

    expect(details.querySelector(".lazy-body")).not.toBeNull();
    await vi.waitFor(() => expect(details.querySelector(".lazy-body")?.textContent).toBe("content"));
  });

  it("disconnects the observer when the details toggles closed before becoming visible", () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const details = document.createElement("details");
    details.open = true;
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));
    document.body.appendChild(details);
    hydrateLazyDetails(details);
    const observer = IntersectionObserverStub.instances.at(-1)!;

    details.open = false;
    details.dispatchEvent(new Event("toggle"));

    expect(observer.disconnected).toBe(true);
  });

  it("keeps a stale body mounted and defers an adopt reset until the details becomes visible", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const current = document.createElement("details");
    document.body.appendChild(current);
    let currentRenders = 0;
    renderLazyDetailsBody(current, "lazy-body", async (body) => {
      currentRenders += 1;
      body.setText("old");
    });
    current.open = true;
    current.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(current.querySelector(".lazy-body")?.textContent).toBe("old"));

    const next = document.createElement("details");
    renderLazyDetailsBody(next, "lazy-body", async (body) => body.setText("new"));
    expect(adoptLazyDetailsBody(current, next, true)).toBe(true);

    expect(current.querySelector(".lazy-body")?.textContent).toBe("old");
    const observer = IntersectionObserverStub.instances.at(-1)!;
    expect(observer.observed).toContain(current);

    observer.trigger(true);

    await vi.waitFor(() => expect(current.querySelector(".lazy-body")?.textContent).toBe("new"));
    expect(currentRenders).toBe(1);
  });

  it("re-renders immediately on an adopt reset when the details is connected without IntersectionObserver", async () => {
    const current = document.createElement("details");
    document.body.appendChild(current);
    renderLazyDetailsBody(current, "lazy-body", async (body) => body.setText("old"));
    current.open = true;
    current.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(current.querySelector(".lazy-body")?.textContent).toBe("old"));

    const next = document.createElement("details");
    renderLazyDetailsBody(next, "lazy-body", async (body) => body.setText("new"));
    expect(adoptLazyDetailsBody(current, next, true)).toBe(true);

    await vi.waitFor(() => expect(current.querySelector(".lazy-body")?.textContent).toBe("new"));
  });

  it("hydrates immediately on an explicit user toggle even while visibility is unobserved", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    const details = document.createElement("details");
    document.body.appendChild(details);
    renderLazyDetailsBody(details, "lazy-body", async (body) => body.setText("content"));

    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(details.querySelector(".lazy-body")).not.toBeNull();
    await vi.waitFor(() => expect(details.querySelector(".lazy-body")?.textContent).toBe("content"));
  });
});
