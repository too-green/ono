import type { JsonObject } from "../../services/opencode-types";
import type { SessionRetryAction } from "../../session-retry-action";
import * as jsonHelpers from "./json-helpers";

export interface SessionRetryStatus {
  attempt: number;
  message: string;
  next: number;
  action?: SessionRetryAction;
}

/** Parses the optional first-party v1 usage-limit action attached to retry status. */
function sessionRetryAction(status: JsonObject): SessionRetryAction | undefined {
  const action = jsonHelpers.readObject(status, "action");
  if (!action) return undefined;
  const reason = jsonHelpers.readString(action, ["reason"]);
  const provider = jsonHelpers.readString(action, ["provider"]);
  const title = jsonHelpers.readString(action, ["title"]);
  const message = jsonHelpers.readString(action, ["message"]);
  const label = jsonHelpers.readString(action, ["label"]);
  if (!reason || !provider || !title || !message || !label) return undefined;
  return { reason, provider, title, message, label, link: jsonHelpers.readString(action, ["link"]) };
}

/** Parses the full v1 retry payload retained by SessionView and TimelineRenderer. */
export function sessionRetryStatus(status: JsonObject | undefined): SessionRetryStatus | undefined {
  if (jsonHelpers.readString(status ?? {}, ["type", "status", "state"]) !== "retry") return undefined;
  return {
    attempt: Math.max(0, Math.trunc(jsonHelpers.readNumber(status ?? {}, ["attempt"]) ?? 0)),
    message: jsonHelpers.readString(status ?? {}, ["message"]) ?? "The provider request failed.",
    next: Math.max(0, jsonHelpers.readNumber(status ?? {}, ["next"]) ?? 0),
    action: sessionRetryAction(status ?? {}),
  };
}

/** Compares retry fields that affect the mounted status card. */
export function sessionRetryStatusEquals(left: SessionRetryStatus | undefined, right: SessionRetryStatus | undefined): boolean {
  return left === right || (!!left && !!right && left.attempt === right.attempt && left.message === right.message && left.next === right.next);
}

/** Formats the live v1 retry deadline as a non-negative countdown and attempt label. */
export function retryCountdownText(retry: Pick<SessionRetryStatus, "attempt" | "next">, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((retry.next - now) / 1_000));
  return seconds > 0 ? `Retrying in ${seconds}s (attempt ${retry.attempt})` : `Retrying (attempt ${retry.attempt})`;
}
