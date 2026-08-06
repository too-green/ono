/** Safe accessors for loosely-typed OpenCode JSON payloads. Extracted from SessionView for unit testing. */

import type { JsonObject } from "../../services/opencode-types";

/** Reads a nested object field from a loosely typed OpenCode object. */
export function readObject(source: JsonObject, key: string): JsonObject | undefined {
  const value = source[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return undefined;
}

/** Reads an array of objects from a loosely typed OpenCode object. */
export function readObjectArray(source: JsonObject, key: string): JsonObject[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item));
}

/** Reads an array of strings from a loosely typed OpenCode object. */
export function readStringArray(source: JsonObject, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Reads the first numeric value from a loosely typed OpenCode object. */
export function readNumber(source: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Reads the first string-like value from a loosely typed OpenCode object; numbers are stringified. */
export function readString(source: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}
