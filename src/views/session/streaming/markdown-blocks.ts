/** Result of splitting streamed Markdown into committed blocks and the active tail block. */
export interface MarkdownBlockSplit {
  committed: string[];
  tail: string;
}

interface BlockGroup {
  start: number;
  end: number;
  firstLine: string;
}

interface FenceMarker {
  char: number;
  length: number;
  restStart: number;
}

/** Returns the first non-whitespace index in [from, to), or `to` when the range is blank. */
function firstNonSpace(source: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const code = source.charCodeAt(i);
    const whitespace = code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
    if (!whitespace) return i;
  }
  return to;
}

/** Detects a ``` or ~~~ fence marker at the start of a line, ignoring leading indentation. */
function fenceMarkerAt(source: string, from: number, to: number): FenceMarker | undefined {
  const start = firstNonSpace(source, from, to);
  const char = source.charCodeAt(start);
  if (char !== 96 && char !== 126) return undefined;
  let i = start;
  while (i < to && source.charCodeAt(i) === char) i++;
  if (i - start < 3) return undefined;
  return { char, length: i - start, restStart: i };
}

/** Collects blank-line-separated block groups, never splitting inside fenced code. */
function collectBlockGroups(markdown: string): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let fence: { char: number; length: number } | undefined;
  let lineStart = 0;
  let groupStart = -1;
  let groupEnd = -1;
  let firstLine: string | undefined;
  const total = markdown.length;
  while (lineStart < total) {
    let lineEnd = lineStart;
    while (lineEnd < total && markdown.charCodeAt(lineEnd) !== 10) lineEnd++;
    const termEnd = lineEnd < total ? lineEnd + 1 : total;
    const contentEnd = lineEnd > lineStart && markdown.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    if (fence) {
      const marker = fenceMarkerAt(markdown, lineStart, contentEnd);
      if (marker && marker.char === fence.char && marker.length >= fence.length && firstNonSpace(markdown, marker.restStart, contentEnd) === contentEnd) {
        fence = undefined;
      }
    } else if (firstNonSpace(markdown, lineStart, contentEnd) !== contentEnd) {
      const marker = fenceMarkerAt(markdown, lineStart, contentEnd);
      if (marker) fence = { char: marker.char, length: marker.length };
      if (groupStart < 0) {
        groupStart = lineStart;
        firstLine = markdown.slice(lineStart, lineEnd);
      }
      groupEnd = termEnd;
    } else if (groupStart >= 0) {
      groups.push({ start: groupStart, end: groupEnd, firstLine: firstLine! });
      groupStart = -1;
      firstLine = undefined;
    }
    lineStart = termEnd;
  }
  if (groupStart >= 0) groups.push({ start: groupStart, end: groupEnd, firstLine: firstLine! });
  return groups;
}

/** Returns the line's leading whitespace stripped. */
function trimLeading(line: string): string {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === 0 ? line : line.slice(i);
}

/** Returns true when the line opens a list item (bullet or ordered marker, any leading indent). */
function startsListItem(line: string): boolean {
  return /^([-+*]|\d{1,9}[.)])(\s|$)/.test(trimLeading(line));
}

/** Returns true when the line starts a blockquote continuation. */
function startsBlockquote(line: string): boolean {
  return trimLeading(line).startsWith(">");
}

/** Returns true when the line looks like a table row. */
function startsTableLine(line: string): boolean {
  return trimLeading(line).startsWith("|");
}

/** Counts the line's leading indent columns (a tab counts as four). */
function leadingIndentColumns(line: string): number {
  let columns = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 32) columns++;
    else if (code === 9) return columns + 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** Returns false when a blank-line boundary between adjacent groups must not be committed. */
function canCommitBetween(prev: BlockGroup, next: BlockGroup): boolean {
  const prevList = startsListItem(prev.firstLine);
  const nextList = startsListItem(next.firstLine);
  if (prevList && nextList) return false;
  if (prevList && (next.firstLine.charCodeAt(0) === 32 || next.firstLine.charCodeAt(0) === 9)) return false;
  if (startsBlockquote(prev.firstLine) && startsBlockquote(next.firstLine)) return false;
  if (leadingIndentColumns(next.firstLine) >= 4) return false;
  if (startsTableLine(prev.firstLine) && startsTableLine(next.firstLine)) return false;
  return true;
}

/** Returns the byte offset of the `\n\n` cut before `next`, or -1 when the separator is not a safe cut. */
function commitCutAt(markdown: string, prev: BlockGroup, next: BlockGroup): number {
  const sepEnd = next.start;
  if (markdown.charCodeAt(sepEnd - 1) !== 10 || markdown.charCodeAt(sepEnd - 2) !== 10) return -1;
  if (!canCommitBetween(prev, next)) return -1;
  return sepEnd - 2;
}

/** Splits Markdown at safe blank-line boundaries into committed blocks plus the active tail block. */
export function splitMarkdownBlocks(markdown: string): MarkdownBlockSplit {
  if (firstNonSpace(markdown, 0, markdown.length) === markdown.length) return { committed: [], tail: "" };
  const groups = collectBlockGroups(markdown);
  const committed: string[] = [];
  let chunkStart = 0;
  for (let g = 1; g < groups.length; g++) {
    const cut = commitCutAt(markdown, groups[g - 1], groups[g]);
    if (cut < 0) continue;
    committed.push(markdown.slice(chunkStart, cut));
    chunkStart = cut + 2;
  }
  return { committed, tail: markdown.slice(chunkStart) };
}
