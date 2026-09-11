import { describe, expect, it } from "vitest";

import { parseBenchmarkWorkspaceLayout } from "./benchmark-workspace-layout";

/** Builds one opencode-session leaf node with an optional session id. */
function sessionLeaf(sessionId?: string): Record<string, unknown> {
  return { type: "leaf", state: { type: "opencode-session", state: sessionId === undefined ? {} : { sessionId } } };
}

/** Builds one leaf node hosting an unrelated view type. */
function otherLeaf(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "leaf", state: { type, state: payload } };
}

describe("parseBenchmarkWorkspaceLayout", () => {
  it("extracts session ids from realistic split/tab nesting in leaf order", () => {
    const layout = {
      main: {
        type: "split",
        children: [
          { type: "tabs", children: [sessionLeaf("ses-1"), sessionLeaf("ses-2")] },
          {
            type: "split",
            direction: "vertical",
            children: [
              { type: "tabs", children: [otherLeaf("markdown", { file: "notes.md" }), sessionLeaf("ses-3")] },
              { type: "tabs", children: [sessionLeaf("ses-4")] },
            ],
          },
        ],
      },
      left: { type: "split", children: [{ type: "tabs", children: [otherLeaf("file-explorer")] }] },
      right: { type: "split", children: [{ type: "tabs", children: [sessionLeaf("ses-5")] }] },
    };

    expect(parseBenchmarkWorkspaceLayout(layout)).toEqual({
      sessionIds: ["ses-1", "ses-2", "ses-3", "ses-4", "ses-5"],
      uniqueSessionIds: ["ses-1", "ses-2", "ses-3", "ses-4", "ses-5"],
    });
  });

  it("keeps duplicate session tabs as separate occurrences while deriving unique fetch ids", () => {
    const layout = {
      main: {
        type: "split",
        children: [
          { type: "tabs", children: [sessionLeaf("ses-a"), sessionLeaf("ses-b"), sessionLeaf("ses-a")] },
          { type: "split", children: [{ type: "tabs", children: [sessionLeaf("ses-c"), sessionLeaf("ses-a")] }] },
        ],
      },
    };

    expect(parseBenchmarkWorkspaceLayout(layout)).toEqual({
      sessionIds: ["ses-a", "ses-b", "ses-a", "ses-c", "ses-a"],
      uniqueSessionIds: ["ses-a", "ses-b", "ses-c"],
    });
  });

  it("reaches session leaves inside floating windows", () => {
    const layout = {
      main: { type: "split", children: [{ type: "tabs", children: [sessionLeaf("ses-main")] }] },
      floating: [
        {
          id: "window-1",
          main: { type: "split", children: [{ type: "tabs", children: [sessionLeaf("ses-floating")] }] },
        },
      ],
    };

    expect(parseBenchmarkWorkspaceLayout(layout)).toEqual({
      sessionIds: ["ses-main", "ses-floating"],
      uniqueSessionIds: ["ses-main", "ses-floating"],
    });
  });

  it("skips internal, unrelated, and incomplete session leaves", () => {
    const layout = {
      main: {
        type: "split",
        children: [
          // Session view without a session id (a draft tab payload has draftId instead).
          sessionLeaf(),
          // Blank and whitespace-only session ids are ignored.
          sessionLeaf(""),
          sessionLeaf("   "),
          // Non-string ids and malformed leaf shapes are tolerated.
          otherLeaf("opencode-session", { sessionId: 42 }),
          { type: "leaf", state: "corrupted" },
          { type: "leaf" },
          sessionLeaf("ses-real"),
          // Internal container nodes and unknown view states never contribute ids.
          { type: "tabs", state: { sessionId: "ses-not-a-leaf" } },
          otherLeaf("empty"),
        ],
      },
    };

    expect(parseBenchmarkWorkspaceLayout(layout)).toEqual({
      sessionIds: ["ses-real"],
      uniqueSessionIds: ["ses-real"],
    });
  });

  it("tolerates malformed top-level data without throwing", () => {
    expect(parseBenchmarkWorkspaceLayout(undefined)).toEqual({ sessionIds: [], uniqueSessionIds: [] });
    expect(parseBenchmarkWorkspaceLayout(null)).toEqual({ sessionIds: [], uniqueSessionIds: [] });
    expect(parseBenchmarkWorkspaceLayout("not a layout")).toEqual({ sessionIds: [], uniqueSessionIds: [] });
    expect(parseBenchmarkWorkspaceLayout(42)).toEqual({ sessionIds: [], uniqueSessionIds: [] });
    expect(parseBenchmarkWorkspaceLayout({ main: { children: [null, 7, "x", { type: "leaf", state: null }] } }))
      .toEqual({ sessionIds: [], uniqueSessionIds: [] });
  });

  it("reports an empty extraction for a layout without any session tabs", () => {
    const layout = { main: { type: "split", children: [{ type: "tabs", children: [otherLeaf("markdown")] }] } };
    expect(parseBenchmarkWorkspaceLayout(layout)).toEqual({ sessionIds: [], uniqueSessionIds: [] });
  });
});
