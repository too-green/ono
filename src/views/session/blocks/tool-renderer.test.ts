import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../services/opencode-types";
import {
  contextSummary,
  customToolDisplay,
  hasToolIcon,
  isContextLocationTool,
  isPathTool,
  normalizedToolName,
  toolIcon,
  toolInfo,
  toolTitle,
} from "./tool-renderer";
import { taskSessionId } from "./specialized-tool-renderers";

describe("normalizedToolName", () => {
  it("lowercases the tool field", () => {
    expect(normalizedToolName({ tool: "Read" })).toBe("read");
    expect(normalizedToolName({ tool: "EDIT" })).toBe("edit");
  });

  it("falls back to name then 'tool'", () => {
    expect(normalizedToolName({ name: "Bash" })).toBe("bash");
    expect(normalizedToolName({})).toBe("tool");
  });
});

describe("toolTitle", () => {
  it("maps known tool names to display titles", () => {
    expect(toolTitle("read", empty)).toBe("Read");
    expect(toolTitle("read_file", empty)).toBe("Read");
    expect(toolTitle("glob", empty)).toBe("Search");
    expect(toolTitle("grep", empty)).toBe("Search");
    expect(toolTitle("list", empty)).toBe("List");
    expect(toolTitle("bash", empty)).toBe("Shell");
    expect(toolTitle("shell", empty)).toBe("Shell");
    expect(toolTitle("edit", empty)).toBe("Edit");
    expect(toolTitle("write", empty)).toBe("Write");
    expect(toolTitle("apply_patch", empty)).toBe("Patch");
    expect(toolTitle("todo", empty)).toBe("Todos");
    expect(toolTitle("todowrite", empty)).toBe("Todos");
  });

  it("task falls back to input.description then 'Task'", () => {
    expect(toolTitle("task", { description: "do thing" })).toBe("do thing");
    expect(toolTitle("task", empty)).toBe("Task");
  });

  it("unknown tools echo their name", () => {
    expect(toolTitle("mcp_custom", empty)).toBe("mcp_custom");
  });
});

describe("toolInfo", () => {
  it("prefers state.title over toolTitle", () => {
    expect(toolInfo("read", empty, { title: "Custom" }).title).toBe("Custom");
    expect(toolInfo("read", empty, empty).title).toBe("Read");
  });

  it("subtitle describes completed todos out of the total", () => {
    const state: JsonObject = { metadata: { todos: [{ status: "completed" }, { status: "pending" }, { status: "completed" }] } };
    expect(toolInfo("todo_write", empty, state).subtitle).toBe("2/3 done");
  });

  it("does not derive generic subtitles from tool arguments", () => {
    expect(toolInfo("edit", { filePath: "a.ts" }, empty).subtitle).toBeUndefined();
  });
});

describe("taskSessionId", () => {
  it("prefers running v1 metadata over resume input and output fallbacks", () => {
    expect(taskSessionId(
      { task_id: "resumed" },
      { metadata: { sessionId: "running" }, output: '<task id="completed" state="completed">' },
    )).toBe("running");
  });

  it("supports resumed tasks and structured persisted output", () => {
    expect(taskSessionId({ task_id: "resumed" }, {})).toBe("resumed");
    expect(taskSessionId({}, { output: '<task id="completed" state="completed">' })).toBe("completed");
    expect(taskSessionId({}, { output: "No child metadata" })).toBeUndefined();
  });
});

describe("isPathTool / isContextLocationTool / hasToolIcon", () => {
  it("isPathTool matches read/edit/write/apply_patch variants", () => {
    expect(isPathTool("read")).toBe(true);
    expect(isPathTool("read_file")).toBe(true);
    expect(isPathTool("edit")).toBe(true);
    expect(isPathTool("write")).toBe(true);
    expect(isPathTool("apply_patch")).toBe(true);
    expect(isPathTool("bash")).toBe(false);
    expect(isPathTool("task")).toBe(false);
  });

  it("isContextLocationTool matches list/glob/grep", () => {
    expect(isContextLocationTool("list")).toBe(true);
    expect(isContextLocationTool("glob")).toBe(true);
    expect(isContextLocationTool("grep")).toBe(true);
    expect(isContextLocationTool("read")).toBe(false);
  });

  it("hasToolIcon is true for built-in and fallback tools", () => {
    expect(hasToolIcon("read")).toBe(true);
    expect(hasToolIcon("glob")).toBe(true);
    expect(hasToolIcon("bash")).toBe(true);
    expect(hasToolIcon("shell")).toBe(true);
    expect(hasToolIcon("task")).toBe(true);
    expect(hasToolIcon("todowrite")).toBe(true);
    expect(hasToolIcon("unknown_mcp")).toBe(true);
  });
});

describe("toolIcon", () => {
  it("returns Lucide icon names per tool category", () => {
    expect(toolIcon("read")).toBe("eye");
    expect(toolIcon("glob")).toBe("search");
    expect(toolIcon("list")).toBe("list");
    expect(toolIcon("bash")).toBe("terminal");
    expect(toolIcon("edit")).toBe("pencil");
    expect(toolIcon("question")).toBe("message-circle-question-mark");
    expect(toolIcon("skill")).toBe("graduation-cap");
    expect(toolIcon("task")).toBe("bot");
    expect(toolIcon("todowrite")).toBe("square-check-big");
    expect(toolIcon("custom")).toBe("wrench");
  });
});

describe("customToolDisplay", () => {
  it("uses the configured icon and selected input argument", () => {
    expect(customToolDisplay("deploy", { environment: "staging" }, [
      { tool: "deploy", icon: "rocket", displayArgument: "environment" },
    ])).toEqual({ icon: "rocket", text: "staging" });
  });

  it("falls back to the tool name when the configured argument is absent", () => {
    expect(customToolDisplay("deploy", {}, [
      { tool: "deploy", icon: "rocket", displayArgument: "environment" },
    ])).toEqual({ icon: "rocket", text: "deploy" });
  });
});

describe("contextSummary", () => {
  it("groups context tools by read/search/list labels", () => {
    const parts: JsonObject[] = [
      { tool: "read" },
      { tool: "read_file" },
      { tool: "glob" },
      { tool: "grep" },
      { tool: "grep" },
      { tool: "list" },
    ];
    expect(contextSummary(parts)).toBe("2 reads, 3 searchs, 1 list");
  });

  it("uses singular form for singletons", () => {
    expect(contextSummary([{ tool: "read" }])).toBe("1 read");
  });

  it("returns empty string for no parts", () => {
    expect(contextSummary([])).toBe("");
  });
});

const empty: JsonObject = {};
