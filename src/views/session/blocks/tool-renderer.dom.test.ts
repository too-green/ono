import { MarkdownRenderer, type Component } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../../services/opencode-types";
import { renderToolCall } from "./tool-renderer";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by tool renderers. */
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
    setText: { configurable: true, value: function (this: HTMLElement, text: string) { this.textContent = text; } },
    addClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); } },
    setAttr: { configurable: true, value: function (this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

/** Builds the minimal rendering context needed by one tool block. */
function context() {
  return { component: {} as Component, sessionId: "session-1", sessionDirectory: "/work" };
}

describe("shared tool container", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      container.textContent = markdown;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([
    ["bash", { command: "npm test" }, "npm test"],
    ["glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["grep", { pattern: "renderTool" }, "renderTool"],
    ["skill", { name: "review" }, "review"],
    ["todowrite", { todos: [{ status: "completed" }, { status: "pending" }] }, "1/2 done"],
    ["unknown_mcp", { query: "hidden while collapsed" }, "unknown_mcp"],
  ])("renders %s in the common icon-and-detail summary", async (tool, input, label) => {
    const container = document.createElement("div");
    await renderToolCall(container, { type: "tool", tool, state: { status: "completed", input, output: "result" } }, context());

    const summary = container.querySelector("summary");
    expect(summary?.querySelector(".opencode-session-view__tool-icon")).not.toBeNull();
    expect(summary?.textContent).toBe(label);
  });

  it("preserves read path typography inside the common summary", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "/work/src/main.ts" }, output: "1: code" },
    }, context());

    expect(container.querySelector(".opencode-session-view__tool-path-prefix")?.textContent).toBe("src/");
    expect(container.querySelector(".opencode-session-view__tool-path-basename")?.textContent).toBe("main.ts");
  });

  it("renders directory read paths entirely as faint text", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/work/src/components" },
        output: "<path>/work/src/components</path>\n<type>directory</type>\n<entries>\nbutton.ts\n</entries>",
        metadata: { display: { type: "directory", path: "/work/src/components" } },
      },
    }, context());

    expect(container.querySelector(".opencode-session-view__tool-path-prefix")?.textContent).toBe("src/components");
    expect(container.querySelector(".opencode-session-view__tool-path-basename")).toBeNull();
  });

  it("shows the exact offset/limit line range faintly after a read file name", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/work/src/main.ts", offset: 20, limit: 10 },
        output: "<type>file</type>\n<content>\n20: first\n21: second\n</content>",
        metadata: { display: { type: "file", path: "/work/src/main.ts", lineStart: 20, lineEnd: 21 } },
      },
    }, context());

    const range = container.querySelector(".opencode-session-view__read-range")!;
    const basename = container.querySelector(".opencode-session-view__tool-path-basename")!;
    expect(range.textContent).toBe("(20-21)");
    expect(basename.nextElementSibling).toBe(range);
    expect(basename.textContent).toBe("main.ts");
  });

  it("does not show the default read line window when offset and limit are omitted", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/work/src/main.ts" },
        metadata: { display: { type: "file", path: "/work/src/main.ts", lineStart: 1, lineEnd: 20 } },
      },
    }, context());

    expect(container.querySelector(".opencode-session-view__read-range")).toBeNull();
  });

  it("shows synthetic new-file write totals in the collapsed shared container", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      id: "write-part",
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: "/work/src/new.ts", content: "first\nsecond\n" },
        metadata: { exists: false },
        output: "Wrote file successfully.",
      },
    }, context());

    const details = container.querySelector<HTMLDetailsElement>("details.opencode-session-view__tool")!;
    expect(details.querySelector("summary")?.textContent).toContain("src/new.ts+2−0");
    expect(details.querySelector(".opencode-session-view__file-operation--new .opencode-session-view__file-operation-full")?.textContent).toBe("New");
    expect(details.querySelector(".opencode-session-view__file-operation--new .opencode-session-view__file-operation-compact")?.textContent).toBe("N");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector(".opencode-session-view__tool-raw-name")?.textContent).toBe("write"));
    expect(details.querySelector(".opencode-session-view__raw-toggle")?.textContent).toBe("Show raw");
  });

  it.each([
    ["edit", { filePath: "/work/src/file.ts", oldString: "old", newString: "new" }],
  ])("keeps specialized %s rendering inside the shared tool container", async (tool, input) => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      id: `${tool}-part`,
      type: "tool",
      tool,
      state: { status: "completed", input, output: "complete" },
    }, context());

    const details = container.querySelector<HTMLDetailsElement>("details.opencode-session-view__tool")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector(".opencode-session-view__tool-raw-name")?.textContent).toBe(tool));
    expect(details.querySelector(".opencode-session-view__raw-toggle")?.textContent).toBe("Show raw");
  });

  it("renders task metadata and opens its running child through the session-title action", async () => {
    const container = document.createElement("div");
    const openSession = vi.fn();
    await renderToolCall(container, {
      id: "task-part",
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { description: "Inspect rendering", subagent_type: "explorer-terra" },
        metadata: { sessionId: "child-1" },
      },
    }, {
      ...context(),
      resolveSession: (sessionId) => sessionId === "child-1" ? { title: "Renderer audit (@explorer-terra subagent)" } : undefined,
      openSession,
    });

    const details = container.querySelector<HTMLDetailsElement>("details.opencode-session-view__tool--task")!;
    const action = details.querySelector<HTMLAnchorElement>(".opencode-session-view__task-session")!;
    const description = details.querySelector<HTMLElement>(".opencode-session-view__task-description")!;
    expect(details.querySelector(".opencode-session-view__task-description")?.textContent).toBe("Inspect rendering");
    expect(details.querySelector(".opencode-session-view__task-agent")).toBeNull();
    expect(description.classList).toContain("opencode-session-view__tool-subtitle");
    expect(details.querySelector(".opencode-session-view__tool-status")).toBeNull();
    expect(action.tagName).toBe("A");
    expect(action.textContent).toBe("Renderer audit (@explorer-terra subagent)");
    expect(action.getAttribute("aria-label")).toBe("Open subagent session Renderer audit (@explorer-terra subagent)");
    expect(action.nextElementSibling).toBe(description);

    action.click();
    expect(openSession).toHaveBeenCalledWith("child-1", "Renderer audit (@explorer-terra subagent)");
    expect(details.open).toBe(false);
  });

  it("waits for canonical child identity before showing task navigation", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { description: "Inspect rendering", subagent_type: "explorer-terra" },
        metadata: { sessionId: "child-1" },
      },
    }, { ...context(), resolveSession: () => undefined, openSession: vi.fn() });

    expect(container.querySelector(".opencode-session-view__task-session")).toBeNull();
  });

  it("switches one expanded fallback block between formatted output and the complete raw part", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      id: "part-123",
      type: "tool",
      tool: "deploy",
      state: { status: "completed", input: { environment: "staging" }, output: "deployed" },
    }, context());
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector(".opencode-session-view__tool-output-raw")?.textContent).toBe("deployed"));

    const toggle = details.querySelector<HTMLButtonElement>(".opencode-session-view__raw-toggle")!;
    expect(details.querySelector(".opencode-session-view__tool-raw-name")?.textContent).toBe("deploy");
    expect(toggle.textContent).toBe("Show raw");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    const raw = details.querySelector(".opencode-session-view__tool-body-content")!;
    await vi.waitFor(() => expect(raw.textContent).toContain("part-123"));
    expect(raw.textContent).toContain('"tool": "deploy"');
    expect(raw.textContent).toContain('"input"');
    expect(raw.textContent).toContain('"output": "deployed"');
    expect(raw.querySelectorAll(".opencode-session-view__markdown")).toHaveLength(1);
    expect(raw.querySelector(".opencode-session-view__tool-section-title")).toBeNull();
  });

  it("applies a custom icon/argument mapping without changing the shared container", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "deploy",
      state: { status: "completed", input: { environment: "production" }, output: "ok" },
    }, {
      ...context(),
      customToolDisplays: [{ tool: "deploy", icon: "rocket", displayArgument: "environment" }],
    });

    expect(container.querySelector("summary")?.textContent).toBe("production");
    expect(container.querySelector(".opencode-session-view__tool-icon")).not.toBeNull();
  });
});

