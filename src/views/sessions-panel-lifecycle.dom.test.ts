import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../main";
import { SessionsPanelView } from "./SessionsPanelView";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the sessions sidebar view. */
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
    setText: { configurable: true, value: function (this: HTMLElement, value: string) { this.textContent = value; } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

describe("SessionsPanelView lifecycle", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not resubscribe when a pending sessions refresh resolves after close", async () => {
    let resolveHealth!: () => void;
    const close = vi.fn();
    const service = {
      health: vi.fn(() => new Promise<void>((resolve) => { resolveHealth = resolve; })),
      subscribeToEvents: vi.fn(() => ({ close })),
    };
    const plugin = {
      settings: { sessionsPanelSessionSort: "created-desc" },
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);

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

  it("hides child sessions and opens a highlighted session with ArrowRight", async () => {
    const openSessionTab = vi.fn();
    const openNewSessionTab = vi.fn(async () => undefined);
    const listSessionChildren = vi.fn();
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn(() => ({ close: vi.fn() })),
      listProjects: vi.fn(async () => [{ id: "project", name: "Workspace", worktree: "/workspace", sandboxes: [] }]),
      getCurrentProject: vi.fn(async () => ({ id: "project", name: "Workspace", worktree: "/workspace" })),
      listSessions: vi.fn(async () => [
        { id: "parent", title: "Parent session", directory: "/workspace", projectID: "project" },
        { id: "child", title: "Research child", directory: "/workspace", projectID: "project", parentID: "parent" },
      ]),
      listSessionChildren,
      getSessionStatus: vi.fn(async () => ({})),
      listPermissionRequests: vi.fn(async () => []),
      listQuestionRequests: vi.fn(async () => []),
    };
    const plugin = {
      settings: { workingAnimation: "pulse", folderCollapseDisplay: "inset" },
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      getSessionNotificationState: vi.fn(() => ({ muted: false, isSubagent: false })),
      isSessionUnread: vi.fn(() => false),
      openDirectoryWithPicker: vi.fn(),
      openSessionTab,
      openNewSessionTab,
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);

    await view.onOpen();

    expect(view.contentEl.querySelector('[data-session-id="parent"]')).not.toBeNull();
    expect(view.contentEl.querySelector('[data-session-id="child"]')).toBeNull();
    expect(view.contentEl.querySelector('button[aria-label^="Sort sessions:"]')).not.toBeNull();
    expect(listSessionChildren).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector(".opencode-sessions-panel__new-session")).toBeNull();

    const create = view.contentEl.querySelector<HTMLButtonElement>(".opencode-sessions-panel__new-session-action")!;
    create.click();
    expect(openNewSessionTab).toHaveBeenCalledWith("/workspace");

    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(openNewSessionTab).toHaveBeenCalledTimes(2);

    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(view.contentEl.querySelector('[data-session-id="parent"]')).toBeNull();
    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(view.contentEl.querySelector('[data-session-id="parent"]')).not.toBeNull();

    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(openSessionTab).toHaveBeenCalledWith("parent", "Parent session");
  });

  it("retains tree scroll, session rows, and rename input across streamed refreshes", async () => {
    vi.useFakeTimers();
    let onEvent: ((event: { type: string; properties?: Record<string, unknown> }) => void) | undefined;
    let onOpen: (() => void) | undefined;
    let onError: ((error: unknown) => void) | undefined;
    let updatedAt = 1_000;
    const listSessions = vi.fn(async () => [{
      id: "session-1",
      title: "Streaming session",
      directory: "/workspace",
      projectID: "project",
      time: { created: 500, updated: updatedAt },
    }]);
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn((handlers: { onEvent: typeof onEvent; onOpen?: () => void; onError?: (error: unknown) => void }) => {
        onEvent = handlers.onEvent;
        onOpen = handlers.onOpen;
        onError = handlers.onError;
        return { close: vi.fn() };
      }),
      listProjects: vi.fn(async () => [{ id: "project", name: "Workspace", worktree: "/workspace", sandboxes: [] }]),
      getCurrentProject: vi.fn(async () => ({ id: "project", name: "Workspace", worktree: "/workspace" })),
      listSessions,
      getSessionStatus: vi.fn(async () => ({ "session-1": { type: "busy" } })),
      listPermissionRequests: vi.fn(async () => []),
      listQuestionRequests: vi.fn(async () => []),
    };
    const plugin = {
      settings: {
        sessionsPanelSessionSort: "created-desc",
        workingAnimation: "pulse",
        folderCollapseDisplay: "inset",
      },
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      settleSessionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      getSessionNotificationState: vi.fn(() => ({ muted: false, isSubagent: false })),
      isSessionUnread: vi.fn(() => false),
      openDirectoryWithPicker: vi.fn(),
      openNewSessionTab: vi.fn(async () => undefined),
      rememberSessionUnread: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => undefined),
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);
    await view.onOpen();
    const tree = view.contentEl.querySelector<HTMLElement>(".opencode-sessions-panel__tree")!;
    const row = view.contentEl.querySelector<HTMLElement>('[data-session-id="session-1"]')!;
    const item = row.parentElement!;
    tree.scrollTop = 140;
    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    view.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const input = row.querySelector<HTMLInputElement>(".opencode-sessions-panel__rename-input")!;
    input.value = "Draft rename";

    updatedAt = 2_000;
    await view.refresh({ showLoading: false });

    expect(view.contentEl.querySelector(".opencode-sessions-panel__tree")).toBe(tree);
    expect(view.contentEl.querySelector('[data-session-id="session-1"]')).toBe(row);
    expect(row.parentElement).toBe(item);
    expect(row.querySelector(".opencode-sessions-panel__rename-input")).toBe(input);
    expect(input.value).toBe("Draft rename");
    expect(tree.scrollTop).toBe(140);

    const refreshCount = listSessions.mock.calls.length;
    const indicator = row.querySelector(".opencode-status-badge--working span");
    onEvent?.({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
    vi.advanceTimersByTime(300);

    expect(row.querySelector(".opencode-status-badge--working span")).toBe(indicator);
    expect(listSessions).toHaveBeenCalledTimes(refreshCount);

    onEvent?.({ type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } });
    vi.advanceTimersByTime(300);

    expect(view.contentEl.querySelector(".opencode-sessions-panel__tree")).toBe(tree);
    expect(tree.scrollTop).toBe(140);
    expect(row.querySelector(".opencode-status-badge--working")).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(refreshCount);

    onEvent?.({ type: "session.error", properties: { sessionID: "session-1", error: { name: "APIError", data: { message: "Failed" } } } });
    expect(row.querySelector(".opencode-status-badge--error")).not.toBeNull();
    onEvent?.({ type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } });
    expect(row.querySelector(".opencode-status-badge--error")).not.toBeNull();
    onEvent?.({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
    expect(row.querySelector(".opencode-status-badge--error")).toBeNull();
    expect(row.querySelector(".opencode-status-badge--working")).not.toBeNull();

    onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(listSessions.mock.calls.length).toBeGreaterThan(refreshCount);

    service.health.mockRejectedValueOnce(new Error("offline"));
    onError?.(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(view.contentEl.textContent).toContain("opencode server not running");
  });
});
