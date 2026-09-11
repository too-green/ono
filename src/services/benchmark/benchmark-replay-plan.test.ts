import { describe, expect, it } from "vitest";

import { buildReplayPlan, chunkByCodePoints } from "./benchmark-replay-plan";
import type { JsonObject, OpenCodeEvent, OpenCodeMessageBundle, OpenCodeSession } from "../opencode/opencode-types";

/** Builds one session input with the given message bundles. */
function sessionInput(id: string, directory: string | undefined, bundles: OpenCodeMessageBundle[]): { session: OpenCodeSession; bundles: OpenCodeMessageBundle[] } {
  const session: OpenCodeSession = { id };
  if (directory) session.directory = directory;
  return { session, bundles };
}

/** Reads a part id from a loosely typed benchmark event payload. */
function eventPartId(event: OpenCodeEvent): unknown {
  const part = event.properties?.part;
  return part && typeof part === "object" && !Array.isArray(part) ? (part as JsonObject).id : undefined;
}

describe("chunkByCodePoints", () => {
  it("splits text into fixed-size code point chunks without splitting surrogate pairs", () => {
    const text = "ab\U0001F44D\U0001F3FDcd";
    const chunks = chunkByCodePoints(text, 3);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(3);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("returns the whole text as one chunk when it fits", () => {
    expect(chunkByCodePoints("hello", 10)).toEqual(["hello"]);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkByCodePoints("", 4)).toEqual([]);
  });
});

describe("buildReplayPlan", () => {
  it("emits busy, chronological message reconstruction, authoritative finish, then idle", () => {
    const userPart = { id: "part-user", type: "text", text: "sent once" };
    const textPart = { id: "part-1", type: "text", text: "hello world", time: { end: 20 } };
    const toolPart = { id: "part-2", type: "tool", state: { status: "completed" } };
    const later: OpenCodeMessageBundle = {
      info: { id: "msg-2", sessionID: "ses-1", role: "assistant", time: { created: 20 } },
      parts: [textPart, toolPart],
    };
    const earlier: OpenCodeMessageBundle = {
      info: { id: "msg-1", sessionID: "ses-1", role: "user", time: { created: 10 } },
      parts: [userPart],
    };
    const plan = buildReplayPlan([sessionInput("ses-1", "/repo", [later, earlier])], { textChunkCodePoints: 5 });

    expect(plan.totalEvents).toBe(plan.timelines[0].events.length);
    const types = plan.timelines[0].events.map((event) => event.type);
    expect(types[0]).toBe("session.status");
    expect(plan.timelines[0].events[0].properties?.status).toEqual({ type: "busy" });
    expect(types[1]).toBe("session.updated");
    expect(types.at(-1)).toBe("session.status");
    expect(plan.timelines[0].events.at(-1)?.properties?.status).toEqual({ type: "idle" });

    // Chronological: msg-1 events precede msg-2 events.
    const firstMessageIndex = types.indexOf("message.updated");
    const secondMessageIndex = types.lastIndexOf("message.updated");
    expect(firstMessageIndex).toBeLessThan(types.indexOf("message.part.updated"));
    expect(secondMessageIndex).toBeGreaterThan(types.lastIndexOf("message.part.updated"));

    // Streaming deltas for the text part stay within the chunk size and reassemble exactly.
    const deltas = plan.timelines[0].events
      .filter((event) => event.type === "message.part.delta")
      .map((event) => event.properties?.delta);
    expect(deltas.join("")).toBe("hello world");
    for (const delta of deltas) expect(Array.from(delta as string).length).toBeLessThanOrEqual(5);
    const partUpdates = plan.timelines[0].events.filter((event) => event.type === "message.part.updated");
    const textUpdates = partUpdates.filter((event) => eventPartId(event) === "part-1");
    // The initial skeleton strips completion metadata so StreamController streams it live.
    expect(textUpdates[0].properties?.part).toEqual({ ...textPart, text: "", time: {}, messageID: "msg-2", sessionID: "ses-1" });

    // Authoritative finish preserves all final non-streamed fields.
    const finalPartEvent = textUpdates.at(-1);
    expect(finalPartEvent?.properties?.part).toEqual({ ...textPart, messageID: "msg-2", sessionID: "ses-1" });
    const finalMessageEvent = plan.timelines[0].events.filter((event) => event.type === "message.updated").at(-1);
    expect(finalMessageEvent?.properties?.info).toEqual(later.info);
  });

  it("emits each submitted user message and complete part exactly once without deltas", () => {
    const info = { id: "msg-user", role: "user", time: { created: 1 } };
    const parts = [
      { id: "part-text", type: "text", text: "complete prompt" },
      { id: "part-file", type: "file", mime: "text/plain", filename: "note.txt" },
    ];
    const plan = buildReplayPlan([sessionInput("ses-1", "/repo", [{ info, parts }])], { textChunkCodePoints: 2 });
    const messageEvents = plan.timelines[0].events.filter((event) => event.type === "message.updated");
    const partEvents = plan.timelines[0].events.filter((event) => event.type === "message.part.updated");
    const deltas = plan.timelines[0].events.filter((event) => event.type === "message.part.delta");

    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0].properties?.info).toEqual({ ...info, sessionID: "ses-1" });
    expect(partEvents).toHaveLength(2);
    expect(partEvents.map((event) => event.properties?.part)).toEqual(parts.map((part) => ({
      ...part,
      messageID: "msg-user",
      sessionID: "ses-1",
    })));
    expect(deltas).toEqual([]);
  });

  it("streams non-empty reasoning text and treats synthetic text parts as single updates", () => {
    const reasoning = { id: "part-r", type: "reasoning", text: "think", time: { end: 5 } };
    const synthetic = { id: "part-s", type: "text", text: "hidden", synthetic: true };
    const plan = buildReplayPlan([sessionInput("ses-1", undefined, [{ info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [reasoning, synthetic] }])], { textChunkCodePoints: 2 });

    const reasoningDeltas = plan.timelines[0].events.filter((event) => event.type === "message.part.delta" && event.properties?.partID === "part-r");
    expect(reasoningDeltas.map((event) => event.properties?.delta).join("")).toBe("think");
    // Synthetic text is only ever a full part.updated, never delta-streamed.
    const syntheticUpdates = plan.timelines[0].events.filter((event) => event.type === "message.part.updated" && eventPartId(event) === "part-s");
    expect(syntheticUpdates).toHaveLength(2);
    expect(syntheticUpdates[0].properties?.part).toEqual({ ...synthetic, messageID: "msg-1", sessionID: "ses-1" });
  });

  it("strips time.end only from the initial reasoning skeleton and restores it at finish", () => {
    const reasoning = { id: "part-r", type: "reasoning", text: "ponder", time: { start: 1, end: 9 } };
    const plan = buildReplayPlan([sessionInput("ses-1", "/repo", [{ info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [reasoning] }])], { textChunkCodePoints: 3 });

    const updates = plan.timelines[0].events.filter((event) => event.type === "message.part.updated" && eventPartId(event) === "part-r");
    expect(updates).toHaveLength(2);
    // Regression: an initial skeleton retaining time.end made StreamController skip the
    // direct streaming patch path, so replayed reasoning never rendered live.
    expect(updates[0].properties?.part).toEqual({ ...reasoning, text: "", time: { start: 1 }, messageID: "msg-1", sessionID: "ses-1" });
    expect(updates[0].properties?.part).not.toHaveProperty("time.end");
    // The authoritative finish restores the full captured part including completion metadata.
    expect(updates[1].properties?.part).toEqual({ ...reasoning, messageID: "msg-1", sessionID: "ses-1" });
    const deltas = plan.timelines[0].events.filter((event) => event.type === "message.part.delta" && event.properties?.partID === "part-r");
    expect(deltas.map((event) => event.properties?.delta).join("")).toBe("ponder");
  });

  it("interleaves nothing across sessions; each timeline is independent and directory-scoped", () => {
    const plan = buildReplayPlan([
      sessionInput("ses-a", "/repo", []),
      sessionInput("ses-b", "/repo/feature", []),
    ], { textChunkCodePoints: 4 });

    expect(plan.timelines).toHaveLength(2);
    expect(plan.timelines[0].directory).toBe("/repo");
    expect(plan.timelines[1].directory).toBe("/repo/feature");
    expect(plan.timelines[0].events.map((event) => event.type)).toEqual(["session.status", "session.updated", "session.status"]);
    expect(plan.totalEvents).toBe(6);
  });
});
