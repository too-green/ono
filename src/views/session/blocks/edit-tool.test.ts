import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../services/opencode-types";
import { parseUnifiedDiffRows } from "../diff-parsing";
import {
  diagnosticsFromTool,
  diffFromTool,
  diffsFromEditTool,
  patchFilesFromMetadata,
  patchToolPath,
  postStateFromTool,
  toolPath,
} from "./edit-tool";

const empty = {};

describe("diffsFromEditTool", () => {
  it("returns [] when no metadata, no filediff, no old/new, and not a write", () => {
    expect(diffsFromEditTool("edit", empty, empty)).toEqual([]);
    expect(diffsFromEditTool("apply_patch", empty, empty)).toEqual([]);
  });

  it("returns metadata.files patches first when present", () => {
    const state: JsonObject = {
      metadata: {
        files: [
          { relativePath: "src/a.ts", patch: "--- a\n+++ b\n@@\n-x\n+y\n", additions: 1, deletions: 1 },
          { filePath: "src/b.ts", patch: "--- c\n+++ d\n", additions: 0, deletions: 0 },
        ],
      },
    };
    const diffs = diffsFromEditTool("apply_patch", empty, state);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toEqual({ file: "src/a.ts", patch: "--- a\n+++ b\n@@\n-x\n+y\n", additions: 1, deletions: 1 });
    expect(diffs[1]).toEqual({ file: "src/b.ts", patch: "--- c\n+++ d\n", additions: 0, deletions: 0 });
  });

  it("falls back to filediff metadata when no files array", () => {
    const state: JsonObject = {
      metadata: {
        filediff: { file: "src/x.ts", patch: "--- a\n+++ b\n", additions: 5, deletions: 2 },
      },
    };
    expect(diffsFromEditTool("edit", empty, state)).toEqual([
      { file: "src/x.ts", patch: "--- a\n+++ b\n", additions: 5, deletions: 2 },
    ]);
  });

  it("builds a before/after patch when filediff lacks a patch field", () => {
    const state: JsonObject = {
      metadata: { filediff: { file: "src/x.ts", before: "old\n", after: "new\n" } },
    };
    const [diff] = diffsFromEditTool("edit", empty, state);
    expect(diff.file).toBe("src/x.ts");
    expect(diff.patch).toContain("-old");
    expect(diff.patch).toContain("+new");
  });

  it("falls back to input old/new strings", () => {
    const input: JsonObject = { filePath: "src/y.ts", oldString: "a\n", newString: "b\n" };
    const [diff] = diffsFromEditTool("edit", input, empty);
    expect(diff.file).toBe("src/y.ts");
    expect(diff.patch).toContain("-a");
    expect(diff.patch).toContain("+b");
  });

  it("write tool with content produces a synthetic /dev/null -> file patch", () => {
    const input: JsonObject = { filePath: "new.ts", content: "line1\nline2\n" };
    const [diff] = diffsFromEditTool("write", input, empty);
    expect(diff.file).toBe("new.ts");
    expect(diff.patch).toContain("--- /dev/null");
    expect(diff.patch).toContain("+++ new.ts");
    expect(diff.patch).toContain("+line1");
    expect(diff.patch).toContain("+line2");
  });

  it("parses produced patch through parseUnifiedDiffRows without dropping content", () => {
    const input: JsonObject = { filePath: "f.ts", oldString: "x\n", newString: "y\n" };
    const [diff] = diffsFromEditTool("edit", input, empty);
    const rows = parseUnifiedDiffRows(diff.patch);
    const texts = rows.map((r) => r.text);
    expect(texts).toContain("x");
    expect(texts).toContain("y");
  });
});

