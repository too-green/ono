import { describe, expect, it } from "vitest";

import type { JsonObject, OpenCodeMessageBundle, OpenCodeSession } from "./services/opencode-types";
import { forkBoundaryAfterMessage, nextAvailableForkTitle } from "./session-fork";

/** Builds a message bundle for fork-boundary tests. */
function message(id: string, created: number, parts: JsonObject[] = []): OpenCodeMessageBundle {
  return { info: { id, time: { created } }, parts };
}

describe("forkBoundaryAfterMessage", () => {
  it("uses the next chronological message as OpenCode's exclusive boundary", () => {
    const messages = [
      message("u2", 4, [{ type: "text", text: "next prompt" }]),
      message("a2", 3, [{ type: "text", text: "final answer" }]),
      message("a1", 2, [{ type: "tool", tool: "read" }]),
    ];

    expect(forkBoundaryAfterMessage(messages, "a2")).toEqual({ found: true, messageID: "u2" });
  });

  it("omits the boundary when the clicked assistant is the session tail", () => {
    expect(forkBoundaryAfterMessage([message("u1", 1), message("a1", 2)], "a1")).toEqual({ found: true, messageID: undefined });
  });

  it("rejects a stale clicked message instead of silently forking the full session", () => {
    expect(forkBoundaryAfterMessage([message("a1", 1)], "missing")).toEqual({ found: false });
  });
});

describe("nextAvailableForkTitle", () => {
  const session = (id: string, title: string): OpenCodeSession => ({ id, title });

  it("increments duplicate parallel fork titles", () => {
    expect(nextAvailableForkTitle("Research (fork #1)", [session("f1", "Research (fork #1)")])).toBe("Research (fork #2)");
  });

  it("continues after the highest existing sibling ordinal", () => {
    const sessions = [session("f1", "Research (fork #1)"), session("f3", "Research (fork #3)"), session("x", "Other (fork #9)")];
    expect(nextAvailableForkTitle("Research (fork #1)", sessions)).toBe("Research (fork #4)");
  });

  it("preserves a unique or non-generated server title", () => {
    expect(nextAvailableForkTitle("Research (fork #2)", [session("f1", "Research (fork #1)")])).toBe("Research (fork #2)");
    expect(nextAvailableForkTitle("Custom title", [session("f1", "Custom title")])).toBe("Custom title");
  });
});
