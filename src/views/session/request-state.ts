/** Reconciles a canonical pending-request snapshot without overwriting newer stream mutations. */
export function reconcilePendingRequests<T extends { id: string }>(
  snapshot: T[],
  live: T[],
  fetchRevision: number,
  currentRevision: number,
  revisionById: ReadonlyMap<string, number>,
): T[] {
  if (currentRevision === fetchRevision) return snapshot;
  const liveById = new Map(live.map((request) => [request.id, request]));
  const reconciled: T[] = [];
  const seen = new Set<string>();
  for (const request of snapshot) {
    const changedDuringFetch = (revisionById.get(request.id) ?? 0) > fetchRevision;
    const current = changedDuringFetch ? liveById.get(request.id) : request;
    if (current) {
      reconciled.push(current);
      seen.add(current.id);
    }
  }
  for (const request of live) {
    if (seen.has(request.id) || (revisionById.get(request.id) ?? 0) <= fetchRevision) continue;
    reconciled.push(request);
  }
  return reconciled;
}
