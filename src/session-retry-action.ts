export interface SessionRetryAction {
  reason: string;
  provider: string;
  title: string;
  message: string;
  label: string;
  link?: string;
}

export const RETRY_ACTION_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

/** Returns the allowlisted first-party usage-limit action key, rejecting arbitrary provider actions. */
export function retryActionKey(action: SessionRetryAction): string | undefined {
  if (action.provider !== "opencode" && action.provider !== "opencode-go") return undefined;
  if (action.reason === "free_tier_limit" || action.reason === "account_rate_limit") return action.reason;
  return undefined;
}

/** Returns an HTTPS-only retry action target suitable for explicit external opening. */
export function safeRetryActionLink(action: SessionRetryAction): string | undefined {
  if (!action.link) return undefined;
  try {
    const url = new URL(action.link);
    const approvedPath = url.pathname === "/go" || /^\/workspace\/[^/]+\/go\/?$/.test(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "opencode.ai" || url.port || url.username || url.password || url.search || url.hash || !approvedPath) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Returns the eligible action key after applying permanent suppression and the 24-hour cooldown. */
export function eligibleRetryActionKey(
  action: SessionRetryAction,
  lastShown: Record<string, number>,
  suppressed: Record<string, true>,
  now = Date.now(),
): string | undefined {
  const key = retryActionKey(action);
  if (!key || suppressed[key]) return undefined;
  return now - (lastShown[key] ?? 0) >= RETRY_ACTION_COOLDOWN_MS ? key : undefined;
}
