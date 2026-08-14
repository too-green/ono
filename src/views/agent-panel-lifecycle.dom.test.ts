import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../main";
import { AgentPanelView } from "./AgentPanelView";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the agents sidebar view. */
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

describe("AgentPanelView lifecycle", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not resubscribe when a pending agents refresh resolves after close", async () => {
    let resolveHealth!: () => void;
    const close = vi.fn();
    const service = {
      health: vi.fn(() => new Promise<void>((resolve) => { resolveHealth = resolve; })),
      subscribeToEvents: vi.fn(() => ({ close })),
    };
    const plugin = {
      settings: { agentPanelSessionSort: "created-desc" },
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
      settings: { sessionMute: {}, sessionUnread: {}, sessionAutoApprove: {}, workingAnimation: "pulse", folderCollapseDisplay: "inset" },
      getOpenedDirectories: () => ["/workspace"],
      getActiveSessionId: () => undefined,
      requireOpenCodeService: () => service,
      cacheSessionHierarchy: vi.fn(),
      routePermissionRequest: vi.fn(),
      shouldSuppressPermissionRequest: vi.fn(() => false),
      openDirectoryWithPicker: vi.fn(),
      openSessionTab,
      openNewSessionTab,
    } as unknown as OpenCodePlugin;
    const view = new AgentPanelView({ app: {} } as never, plugin);

    await view.onOpen();

    expect(view.contentEl.querySelector('[data-session-id="parent"]')).not.toBeNull();
    expect(view.contentEl.querySelector('[data-session-id="child"]')).toBeNull();
    expect(view.contentEl.querySelector('button[aria-label^="Sort sessions:"]')).not.toBeNull();
    expect(listSessionChildren).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector(".opencode-agent-panel__new-session")).toBeNull();

    const create = view.contentEl.querySelector<HTMLButtonElement>(".opencode-agent-panel__new-session-action")!;
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
});
