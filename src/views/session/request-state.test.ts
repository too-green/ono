import { describe, expect, it } from "vitest";

import { reconcilePendingRequests } from "./request-state";

describe("reconcilePendingRequests", () => {
  it("uses the canonical snapshot when no stream mutation occurred during the fetch", () => {
    expect(reconcilePendingRequests([{ id: "canonical" }], [{ id: "stale" }], 2, 2, new Map())).toEqual([{ id: "canonical" }]);
  });

  it("preserves requests asked while the canonical snapshot was loading", () => {
    expect(reconcilePendingRequests([{ id: "existing" }], [{ id: "existing" }, { id: "asked" }], 2, 3, new Map([["asked", 3]]))).toEqual([
      { id: "existing" },
      { id: "asked" },
    ]);
  });

  it("does not resurrect requests settled while the canonical snapshot was loading", () => {
    expect(reconcilePendingRequests([{ id: "settled" }, { id: "existing" }], [{ id: "existing" }], 2, 3, new Map([["settled", 3]]))).toEqual([
      { id: "existing" },
    ]);
  });
});
