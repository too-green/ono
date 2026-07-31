export type SessionVisualStatus = "idle" | "working" | "attention" | "done" | "error" | "retry";

export type WorkingAnimation = "W1" | "W2" | "W3" | "W4";

export const DEFAULT_WORKING_ANIMATION: WorkingAnimation = "W3";

/** Normalizes the persisted working animation setting to a supported variant. */
export function normalizeWorkingAnimation(value: unknown): WorkingAnimation {
  return value === "W1" || value === "W2" || value === "W3" || value === "W4" ? value : DEFAULT_WORKING_ANIMATION;
}

/** Returns whether an OpenCode session status means the agent is still active. */
export function isActiveSessionStatus(type: string | undefined): boolean {
  return type === "busy" || type === "retry" || type === "working" || type === "running" || type === "active";
}

/** Maps an OpenCode status type and local unread state to the session-row visual state. */
export function visualStatusForSession(type: string | undefined, unread: boolean): SessionVisualStatus {
  if (type === "retry") return "retry";
  if (type === "error" || type === "failed") return "error";
  if (type === "permission" || type === "question" || type === "attention") return "attention";
  if (isActiveSessionStatus(type)) return "working";
  if (type === "done" || type === "complete" || type === "completed" || unread) return "done";
  return "idle";
}
