import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../../main";
import { RequestDocksController } from "./request-docks";
import { SessionViewModel } from "./session-view-model";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by request dock rendering. */
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
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
    toggleClass: { configurable: true, value: function (this: HTMLElement, cls: string, force?: boolean) { this.classList.toggle(cls, force); } },
  });
}

/** Builds a mounted request controller with an observable plugin boundary. */
function setup(autoApproveSessions: string[] = []) {
  const model = new SessionViewModel();
  model.sessionId = "parent";
  model.sessionDirectory = "/work";
  model.descendantSessions.set("child", { title: "Research API", directory: "/child-work" });
  const service = {
    replyPermission: vi.fn(async () => true),
    replyQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
  };
  const plugin = {
    settings: { sessionAutoApprove: Object.fromEntries(autoApproveSessions.map((sessionId) => [sessionId, true])) },
    openSessionTab: vi.fn(async () => undefined),
    requireOpenCodeService: vi.fn(() => service),
    isSessionRequestResponding: vi.fn(() => false),
    beginSessionRequestResponse: vi.fn(() => true),
    finishSessionRequestResponse: vi.fn(),
    settleSessionRequest: vi.fn(),
    shouldSuppressPermissionRequest: vi.fn(() => false),
    getSessionAutoApproveState: vi.fn((sessionId?: string) => ({
      enabled: !!sessionId && autoApproveSessions.includes(sessionId),
      inherited: false,
      sourceSessionId: autoApproveSessions.includes(sessionId ?? "") ? sessionId : undefined,
    })),
  } as unknown as OpenCodePlugin;
  const onChanged = vi.fn();
  const requestCanonicalSync = vi.fn();
  const controller = new RequestDocksController({ plugin, model, onChanged, requestCanonicalSync });
  const container = document.body.createDiv();
  controller.mount(container);
  return { model, plugin, service, controller, container, requestCanonicalSync };
}

