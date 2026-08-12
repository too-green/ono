import { describe, expect, it } from "vitest";
import { beforeAfterDiff, escapeFence, foldUnifiedDiffContext, inlineValue, languageFromPath, parseReadOutputRows, parseUnifiedDiffRows, stripAnsi } from "./diff-parsing";

describe("languageFromPath", () => {
  it("maps known extensions to Obsidian fenced-code languages", () => {
    expect(languageFromPath("foo.ts")).toBe("typescript");
    expect(languageFromPath("foo.tsx")).toBe("tsx");
    expect(languageFromPath("foo.js")).toBe("javascript");
    expect(languageFromPath("foo.json")).toBe("json");
    expect(languageFromPath("foo.sh")).toBe("bash");
    expect(languageFromPath("foo.bash")).toBe("bash");
    expect(languageFromPath("foo.zsh")).toBe("bash");
    expect(languageFromPath("foo.md")).toBe("markdown");
    expect(languageFromPath("foo.py")).toBe("python");
    expect(languageFromPath("foo.yml")).toBe("yaml");
    expect(languageFromPath("foo.yaml")).toBe("yaml");
  });

  it("returns text only when path is undefined or has no dot", () => {
    expect(languageFromPath(undefined)).toBe("text");
    expect(languageFromPath("")).toBe("text");
  });

  it("returns the lowercased last dot segment for unknown extensions", () => {
    expect(languageFromPath("README")).toBe("readme");
    expect(languageFromPath("weird.ext")).toBe("ext");
  });

  it("is case-insensitive on the extension", () => {
    expect(languageFromPath("Foo.TS")).toBe("typescript");
    expect(languageFromPath("Foo.JSON")).toBe("json");
  });

  it("uses only the final segment after the last dot", () => {
    expect(languageFromPath("/a/b.c/min.ts")).toBe("typescript");
  });
});

describe("stripAnsi", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m text")).toBe("red text");
    expect(stripAnsi("\u001b[1;32mbold green\u001b[0m")).toBe("bold green");
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("no codes here")).toBe("no codes here");
  });
});

describe("escapeFence", () => {
  it("escapes triple backticks so nested fences don't break the outer block", () => {
    expect(escapeFence("```ts\ncode\n```")).toBe("``\\`ts\ncode\n``\\`");
  });

  it("does nothing to fence-free text", () => {
    expect(escapeFence("plain code")).toBe("plain code");
  });
});

describe("inlineValue", () => {
  it("returns short strings unchanged", () => {
    expect(inlineValue("short")).toBe("short");
  });

  it("truncates strings longer than 40 chars to 37 chars + ellipsis (38 total)", () => {
    const long = "x".repeat(50);
    const out = inlineValue(long);
    expect(out.length).toBe(38);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("x".repeat(37))).toBe(true);
  });

  it("stringifies numbers and booleans", () => {
    expect(inlineValue(42)).toBe("42");
    expect(inlineValue(true)).toBe("true");
    expect(inlineValue(false)).toBe("false");
  });

  it("stringifies null and undefined literally", () => {
    expect(inlineValue(null)).toBe("null");
    expect(inlineValue(undefined)).toBe("undefined");
  });

  it("JSON-stringifies objects, capped at 40 chars", () => {
    expect(inlineValue({ a: 1 })).toBe('{"a":1}');
    const out = inlineValue({ x: "x".repeat(100) });
    expect(out.length).toBe(40);
  });
});

describe("beforeAfterDiff", () => {
  it("emits before/after headers using 'before'/'after' fallbacks", () => {
    expect(beforeAfterDiff("a", "b")).toBe("--- before\n+++ after\n-a\n+b");
  });

  it("uses file in headers when provided", () => {
    expect(beforeAfterDiff("a", "b", "foo.ts")).toBe("--- foo.ts\n+++ foo.ts\n-a\n+b");
  });

  it("splits multiline before/after line-by-line", () => {
    expect(beforeAfterDiff("x\ny", "z", "f.ts")).toBe("--- f.ts\n+++ f.ts\n-x\n-y\n+z");
  });
});

