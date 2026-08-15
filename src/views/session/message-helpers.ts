/** Pure message-bundle metadata accessors. Extracted from SessionView for unit testing. */

import type { JsonObject, OpenCodeMessageBundle } from "../../services/opencode-types";
import { readNumber, readObject, readObjectArray, readString } from "./json-helpers";
import { basename } from "./path-utils";

export interface ImageAttachment {
  url: string;
  name: string;
  mime?: string;
}

/** Returns message creation time for stable chronological rendering. */
export function messageTime(bundle: OpenCodeMessageBundle): number {
  const time = readObject(bundle.info, "time");
  const created = time?.created;
  return typeof created === "number" ? created : 0;
}

/** Returns the stable id for a message bundle, falling back to creation time. */
export function messageId(bundle: OpenCodeMessageBundle): string {
  return readString(bundle.info, ["id", "messageID", "messageId"]) ?? String(messageTime(bundle));
}

/** Resolves role with v2 `type` fallback so renderers can group user/assistant correctly. */
export function messageRole(bundle: OpenCodeMessageBundle): string {
  const role = readString(bundle.info, ["role"]);
  if (role) return role;
  const type = readString(bundle.info, ["type"]);
  if (type === "user" || type === "assistant") return type;
  return "assistant";
}

/** Joins visible text parts for non-assistant messages, skipping synthetic/ignored and non-text parts. */
export function textFromParts(parts: JsonObject[]): string {
  return parts
    .flatMap((part) => {
      if (readString(part, ["type"]) !== "text") return [];
      if (part.synthetic === true || part.ignored === true) return [];
      return [readString(part, ["text"]) ?? ""];
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** Extracts text for user messages from parts first, then v2 info.text fallback. */
export function userMessageText(bundle: OpenCodeMessageBundle): string {
  return textFromParts(bundle.parts) || readString(bundle.info, ["text"]) || "";
}

/** Resolves the displayable URL for OpenCode v1 file parts and v2 prompt files. */
export function attachmentUrl(file: JsonObject): string | undefined {
  const raw = readString(file, ["url", "uri", "path"]);
  if (!raw) return undefined;
  if (/^(https?:|file:|data:|blob:)/i.test(raw)) return raw;
  if (raw.startsWith("/")) return `file://${encodeURI(raw)}`;
  return raw;
}

/** Detects images by MIME type first, then common image extensions. */
export function isImageAttachment(url: string, name: string, mime?: string): boolean {
  if (mime?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(url);
}

/** Finds image file parts/attachments attached to a user message. */
export function imageAttachments(bundle: OpenCodeMessageBundle): ImageAttachment[] {
  const candidates = [
    ...bundle.parts.filter((part) => readString(part, ["type"]) === "file"),
    ...readObjectArray(bundle.info, "files"),
    ...readObjectArray(bundle.info, "attachments"),
  ];
  return candidates.flatMap((file) => {
    const url = attachmentUrl(file);
    const name = readString(file, ["filename", "name", "uri", "url"]) ?? "image";
    const mime = readString(file, ["mime", "mimeType"]);
    if (!url || !isImageAttachment(url, name, mime)) return [];
    return [{ url, name: basename(name), mime }];
  });
}

/** Returns true when a message bundle represents a compaction boundary. */
export function isCompactionMessage(bundle: OpenCodeMessageBundle): boolean {
  return readString(bundle.info, ["type"]) === "compaction" || bundle.parts.some((part) => readString(part, ["type"]) === "compaction");
}

/** Capitalizes short metadata labels without changing undefined values. */
export function capitalized(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Produces a human-readable model label from loose OpenCode message info. */
export function modelLabel(info: JsonObject): string | undefined {
  const model = readObject(info, "model");
  if (model) return readString(model, ["modelID", "modelId", "id", "name"]);
  return readString(info, ["modelID", "modelId", "model"]);
}

/** Returns an assistant message completion timestamp when OpenCode has settled it. */
export function messageCompletedTime(bundle: OpenCodeMessageBundle): number | undefined {
  const time = readObject(bundle.info, "time");
  return typeof time?.completed === "number" ? time.completed : undefined;
}

/** Formats elapsed time between turn-level start and end timestamps. */
export function elapsedDurationLabel(start: number | undefined, end: number | undefined): string | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  const seconds = (end - start) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Joins reasoning text parts into a single string for the collapsed thought label. */
export function reasoningText(parts: JsonObject[]): string {
  return parts.map((part) => readString(part, ["text"]) ?? "").filter((text) => text.trim().length > 0).join("\n\n");
}

/** Returns whether all reasoning fragments have finished streaming based on their time.end markers. */
export function reasoningComplete(parts: JsonObject[]): boolean {
  return parts.every((part) => {
    const time = readObject(part, "time");
    return typeof time?.end === "number";
  });
}

/** Reads the assistant message reasoning token count for the collapsed thought label. */
export function reasoningTokenCount(info: JsonObject): number | undefined {
  const tokens = readObject(info, "tokens");
  return tokens ? readNumber(tokens, ["reasoning", "reasoningTokens", "reasoning_tokens"]) : undefined;
}

/** Returns the agent name from the most recent user message in `messages`, or undefined. Referenced by `composerAgentFromState()`. */
export function latestUserAgent(messages: OpenCodeMessageBundle[]): string | undefined {
  for (const bundle of [...messages].reverse()) {
    if (messageRole(bundle) !== "user") continue;
    const agent = readString(bundle.info, ["agent"]);
    if (agent) return agent;
  }
  return undefined;
}
