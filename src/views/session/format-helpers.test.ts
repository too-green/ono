import { describe, expect, it } from "vitest";
import { formatCompactNumber, trimDecimal } from "./format-helpers";

describe("trimDecimal", () => {
  it("strips trailing .0", () => {
    expect(trimDecimal(1.0)).toBe("1");
    expect(trimDecimal(10.0)).toBe("10");
  });

  it("keeps one decimal place for fractional values", () => {
    expect(trimDecimal(1.5)).toBe("1.5");
    expect(trimDecimal(2.55)).toBe("2.5");
  });

  it("handles zero", () => {
    expect(trimDecimal(0)).toBe("0");
    expect(trimDecimal(0.04)).toBe("0");
  });

  it("handles negatives", () => {
    expect(trimDecimal(-1.0)).toBe("-1");
    expect(trimDecimal(-2.5)).toBe("-2.5");
  });
});

describe("formatCompactNumber", () => {
  it("passes through small numbers via trimDecimal", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(42)).toBe("42");
    expect(formatCompactNumber(999)).toBe("999");
  });

  it("rounds thousands to k", () => {
    expect(formatCompactNumber(1_000)).toBe("1k");
    expect(formatCompactNumber(1_500)).toBe("2k");
    expect(formatCompactNumber(9_999)).toBe("10k");
    expect(formatCompactNumber(99_999)).toBe("100k");
  });

  it("formats M with one decimal under 1B once >=100M", () => {
    expect(formatCompactNumber(100_000_000)).toBe("100M");
    expect(formatCompactNumber(250_000_000)).toBe("250M");
    expect(formatCompactNumber(999_999_999)).toBe("1000M");
  });

  it("formats B with one decimal once >=1B", () => {
    expect(formatCompactNumber(1_000_000_000)).toBe("1B");
    expect(formatCompactNumber(2_500_000_000)).toBe("2.5B");
  });

  it("respects absolute value for threshold, preserves sign", () => {
    expect(formatCompactNumber(-1_000)).toBe("-1k");
    expect(formatCompactNumber(-2_500_000_000)).toBe("-2.5B");
  });

  it("rounds <100M down to k (since M threshold is 100M)", () => {
    expect(formatCompactNumber(99_999_999)).toBe("100000k");
  });
});
