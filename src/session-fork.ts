import { orderedBoundary } from "./message-order";
import type { OpenCodeMessageBundle, OpenCodeSession } from "./services/opencode-types";
import { messageId, messageTime } from "./views/session/message-helpers";

export interface ForkMessageBoundary {
  /** Whether the clicked message still exists in the canonical message list. */
  found: boolean;
  /** First message excluded by OpenCode; absent when the clicked message is the session tail. */
  messageID?: string;
}

/** Resolves OpenCode's exclusive fork boundary immediately after a clicked message; referenced by metadata-bar forks. */
export function forkBoundaryAfterMessage(messages: readonly OpenCodeMessageBundle[], includedMessageId: string): ForkMessageBoundary {
  const location = orderedBoundary(messages, includedMessageId, messageId, messageTime);
  if (!location.found) return { found: false };
  const next = location.ordered[location.index + 1];
  return { found: true, messageID: next ? messageId(next) : undefined };
}

/** Returns the next unused sibling-fork title when OpenCode generates a duplicate; referenced by `OpenCodePlugin.forkSession`. */
export function nextAvailableForkTitle(generatedTitle: string, existingSessions: readonly OpenCodeSession[]): string {
  const generated = parseForkTitle(generatedTitle);
  if (!generated) return generatedTitle;
  const matchingNumbers = existingSessions.flatMap((session) => {
    const parsed = session.title ? parseForkTitle(session.title) : undefined;
    return parsed?.base === generated.base ? [parsed.number] : [];
  });
  if (!matchingNumbers.includes(generated.number)) return generatedTitle;
  return `${generated.base} (fork #${Math.max(generated.number, ...matchingNumbers) + 1})`;
}

/** Parses OpenCode's generated fork-title suffix; used only by sibling-title normalization. */
function parseForkTitle(title: string): { base: string; number: number } | undefined {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/);
  if (!match) return undefined;
  return { base: match[1], number: Number(match[2]) };
}
