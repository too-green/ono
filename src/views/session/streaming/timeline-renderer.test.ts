import type { JsonObject, OpenCodeMessageBundle } from "../../../services/opencode-types";
import { describe, expect, it } from "vitest";

import {
  assistantTurnTiming,
  isCompactAssistantPart,
  latestMessageIndex,
  latestVisibleAssistantIndex,
  messageRenderKind,
  messageRenderOptions,
  visibleTimelineMessages,
} from "./timeline-renderer";

/** Builds a compact message bundle for pure timeline-helper tests. */
function bundle(id: string, role: string, created: number, parts: JsonObject[] = [], extraInfo: JsonObject = {}): OpenCodeMessageBundle {
  return { info: { id, role, time: { created }, ...extraInfo }, parts };
}

describe("messageRenderKind", () => {
  it("classifies user text and image-only messages", () => {
    expect(messageRenderKind(bundle("u1", "user", 1, [{ type: "text", text: "hello" }]), true)).toBe("user");
    expect(messageRenderKind(bundle("u2", "user", 2, [{ type: "file", url: "data:image/png;base64,x", filename: "x.png" }]), true)).toBe("user");
  });

  it("hides empty and synthetic-only user messages", () => {
    expect(messageRenderKind(bundle("u1", "user", 1), true)).toBe("none");
    expect(messageRenderKind(bundle("u2", "user", 2, [{ type: "text", text: "hidden", synthetic: true }]), true)).toBe("none");
  });

  it("classifies assistant prose, compact parts, and mixed messages", () => {
    expect(messageRenderKind(bundle("a1", "assistant", 1, [{ type: "text", text: "answer" }]), true)).toBe("assistant-text");
    expect(messageRenderKind(bundle("a2", "assistant", 2, [{ type: "tool", tool: "read" }]), true)).toBe("assistant-compact");
    expect(messageRenderKind(bundle("a3", "assistant", 3, [{ type: "text", text: "answer" }, { type: "tool", tool: "read" }]), true)).toBe("assistant-mixed");
  });

  it("gates reasoning-only messages on the reasoning setting", () => {
    const reasoning = bundle("a1", "assistant", 1, [{ type: "reasoning", text: "thinking" }]);
    expect(messageRenderKind(reasoning, true)).toBe("assistant-compact");
    expect(messageRenderKind(reasoning, false)).toBe("none");
  });

  it("always exposes compaction boundaries as assistant text", () => {
    expect(messageRenderKind(bundle("c1", "assistant", 1, [], { type: "compaction" }), false)).toBe("assistant-text");
  });
});

describe("isCompactAssistantPart", () => {
  it("recognizes tools and visible reasoning only", () => {
    expect(isCompactAssistantPart({ type: "tool" }, false)).toBe(true);
    expect(isCompactAssistantPart({ type: "reasoning", text: "x" }, true)).toBe(true);
    expect(isCompactAssistantPart({ type: "reasoning", text: "x" }, false)).toBe(false);
    expect(isCompactAssistantPart({ type: "text", text: "x" }, true)).toBe(false);
  });
});

describe("visibleTimelineMessages", () => {
  it("sorts messages, removes empty bundles, and applies a lexically rolled-over rewind boundary", () => {
    const messages = [
      bundle("msg_002", "assistant", 3, [{ type: "text", text: "third" }]),
      bundle("msg_ff1", "user", 1, [{ type: "text", text: "first" }]),
      bundle("msg_ff2", "user", 2),
    ];
    expect(visibleTimelineMessages(messages, "msg_002", true).map((message) => message.info.id)).toEqual(["msg_ff1"]);
    expect(messages.map((message) => message.info.id)).toEqual(["msg_002", "msg_ff1", "msg_ff2"]);
  });

  it("keeps the v1 compaction summary assistant visible as its own message after the marker", () => {
    const messages = [
      bundle("c1", "user", 1, [{ type: "compaction", auto: false }]),
      bundle("a1", "assistant", 2, [{ type: "text", text: "Retained session context" }], {
        parentID: "c1",
        mode: "compaction",
        summary: true,
      }),
    ];

    const visible = visibleTimelineMessages(messages, undefined, true);

    expect(visible.map((message) => message.info.id)).toEqual(["c1", "a1"]);
    expect(visible[0].info).not.toHaveProperty("summary");
    expect(visible[0].info).not.toHaveProperty("compactionSummaryMessageID");
  });
});

describe("timeline index helpers", () => {
  const messages = [
    bundle("u1", "user", 1, [{ type: "text", text: "question" }]),
    bundle("a1", "assistant", 2, [{ type: "text", text: "first" }]),
    bundle("a2", "assistant", 3, [{ type: "text", text: "second" }]),
  ];

  it("finds the highest mounted canonical index", () => {
    expect(latestMessageIndex(messages, ["u1", "a2"])).toBe(2);
    expect(latestMessageIndex(messages, ["missing"])).toBe(-1);
  });

  it("finds the latest non-compaction assistant", () => {
    expect(latestVisibleAssistantIndex(messages, 2)).toBe(2);
    expect(latestVisibleAssistantIndex(messages, 0)).toBe(-1);
  });
});

describe("messageRenderOptions", () => {
  it("places metadata only on the final message of a contiguous assistant turn", () => {
    const messages = [
      bundle("u1", "user", 1, [{ type: "text", text: "question" }]),
      bundle("a1", "assistant", 2, [{ type: "text", text: "first" }]),
      bundle("a2", "assistant", 3, [{ type: "text", text: "second" }]),
      bundle("u2", "user", 4, [{ type: "text", text: "next" }]),
    ];
    expect(messageRenderOptions(messages, 1)).toEqual({ showAssistantMeta: false, assistantTurnText: "" });
    expect(messageRenderOptions(messages, 2)).toEqual({ showAssistantMeta: true, assistantTurnText: "first\n\nsecond" });
    expect(messageRenderOptions(messages, 3)).toEqual({ showAssistantMeta: false, assistantTurnText: "" });
  });

  it("separates assistant turns at compaction boundaries", () => {
    const messages = [
      bundle("a1", "assistant", 1, [{ type: "text", text: "before" }]),
      bundle("c1", "assistant", 2, [], { type: "compaction" }),
    ];
    expect(messageRenderOptions(messages, 0)).toEqual({ showAssistantMeta: true, assistantTurnText: "before" });
    expect(messageRenderOptions(messages, 1)).toEqual({ showAssistantMeta: false, assistantTurnText: "" });
  });
});

describe("assistantTurnTiming", () => {
  it("measures a multi-message assistant turn from its preceding user message", () => {
    const messages = [
      bundle("u1", "user", 1_000, [{ type: "text", text: "question" }]),
      bundle("a1", "assistant", 2_000, [{ type: "tool", tool: "read" }], { parentID: "u1", time: { created: 2_000, completed: 4_000 } }),
      bundle("a2", "assistant", 5_000, [{ type: "text", text: "answer" }], { parentID: "u1", time: { created: 5_000, completed: 10_000 } }),
    ];

    expect(assistantTurnTiming(messages, 2)).toEqual({ startedAt: 1_000, completedAt: 10_000 });
  });

  it("falls back to the first assistant creation time when its user message is unavailable", () => {
    const messages = [bundle("a1", "assistant", 2_000, [{ type: "text", text: "answer" }], { time: { created: 2_000, completed: 4_000 } })];

    expect(assistantTurnTiming(messages, 0)).toEqual({ startedAt: 2_000, completedAt: 4_000 });
  });
});
