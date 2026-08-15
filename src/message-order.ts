/** Describes records in chronological order and the exact position of an optional identity boundary. */
export interface OrderedBoundary<T> {
  ordered: T[];
  index: number;
  found: boolean;
}

/** Stable-sorts records by time and resolves a boundary by identity; referenced by rewind rendering, actions, pagination, and diff rollups. */
export function orderedBoundary<T>(
  items: readonly T[],
  boundaryId: string | undefined,
  itemId: (item: T) => string | undefined,
  itemTime: (item: T) => number,
): OrderedBoundary<T> {
  const ordered = items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .sort((left, right) => itemTime(left.item) - itemTime(right.item) || left.sourceIndex - right.sourceIndex)
    .map(({ item }) => item);
  if (!boundaryId) return { ordered, index: ordered.length, found: false };
  const index = ordered.findIndex((item) => itemId(item) === boundaryId);
  return { ordered, index: index < 0 ? ordered.length : index, found: index >= 0 };
}