describe("RequestDocksController descendant routing", () => {
  beforeEach(() => installObsidianDomMethods());

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("surfaces child requests with owner navigation and blocks the parent composer", () => {
    const { model, plugin, controller, container } = setup();
    controller.ingestPermissionAsked({
      id: "permission-child",
      sessionID: "child",
      permission: "bash",
      patterns: ["npm test"],
      metadata: {},
      always: [],
    });

    expect(model.pendingPermissions).toHaveLength(1);
    expect(controller.isComposerBlocked()).toBe(true);
    expect(container.textContent).toContain("Subagent: Research API");
    const owner = container.querySelector<HTMLButtonElement>(".opencode-session-view__request-owner");
    expect(owner?.getAttribute("aria-label")).toBeNull();
    expect(owner?.getAttribute("title")).toBeNull();
    owner?.click();
    expect(plugin.openSessionTab).toHaveBeenCalledWith("child", "Research API");
  });

  it("keeps the active request stable and ignores requests outside the loaded tree", () => {
    const { model, controller, container, requestCanonicalSync } = setup();
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["child"], metadata: {}, always: [] });
    controller.ingestPermissionAsked({ id: "parent", sessionID: "parent", permission: "edit", patterns: ["parent"], metadata: {}, always: [] });
    controller.ingestPermissionAsked({ id: "foreign", sessionID: "foreign", permission: "read", patterns: ["foreign"], metadata: {}, always: [] });

    expect(model.pendingPermissions.map((request) => request.id)).toEqual(["child", "parent"]);
    const summaries = container.querySelectorAll(".opencode-session-view__request-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.textContent).toBe("child");
    expect(container.textContent).toContain("2 pending");
    expect(container.textContent).not.toContain("parent");
    expect(container.textContent).not.toContain("foreign");
    expect(model.unscopedPendingPermissions.map((request) => request.id)).toEqual(["foreign"]);
    expect(requestCanonicalSync).toHaveBeenCalledOnce();

    controller.ingestPermissionReplied("child");
    expect(container.querySelectorAll(".opencode-session-view__request-dock")).toHaveLength(1);
    expect(container.textContent).toContain("parent");
  });

  it("queues permission and question dialogs in one interaction flow", () => {
    const { model, controller, container } = setup();
    controller.ingestPermissionAsked({ id: "permission-parent", sessionID: "parent", permission: "edit", patterns: ["first"], metadata: {}, always: [] });
    controller.ingestQuestionAsked({
      id: "question-parent",
      sessionID: "parent",
      questions: [{ header: "Next", question: "Continue?", options: [], multiple: false, custom: true }],
    });

    expect(model.pendingPermissions).toHaveLength(1);
    expect(model.pendingQuestions).toHaveLength(1);
    expect(container.querySelectorAll(".opencode-session-view__request-dock")).toHaveLength(1);
    expect(container.textContent).toContain("first");
    expect(container.textContent).toContain("2 pending");
    expect(container.textContent).not.toContain("Continue?");

    controller.ingestPermissionReplied("permission-parent");

    expect(container.querySelectorAll(".opencode-session-view__request-dock")).toHaveLength(1);
    expect(container.textContent).not.toContain("first");
    expect(container.textContent).toContain("Continue?");
    expect(container.textContent).not.toContain("pending");
  });

  it("promotes a held request after descendant discovery confirms its owner", () => {
    const { model, controller, container } = setup();
    controller.ingestQuestionAsked({ id: "nested-question", sessionID: "nested", questions: [] });
    expect(model.pendingQuestions).toEqual([]);
    expect(container.textContent).not.toContain("nested-question");

    model.descendantSessions.set("nested", { title: "Nested worker", directory: "/nested-work" });
    controller.reconcileRequestScope();
    controller.refresh();
    expect(model.pendingQuestions.map((request) => request.id)).toEqual(["nested-question"]);
    expect(model.unscopedPendingQuestions).toEqual([]);
    expect(container.textContent).toContain("Subagent: Nested worker");
  });

  it("renders only permissions that the central coordinator surfaces", () => {
    const { controller, plugin, service, container } = setup(["parent"]);
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] });

    expect(service.replyPermission).not.toHaveBeenCalled();
    expect(container.textContent).toContain("npm test");
    vi.mocked(plugin.shouldSuppressPermissionRequest).mockReturnValue(true);
    controller.refresh();
    expect(container.textContent).not.toContain("npm test");
  });

  it("never submits automatic replies from duplicate parent or child views", () => {
    const { controller, plugin, service } = setup(["child"]);
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] });

    expect(service.replyPermission).not.toHaveBeenCalled();
    expect(plugin.beginSessionRequestResponse).not.toHaveBeenCalled();
  });

  it("preserves question input state and focus across canonical refreshes", () => {
    const { controller, container } = setup();
    controller.ingestQuestionAsked({
      id: "question-parent",
      sessionID: "parent",
      questions: [{
        header: "Choice",
        question: "How should this continue?",
        multiple: true,
        custom: true,
        options: [{ label: "Carefully", description: "Keep state" }],
      }],
    });
    const dock = container.querySelector<HTMLElement>('[data-request-key="question:question-parent"]')!;
    const option = dock.querySelector<HTMLInputElement>(".opencode-session-view__question-option input")!;
    const custom = dock.querySelector<HTMLInputElement>(".opencode-session-view__question-custom")!;
    option.checked = true;
    custom.value = "Preserve this draft";
    custom.focus();
    controller.ingestPermissionAsked({ id: "permission-after-question", sessionID: "parent", permission: "bash", patterns: ["later"], metadata: {}, always: [] });

    controller.refresh();

    expect(container.querySelector('[data-request-key="question:question-parent"]')).toBe(dock);
    expect(option.checked).toBe(true);
    expect(custom.value).toBe("Preserve this draft");
    expect(document.activeElement).toBe(custom);
    expect(container.textContent).toContain("2 pending");
    expect(container.textContent).not.toContain("later");
  });
});
