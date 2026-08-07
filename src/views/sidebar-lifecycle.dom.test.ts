import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../main";
import { AgentPanelView } from "./AgentPanelView";
import { compactDiffSummaries, DiffPanelView } from "./DiffPanelView";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by both sidebar views. */
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
    addClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); } },
    removeClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

describe("sidebar view lifecycle", () => {
  beforeEach(() => {
    installObsidianDomMethods();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("removes raw patches from retained diff summaries", () => {
    expect(compactDiffSummaries([{ file: "large.ts", additions: 2, deletions: 1, patch: "large raw patch", status: "modified" }])).toEqual([
      { file: "large.ts", additions: 2, deletions: 1, status: "modified" },
    ]);
  });

  it("replaces the previous session's diffs while the next context loads", async () => {
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => sessionId === "a"
        ? Promise.resolve({ id: "a", title: "Session A" })
        : new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; })),
      listMessages: vi.fn((sessionId: string) => sessionId === "a"
        ? Promise.resolve([])
        : new Promise<[]>((resolve) => { resolveMessages = resolve; })),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(["a", "b"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    expect(view.contentEl.textContent).toContain("Session A");

    const switching = view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    expect(view.contentEl.textContent).toContain("Loading diffs");
    expect(view.contentEl.textContent).not.toContain("Session A");

    resolveSession({ id: "b", title: "Session B" });
    resolveMessages([]);
    await switching;
    expect(view.contentEl.textContent).toContain("Session B");
  });

  it("skips clean cache requests and revalidates dirty entries after rendering them", async () => {
    /** Builds one user message carrying a summarized file diff. */
    const messagesFor = (sessionId: string, file: string) => [{
      info: { id: `${sessionId}-user`, role: "user", time: { created: 1 }, summary: { diffs: [{ file, additions: 1, deletions: 0 }] } },
      parts: [],
    }];
    let aSessionCalls = 0;
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: ReturnType<typeof messagesFor>) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "a" || aSessionCalls++ === 0) return Promise.resolve({ id: sessionId, title: `Session ${sessionId.toUpperCase()}` });
        return new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; });
      }),
      listMessages: vi.fn((sessionId: string) => {
        if (sessionId !== "a" || aSessionCalls === 1) return Promise.resolve(messagesFor(sessionId, `${sessionId}.ts`));
        return new Promise<ReturnType<typeof messagesFor>>((resolve) => { resolveMessages = resolve; });
      }),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(["a", "b"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });

    await view.setContext({ sessionId: "a", sessionTitle: "Session A" });
    expect(view.contentEl.textContent).toContain("Session A");
    expect(view.contentEl.textContent).toContain("a.ts");
    expect(view.contentEl.textContent).not.toContain("Loading diffs");
    expect(service.getSession.mock.calls.filter(([sessionId]) => sessionId === "a")).toHaveLength(1);

    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    view.markSessionDirty("a");
    const switchingBack = view.setContext({ sessionId: "a", sessionTitle: "Session A" });
    expect(view.contentEl.textContent).toContain("a.ts");

    resolveSession({ id: "a", title: "Session A" });
    resolveMessages(messagesFor("a", "a-updated.ts"));
    await switchingBack;
    expect(view.contentEl.textContent).toContain("a-updated.ts");
  });

  it("prevents an older dirty refresh from overwriting a clean tab switch", async () => {
    let bSessionCalls = 0;
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || ++bSessionCalls === 1) return Promise.resolve({ id: sessionId, title: `Session ${sessionId.toUpperCase()}` });
        return new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; });
      }),
      listMessages: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || bSessionCalls === 1) return Promise.resolve([]);
        return new Promise<[]>((resolve) => { resolveMessages = resolve; });
      }),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(["a", "b"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    view.markSessionDirty("b");
    const refreshingB = view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    await view.setContext({ sessionId: "a", sessionTitle: "Session A" });

    resolveSession({ id: "b", title: "Session B" });
    resolveMessages([]);
    await refreshingB;
    expect(view.contentEl.textContent).toContain("Session A");
  });

  it("keeps an entry dirty when invalidated during its refresh", async () => {
    let bSessionCalls = 0;
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || ++bSessionCalls !== 2) return Promise.resolve({ id: sessionId, title: `Session ${sessionId.toUpperCase()}` });
        return new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; });
      }),
      listMessages: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || bSessionCalls !== 2) return Promise.resolve([]);
        return new Promise<[]>((resolve) => { resolveMessages = resolve; });
      }),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(["a", "b"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    view.markSessionDirty("b");
    const refreshingB = view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    view.markSessionDirty("b");
    resolveSession({ id: "b", title: "Session B" });
    resolveMessages([]);
    await refreshingB;

    await view.setContext({ sessionId: "a", sessionTitle: "Session A" });
    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    expect(service.getSession.mock.calls.filter(([sessionId]) => sessionId === "b")).toHaveLength(3);
  });

  it("evicts the least-recently-used snapshot above forty sessions", async () => {
    const openSessionIds = new Set(Array.from({ length: 41 }, (_, index) => `s${index}`));
    let firstSessionCalls = 0;
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "s0" || firstSessionCalls++ === 0) return Promise.resolve({ id: sessionId, title: sessionId });
        return new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; });
      }),
      listMessages: vi.fn((sessionId: string) => {
        if (sessionId !== "s0" || firstSessionCalls === 1) return Promise.resolve([]);
        return new Promise<[]>((resolve) => { resolveMessages = resolve; });
      }),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "s0" }),
      getOpenSessionIds: () => new Set(openSessionIds),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    for (let index = 1; index <= 40; index += 1) await view.setContext({ sessionId: `s${index}` });

    const reopeningOldest = view.setContext({ sessionId: "s0" });
    expect(view.contentEl.textContent).toContain("Loading diffs");
    resolveSession({ id: "s0", title: "s0" });
    resolveMessages([]);
    await reopeningOldest;
  });

  it("evicts a cached snapshot after its session tab closes", async () => {
    const openSessionIds = new Set(["a", "b"]);
    let bSessionCalls = 0;
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || bSessionCalls++ === 0) return Promise.resolve({ id: sessionId, title: `Session ${sessionId.toUpperCase()}` });
        return new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; });
      }),
      listMessages: vi.fn((sessionId: string) => {
        if (sessionId !== "b" || bSessionCalls === 1) return Promise.resolve([]);
        return new Promise<[]>((resolve) => { resolveMessages = resolve; });
      }),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(openSessionIds),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    await view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    openSessionIds.delete("b");
    await view.setContext({ sessionId: "a", sessionTitle: "Session A" });
    openSessionIds.add("b");

    const reopening = view.setContext({ sessionId: "b", sessionTitle: "Session B" });
    expect(view.contentEl.textContent).toContain("Loading diffs");
    resolveSession({ id: "b", title: "Session B" });
    resolveMessages([]);
    await reopening;
  });

  it("clears the displayed snapshot when its final session tab closes", async () => {
    const service = {
      getSession: vi.fn(async () => ({ id: "a", title: "Session A" })),
      listMessages: vi.fn(async () => []),
    };
    const plugin = {
      getDiffPanelContext: () => ({ sessionId: "a", sessionTitle: "Session A" }),
      getOpenSessionIds: () => new Set(["a"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    view.evictSnapshot("a");
    expect(view.contentEl.textContent).toContain("No OpenCode session selected");
  });

  it("does not repaint when a pending diff refresh resolves after close", async () => {
    let resolveSession!: (session: { id: string; title: string }) => void;
    let resolveMessages!: (messages: []) => void;
    const service = {
      getSession: vi.fn(() => new Promise<{ id: string; title: string }>((resolve) => { resolveSession = resolve; })),
      listMessages: vi.fn(() => new Promise<[]>((resolve) => { resolveMessages = resolve; })),
    };
    const plugin = {
      getDiffPanelContext: () => ({}),
      getOpenSessionIds: () => new Set(["a"]),
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new DiffPanelView({ app: {} } as never, plugin);

    await view.onOpen();
    const refreshing = view.setContext({ sessionId: "a", sessionTitle: "Session A" });
    expect(view.contentEl.textContent).toContain("Loading diffs");
    await view.onClose();

    resolveSession({ id: "a", title: "Session A" });
    resolveMessages([]);
    await refreshing;
    expect(view.contentEl.hasChildNodes()).toBe(false);
  });

  it("does not resubscribe when a pending agents refresh resolves after close", async () => {
    let resolveHealth!: () => void;
    const close = vi.fn();
    const service = {
      health: vi.fn(() => new Promise<void>((resolve) => { resolveHealth = resolve; })),
      subscribeToEvents: vi.fn(() => ({ close })),
    };
    const plugin = {
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new AgentPanelView({ app: {} } as never, plugin);

    const opening = view.onOpen();
    expect(service.subscribeToEvents).toHaveBeenCalledOnce();
    await view.onClose();
    resolveHealth();
    await opening;

    expect(close).toHaveBeenCalledOnce();
    expect(service.subscribeToEvents).toHaveBeenCalledOnce();
    expect(view.contentEl.hasChildNodes()).toBe(false);
    expect(view.contentEl.classList.contains("opencode-sidebar-panel")).toBe(false);
  });
});
