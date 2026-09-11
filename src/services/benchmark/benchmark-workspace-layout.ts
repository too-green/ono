/** Obsidian session-view type persisted inside workspace layout leaf state; mirrors SessionView. */
const OPENCODE_SESSION_VIEW_TYPE = "opencode-session";

/** Session ids extracted from one benchmark workspace layout. */
export interface BenchmarkLayoutExtraction {
  /** Session ids in leaf occurrence order; one entry per `opencode-session` leaf, duplicates kept. */
  sessionIds: string[];
  /** Unique session ids in first-occurrence order; the set benchmark preparation fetches. */
  uniqueSessionIds: string[];
}

/**
 * Pure parser that recursively extracts every `opencode-session` leaf state holding a non-empty
 * `sessionId` from a serialized Obsidian workspace layout (the shape returned by the public
 * `app.workspace.getLayout()`). Descends split/tab containers, sidebars, and floating windows;
 * unrelated or internal nodes are skipped, and malformed nodes are tolerated without throwing.
 * Referenced by the plugin's benchmark startup path in `main.ts`.
 */
export function parseBenchmarkWorkspaceLayout(layout: unknown): BenchmarkLayoutExtraction {
  const sessionIds: string[] = [];
  visit(layout);
  return { sessionIds, uniqueSessionIds: [...new Set(sessionIds)] };

  /** Depth-first walk in container order; leaf states are payloads, so they stop the descent. */
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "leaf") {
      recordSessionLeaf(record);
      return;
    }
    for (const value of Object.values(record)) visit(value);
  }

  /** Records one leaf's session id when the leaf hosts a session view with a non-empty id. */
  function recordSessionLeaf(leaf: Record<string, unknown>): void {
    const state = leaf.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    const viewState = state as Record<string, unknown>;
    if (viewState.type !== OPENCODE_SESSION_VIEW_TYPE) return;
    const viewPayload = viewState.state;
    if (!viewPayload || typeof viewPayload !== "object" || Array.isArray(viewPayload)) return;
    const sessionId = (viewPayload as Record<string, unknown>).sessionId;
    if (typeof sessionId === "string" && sessionId.trim() !== "") sessionIds.push(sessionId);
  }
}
