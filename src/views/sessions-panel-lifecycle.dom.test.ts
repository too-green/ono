import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "obsidian";

import type OpenCodePlugin from "../../main";
import { SessionsPanelView } from "./SessionsPanelView";
import { SessionStatusStore } from "../services/session-status-store";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };
type TestMenuItem = { title: string; disabled: boolean; callback?: () => unknown };
type TestMenu = { items: Array<TestMenuItem | "separator"> };

/** Returns menus captured by the Obsidian test stub. */
function menus(): TestMenu[] {
  return (Menu as unknown as { instances: TestMenu[] }).instances;
}

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

/** Dispatches a cancellable native-style drag event with mutable transfer state. */
function dispatchDrag(element: HTMLElement, type: string, sessionId = "ses_123"): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["application/x-opencode-session-id"],
      getData: vi.fn(() => sessionId),
      setData: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    },
  });
  element.dispatchEvent(event);
}

describe("SessionsPanelView lifecycle", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    menus().length = 0;
    (Notice as unknown as { history: unknown[] }).history = [];
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
      directoryContexts: { getProject: service.getCurrentProject },
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

  it("reconciles only each directory's own status response scope", async () => {
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn(() => ({ close: vi.fn() })),
      listProjects: vi.fn(async () => [
        { id: "project-a", name: "Repo", worktree: "/repo", sandboxes: [] },
        { id: "project-b", name: "Other", worktree: "/other", sandboxes: [] },
      ]),
      getCurrentProject: vi.fn(async (directory: string) => directory === "/repo"
        ? { id: "project-a", name: "Repo", worktree: "/repo" }
        : { id: "project-b", name: "Other", worktree: "/other" }),
      listSessions: vi.fn(async ({ directory }: { directory: string }) => directory === "/repo"
        ? [{ id: "ses-a", title: "Repo session", directory: "/repo", projectID: "project-a" }]
        : [{ id: "ses-b", title: "Other session", directory: "/other", projectID: "project-b" }]),
      getSessionStatus: vi.fn(async (directory: string) => directory === "/repo" ? { "ses-a": { type: "busy" } } : {}),
      listPermissionRequests: vi.fn(async () => []),
      listQuestionRequests: vi.fn(async () => []),
    };
    const sessionStatuses = new SessionStatusStore({});
    const plugin = {
      settings: { workingAnimation: "pulse", folderCollapseDisplay: "inset" },
      getOpenedDirectories: () => ["/repo", "/other"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject },
      sessionStatuses,
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      getSessionNotificationState: vi.fn(() => ({ muted: false, isSubagent: false })),
      isSessionUnread: vi.fn(() => false),
      openDirectoryWithPicker: vi.fn(),
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);

    await view.onOpen();

    // Each directory gets its own scoped GET, and only its response is reconciled into its scope.
    expect(service.getSessionStatus).toHaveBeenCalledWith("/repo");
    expect(service.getSessionStatus).toHaveBeenCalledWith("/other");
    expect(sessionStatuses.statusFor("ses-a")?.type).toBe("busy");
    expect(sessionStatuses.statusFor("ses-a")?.directory).toBe("/repo");
    expect(sessionStatuses.statusFor("ses-b")).toBeUndefined();
    const repoRow = view.contentEl.querySelector<HTMLElement>('[data-session-id="ses-a"]')!;
    expect(repoRow.querySelector(".opencode-status-badge--working")).not.toBeNull();
    const otherRow = view.contentEl.querySelector<HTMLElement>('[data-session-id="ses-b"]')!;
    expect(otherRow.querySelector(".opencode-status-badge--working")).toBeNull();
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
    const sessionStatuses = new SessionStatusStore({});
    const plugin = {
      settings: {
        sessionsPanelSessionSort: "created-desc",
        workingAnimation: "pulse",
        folderCollapseDisplay: "inset",
      },
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject },
      sessionStatuses,
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
    sessionStatuses.handleStatus("/workspace", "session-1", { type: "busy" }, "event");
    vi.advanceTimersByTime(300);

    expect(row.querySelector(".opencode-status-badge--working span")).toBe(indicator);
    expect(listSessions).toHaveBeenCalledTimes(refreshCount);

    sessionStatuses.handleStatus("/workspace", "session-1", { type: "idle" }, "event");
    vi.advanceTimersByTime(300);

    expect(view.contentEl.querySelector(".opencode-sessions-panel__tree")).toBe(tree);
    expect(tree.scrollTop).toBe(140);
    expect(row.querySelector(".opencode-status-badge--working")).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(refreshCount);

    sessionStatuses.handleEvent("/workspace", { type: "session.error", properties: { sessionID: "session-1", error: { name: "APIError", data: { message: "Failed" } } } });
    expect(row.querySelector(".opencode-status-badge--error")).not.toBeNull();
    sessionStatuses.handleStatus("/workspace", "session-1", { type: "idle" }, "event");
    expect(row.querySelector(".opencode-status-badge--error")).not.toBeNull();
    sessionStatuses.handleStatus("/workspace", "session-1", { type: "busy" }, "event");
    expect(row.querySelector(".opencode-status-badge--error")).toBeNull();
    expect(row.querySelector(".opencode-status-badge--working")).not.toBeNull();

    onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(listSessions.mock.calls.length).toBeGreaterThan(refreshCount);
    // Reconnect hydration refetches each opened directory's scoped status snapshot.
    expect(service.getSessionStatus).toHaveBeenCalledWith("/workspace");

    service.health.mockRejectedValueOnce(new Error("offline"));
    onError?.(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(view.contentEl.textContent).toContain("opencode server not running");
  });

  it("exposes project and worktree management from their respective context menus", async () => {
    let openedDirectories = ["/repo", "/repo/a"];
    const removeOpenedDirectory = vi.fn(async () => undefined);
    const removeOpenedDirectories = vi.fn(async () => undefined);
    const openExistingWorktree = vi.fn(async () => undefined);
    const requestWorktreeCreate = vi.fn(async () => undefined);
    const requestWorktreeReset = vi.fn(async () => undefined);
    const requestWorktreeRemove = vi.fn(async () => undefined);
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn(() => ({ close: vi.fn() })),
      listProjects: vi.fn(async () => [{ id: "project", name: "Repository", worktree: "/repo", vcs: "git", sandboxes: ["/repo/a", "/repo/b"] }]),
      getCurrentProject: vi.fn(async () => ({ id: "project", name: "Repository", worktree: "/repo", vcs: "git" })),
      listSessions: vi.fn(async () => []),
      getSessionStatus: vi.fn(async () => ({})),
      listPermissionRequests: vi.fn(async () => []),
      listQuestionRequests: vi.fn(async () => []),
    };
    const plugin = {
      settings: { workingAnimation: "pulse", folderCollapseDisplay: "inset" },
      getOpenedDirectories: () => openedDirectories,
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject },
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      getSessionNotificationState: vi.fn(() => ({ muted: false, isSubagent: false })),
      isSessionUnread: vi.fn(() => false),
      getWorktreeStatus: vi.fn(() => undefined),
      isWorktreeOperationInProgress: vi.fn(() => false),
      removeOpenedDirectory,
      removeOpenedDirectories,
      openExistingWorktree,
      requestWorktreeCreate,
      requestWorktreeReset,
      requestWorktreeRemove,
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);
    await view.onOpen();

    view.contentEl.querySelector<HTMLElement>(".opencode-sessions-panel__project .nav-folder-title")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const projectMenu = menus().at(-1)!;
    const projectItems = projectMenu.items.filter((item): item is TestMenuItem => item !== "separator");
    expect(projectItems.map((item) => item.title)).toContain("Open existing worktree...");
    expect(projectItems.find((item) => item.title === "Open existing worktree...")?.disabled).toBe(false);
    projectItems.find((item) => item.title === "Create worktree...")?.callback?.();
    projectItems.find((item) => item.title === "Close project")?.callback?.();

    const worktreeRows = view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__worktree .nav-folder-title");
    worktreeRows[0]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const primaryItems = menus().at(-1)!.items.filter((item): item is TestMenuItem => item !== "separator");
    expect(primaryItems.map((item) => item.title)).toEqual(["Close directory"]);

    worktreeRows[1]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const worktreeMenu = menus().at(-1)!;
    const worktreeItems = worktreeMenu.items.filter((item): item is TestMenuItem => item !== "separator");
    expect(worktreeItems.map((item) => item.title)).toEqual(["Close directory", "Reset worktree...", "Remove worktree..."]);
    worktreeItems.find((item) => item.title === "Close directory")?.callback?.();
    worktreeItems.find((item) => item.title === "Reset worktree...")?.callback?.();
    worktreeItems.find((item) => item.title === "Remove worktree...")?.callback?.();

    expect(requestWorktreeCreate).toHaveBeenCalledWith("/repo");
    expect(removeOpenedDirectories).toHaveBeenCalledWith(["/repo", "/repo/a"]);
    expect(removeOpenedDirectory).toHaveBeenCalledWith("/repo/a");
    expect(requestWorktreeReset).toHaveBeenCalledWith("/repo", "/repo/a");
    expect(requestWorktreeRemove).toHaveBeenCalledWith("/repo", "/repo/a");

    const menuHarness = view as unknown as {
      showProjectMenu(event: MouseEvent, project: {
        id: string;
        name: string;
        git: boolean;
        rootDirectory: string;
        openedDirectories: string[];
        managedWorktreeDirectories: string[];
        worktrees: never[];
      }): void;
    };
    menuHarness.showProjectMenu(new MouseEvent("contextmenu"), {
      id: "project",
      name: "Repository",
      git: true,
      rootDirectory: "/repo",
      openedDirectories: ["/repo", "/repo/a", "/repo/b"],
      managedWorktreeDirectories: ["/repo/a", "/repo/b"],
      worktrees: [],
    });
    const exhaustedItems = menus().at(-1)!.items.filter((item): item is TestMenuItem => item !== "separator");
    expect(exhaustedItems.find((item) => item.title === "Open existing worktree...")?.disabled).toBe(true);

    openedDirectories = ["/repo/a"];
    await view.refresh({ showLoading: false });
    expect(view.contentEl.querySelectorAll(".opencode-sessions-panel__worktree")).toHaveLength(1);
  });

  it("moves sessions onto same-project folders and rejects cross-project drops", async () => {
    vi.useFakeTimers();
    const moveSessionToDirectory = vi.fn(async () => undefined);
    const openedDirectories = ["/repo", "/repo/feature", "/other"];
    const projects = [
      { id: "project-a", name: "Repository", worktree: "/repo", vcs: "git", sandboxes: ["/repo/feature"] },
      { id: "project-b", name: "Other", worktree: "/other", vcs: "git", sandboxes: [] },
    ];
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn(() => ({ close: vi.fn() })),
      listProjects: vi.fn(async () => projects),
      listSessions: vi.fn(async ({ directory }: { directory: string }) => directory === "/repo"
        ? [{ id: "ses_123", title: "Movable", directory: "/repo/packages/app", projectID: "project-a" }]
        : []),
      getSessionStatus: vi.fn(async () => ({})),
      listPermissionRequests: vi.fn(async () => []),
      listQuestionRequests: vi.fn(async () => []),
    };
    const sessionStatuses = new SessionStatusStore({});
    const getProject = vi.fn(async (directory: string) => projects.find((project) => project.worktree === directory || project.sandboxes.includes(directory))!);
    const plugin = {
      settings: { sessionsPanelSessionSort: "created-desc", workingAnimation: "pulse", folderCollapseDisplay: "inset" },
      getOpenedDirectories: () => openedDirectories,
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      directoryContexts: { getProject },
      sessionStatuses,
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      getSessionNotificationState: vi.fn(() => ({ muted: false, isSubagent: false })),
      isSessionUnread: vi.fn(() => false),
      getWorktreeStatus: vi.fn(() => undefined),
      openDirectoryWithPicker: vi.fn(),
      moveSessionToDirectory,
    } as unknown as OpenCodePlugin;
    const view = new SessionsPanelView({ app: {} } as never, plugin);
    await view.onOpen();

    const session = view.contentEl.querySelector<HTMLElement>('[data-session-id="ses_123"]')!;
    const sourceWorktree = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__worktree"))
      .find((item) => item.querySelector<HTMLElement>(".nav-folder-title")?.title === "/repo")!;
    const featureRow = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__worktree"))
      .find((item) => item.querySelector<HTMLElement>(".nav-folder-title")?.title === "/repo/feature")!;
    featureRow.querySelector<HTMLElement>(".nav-folder-title")!.click();
    const collapsedFeature = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__worktree"))
      .find((item) => item.querySelector<HTMLElement>(".nav-folder-title")?.title === "/repo/feature")!;

    dispatchDrag(session, "dragstart");
    dispatchDrag(sourceWorktree, "dragenter");
    dispatchDrag(sourceWorktree, "dragover");
    expect(sourceWorktree.classList.contains("opencode-sessions-panel__folder--drop-target")).toBe(false);
    dispatchDrag(sourceWorktree, "drop");
    expect(moveSessionToDirectory).not.toHaveBeenCalled();

    dispatchDrag(session, "dragstart");
    dispatchDrag(collapsedFeature, "dragenter");
    dispatchDrag(collapsedFeature, "dragover");
    expect(collapsedFeature.classList.contains("opencode-sessions-panel__folder--drop-target")).toBe(true);
    expect(collapsedFeature.querySelector(".nav-folder-title")?.getAttribute("aria-expanded")).toBe("false");

    vi.advanceTimersByTime(1_200);
    const expandedFeature = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__worktree"))
      .find((item) => item.querySelector<HTMLElement>(".nav-folder-title")?.title === "/repo/feature")!;
    expect(expandedFeature.classList.contains("opencode-sessions-panel__folder--drop-target")).toBe(true);
    expect(expandedFeature.querySelector(".nav-folder-title")?.getAttribute("aria-expanded")).toBe("true");

    dispatchDrag(expandedFeature, "drop");
    await vi.waitFor(() => expect(moveSessionToDirectory).toHaveBeenCalledWith("ses_123", "/repo/packages/app", "/repo/feature"));

    const otherProject = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".opencode-sessions-panel__project"))
      .find((item) => item.textContent?.includes("Other"))!;
    dispatchDrag(session, "dragstart");
    dispatchDrag(otherProject, "dragenter");
    dispatchDrag(otherProject, "dragover");
    expect(otherProject.classList.contains("opencode-sessions-panel__folder--drop-invalid")).toBe(true);
    dispatchDrag(otherProject, "dragleave");
    expect(otherProject.classList.contains("opencode-sessions-panel__folder--drop-invalid")).toBe(false);
    dispatchDrag(otherProject, "dragenter");
    dispatchDrag(otherProject, "dragover");
    dispatchDrag(otherProject, "drop");
    expect(moveSessionToDirectory).toHaveBeenCalledTimes(1);

    sessionStatuses.handleStatus("/repo", "ses_123", { type: "busy" }, "event");
    dispatchDrag(session, "dragstart");
    dispatchDrag(expandedFeature, "dragenter");
    dispatchDrag(expandedFeature, "dragover");
    dispatchDrag(expandedFeature, "drop");
    expect(moveSessionToDirectory).toHaveBeenCalledTimes(1);
    expect((Notice as unknown as { history: Array<{ message: unknown }> }).history.at(-1)?.message)
      .toBe("Abort the session before moving it.");

    dispatchDrag(session, "dragend");
    expect(view.contentEl.querySelector(".opencode-sessions-panel__folder--drop-invalid")).toBeNull();
  });
});
