import type { SessionsPanelSessionSort } from "../../settings";
import type { SessionsPanelSession } from "./rows";

/** Returns sessions ordered by the persisted sessions-panel sort selection. */
export function sortSessionsPanelSessions(sessions: SessionsPanelSession[], sort: SessionsPanelSessionSort): SessionsPanelSession[] {
  return [...sessions].sort((left, right) => {
    const direction = sort.endsWith("-asc") ? 1 : -1;
    let compared = 0;
    if (sort.startsWith("created-")) compared = compareOptionalNumbers(left.createdAt, right.createdAt, direction);
    if (sort.startsWith("modified-")) compared = compareOptionalNumbers(left.updatedAt ?? left.createdAt, right.updatedAt ?? right.createdAt, direction);
    if (sort.startsWith("title-")) compared = direction * left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
    return compared || left.id.localeCompare(right.id);
  });
}

/** Compares optional timestamps while consistently placing missing values last. */
function compareOptionalNumbers(left: number | undefined, right: number | undefined, direction: 1 | -1): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return direction * (left - right);
}
