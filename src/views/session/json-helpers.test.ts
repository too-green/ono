import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../services/opencode-types";
import { readNumber, readObject, readObjectArray, readString, readStringArray } from "./json-helpers";

describe("readObject", () => {
  it("returns the object when value is a plain object", () => {
    const source: JsonObject = { nested: { a: 1 } };
    expect(readObject(source, "nested")).toEqual({ a: 1 });
  });

  it("returns undefined for missing key", () => {
    expect(readObject({ a: 1 }, "missing")).toBeUndefined();
  });

  it("returns undefined for arrays", () => {
    expect(readObject({ arr: [1, 2] }, "arr")).toBeUndefined();
  });

  it("returns undefined for primitives", () => {
    expect(readObject({ str: "x", num: 1, bool: true, nil: null }, "str")).toBeUndefined();
    expect(readObject({ str: "x", num: 1, bool: true, nil: null }, "num")).toBeUndefined();
    expect(readObject({ str: "x", num: 1, bool: true, nil: null }, "bool")).toBeUndefined();
    expect(readObject({ str: "x", num: 1, bool: true, nil: null }, "nil")).toBeUndefined();
  });
});

describe("readObjectArray", () => {
  it("returns objects from a mixed array, filtering primitives and arrays", () => {
    const source: JsonObject = { items: [{ a: 1 }, "x", 42, null, [1], { b: 2 }] };
    expect(readObjectArray(source, "items")).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns empty array when value is not an array", () => {
    expect(readObjectArray({ items: "nope" }, "items")).toEqual([]);
    expect(readObjectArray({ items: { a: 1 } }, "items")).toEqual([]);
    expect(readObjectArray({}, "items")).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(readObjectArray({ items: [] }, "items")).toEqual([]);
  });
});

describe("readStringArray", () => {
  it("keeps non-empty strings only", () => {
    expect(readStringArray({ tags: ["a", "", "  ", "b", 1, true] }, "tags")).toEqual(["a", "b"]);
  });

  it("returns empty array for non-array values", () => {
    expect(readStringArray({ tags: "x" }, "tags")).toEqual([]);
    expect(readStringArray({}, "tags")).toEqual([]);
  });
});

describe("readNumber", () => {
  it("returns the first finite numeric match across keys", () => {
    expect(readNumber({ a: "x", b: 7, c: 9 }, ["a", "b", "c"])).toBe(7);
  });

  it("skips NaN/Infinity", () => {
    expect(readNumber({ a: NaN, b: Infinity, c: 3 }, ["a", "b", "c"])).toBe(3);
  });

  it("returns undefined when no match", () => {
    expect(readNumber({ a: "x" }, ["a", "b"])).toBeUndefined();
  });
});

describe("readString", () => {
  it("returns the first non-empty string", () => {
    expect(readString({ a: "", b: "x" }, ["a", "b"])).toBe("x");
  });

  it("coerces numbers to string when no string is present", () => {
    expect(readString({ a: 42 }, ["a", "b"])).toBe("42");
  });

  it("prefers an earlier string over a later number", () => {
    expect(readString({ a: "str", b: 42 }, ["a", "b"])).toBe("str");
  });

  it("skips whitespace-only strings", () => {
    expect(readString({ a: "   ", b: "x" }, ["a", "b"])).toBe("x");
  });

  it("returns undefined when nothing matches", () => {
    expect(readString({ a: null, b: true }, ["a", "b"])).toBeUndefined();
    expect(readString({}, ["a", "b"])).toBeUndefined();
  });

  it("does not coerce zero to empty (0 → '0')", () => {
    expect(readString({ a: 0 }, ["a"])).toBe("0");
  });
});
