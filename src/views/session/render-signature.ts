/** Hashes serialized render state into a compact stable DOM signature. */
export function hashRenderState(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

interface CachedHash {
  revision: number;
  hash: string;
}

const revisions = new WeakMap<object, number>();
const hashCaches = new WeakMap<object, Map<string, CachedHash>>();
const registeredParts = new WeakSet<object>();

/** Bumps the mutation revision of an object so its cached render hashes recompute. */
export function touchRenderedState(target: object): void {
  revisions.set(target, (revisions.get(target) ?? 0) + 1);
}

/** Returns a hash of `derive()` cached on the object identity, derivation key, and mutation revision. */
export function cachedRenderHash(target: object, key: string, derive: () => string): string {
  const revision = revisions.get(target) ?? 0;
  let cache = hashCaches.get(target);
  if (!cache) {
    cache = new Map();
    hashCaches.set(target, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.revision === revision) return cached.hash;
  const hash = hashRenderState(derive());
  cache.set(key, { revision, hash });
  return hash;
}

/** Returns the cached full-content hash of one part, recomputed only after its revision changes. */
export function renderedPartHash(part: object): string {
  registeredParts.add(part);
  return cachedRenderHash(part, "part", () => JSON.stringify(part));
}

/** Returns annotate state with every registered part object replaced by its cached hash. */
export function projectedRenderState(state: unknown): unknown {
  if (Array.isArray(state)) return state.map(projectedRenderState);
  if (!state || typeof state !== "object") return state;
  if (registeredParts.has(state)) return renderedPartHash(state);
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(state)) projected[key] = projectedRenderState((state as Record<string, unknown>)[key]);
  return projected;
}
