import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "./markdown-blocks";

/** Asserts byte-exact re-concatenation and the append-only tail invariant. */
function expectRoundTrip(markdown: string): { committed: string[]; tail: string } {
  const split = splitMarkdownBlocks(markdown);
  if (split.committed.length > 0) {
    expect(split.committed.join("\n\n") + (split.tail ? "\n\n" + split.tail : "")).toBe(markdown);
  } else {
    expect(split.tail).toBe(markdown);
  }
  if (split.committed.length > 0 || split.tail.length > 0) expect(split.tail.length).toBeGreaterThan(0);
  return split;
}

describe("splitMarkdownBlocks", () => {
  it("returns empty for empty and whitespace-only input", () => {
    expect(splitMarkdownBlocks("")).toEqual({ committed: [], tail: "" });
    expect(splitMarkdownBlocks("   \n \t\n ")).toEqual({ committed: [], tail: "" });
    expect(splitMarkdownBlocks("\n\n")).toEqual({ committed: [], tail: "" });
  });

  it("keeps a single unfinished paragraph entirely in the tail", () => {
    const split = expectRoundTrip("just one paragraph");
    expect(split.committed).toEqual([]);
    expect(split.tail).toBe("just one paragraph");
  });

  it("commits closed paragraphs and keeps the last block as tail", () => {
    const split = expectRoundTrip("first para\n\nsecond para\n\nthird para");
    expect(split.committed).toEqual(["first para", "second para"]);
    expect(split.tail).toBe("third para");
  });

  it("keeps a closed fenced code block with blank lines as one block", () => {
    const markdown = "intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\noutro";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["intro", "```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(split.tail).toBe("outro");
  });

  it("keeps an unterminated fence entirely in the tail", () => {
    const split = expectRoundTrip("intro\n\n```js\nconst a = 1;\n\nstill code");
    expect(split.committed).toEqual(["intro"]);
    expect(split.tail).toBe("```js\nconst a = 1;\n\nstill code");
  });

  it("tracks tilde fences separately from backtick fences", () => {
    const markdown = "~~~\ncode with ``` inside\n\nmore\n~~~\n\ntail";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["~~~\ncode with ``` inside\n\nmore\n~~~"]);
    expect(split.tail).toBe("tail");
  });

  it("keeps a backtick fence open across tilde lines", () => {
    const split = expectRoundTrip("before\n\n```\n~~~\n\nstill open");
    expect(split.committed).toEqual(["before"]);
    expect(split.tail).toBe("```\n~~~\n\nstill open");
  });

  it("keeps loose lists whole across blank lines", () => {
    const markdown = "- item one\n\n- item two\n\n- item three\n\nafter list";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["- item one\n\n- item two\n\n- item three"]);
    expect(split.tail).toBe("after list");
  });

  it("keeps ordered lists with markers whole", () => {
    const markdown = "1. first\n\n2. second\n\ndone";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["1. first\n\n2. second"]);
    expect(split.tail).toBe("done");
  });

  it("keeps blockquotes together across blank lines", () => {
    const markdown = "> quote one\n\n> quote two\n\nafter";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["> quote one\n\n> quote two"]);
    expect(split.tail).toBe("after");
  });

  it("does not split between table rows", () => {
    const markdown = "| a | b |\n|---|---|\n\n| 1 | 2 |\n|---|---|\n\ntail";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["| a | b |\n|---|---|\n\n| 1 | 2 |\n|---|---|"]);
    expect(split.tail).toBe("tail");
  });

  it("commits headings and mixed documents", () => {
    const markdown = "# Title\n\nSome text\n\n- a\n\n- b\n\n> quote\n\nfinal words";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["# Title", "Some text", "- a\n\n- b", "> quote"]);
    expect(split.tail).toBe("final words");
  });

  it("does not split between a paragraph and an indented 4-space continuation", () => {
    const split = expectRoundTrip("para\n\n    indented code\n\nafter");
    expect(split.committed).toEqual(["para\n\n    indented code"]);
    expect(split.tail).toBe("after");
  });

  it("does not split between a list item and an indented continuation", () => {
    const split = expectRoundTrip("- item\n\n  continued\n\ntail");
    expect(split.committed).toEqual(["- item\n\n  continued"]);
    expect(split.tail).toBe("tail");
  });

  it("preserves extra blank lines and leading whitespace byte-exactly", () => {
    const markdown = "\n\n  first\n\n\n\nsecond\n\n";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual(["\n\n  first\n\n"]);
    expect(split.tail).toBe("second\n\n");
  });

  it("keeps CRLF-separated documents unsplit for exactness", () => {
    const markdown = "a\r\n\r\nb\r\n\r\nc";
    const split = expectRoundTrip(markdown);
    expect(split.committed).toEqual([]);
    expect(split.tail).toBe(markdown);
  });

  it("commits blocks before a fence that later closes mid-stream", () => {
    const before = "para\n\n```js\ncode";
    const after = "para\n\n```js\ncode\n```\n\nnext";
    const splitBefore = expectRoundTrip(before);
    const splitAfter = expectRoundTrip(after);
    expect(splitBefore.committed).toEqual(["para"]);
    expect(splitBefore.tail).toBe("```js\ncode");
    expect(splitAfter.committed).toEqual(["para", "```js\ncode\n```"]);
    expect(splitAfter.tail).toBe("next");
  });

  it("grows committed blocks append-only as a stream advances", () => {
    const deltas = ["Hello", "Hello w", "Hello world", "Hello world\n", "Hello world\n\nSe", "Hello world\n\nSecond block", "Hello world\n\nSecond block\n\nThird"];
    let previous: string[] = [];
    for (const markdown of deltas) {
      const { committed } = expectRoundTrip(markdown);
      expect(committed.length).toBeGreaterThanOrEqual(previous.length);
      for (let i = 0; i < previous.length; i++) expect(committed[i]).toBe(previous[i]);
      previous = committed;
    }
    expect(previous).toEqual(["Hello world", "Second block"]);
  });
});