describe("parseUnifiedDiffRows", () => {
  it("parses a standard hunk with context + add + del and tracks line numbers", () => {
    const patch = [
      "--- a.ts",
      "+++ b.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");
    const rows = parseUnifiedDiffRows(patch);
    expect(rows).toEqual([
      { kind: "meta", text: "Lines 1-1" },
      { kind: "context", oldLine: 1, newLine: 1, text: "context" },
      { kind: "del", oldLine: 2, text: "old" },
      { kind: "add", newLine: 2, text: "new" },
    ]);
  });

  it("fills meta text from hunk section heading", () => {
    const patch = "@@ -1,1 +1,1 @@ fn foo()";
    expect(parseUnifiedDiffRows(patch)).toEqual([{ kind: "meta", text: "fn foo()" }]);
  });

  it("falls back to 'Lines X-Y' when section heading is empty", () => {
    expect(parseUnifiedDiffRows("@@ -3,2 +5,2 @@")).toEqual([
      { kind: "meta", text: "Lines 3-5" },
    ]);
  });

  it("skips git/file headers and 'No newline' markers", () => {
    const patch = ["diff --git a/foo b/foo", "Index: foo", "====", "--- a/foo", "+++ b/foo", "@@ -1,1 +1,1 @@", " keep", "\\ No newline at end of file"].join("\n");
    const rows = parseUnifiedDiffRows(patch);
    expect(rows.some((r) => r.kind === "meta" && r.text.includes("No newline"))).toBe(false);
    expect(rows[0]).toEqual({ kind: "meta", text: "Lines 1-1" });
  });

  it("treats unmarked lines as meta", () => {
    expect(parseUnifiedDiffRows("just some prose")).toEqual([{ kind: "meta", text: "just some prose" }]);
  });

  it("skips blank lines", () => {
    expect(parseUnifiedDiffRows("\n\n")).toEqual([]);
  });

  it("normalizes CRLF line endings", () => {
    const patch = "@@ -1,1 +1,1 @@\r\n+hello\r\n";
    expect(parseUnifiedDiffRows(patch)).toEqual([
      { kind: "meta", text: "Lines 1-1" },
      { kind: "add", newLine: 1, text: "hello" },
    ]);
  });

  it("tracks independent old/new counters across mixed sequences", () => {
    const patch = ["@@ -1,3 +1,3 @@", " a", "-b", "-c", "+B", "+C", " d"].join("\n");
    const rows = parseUnifiedDiffRows(patch).slice(1);
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, undefined],
      ["del", 3, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 4, 4],
    ]);
  });
});

describe("foldUnifiedDiffContext", () => {
  it("keeps three context lines around changes and folds distant runs", () => {
    const rows = parseUnifiedDiffRows([
      "@@ -1,12 +1,12 @@",
      ...Array.from({ length: 5 }, (_, index) => ` before ${index + 1}`),
      "-old",
      "+new",
      ...Array.from({ length: 5 }, (_, index) => ` after ${index + 1}`),
    ].join("\n"));

    const folded = foldUnifiedDiffContext(rows);

    expect(folded.filter((item) => item.type === "fold").map((item) => item.rows.length)).toEqual([2, 2]);
    expect(folded.flatMap((item) => item.type === "row" ? [item.row.text] : [])).toEqual([
      "Lines 1-1",
      "before 3",
      "before 4",
      "before 5",
      "old",
      "new",
      "after 1",
      "after 2",
      "after 3",
    ]);
  });

  it("does not merge context across hunk metadata rows", () => {
    const rows = parseUnifiedDiffRows([
      "@@ -1,5 +1,5 @@",
      " one",
      " two",
      " three",
      " four",
      "+change",
      "@@ -20,5 +20,5 @@",
      "+change two",
      " one",
      " two",
      " three",
      " four",
    ].join("\n"));

    expect(foldUnifiedDiffContext(rows).filter((item) => item.type === "fold").map((item) => item.rows.length)).toEqual([1, 1]);
  });
});

describe("parseReadOutputRows", () => {
  it("parses rows of the form N: text", () => {
    expect(parseReadOutputRows("10: foo\n11: bar")).toEqual([
      { line: 10, text: "foo" },
      { line: 11, text: "bar" },
    ]);
  });

  it("extracts rows from a <content> wrapper and ignores outer text", () => {
    const wrapped = "path: foo.ts\ntype: text\n<content>\n1: hello\n2: world\n</content>";
    expect(parseReadOutputRows(wrapped)).toEqual([
      { line: 1, text: "hello" },
      { line: 2, text: "world" },
    ]);
  });

  it("returns empty array when no lines match", () => {
    expect(parseReadOutputRows("just prose\nno numbers")).toEqual([]);
  });

  it("tolerates a leading space after the colon", () => {
    expect(parseReadOutputRows("5:    indented")).toEqual([{ line: 5, text: "   indented" }]);
  });

  it("normalizes CRLF", () => {
    expect(parseReadOutputRows("1: a\r\n2: b")).toEqual([
      { line: 1, text: "a" },
      { line: 2, text: "b" },
    ]);
  });
});
