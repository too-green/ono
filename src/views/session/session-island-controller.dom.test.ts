import { Component, MarkdownRenderer } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../../main";
import type { OpenCodeMessageBundle, OpenCodeTodo } from "../../services/opencode-types";
import { SessionViewModel } from "./session-view-model";
import { SessionIslandController } from "./session-island-controller";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string>; type?: string };

/** Installs the Obsidian HTMLElement helpers used by the Session Island controller. */
function installObsidianDomMethods(): void {
  const create = function (this: HTMLElement, tag: string, options: DomOptions = {}): HTMLElement {
    const element = document.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    if (options.type) element.setAttribute("type", options.type);
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
    toggleClass: { configurable: true, value: function (this: HTMLElement, className: string, force?: boolean) { this.classList.toggle(className, force); } },
    setAttr: { configurable: true, value: function (this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); } },
    setText: { configurable: true, value: function (this: HTMLElement, value: string) { this.textContent = value; } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

/** Builds a user message carrying one summarized file diff. */
function userDiffMessage(id = "u1"): OpenCodeMessageBundle {
  return {
    info: {
      id,
      role: "user",
      time: { created: 1 },
      summary: { diffs: [{ file: "src/a.ts", additions: 2, deletions: 1 }] },
    },
    parts: [],
  };
}

describe("SessionIslandController", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, element) => {
      for (const line of markdown.split("\n")) {
        const match = line.match(/^- \[(.)\] (.*)$/);
        if (match) {
          const row = element.createEl("li", { cls: "task-list-item", attr: { "data-task": match[1] ?? " " } });
          row.createEl("input", { type: "checkbox" });
          row.createSpan({ text: match[2] });
          continue;
        }
        element.textContent = markdown;
      }
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Creates and hydrates one controller with observable service calls. */
  async function setup(input: { git?: boolean; todos?: OpenCodeTodo[]; messages?: OpenCodeMessageBundle[]; marker?: string; muted?: boolean; autoApprove?: boolean; model?: SessionViewModel } = {}) {
    const service = {
      getSessionTodo: vi.fn(async () => input.todos ?? []),
      getCurrentProject: vi.fn(async () => ({ id: "p1", worktree: "/workspace", vcs: input.git ? "git" : undefined })),
      listMessages: vi.fn(async () => input.messages ?? []),
    };
    const plugin = {
      settings: {
        sessionIslandContextLabel: "percentage",
        todoInProgressStatusCharacter: input.marker ?? "",
      },
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject, refreshProject: service.getCurrentProject },
      openSessionTab: vi.fn(),
    } as unknown as OpenCodePlugin;
    const model = input.model ?? new SessionViewModel();
    model.sessionId = "s1";
    model.sessionDirectory = "/workspace";
    const controller = new SessionIslandController({
      plugin,
      component: new Component(),
      model,
      getRevertMessageId: () => undefined,
      isActive: () => true,
      isSessionMuted: () => input.muted === true,
      shouldAutoApprove: () => input.autoApprove === true,
      isAutoApproveInherited: () => false,
      onPromptActivated: vi.fn(),
    });
    const dock = document.body.createDiv();
    controller.bind("s1", "/workspace", input.messages ?? []);
    const promptContent = controller.mount(dock);
    await controller.revalidate();
    return { controller, dock, plugin, service, model, promptContent };
  }

  it("shows Prompt and Todos outside Git projects and skips the full-history request", async () => {
    const { dock, service } = await setup({ todos: [{ content: "Task", status: "pending", priority: "medium" }] });

    expect(dock.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(dock.querySelector('[data-island-tab="prompt"]')?.getAttribute("aria-selected")).toBe("true");
    expect(dock.querySelector('[data-island-tab="todos"]')?.textContent).toBe("0/1");
    expect(service.listMessages).not.toHaveBeenCalled();
  });

  it("shows Git diff tabs with last-turn and session totals", async () => {
    const { dock, service } = await setup({ git: true, messages: [userDiffMessage()] });

    expect(dock.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(dock.querySelectorAll('.opencode-session-view__island-tab-icon[aria-hidden="true"]')).toHaveLength(3);
    expect(dock.querySelector('[data-island-tab="turn"]')?.textContent).toBe("+2−1");
    expect(dock.querySelector('[data-island-tab="session"]')?.textContent).toBe("+2−1");
    expect(service.listMessages).toHaveBeenCalledOnce();
  });

  it("identifies the active detail panel for content-specific sizing", async () => {
    const { dock } = await setup({
      git: true,
      todos: [{ content: "Task", status: "pending", priority: "medium" }],
      messages: [userDiffMessage()],
    });
    const panel = dock.querySelector<HTMLElement>(".opencode-session-view__island-panel--detail")!;

    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    expect(panel.dataset.islandPanel).toBe("todos");

    (dock.querySelector('[data-island-tab="turn"]') as HTMLButtonElement).click();
    expect(panel.dataset.islandPanel).toBe("turn");

    (dock.querySelector('[data-island-tab="turn"]') as HTMLButtonElement).click();
    expect(panel.dataset.islandPanel).toBeUndefined();
  });

  it("updates todos from events without another request and uses the custom task character", async () => {
    const { controller, dock, service } = await setup({ marker: "/" });
    controller.applyTodos([{ content: "Implement roll-ups", status: "in_progress", priority: "high" }]);
    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled());

    expect(dock.querySelector('[data-island-tab="todos"]')?.textContent).toBe("0/1");
    expect(MarkdownRenderer.renderMarkdown).toHaveBeenLastCalledWith(expect.stringContaining("- [/] Implement roll-ups"), expect.any(HTMLElement), expect.any(String), expect.any(Component));
    expect(service.getSessionTodo).toHaveBeenCalledOnce();
  });

  it("highlights the unmarked in-progress task instead of the following task", async () => {
    const { dock } = await setup({
      todos: [
        { content: "Finished", status: "completed", priority: "medium" },
        { content: "Current task", status: "in_progress", priority: "high" },
        { content: "Next task", status: "pending", priority: "medium" },
      ],
    });
    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dock.querySelectorAll("li.task-list-item")).toHaveLength(3));
    const rows = Array.from(dock.querySelectorAll<HTMLElement>("li.task-list-item"));

    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toContain("Current task");
    expect(rows[1].classList.contains("is-in-progress")).toBe(true);
    expect(rows[2].textContent).toContain("Next task");
    expect(rows[2].classList.contains("is-in-progress")).toBe(false);
  });

  it("does not let an older todo fetch overwrite a newer todo event", async () => {
    let resolveTodos!: (todos: OpenCodeTodo[]) => void;
    const service = {
      getSessionTodo: vi.fn(() => new Promise<OpenCodeTodo[]>((resolve) => { resolveTodos = resolve; })),
      getCurrentProject: vi.fn(async () => ({ id: "p1", worktree: "/workspace" })),
      listMessages: vi.fn(async () => []),
    };
    const plugin = {
      settings: { sessionIslandContextLabel: "percentage", todoInProgressStatusCharacter: "" },
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject, refreshProject: service.getCurrentProject },
    } as unknown as OpenCodePlugin;
    const controller = new SessionIslandController({
      plugin,
      component: new Component(),
      model: new SessionViewModel(),
      getRevertMessageId: () => undefined,
      isActive: () => true,
      isSessionMuted: () => false,
      shouldAutoApprove: () => false,
      isAutoApproveInherited: () => false,
      onPromptActivated: vi.fn(),
    });
    const dock = document.body.createDiv();
    controller.bind("s1", "/workspace", []);
    controller.mount(dock);
    controller.applyTodos([{ content: "New event", status: "in_progress", priority: "high" }]);
    resolveTodos([{ content: "Old fetch", status: "pending", priority: "low" }]);
    await controller.revalidate();

    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(MarkdownRenderer.renderMarkdown).toHaveBeenLastCalledWith(
      expect.stringContaining("New event"),
      expect.any(HTMLElement),
      expect.any(String),
      expect.any(Component),
    ));
    expect(vi.mocked(MarkdownRenderer.renderMarkdown).mock.lastCall?.[0]).not.toContain("Old fetch");
  });

  it("hydrates a file body only after its row expands", async () => {
    const { dock } = await setup({ git: true, messages: [userDiffMessage()] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    const details = dock.querySelector("details") as HTMLDetailsElement;
    const path = details.querySelector(".opencode-session-view__rollup-file-path");
    expect(path?.nextElementSibling?.classList.contains("opencode-session-view__diff-stats")).toBe(true);
    expect(details.querySelector(".opencode-session-view__rollup-file-body")).toBeNull();

    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector(".opencode-session-view__rollup-file-body")).not.toBeNull());
    expect(details.textContent).toContain("Patch unavailable");
  });

  it("keeps only one file expanded within a diff panel", async () => {
    const message = userDiffMessage();
    message.info.summary = {
      diffs: [
        { file: "src/a.ts", additions: 2, deletions: 1 },
        { file: "src/b.ts", additions: 3, deletions: 0 },
      ],
    };
    const { dock } = await setup({ git: true, messages: [message] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    const files = Array.from(dock.querySelectorAll<HTMLDetailsElement>(".opencode-session-view__rollup-file"));

    files[0].open = true;
    files[0].dispatchEvent(new Event("toggle"));
    expect(files[0].open).toBe(true);

    files[1].open = true;
    files[1].dispatchEvent(new Event("toggle"));
    expect(files[0].open).toBe(false);
    expect(files[1].open).toBe(true);
    expect(files.filter((file) => file.open)).toHaveLength(1);
  });

  it("lets reconnect history replace a stale cached message summary", async () => {
    const fresh = userDiffMessage();
    fresh.info.summary = { diffs: [{ file: "src/fresh.ts", additions: 7, deletions: 2 }] };
    const stale = userDiffMessage();
    const service = {
      getSessionTodo: vi.fn(async () => []),
      getCurrentProject: vi.fn(async () => ({ id: "p1", worktree: "/workspace", vcs: "git" })),
      listMessages: vi.fn(async () => [fresh]),
    };
    const plugin = {
      settings: { sessionIslandContextLabel: "percentage", todoInProgressStatusCharacter: "" },
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject, refreshProject: service.getCurrentProject },
    } as unknown as OpenCodePlugin;
    const controller = new SessionIslandController({
      plugin,
      component: new Component(),
      model: new SessionViewModel(),
      getRevertMessageId: () => undefined,
      isActive: () => true,
      isSessionMuted: () => false,
      shouldAutoApprove: () => false,
      isAutoApproveInherited: () => false,
      onPromptActivated: vi.fn(),
    });
    const dock = document.body.createDiv();
    controller.bind("s1", "/workspace", [stale]);
    controller.mount(dock);
    await controller.revalidate();

    expect(dock.querySelector('[data-island-tab="session"]')?.textContent).toContain("+7−2");
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    expect(dock.textContent).toContain("fresh.ts");
    expect(dock.textContent).not.toContain("a.ts");
  });

  it("does not let a stale Markdown render mutate a newly selected panel", async () => {
    let release!: () => void;
    vi.mocked(MarkdownRenderer.renderMarkdown).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const { controller, dock } = await setup({ git: true, messages: [userDiffMessage()] });
    controller.applyTodos([{ content: "Old todo render", status: "pending", priority: "low" }]);
    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    (dock.querySelector('[data-island-tab="turn"]') as HTMLButtonElement).click();
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(dock.querySelector(".opencode-session-view__island-panel--detail")?.textContent).toContain("a.ts");
    expect(dock.querySelector(".opencode-session-view__island-panel--detail")?.textContent).not.toContain("Old todo render");
  });

  it("defers reconnect recovery until a hidden session leaf becomes active", async () => {
    let active = true;
    const service = {
      getSessionTodo: vi.fn(async () => []),
      getCurrentProject: vi.fn(async () => ({ id: "p1", worktree: "/workspace" })),
      listMessages: vi.fn(async () => []),
    };
    const plugin = {
      settings: { sessionIslandContextLabel: "percentage", todoInProgressStatusCharacter: "" },
      requireOpenCodeService: () => service,
      directoryContexts: { getProject: service.getCurrentProject, refreshProject: service.getCurrentProject },
    } as unknown as OpenCodePlugin;
    const controller = new SessionIslandController({
      plugin,
      component: new Component(),
      model: new SessionViewModel(),
      getRevertMessageId: () => undefined,
      isActive: () => active,
      isSessionMuted: () => false,
      shouldAutoApprove: () => false,
      isAutoApproveInherited: () => false,
      onPromptActivated: vi.fn(),
    });
    controller.bind("s1", "/workspace", []);
    controller.mount(document.body.createDiv());
    await controller.revalidate();
    expect(service.getSessionTodo).toHaveBeenCalledOnce();

    active = false;
    controller.recoverAfterReconnect();
    expect(service.getSessionTodo).toHaveBeenCalledOnce();
    active = true;
    controller.activate();
    await vi.waitFor(() => expect(service.getSessionTodo).toHaveBeenCalledTimes(2));
  });

  it("supports tab-strip arrow navigation and keyboard activation", async () => {
    const { dock } = await setup({ git: true, messages: [userDiffMessage()] });
    const promptTab = dock.querySelector('[data-island-tab="prompt"]') as HTMLButtonElement;
    const turnTab = dock.querySelector('[data-island-tab="turn"]') as HTMLButtonElement;
    promptTab.focus();
    promptTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(turnTab);

    turnTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(dock.querySelector('[data-island-tab="turn"]')?.getAttribute("aria-selected")).toBe("true");
    expect(dock.querySelector(".opencode-session-view__island-panel--prompt")?.getAttribute("aria-hidden")).toBe("true");
    expect(dock.querySelector(".opencode-session-view__island-panel--detail")?.getAttribute("aria-hidden")).toBe("false");
    expect(dock.querySelector(".opencode-session-view__island-panel--detail")?.classList.contains("is-rolling-up")).toBe(true);
  });

  it("focuses the selected detail panel's first row when opened", async () => {
    const model = new SessionViewModel();
    model.descendantSessions.set("child-1", { title: "Research", statusType: "busy" });
    const { dock } = await setup({ model });

    (dock.querySelector('[data-island-tab="subagents"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.activeElement).toBe(dock.querySelector(".opencode-session-view__island-subagent")));
  });

  it("navigates subagent rows and opens the selected session with Space", async () => {
    const model = new SessionViewModel();
    model.descendantSessions.set("child-1", { title: "Research", directory: "/child", statusType: "busy" });
    model.descendantSessions.set("child-2", { title: "Review", directory: "/child", statusType: "idle" });
    const { dock, plugin } = await setup({ model });
    (dock.querySelector('[data-island-tab="subagents"]') as HTMLButtonElement).click();
    const rows = Array.from(dock.querySelectorAll<HTMLButtonElement>(".opencode-session-view__island-subagent"));

    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);

    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(dock.querySelector("[data-subagent-response]")).toBeNull();
    expect(plugin.openSessionTab).not.toHaveBeenCalled();

    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(plugin.openSessionTab).toHaveBeenCalledTimes(1);
    expect(plugin.openSessionTab).toHaveBeenCalledWith("child-1", "Research");
  });

  it("navigates diff file rows and enters an expanded file's line cursor", async () => {
    const message = userDiffMessage();
    message.info.summary = {
      diffs: [
        { file: "src/a.ts", additions: 2, deletions: 1, patch: "+a" },
        { file: "src/b.ts", additions: 1, deletions: 0, patch: "+b" },
      ],
    };
    const { dock } = await setup({ git: true, messages: [message] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    const summaries = Array.from(dock.querySelectorAll<HTMLElement>(".opencode-session-view__rollup-file-summary"));

    await vi.waitFor(() => expect(document.activeElement).toBe(summaries[0]));
    summaries[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(summaries[1]);
    summaries[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const files = Array.from(dock.querySelectorAll<HTMLDetailsElement>(".opencode-session-view__rollup-file"));
    expect(files[1].open).toBe(true);
    const body = await vi.waitFor(() => files[1].querySelector<HTMLElement>(".opencode-session-view__rollup-file-body")!);
    await vi.waitFor(() => expect(body.querySelectorAll("[data-diff-row]")).toHaveLength(1));
    const enterEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    summaries[1].dispatchEvent(enterEvent);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body);
    expect(body.getAttribute("aria-activedescendant")).toBe(body.querySelector("[data-diff-row]")?.id);

    body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(files[1].open).toBe(false);
    expect(document.activeElement).toBe(summaries[1]);
  });

  it("expands folded context and collapses it from any restored line", async () => {
    const message = userDiffMessage();
    message.info.summary = {
      diffs: [{
        file: "src/a.ts",
        additions: 1,
        deletions: 1,
        patch: [
          "@@ -1,12 +1,12 @@",
          ...Array.from({ length: 5 }, (_, index) => ` before ${index + 1}`),
          "-old",
          "+new",
          ...Array.from({ length: 5 }, (_, index) => ` after ${index + 1}`),
        ].join("\n"),
      }],
    };
    const { dock } = await setup({ git: true, messages: [message] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    const details = dock.querySelector<HTMLDetailsElement>(".opencode-session-view__rollup-file")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const body = await vi.waitFor(() => details.querySelector<HTMLElement>(".opencode-session-view__rollup-file-body")!);
    await vi.waitFor(() => expect(body.querySelectorAll("[data-diff-folded]")).toHaveLength(2));
    const firstFold = body.querySelector<HTMLElement>("[data-diff-folded]")!;
    body.focus();
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(body.getAttribute("aria-activedescendant")).toBe(firstFold.id);
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));

    const restored = Array.from(body.querySelectorAll<HTMLElement>("[data-diff-fold-id]"));
    expect(restored).toHaveLength(2);
    expect(body.getAttribute("aria-activedescendant")).toBe(restored[0].id);
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(body.getAttribute("aria-activedescendant")).toBe(restored[1].id);
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));

    expect(body.querySelectorAll("[data-diff-fold-id]")).toHaveLength(0);
    expect(body.querySelectorAll("[data-diff-folded]")).toHaveLength(2);
    expect(body.querySelector<HTMLElement>(`#${body.getAttribute("aria-activedescendant")}`)?.hasAttribute("data-diff-folded")).toBe(true);
  });

  it("collapses an expanded file when another tab trigger or the cycle command is used", async () => {
    const message = userDiffMessage();
    message.info.summary = { diffs: [{ file: "src/a.ts", additions: 1, deletions: 0, patch: "+a" }] };
    const { controller, dock } = await setup({ git: true, todos: [{ content: "Task", status: "pending", priority: "medium" }], messages: [message] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    let details = dock.querySelector<HTMLDetailsElement>(".opencode-session-view__rollup-file")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    (dock.querySelector('[data-island-tab="todos"]') as HTMLButtonElement).click();
    expect(details.open).toBe(false);
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    details = dock.querySelector<HTMLDetailsElement>(".opencode-session-view__rollup-file")!;
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    controller.cycleTab();
    expect(details.open).toBe(false);
  });

  it("collapses the active panel without unmounting Prompt and reopens it from the same trigger", async () => {
    const { dock, promptContent } = await setup();
    const marker = promptContent.createSpan({ text: "Draft stays mounted" });
    const promptPanel = dock.querySelector<HTMLElement>(".opencode-session-view__island-panel--prompt")!;
    const detailPanel = dock.querySelector<HTMLElement>(".opencode-session-view__island-panel--detail")!;

    (dock.querySelector('[data-island-tab="prompt"]') as HTMLButtonElement).click();
    const collapsedPromptTab = dock.querySelector('[data-island-tab="prompt"]') as HTMLButtonElement;

    expect(collapsedPromptTab.getAttribute("aria-selected")).toBe("false");
    expect(collapsedPromptTab.tabIndex).toBe(0);
    expect(promptPanel.getAttribute("aria-hidden")).toBe("true");
    expect(detailPanel.getAttribute("aria-hidden")).toBe("true");
    expect(promptContent.contains(marker)).toBe(true);

    collapsedPromptTab.click();

    expect(dock.querySelector('[data-island-tab="prompt"]')?.getAttribute("aria-selected")).toBe("true");
    expect(promptPanel.getAttribute("aria-hidden")).toBe("false");
    expect(promptContent.contains(marker)).toBe(true);
  });

  it("keeps bottom navigation anchored while cycling the mounted Prompt panel", async () => {
    const { controller, dock, promptContent } = await setup({ todos: [{ content: "Task", status: "pending", priority: "medium" }] });
    const marker = promptContent.createSpan({ text: "Draft stays mounted" });
    const island = dock.querySelector<HTMLElement>(".opencode-session-view__island")!;
    const panels = island.querySelector<HTMLElement>(".opencode-session-view__island-panels")!;
    const tabs = island.querySelector<HTMLElement>(".opencode-session-view__island-tabs")!;
    const promptPanel = promptContent.closest<HTMLElement>(".opencode-session-view__island-panel--prompt")!;

    expect(panels.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(controller.canCycleTabs()).toBe(true);
    controller.cycleTab();
    expect(dock.querySelector('[data-island-tab="todos"]')?.getAttribute("aria-selected")).toBe("true");
    expect(promptContent.contains(marker)).toBe(true);
    expect(promptPanel.getAttribute("aria-hidden")).toBe("true");

    controller.cycleTab();
    expect(dock.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(0);
    expect(promptContent.contains(marker)).toBe(true);
    expect(promptPanel.getAttribute("aria-hidden")).toBe("true");

    controller.cycleTab();
    expect(dock.querySelector('[data-island-tab="prompt"]')?.getAttribute("aria-selected")).toBe("true");
    expect(promptContent.contains(marker)).toBe(true);
    expect(promptPanel.getAttribute("aria-hidden")).toBe("false");
    expect(promptPanel.classList.contains("is-rolling-up")).toBe(true);
  });

  it("cycles between Prompt and collapsed state when Prompt is the only trigger", async () => {
    const { controller, dock } = await setup();

    expect(controller.canCycleTabs()).toBe(true);
    controller.cycleTab();
    expect(dock.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(0);
    expect(dock.querySelector(".opencode-session-view__island-panel--prompt")?.getAttribute("aria-hidden")).toBe("true");

    controller.cycleTab();
    expect(dock.querySelector('[data-island-tab="prompt"]')?.getAttribute("aria-selected")).toBe("true");
    expect(dock.querySelector(".opencode-session-view__island-panel--prompt")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("shows context and Prompt state indicators without remounting the island", async () => {
    const model = new SessionViewModel();
    model.loadedMessages = [{ info: { id: "a1", role: "assistant", tokens: { input: 50, output: 0 } }, parts: [] }];
    model.selectedModel = { providerID: "provider", modelID: "model" };
    model.availableModels = [{ providerID: "provider", modelID: "model", limit: { context: 100 } }];
    const { controller, dock, plugin } = await setup({ model, muted: true, autoApprove: true });
    const root = dock.querySelector<HTMLElement>(".opencode-session-view__island")!;

    expect(root.querySelector('[data-island-tab="prompt"]')?.textContent).toContain("50%");
    expect(root.querySelector('[data-island-tab="prompt"]')?.textContent).not.toContain("context");
    expect(root.querySelectorAll(".opencode-session-view__island-tab-indicator")).toHaveLength(2);

    plugin.settings.sessionIslandContextLabel = "tokens";
    controller.refreshDisplay();

    expect(dock.querySelector(".opencode-session-view__island")).toBe(root);
    expect(root.querySelector('[data-island-tab="prompt"]')?.textContent).toContain("50");
    expect(root.querySelector('[data-island-tab="prompt"]')?.textContent).not.toContain("100");
  });

  it("tracks working subagents and opens the selected child session", async () => {
    const model = new SessionViewModel();
    model.descendantSessions.set("child-1", { title: "Research", statusType: "busy" });
    model.descendantSessions.set("child-2", { title: "Review", statusType: "idle" });
    const { controller, dock, plugin } = await setup({ model });

    expect(dock.querySelector('[data-island-tab="subagents"]')?.textContent).toContain("1 working...");
    (dock.querySelector('[data-island-tab="subagents"]') as HTMLButtonElement).click();
    const rows = dock.querySelectorAll<HTMLButtonElement>(".opencode-session-view__island-subagent");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".opencode-session-view__island-subagent-status .opencode-status-badge--working")).not.toBeNull();
    expect(rows[0].getAttribute("aria-busy")).toBe("true");
    expect(rows[0].textContent).not.toContain("Working");
    expect(rows[1].textContent).toContain("Idle");
    rows[0].click();
    expect(plugin.openSessionTab).toHaveBeenCalledWith("child-1", "Research");

    model.descendantSessions.get("child-1")!.statusType = "idle";
    controller.refreshState();
    expect(dock.querySelector('[data-island-tab="subagents"]')?.textContent).toContain("2");
    expect(dock.querySelector('[data-island-tab="subagents"]')?.textContent).not.toContain("Subagents");
  });

  it("gates large patches until Render anyway is selected", async () => {
    const large = userDiffMessage();
    large.info.summary = { diffs: [{ file: "src/large.ts", patch: "+line", additions: 501, deletions: 0 }] };
    const { dock } = await setup({ git: true, messages: [large] });
    (dock.querySelector('[data-island-tab="session"]') as HTMLButtonElement).click();
    const details = dock.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const render = await vi.waitFor(() => {
      const button = Array.from(details.querySelectorAll("button")).find((item) => item.textContent === "Render anyway");
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    });
    render.click();
    await vi.waitFor(() => expect(details.textContent).not.toContain("501 changed lines"));
  });
});
