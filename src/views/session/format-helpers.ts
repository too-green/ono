/** Compact number formatting for token/line counters. Extracted from SessionView for unit testing. */

/** Returns a string with at most one decimal place, stripping trailing .0. */
export function trimDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** Formats large counts as k/M/B; rounds thousands, decimal-places M/B. */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return trimDecimal(value / 1_000_000_000) + "B";
  if (abs >= 100_000_000) return trimDecimal(value / 1_000_000) + "M";
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return trimDecimal(value);
}
