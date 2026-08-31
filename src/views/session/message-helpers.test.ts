import { describe, expect, it } from "vitest";
import type { JsonObject, OpenCodeMessageBundle } from "../../services/opencode-types";
import { attachmentUrl, capitalized, elapsedDurationLabel, imageAttachments, isCompactionMessage, isImageAttachment, messageCompletedTime, messageId, messageRole, messageTime, modelLabel, modelVariantLabel, reasoningComplete, reasoningText, reasoningTokenCount, textFromParts, userMessageText } from "./message-helpers";

function bundle(info: JsonObject, parts: JsonObject[] = []): OpenCodeMessageBundle {
  return { info, parts };
}

describe("messageTime", () => {
  it("returns created time when present as number", () => {
    expect(messageTime(bundle({ time: { created: 1234 } }))).toBe(1234);
  });

  it("returns 0 when missing or non-numeric", () => {
    expect(messageTime(bundle({}))).toBe(0);
    expect(messageTime(bundle({ time: { created: "x" } }))).toBe(0);
  });
});

describe("messageId", () => {
  it("prefers info.id", () => {
    expect(messageId(bundle({ id: "abc" }))).toBe("abc");
  });

  it("falls back to messageID/messageId", () => {
    expect(messageId(bundle({ messageID: "mid" }))).toBe("mid");
    expect(messageId(bundle({ messageId: "mid2" }))).toBe("mid2");
  });

  it("falls back to created time as string", () => {
    expect(messageId(bundle({ time: { created: 99 } }))).toBe("99");
  });
});

describe("messageRole", () => {
  it("uses role when present", () => {
    expect(messageRole(bundle({ role: "user" }))).toBe("user");
  });

  it("falls back to type when role missing", () => {
    expect(messageRole(bundle({ type: "assistant" }))).toBe("assistant");
    expect(messageRole(bundle({ type: "user" }))).toBe("user");
  });

  it("defaults to assistant when nothing matches", () => {
    expect(messageRole(bundle({}))).toBe("assistant");
    expect(messageRole(bundle({ type: "system" }))).toBe("assistant");
  });
});

