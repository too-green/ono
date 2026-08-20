import type { OpenCodeSession } from "./services/opencode-types";

export interface SessionNotificationState {
  muted: boolean;
  isSubagent: boolean;
}

/** Resolves a session's explicit mute override over root-enabled/subagent-muted defaults. */
export function resolveSessionNotificationState(
  overrides: Readonly<Record<string, boolean>>,
  session: OpenCodeSession,
): SessionNotificationState {
  const parentId = typeof session.parentID === "string" ? session.parentID : session.parentId;
  const isSubagent = typeof parentId === "string" && parentId.trim().length > 0;
  const hasOverride = Object.prototype.hasOwnProperty.call(overrides, session.id);
  return {
    muted: hasOverride ? overrides[session.id] === true : isSubagent,
    isSubagent,
  };
}

/** Returns the sparse persisted override needed for a requested effective mute state. */
export function muteOverrideForState(muted: boolean, isSubagent: boolean): boolean | undefined {
  return muted === isSubagent ? undefined : muted;
}
