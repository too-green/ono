import { describe, expect, it } from "vitest";

import { normalizeTodoStatusCharacter } from "../../settings";
import type { OpenCodeTodo } from "../../services/opencode-types";
import { sessionTodoMarkdown, todoTabTitle } from "./session-rollup-helpers";

const todos: OpenCodeTodo[] = [
  { content: "Finished", status: "completed", priority: "medium" },
  { content: "Current task", status: "in_progress", priority: "high" },
  { content: "Later", status: "pending", priority: "low" },
  { content: "Dropped", status: "cancelled", priority: "low" },
];

describe("session roll-up todo helpers", () => {
  it("uses the completed/total count", () => {
    expect(todoTabTitle(todos)).toBe("1/4");
    expect(todoTabTitle(todos.filter((todo) => todo.status !== "in_progress"))).toBe("1/3");
  });

  it("normalizes one custom character and rejects closing brackets", () => {
    expect(normalizeTodoStatusCharacter(" / ")).toBe("/");
    expect(normalizeTodoStatusCharacter("]")).toBe("");
    expect(normalizeTodoStatusCharacter("x")).toBe("");
    expect(normalizeTodoStatusCharacter(undefined)).toBe("");
  });

  it("maps all OpenCode statuses to Markdown task syntax", () => {
    expect(sessionTodoMarkdown(todos, "/")).toBe([
      "- [x] Finished",
      "- [/] Current task",
      "- [ ] Later",
      "- [-] Dropped",
    ].join("\n"));
  });

  it("uses valid unchecked task syntax for an unmarked in-progress todo", () => {
    expect(sessionTodoMarkdown(todos, "")).toContain("- [ ] Current task");
    expect(sessionTodoMarkdown(todos, "")).not.toContain("- [] Current task");
  });
});