describe("patchFilesFromMetadata", () => {
  it("returns [] for empty metadata", () => {
    expect(patchFilesFromMetadata(empty)).toEqual([]);
    expect(patchFilesFromMetadata({ files: [] })).toEqual([]);
  });

  it("skips entries with neither patch nor before/after", () => {
    const metadata: JsonObject = { files: [{ relativePath: "skipped.ts" }] };
    expect(patchFilesFromMetadata(metadata)).toEqual([]);
  });

  it("synthesizes a patch from before/after when patch is missing", () => {
    const metadata: JsonObject = {
      files: [{ path: "f.ts", before: "a\n", after: "b\n", additions: 1, deletions: 1 }],
    };
    const [diff] = patchFilesFromMetadata(metadata);
    expect(diff.file).toBe("f.ts");
    expect(diff.patch).toContain("+b");
    expect(diff.patch).toContain("-a");
  });
});

describe("diffFromTool", () => {
  it("returns undefined when no filediff and no old/new input", () => {
    expect(diffFromTool(empty, empty)).toBeUndefined();
    expect(diffFromTool({ description: "x" }, { metadata: {} })).toBeUndefined();
  });

  it("prefers filediff file path, falls back to input filePath", () => {
    const state: JsonObject = { metadata: { filediff: { patch: "p", additions: 1 } } };
    expect(diffFromTool({ filePath: "fallback.ts" }, state)?.file).toBe("fallback.ts");
  });
});

describe("postStateFromTool", () => {
  it("returns input.content verbatim for write", () => {
    expect(postStateFromTool("write", { content: "abc" }, empty)).toBe("abc");
  });

  it("returns filediff.after when present for non-write", () => {
    const state: JsonObject = { metadata: { filediff: { after: "new body" } } };
    expect(postStateFromTool("edit", empty, state)).toBe("new body");
  });

  it("falls back to input.newString/new", () => {
    expect(postStateFromTool("edit", { newString: "ns" }, empty)).toBe("ns");
    expect(postStateFromTool("edit", { new: "n" }, empty)).toBe("n");
  });

  it("returns undefined when nothing is available", () => {
    expect(postStateFromTool("edit", empty, empty)).toBeUndefined();
  });
});

describe("diagnosticsFromTool", () => {
  it("returns [] when metadata has no diagnostics", () => {
    expect(diagnosticsFromTool(undefined, empty)).toEqual([]);
    expect(diagnosticsFromTool("a.ts", { metadata: {} })).toEqual([]);
  });

  it("keeps only severity-1 entries and caps at 3", () => {
    const state: JsonObject = {
      metadata: {
        diagnostics: {
          "a.ts": [
            { severity: 1, message: "err1", range: { start: { line: 4, character: 2 } } },
            { severity: 2, message: "warn" },
            { severity: 1, message: "err2" },
            { severity: 1, message: "err3" },
            { severity: 1, message: "err4" },
          ],
        },
      },
    };
    const diagnostics = diagnosticsFromTool("a.ts", state);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toEqual({ location: "[5:3]", message: "err1" });
    expect(diagnostics[1]).toEqual({ location: undefined, message: "err2" });
    expect(diagnostics[2]).toEqual({ location: undefined, message: "err3" });
  });

  it("falls back to the first file key when filePath is not present", () => {
    const state: JsonObject = {
      metadata: {
        diagnostics: {
          "other.ts": [{ severity: 1, message: "fallback" }],
        },
      },
    };
    expect(diagnosticsFromTool("a.ts", state)).toEqual([{ location: undefined, message: "fallback" }]);
  });
});

describe("toolPath / patchToolPath", () => {
  it("toolPath reads the first path-like key", () => {
    expect(toolPath({ filePath: "a.ts" })).toBe("a.ts");
    expect(toolPath({ filepath: "b.ts" })).toBe("b.ts");
    expect(toolPath({ path: "c.ts" })).toBe("c.ts");
    expect(toolPath({ description: "x" })).toBeUndefined();
  });

  it("patchToolPath prefers filediff.file then files[] first entry", () => {
    expect(patchToolPath(empty, { metadata: { filediff: { file: "fd.ts" } } })).toBe("fd.ts");
    expect(patchToolPath(empty, { metadata: { files: [{ filePath: "f1.ts" }] } })).toBe("f1.ts");
    expect(patchToolPath({ files: [{ relativePath: "f2.ts" }] }, empty)).toBe("f2.ts");
    expect(patchToolPath(empty, empty)).toBeUndefined();
  });
});
