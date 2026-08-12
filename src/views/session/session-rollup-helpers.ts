import type { OpenCodeTodo } from "../../services/opencode-types";

/** Builds the compact completed/total title used by the Session Island Todos trigger. */
export function todoTabTitle(todos: OpenCodeTodo[]): string {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return `${completed}/${todos.length}`;
}

/** Produces native Markdown task syntax for the complete session todo list. */
export function sessionTodoMarkdown(todos: OpenCodeTodo[], inProgressCharacter: string): string {
  return todos.map((todo) => `- [${todoStatusCharacter(todo, inProgressCharacter)}] ${todo.content.replace(/\s*\r?\n\s*/g, " ")}`).join("\n");
}

/** Maps OpenCode's four todo states onto native or theme-defined Markdown task characters. */
function todoStatusCharacter(todo: OpenCodeTodo, inProgressCharacter: string): string {
  if (todo.status === "completed") return "x";
  if (todo.status === "cancelled") return "-";
  if (todo.status === "in_progress") return inProgressCharacter || " ";
  return " ";
}
