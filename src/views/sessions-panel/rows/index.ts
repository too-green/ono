import { ProjectRow } from "./ProjectRow";
import { SessionRow } from "./SessionRow";
import { WorktreeRow } from "./WorktreeRow";
import type { SessionsPanelRowComponents } from "./types";

export * from "./ProjectRow";
export * from "./SessionRow";
export * from "./WorktreeRow";
export * from "./types";

/** Creates the standard component set used when SessionsPanelView receives no overrides. */
export function createDefaultSessionsPanelRowComponents(): SessionsPanelRowComponents {
  return {
    project: new ProjectRow(),
    worktree: new WorktreeRow(),
    session: new SessionRow(),
  };
}
