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
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

/** Builds the minimal rendering context needed by one tool block. */
function context() {
  return { component: {} as Component, sessionId: "session-1", sessionDirectory: "/work" };
}

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
    expect(container.textContent).toContain("running");
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

  it("keeps failed patches as one expandable error block", async () => {
    const container = document.createElement("div");
    await renderToolCall(container, {
      type: "tool",
      tool: "apply_patch",
      state: { status: "error", input: { patchText: "bad patch" }, error: "Patch rejected" },
    }, context());

    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelector("summary")?.textContent).toContain("Patch failed");
  });
});