describe("apply_patch tool rendering", () => {
  beforeEach(() => {
    installObsidianDomMethods();
    vi.spyOn(MarkdownRenderer, "renderMarkdown").mockImplementation(async (markdown, container) => {
      container.textContent = markdown;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders running patches as one non-expandable placeholder", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "apply_patch",
      state: { status: "running", input: { patchText: "*** Begin Patch\n*** End Patch" } },
    }, context());

    expect(container.querySelectorAll(".opencode-session-view__tool")).toHaveLength(1);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Patching files…");
    expect(container.querySelector(".opencode-session-view__tool-status")).toBeNull();
  });

  it("renders one collapsed edit-style block per completed patch file", async () => {
    const container = document.createElement("div");
    const state: JsonObject = {
      status: "completed",
      input: { patchText: "patch" },
      metadata: {
        files: [
          {
            filePath: "/work/src/a.ts",
            relativePath: "src/a.ts",
            type: "update",
            patch: "@@ -1 +1 @@\n-old\n+new",
            additions: 1,
            deletions: 1,
          },
          {
            filePath: "/work/src/old.ts",
            relativePath: "src/new.ts",
            movePath: "/work/src/new.ts",
            type: "move",
            patch: "@@ -1 +1 @@\n-before\n+after",
            additions: 1,
            deletions: 1,
          },
        ],
        diagnostics: {
          "/work/src/new.ts": [{ severity: 1, message: "Move error", range: { start: { line: 2, character: 4 } } }],
        },
      },
      output: "Success",
    };

    await renderToolCall(container, { type: "tool", tool: "apply_patch", state }, context());

    const group = container.querySelector(".opencode-session-view__patch-files");
    const blocks = group?.querySelectorAll<HTMLDetailsElement>(":scope > details") ?? [];
    expect(group?.getAttribute("role")).toBe("group");
    expect(blocks).toHaveLength(2);
    expect([...blocks].every((block) => !block.open)).toBe(true);
    expect(blocks[0].textContent).toContain("src/a.ts");
    expect(blocks[0].textContent).toContain("+1");
    expect(blocks[0].textContent).toContain("−1");
    expect(blocks[1].textContent).toContain("Moved");
    expect(blocks[1].querySelector("summary")?.textContent).toContain("src/new.ts+1−1Moved");
    expect(blocks[1].querySelector("summary")?.textContent).not.toContain("src/old.ts");

    blocks[0].open = true;
    blocks[0].dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(blocks[0].querySelector(".opencode-session-view__diff-table")).not.toBeNull());
    expect(blocks[0].querySelector(".opencode-session-view__tool-raw-name")?.textContent).toBe("apply_patch");
    expect(blocks[0].querySelector(".opencode-session-view__raw-toggle")?.textContent).toBe("Show raw");
    expect(blocks[0].textContent).not.toContain("Move error");

    blocks[1].open = true;
    blocks[1].dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(blocks[1].querySelector(".opencode-session-view__diff-table")).not.toBeNull());
    expect(blocks[1].textContent).toContain("Moved fromsrc/old.ts");
    expect(blocks[1].textContent).toContain("[3:5]");
    expect(blocks[1].textContent).toContain("Move error");
  });

  it("renders pure moves with paths but without empty diff tables or stats", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "apply_patch",
      state: {
        status: "completed",
        metadata: {
          files: [{
            filePath: "/work/src/before.ts",
            relativePath: "src/after.ts",
            movePath: "/work/src/after.ts",
            type: "move",
            patch: "",
            additions: 0,
            deletions: 0,
          }],
          diagnostics: {},
        },
      },
    }, context());

    const block = container.querySelector<HTMLDetailsElement>("details");
    expect(block?.querySelector("summary")?.textContent).toContain("src/after.tsMoved");
    expect(block?.querySelector("summary")?.textContent).not.toContain("src/before.ts");
    expect(block?.querySelector(".opencode-session-view__diff-stats")).toBeNull();

    block!.open = true;
    block!.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(block?.querySelector(".opencode-session-view__move-source")).not.toBeNull());
    expect(block?.textContent).toContain("Moved fromsrc/before.ts");
    expect(block?.querySelector(".opencode-session-view__diff-table")).toBeNull();
  });

  it("labels added, deleted, and moved patch files with responsive operation text", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "apply_patch",
      state: {
        status: "completed",
        metadata: {
          files: [
            { relativePath: "new.ts", type: "add", patch: "@@ -0,0 +1 @@\n+new", additions: 1, deletions: 0 },
            { relativePath: "old.ts", type: "delete", patch: "@@ -1 +0,0 @@\n-old", additions: 0, deletions: 1 },
            { filePath: "before.ts", relativePath: "after.ts", movePath: "after.ts", type: "move", patch: "", additions: 0, deletions: 0 },
          ],
        },
      },
    }, context());

    const operations = Array.from(container.querySelectorAll<HTMLElement>(".opencode-session-view__file-operation"));
    expect(operations.map((operation) => operation.getAttribute("aria-label"))).toEqual(["New", "Deleted", "Moved"]);
    expect(operations.map((operation) => operation.querySelector(".opencode-session-view__file-operation-compact")?.textContent)).toEqual(["N", "D", "M"]);
    expect(operations[0].classList).toContain("opencode-session-view__file-operation--new");
    expect(operations[1].classList).toContain("opencode-session-view__file-operation--deleted");
    expect(operations[2].classList).toContain("opencode-session-view__file-operation--moved");
  });

  it("keeps failed patches as one expandable error block", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "apply_patch",
      state: { status: "error", input: { patchText: "bad patch" }, error: "Patch rejected" },
    }, context());

    expect(container.querySelectorAll("details")).toHaveLength(1);
    const failure = container.querySelector<HTMLElement>(".opencode-session-view__tool-subtitle");
    expect(failure?.textContent).toBe("Patch failed");
    expect(container.querySelector(".opencode-session-view__tool-title")).toBeNull();
    expect(container.querySelector(".opencode-session-view__tool--error > .opencode-session-view__tool-summary .opencode-session-view__tool-icon")).not.toBeNull();
  });
});
