export type SessionVisualStatus = "idle" | "working" | "attention" | "done" | "error" | "retry";

export const WORKING_ANIMATION_LABELS = {
  bounce: "Micro bounce",
  pulse: "Soft pulse",
  orbit: "Braille orbit",
  scanner: "Scanner",
  puzzle: "Sliding puzzle",
} as const;

export type WorkingAnimation = keyof typeof WORKING_ANIMATION_LABELS;

export const DEFAULT_WORKING_ANIMATION: WorkingAnimation = "bounce";

/** Normalizes current and legacy persisted animation settings; referenced during load and settings updates. */
export function normalizeWorkingAnimation(value: unknown): WorkingAnimation {
  if (typeof value === "string" && Object.hasOwn(WORKING_ANIMATION_LABELS, value)) return value as WorkingAnimation;
  if (value === "W1") return "pulse";
  if (value === "W2") return "orbit";
  if (value === "W3") return "bounce";
  if (value === "W4") return "scanner";
  return DEFAULT_WORKING_ANIMATION;
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
