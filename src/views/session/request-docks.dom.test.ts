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
    expect(owner?.getAttribute("aria-label")).toBe("Open subagent session Research API");
    owner?.click();
    expect(plugin.openSessionTab).toHaveBeenCalledWith("child", "Research API");
  });

  it("keeps parent-owned requests first and ignores requests outside the loaded tree", () => {
    const { model, controller, container, requestCanonicalSync } = setup();
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["child"], metadata: {}, always: [] });
    controller.ingestPermissionAsked({ id: "parent", sessionID: "parent", permission: "edit", patterns: ["parent"], metadata: {}, always: [] });
    controller.ingestPermissionAsked({ id: "foreign", sessionID: "foreign", permission: "read", patterns: ["foreign"], metadata: {}, always: [] });

    expect(model.pendingPermissions.map((request) => request.id)).toEqual(["child", "parent"]);
    const summaries = container.querySelectorAll(".opencode-session-view__request-summary");
    expect(summaries[0]?.textContent).toBe("parent");
    expect(summaries[1]?.textContent).toBe("child");
    expect(container.textContent).not.toContain("foreign");
    expect(model.unscopedPendingPermissions.map((request) => request.id)).toEqual(["foreign"]);
    expect(requestCanonicalSync).toHaveBeenCalledOnce();
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

  it("does not apply a parent's auto-approval setting to child permissions", () => {
    const { controller, service, container } = setup(["parent"]);
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] });

    expect(service.replyPermission).not.toHaveBeenCalled();
    expect(container.textContent).toContain("npm test");
  });

  it("applies the child owner's auto-approval setting from an open parent view", async () => {
    const { controller, plugin, service } = setup(["child"]);
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] });

    await vi.waitFor(() => expect(service.replyPermission).toHaveBeenCalledWith("child", "once", "/child-work"));
    expect(plugin.settleSessionRequest).toHaveBeenCalledWith("child");
  });

  it("retains every visible copy when an automatic approval fails", async () => {
    const { model, controller, plugin, service } = setup(["child"]);
    service.replyPermission.mockRejectedValueOnce(new Error("failed"));
    controller.ingestPermissionAsked({ id: "child", sessionID: "child", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] });

    await vi.waitFor(() => expect(plugin.finishSessionRequestResponse).toHaveBeenCalledWith("child"));
    expect(model.pendingPermissions.map((request) => request.id)).toEqual(["child"]);
  });
});
