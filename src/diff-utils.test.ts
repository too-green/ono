import { describe, expect, it } from "vitest";

import { diffTotals, latestSummarizedTurnDiffs, sessionDiffFiles } from "./diff-utils";
import type { OpenCodeMessageBundle } from "./services/opencode-types";

/** Builds one user message with an optional authoritative summary for roll-up helper tests. */
function userMessage(id: string, created: number, diffs?: Array<Record<string, unknown>>): OpenCodeMessageBundle {
  return {
    info: {
      id,
      role: "user",
      time: { created },
      ...(diffs === undefined ? {} : { summary: { diffs } }),
    },
    parts: [],
  };
}

describe("session diff aggregation", () => {
  it("uses the latest summarized turn rather than an in-flight user message", () => {
    const messages = [
      userMessage("u1", 1, [{ file: "a.ts", additions: 1, deletions: 0 }]),
      userMessage("u2", 2, []),
      userMessage("u3", 3),
    ];

    expect(latestSummarizedTurnDiffs(messages)).toEqual({ messageId: "u2", created: 2, diffs: [] });
  });

  it("groups chronological patches by file and sums their activity stats", () => {
    const messages = [
      userMessage("u1", 1, [{ file: "a.ts", patch: "+one", additions: 1, deletions: 0, status: "added" }]),
      userMessage("u2", 2, [
        { file: "a.ts", patch: "-one\n+two", additions: 1, deletions: 1, status: "modified" },
        { file: "b.ts", patch: "+b", additions: 1, deletions: 0, status: "added" },
      ]),
    ];

    const files = sessionDiffFiles(messages);
    expect(files.map(({ file, additions, deletions, status }) => ({ file, additions, deletions, status }))).toEqual([
      { file: "a.ts", additions: 2, deletions: 1, status: "modified" },
      { file: "b.ts", additions: 1, deletions: 0, status: "added" },
    ]);
    expect(files[0]?.turns.map((turn) => turn.messageId)).toEqual(["u1", "u2"]);
    expect(diffTotals(files)).toEqual({ additions: 3, deletions: 1 });
  });

  it("excludes summaries at and after the active rewind boundary", () => {
    const messages = [
      userMessage("u1", 1, [{ file: "kept.ts", additions: 1, deletions: 0 }]),
      userMessage("u2", 2, [{ file: "rewound.ts", additions: 3, deletions: 0 }]),
    ];

    expect(sessionDiffFiles(messages, "u2").map((file) => file.file)).toEqual(["kept.ts"]);
    expect(latestSummarizedTurnDiffs(messages, "u2")?.messageId).toBe("u1");
  });
});
