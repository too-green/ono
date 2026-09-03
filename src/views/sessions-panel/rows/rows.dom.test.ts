import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenCodePlugin from "../../../../main";
import { SessionsPanelView } from "../../SessionsPanelView";
import { ProjectRow } from "./ProjectRow";
import { SessionRow, relativeModifiedTime } from "./SessionRow";
import { WorktreeRow } from "./WorktreeRow";
import type { SessionsPanelProject, SessionsPanelSession, SessionsPanelWorktree } from "./types";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the row component tests. */
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
    scrollIntoView: { configurable: true, value: vi.fn() },
  });
}

const session: SessionsPanelSession = {
  id: "session-1",
  title: "Extract panel rows",
  directory: "/workspace",
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 60_000,
  status: "working",
  muted: true,
  requiresAttention: false,
};

const worktree: SessionsPanelWorktree = {
  id: "/workspace",
  name: "workspace",
  path: "/workspace",
  sessions: [session],
};

const project: SessionsPanelProject = {
  id: "project-1",
  name: "OpenCode plugin",
  openedDirectories: ["/workspace"],
  worktrees: [worktree],
};

describe("sessions-panel row components", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    document.body.replaceChildren();
  });

  it("returns project row, child, and creation-action handles", () => {
    const handle = new ProjectRow().render(document.body, {
      project,
      collapsed: false,
      collapseDisplay: "inset",
      showNewSessionAction: true,
    });

    expect(handle.rowEl.textContent).toContain("OpenCode plugin");
    expect(handle.rowEl.getAttribute("aria-expanded")).toBe("true");
    expect(handle.childrenEl?.parentElement).toBe(handle.itemEl);
    expect(handle.newSessionButtonEl?.getAttribute("aria-label")).toBe("New session");
    const avatar = handle.rowEl.querySelector<HTMLElement>(".opencode-sessions-panel__project-avatar");
    expect(avatar?.textContent).toBe("OP");
    expect(avatar?.classList.contains("tree-item-icon")).toBe(true);
    expect(avatar?.classList.contains("collapse-icon")).toBe(false);
    expect(avatar?.style.getPropertyValue("--opencode-project-avatar-color")).toMatch(/^var\(--color-/);
  });

  it("returns a collapsed worktree row without mounting its children", () => {
    const handle = new WorktreeRow().render(document.body, { worktree, collapsed: true, collapseDisplay: "size" });

    expect(handle.rowEl.textContent).toContain("workspace");
    expect(handle.rowEl.title).toBe("/workspace");
    expect(handle.rowEl.getAttribute("aria-expanded")).toBe("false");
    expect(handle.rowEl.querySelector(".opencode-sessions-panel__worktree-icon")?.classList.contains("tree-item-icon")).toBe(true);
    expect(handle.childrenEl).toBeUndefined();
    expect(handle.newSessionButtonEl).toBeInstanceOf(HTMLButtonElement);
    expect(handle.rowEl.classList.contains("opencode-sessions-panel__folder-row--size")).toBe(true);
  });

  it("exposes stable session title and live-status operations", () => {
    const handle = new SessionRow().render(document.body, { session, active: true, workingAnimation: "pulse" });

    expect(handle.rowEl.classList.contains("is-active")).toBe(true);
    expect(handle.titleEl.textContent).toBe("Extract panel rows");
    expect(handle.rowEl.querySelector(".collapse-icon")).toBeNull();
    expect(handle.rowEl.querySelector(".opencode-sessions-panel__status")?.classList.contains("tree-item-icon")).toBe(true);
    expect(handle.rowEl.querySelector(".opencode-sessions-panel__notification")).not.toBeNull();
    expect(handle.rowEl.querySelector(".opencode-sessions-panel__session-modified")?.textContent).toBe("1m");
    expect(handle.rowEl.lastElementChild?.classList.contains("opencode-sessions-panel__session-modified")).toBe(true);
    expect(handle.rowEl.querySelector(".opencode-status-badge--working")?.getAttribute("data-working-animation")).toBe("pulse");
    const workingIndicator = handle.rowEl.querySelector(".opencode-status-badge--working span");
    expect(workingIndicator?.children).toHaveLength(3);

    handle.updatePresentation?.({ ...session, updatedAt: Date.now() }, true, "pulse");

    expect(handle.rowEl.querySelector(".opencode-status-badge--working span")).toBe(workingIndicator);

    handle.updateActive(false);
    handle.updateStatus("done", "orbit");

    expect(handle.rowEl.classList.contains("is-active")).toBe(false);
    expect(handle.rowEl.querySelector(".opencode-status-badge--working")).toBeNull();
    expect(handle.rowEl.querySelector(".opencode-status-badge--done")?.getAttribute("data-working-animation")).toBe("orbit");
  });

  it("formats compact relative modified times across useful sidebar ranges", () => {
    const now = 1_800_000_000_000;
    expect(relativeModifiedTime(now - 30_000, now)).toBe("now");
    expect(relativeModifiedTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeModifiedTime(now - 3 * 60 * 60_000, now)).toBe("3h");
    expect(relativeModifiedTime(now - 4 * 24 * 60 * 60_000, now)).toBe("4d");
    expect(relativeModifiedTime(now - 60 * 24 * 60 * 60_000, now)).toBe("2mo");
    expect(relativeModifiedTime(now - 730 * 24 * 60 * 60_000, now)).toBe("2y");
  });

  it("does not reserve a notification slot for an unmuted session", () => {
    const handle = new SessionRow().render(document.body, {
      session: { ...session, muted: false },
      active: false,
      workingAnimation: "pulse",
    });

    expect(handle.rowEl.querySelector(".opencode-sessions-panel__notification")).toBeNull();
  });

  it("renders the trailing collapse indicator after the folder title", () => {
    const handle = new ProjectRow().render(document.body, {
      project,
      collapsed: true,
      collapseDisplay: "chevron",
      showNewSessionAction: false,
    });
    const title = handle.rowEl.querySelector(".nav-folder-title-content");
    const indicator = handle.rowEl.querySelector(".opencode-sessions-panel__collapse-indicator");

    expect(indicator).not.toBeNull();
    expect(indicator?.previousElementSibling).toBe(title);
    expect(handle.rowEl.querySelector(".collapse-icon")).toBeNull();
  });

  it("lets SessionsPanelView compose a custom session-row component", async () => {
    const openSessionTab = vi.fn();
    const service = {
      health: vi.fn(async () => undefined),
      subscribeToEvents: vi.fn(() => ({ close: vi.fn() })),
      listProjects: vi.fn(async () => [{ id: "project-1", name: "OpenCode plugin", worktree: "/workspace", sandboxes: [] }]),
      getCurrentProject: vi.fn(async () => ({ id: "project-1", name: "OpenCode plugin", worktree: "/workspace" })),
      listSessions: vi.fn(async () => [{ id: session.id, title: session.title, directory: session.directory, projectID: "project-1" }]),
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
      openSessionTab,
    } as unknown as OpenCodePlugin;
    const customSession = {
      render: (container: HTMLElement, props: { session: SessionsPanelSession }) => {
        const itemEl = container.createDiv({ cls: "custom-session" });
        const wrapper = itemEl.createDiv({ cls: "custom-session__wrapper" });
        const rowEl = wrapper.createDiv({ text: props.session.title, cls: "custom-session__row" });
        const titleEl = rowEl.createSpan({ text: props.session.title });
        return {
          itemEl,
          rowEl,
          titleEl,
          updateActive: (active: boolean) => rowEl.classList.toggle("is-active", active),
          updateStatus: vi.fn(),
        };
      },
    };
    const customProject = {
      render: (container: HTMLElement, props: { project: SessionsPanelProject; collapsed: boolean }) => {
        const itemEl = container.createDiv({ cls: "custom-project" });
        const rowEl = itemEl.createDiv({ text: props.project.name, cls: "custom-project__row" });
        const childrenEl = props.collapsed ? undefined : itemEl.createDiv({ cls: "custom-project__children" });
        return { itemEl, rowEl, childrenEl };
      },
    };
    const view = new SessionsPanelView({ app: {} } as never, plugin, { project: customProject, session: customSession });

    await view.onOpen();
    const row = view.contentEl.querySelector<HTMLElement>(".custom-session__row")!;
    await view.refresh({ showLoading: false });
    view.contentEl.querySelector<HTMLElement>(".custom-session__row")?.click();

    expect(view.contentEl.querySelector(".opencode-sessions-panel__session")).toBeNull();
    expect(view.contentEl.querySelector(".custom-session__row")).toBe(row);
    expect(openSessionTab).toHaveBeenCalledWith("session-1", "Extract panel rows");
  });
});