describe("textFromParts", () => {
  it("joins text parts with double newline, trimming empties", () => {
    expect(textFromParts([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\n\nb");
  });

  it("skips non-text parts", () => {
    expect(textFromParts([{ type: "tool", text: "x" }, { type: "text", text: "keep" }])).toBe("keep");
  });

  it("skips synthetic and ignored parts", () => {
    expect(textFromParts([{ type: "text", text: "skip", synthetic: true }, { type: "text", text: "ignored", ignored: true }, { type: "text", text: "keep" }])).toBe("keep");
  });

  it("skips whitespace-only text parts", () => {
    expect(textFromParts([{ type: "text", text: "   " }, { type: "text", text: "x" }])).toBe("x");
  });

  it("returns empty string when no usable parts", () => {
    expect(textFromParts([{ type: "tool" }])).toBe("");
  });
});

describe("userMessageText", () => {
  it("uses text parts first", () => {
    expect(userMessageText(bundle({}, [{ type: "text", text: "from parts" }]))).toBe("from parts");
  });

  it("falls back to info.text", () => {
    expect(userMessageText(bundle({ text: "from info" }))).toBe("from info");
  });

  it("returns empty string when nothing available", () => {
    expect(userMessageText(bundle({}))).toBe("");
  });
});

describe("attachmentUrl", () => {
  it("passes through http/https/file/data/blob URLs", () => {
    expect(attachmentUrl({ url: "https://x/y" })).toBe("https://x/y");
    expect(attachmentUrl({ url: "file:///a" })).toBe("file:///a");
    expect(attachmentUrl({ url: "data:image/png;base64,xx" })).toBe("data:image/png;base64,xx");
    expect(attachmentUrl({ url: "blob:https://x/yy" })).toBe("blob:https://x/yy");
  });

  it("prefixes absolute paths with file:// and encodes", () => {
    expect(attachmentUrl({ path: "/a b/c.png" })).toBe("file:///a%20b/c.png");
  });

  it("returns relative paths unchanged", () => {
    expect(attachmentUrl({ uri: "rel/path" })).toBe("rel/path");
  });

  it("returns undefined when no URL-ish field present", () => {
    expect(attachmentUrl({})).toBeUndefined();
  });
});

describe("isImageAttachment", () => {
  it("detects via mime", () => {
    expect(isImageAttachment("x", "x", "image/png")).toBe(true);
    expect(isImageAttachment("x", "x", "application/pdf")).toBe(false);
  });

  it("detects via name extension", () => {
    expect(isImageAttachment("x", "foo.PNG")).toBe(true);
    expect(isImageAttachment("x", "foo.jpeg")).toBe(true);
    expect(isImageAttachment("x", "foo.txt")).toBe(false);
  });

  it("detects via url extension including query/hash suffix", () => {
    expect(isImageAttachment("https://x/y.jpg?q=1", "noext")).toBe(true);
    expect(isImageAttachment("https://x/y.svg#frag", "noext")).toBe(true);
    expect(isImageAttachment("https://x/y.docx", "noext")).toBe(false);
  });
});

describe("imageAttachments", () => {
  it("collects image parts and info.files/attachments in candidate order (parts → files → attachments)", () => {
    const b = bundle(
      { files: [{ url: "https://x/a.png", filename: "/p/a.png" }], attachments: [{ uri: "/rel/b.jpg", name: "b.jpg" }] },
      [{ type: "file", path: "/abs/c.gif", filename: "c.gif" }],
    );
    expect(imageAttachments(b).map((x) => x.name)).toEqual(["c.gif", "a.png", "b.jpg"]);
  });

  it("defaults name to 'image' when file part has no filename/name/uri/url field", () => {
    const b = bundle({}, [{ type: "file", path: "/abs/c.gif" }]);
    expect(imageAttachments(b).map((x) => x.name)).toEqual(["image"]);
  });

  it("filters non-image files", () => {
    const b = bundle({}, [{ type: "file", path: "/abs/c.txt" }]);
    expect(imageAttachments(b)).toEqual([]);
  });

  it("returns empty when no candidates", () => {
    expect(imageAttachments(bundle({}))).toEqual([]);
  });
});

describe("isCompactionMessage", () => {
  it("detects v2 info.type compaction", () => {
    expect(isCompactionMessage(bundle({ type: "compaction" }))).toBe(true);
  });

  it("detects legacy compaction part", () => {
    expect(isCompactionMessage(bundle({}, [{ type: "compaction" }]))).toBe(true);
  });

  it("returns false for ordinary messages", () => {
    expect(isCompactionMessage(bundle({ type: "user" }))).toBe(false);
  });
});

describe("capitalized", () => {
  it("capitalizes the first character", () => {
    expect(capitalized("auto")).toBe("Auto");
    expect(capitalized("Manual")).toBe("Manual");
  });

  it("returns undefined for empty/undefined input", () => {
    expect(capitalized(undefined)).toBeUndefined();
    expect(capitalized("")).toBeUndefined();
  });
});

describe("modelLabel", () => {
  it("prefers nested model object", () => {
    expect(modelLabel({ model: { id: "gpt-4" } })).toBe("gpt-4");
  });

  it("falls back to flat modelID/modelId/model", () => {
    expect(modelLabel({ modelID: "claude" })).toBe("claude");
    expect(modelLabel({ modelId: "gemini" })).toBe("gemini");
    expect(modelLabel({ model: "flat-string" })).toBe("flat-string");
  });

  it("returns undefined when no model info", () => {
    expect(modelLabel({})).toBeUndefined();
  });
});

describe("modelVariantLabel", () => {
  it("reads nested user-message variants", () => {
    expect(modelVariantLabel({ model: { variant: "high" } })).toBe("high");
  });

  it("reads flat assistant-message variants", () => {
    expect(modelVariantLabel({ variant: "medium" })).toBe("medium");
  });

  it("returns undefined when no variant was used", () => {
    expect(modelVariantLabel({ model: { modelID: "claude" } })).toBeUndefined();
  });
});

describe("elapsedDurationLabel", () => {
  it("formats sub-10s durations with one decimal", () => {
    expect(elapsedDurationLabel(0, 4500)).toBe("4.5s");
  });

  it("formats >=10s durations rounded", () => {
    expect(elapsedDurationLabel(0, 42_000)).toBe("42s");
  });

  it("formats minute-scale durations as minutes and seconds", () => {
    expect(elapsedDurationLabel(0, 2_500_000)).toBe("41m 40s");
    expect(elapsedDurationLabel(0, 65_000)).toBe("1m 5s");
  });

  it("formats hour-scale durations as hours and minutes", () => {
    expect(elapsedDurationLabel(0, 3_900_000)).toBe("1h 5m");
    expect(elapsedDurationLabel(0, 7_500_000)).toBe("2h 5m");
  });

  it("returns undefined when either endpoint missing", () => {
    expect(elapsedDurationLabel(0, undefined)).toBeUndefined();
    expect(elapsedDurationLabel(undefined, 100)).toBeUndefined();
  });

  it("returns undefined when end < start", () => {
    expect(elapsedDurationLabel(100, 50)).toBeUndefined();
  });

  it("reads an assistant message completion timestamp", () => {
    expect(messageCompletedTime(bundle({ time: { created: 0, completed: 4500 } }))).toBe(4500);
    expect(messageCompletedTime(bundle({ time: { created: 0 } }))).toBeUndefined();
  });
});

describe("reasoningText", () => {
  it("joins non-empty reasoning text parts", () => {
    expect(reasoningText([{ text: "a" }, { text: "" }, { text: "b" }])).toBe("a\n\nb");
  });

  it("returns empty string when nothing", () => {
    expect(reasoningText([{ text: "" }])).toBe("");
  });
});

describe("reasoningComplete", () => {
  it("true when every part has a numeric time.end", () => {
    expect(reasoningComplete([{ time: { end: 1 } }, { time: { end: 2 } }])).toBe(true);
  });

  it("false if any part lacks time.end", () => {
    expect(reasoningComplete([{ time: { end: 1 } }, {}])).toBe(false);
  });

  it("true for empty array (vacuous)", () => {
    expect(reasoningComplete([])).toBe(true);
  });
});

describe("reasoningTokenCount", () => {
  it("returns reasoning count from tokens object", () => {
    expect(reasoningTokenCount({ tokens: { reasoning: 42 } })).toBe(42);
    expect(reasoningTokenCount({ tokens: { reasoning_tokens: 7 } })).toBe(7);
  });

  it("returns undefined when no tokens object", () => {
    expect(reasoningTokenCount({})).toBeUndefined();
  });
});
