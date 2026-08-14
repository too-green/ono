import { describe, expect, it } from "vitest";

import { resolveSessionAutoApprove } from "./session-auto-approve";

const hierarchy = new Map<string, string | undefined>([
  ["root", undefined],
  ["child", "root"],
  ["grandchild", "child"],
  ["sibling", "root"],
]);

describe("resolveSessionAutoApprove", () => {
  it("inherits enabled policy through the full ancestor chain", () => {
    expect(resolveSessionAutoApprove({ root: true }, "grandchild", hierarchy)).toEqual({
      enabled: true,
      inherited: true,
      sourceSessionId: "root",
    });
  });

  it("prefers the nearest explicit child override", () => {
    expect(resolveSessionAutoApprove({ root: true, child: false }, "grandchild", hierarchy)).toEqual({
      enabled: false,
      inherited: true,
      sourceSessionId: "child",
    });
    expect(resolveSessionAutoApprove({ root: false, child: true }, "child", hierarchy)).toEqual({
      enabled: true,
      inherited: false,
      sourceSessionId: "child",
    });
  });

  it("does not inherit from siblings and terminates malformed cycles", () => {
    expect(resolveSessionAutoApprove({ sibling: true }, "child", hierarchy)).toEqual({ enabled: false, inherited: false });
    expect(resolveSessionAutoApprove({ root: true }, "a", new Map([["a", "b"], ["b", "a"]]))).toEqual({ enabled: false, inherited: false });
  });
});
