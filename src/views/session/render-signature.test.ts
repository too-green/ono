import { describe, expect, it, vi } from "vitest";

import { cachedRenderHash, projectedRenderState, renderedPartHash, touchRenderedState } from "./render-signature";

describe("render signature cache", () => {
  it("derives a part hash once for repeated reads of the same object", () => {
    const part = { id: "p1", text: "abc" };
    const derive = vi.fn(() => JSON.stringify(part));

    const first = cachedRenderHash(part, "part", derive);
    const second = cachedRenderHash(part, "part", derive);

    expect(derive).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it("recomputes only after touchRenderedState bumps the revision", () => {
    const part = { id: "p1", text: "abc" };
    let suffix = "";
    const derive = vi.fn(() => JSON.stringify({ ...part, text: `${part.text}${suffix}` }));
    const before = cachedRenderHash(part, "part", derive);

    suffix = "!";
    touchRenderedState(part);

    const after = cachedRenderHash(part, "part", derive);
    expect(derive).toHaveBeenCalledTimes(2);
    expect(after).not.toBe(before);
  });

  it("keeps different derivation keys independent on one object", () => {
    const part = { id: "p1", state: { output: "x" } };
    const deriveRow = vi.fn(() => JSON.stringify(part));
    const deriveDetail = vi.fn(() => JSON.stringify([part.id]));

    const rowFirst = cachedRenderHash(part, "part", deriveRow);
    const detailFirst = cachedRenderHash(part, "tool-detail", deriveDetail);
    const rowSecond = cachedRenderHash(part, "part", deriveRow);
    const detailSecond = cachedRenderHash(part, "tool-detail", deriveDetail);

    expect(deriveRow).toHaveBeenCalledOnce();
    expect(deriveDetail).toHaveBeenCalledOnce();
    expect(rowSecond).toBe(rowFirst);
    expect(detailSecond).toBe(detailFirst);
    expect(rowFirst).not.toBe(detailFirst);
  });

  it("changes the part hash when touched content mutates and keeps it when content is stable", () => {
    const part = { id: "p1", text: "hello" };
    const before = renderedPartHash(part);

    part.text = "hello world";
    touchRenderedState(part);
    const mutated = renderedPartHash(part);
    expect(mutated).not.toBe(before);

    touchRenderedState(part);
    expect(renderedPartHash(part)).toBe(mutated);
  });

  it("projects registered parts to hashes while recursing arrays and plain objects", () => {
    const part = { id: "p1", text: "deep" };
    const hash = renderedPartHash(part);
    const bundle = { info: { id: "m1" }, parts: [part, "plain"] };

    const projected = projectedRenderState([bundle, 3, null, "text"]) as Array<Record<string, any>>;
    const projectedParts = projected[0].parts as unknown[];

    expect(projectedParts[0]).toBe(hash);
    expect(projectedParts[1]).toBe("plain");
    expect(projected[0].info).toEqual({ id: "m1" });
    expect(projected[1]).toBe(3);
    expect(projected[2]).toBeNull();
    expect(projected[3]).toBe("text");
  });

  it("keeps projected signatures equal for equal states and distinct for touched content changes", () => {
    const part = { id: "p1", text: "before" };
    const state = () => [{ info: { id: "m1" }, parts: [part] }, true];

    const before = JSON.stringify(projectedRenderState(state()));
    part.text = "after";
    touchRenderedState(part);
    const after = JSON.stringify(projectedRenderState(state()) as unknown[]);

    expect(after).not.toBe(before);
    expect(JSON.stringify(projectedRenderState(state()))).toBe(after);
  });
});
