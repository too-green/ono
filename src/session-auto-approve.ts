export interface SessionAutoApproveState {
  enabled: boolean;
  inherited: boolean;
  sourceSessionId?: string;
}

/** Resolves the nearest explicit auto-approve setting in a session's cached ancestry. */
export function resolveSessionAutoApprove(
  settings: Readonly<Record<string, boolean>>,
  sessionId: string,
  parentBySessionId: ReadonlyMap<string, string | undefined>,
): SessionAutoApproveState {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (Object.prototype.hasOwnProperty.call(settings, current)) {
      return {
        enabled: settings[current] === true,
        inherited: current !== sessionId,
        sourceSessionId: current,
      };
    }
    current = parentBySessionId.get(current);
  }
  return { enabled: false, inherited: false };
}
