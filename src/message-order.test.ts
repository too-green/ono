import { describe, expect, it } from "vitest";

import { orderedBoundary } from "./message-order";

interface Item {
  id: string;
  created: number;
}

describe("orderedBoundary", () => {
  it("locates a boundary by position when message IDs roll over lexically", () => {
    const items: Item[] = [
      { id: "msg_002", created: 3 },
      { id: "msg_fe1", created: 1 },
      { id: "msg_ff1", created: 2 },
      { id: "msg_003", created: 4 },
    ];

    const location = orderedBoundary(items, "msg_002", (item) => item.id, (item) => item.created);

    expect(location.found).toBe(true);
    expect(location.index).toBe(2);
    expect(location.ordered.map((item) => item.id)).toEqual(["msg_fe1", "msg_ff1", "msg_002", "msg_003"]);
  });

  it("preserves source order when creation timestamps are equal", () => {
    const items: Item[] = [
      { id: "msg_ff1", created: 1 },
      { id: "msg_001", created: 1 },
    ];

    const location = orderedBoundary(items, undefined, (item) => item.id, (item) => item.created);

    expect(location.ordered.map((item) => item.id)).toEqual(["msg_ff1", "msg_001"]);
  });
});
