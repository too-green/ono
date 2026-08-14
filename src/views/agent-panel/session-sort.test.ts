import { describe, expect, it } from "vitest";
import type { AgentPanelSessionSort } from "../../settings";
import type { AgentPanelSession } from "./rows";
import { sortAgentPanelSessions } from "./session-sort";

/** Creates the minimal session-row model needed by sort tests. */
function session(id: string, title: string, createdAt?: number, updatedAt?: number): AgentPanelSession {
  return {
    id,
    title,
    directory: "/workspace",
    createdAt,
    updatedAt,
    status: "idle",
    muted: false,
    requiresAttention: false,
  };
}

describe("sortAgentPanelSessions", () => {
  const sessions = [
    session("alpha", "Alpha 10", 100, 400),
    session("beta", "Beta", 300, 200),
    session("alpha-2", "Alpha 2", 200, 300),
  ];

  it.each<[AgentPanelSessionSort, string[]]>([
    ["created-desc", ["beta", "alpha-2", "alpha"]],
    ["created-asc", ["alpha", "alpha-2", "beta"]],
    ["modified-desc", ["alpha", "alpha-2", "beta"]],
    ["modified-asc", ["beta", "alpha-2", "alpha"]],
    ["title-asc", ["alpha-2", "alpha", "beta"]],
    ["title-desc", ["beta", "alpha", "alpha-2"]],
  ])("orders sessions using %s", (sort, expected) => {
    expect(sortAgentPanelSessions(sessions, sort).map((item) => item.id)).toEqual(expected);
  });

  it("places missing timestamps last in either direction", () => {
    const incomplete = [session("missing", "Missing"), session("known", "Known", 100, 200)];
    expect(sortAgentPanelSessions(incomplete, "created-asc").map((item) => item.id)).toEqual(["known", "missing"]);
    expect(sortAgentPanelSessions(incomplete, "modified-desc").map((item) => item.id)).toEqual(["known", "missing"]);
  });
});
