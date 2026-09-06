import type { OpenCodeSession } from "./services/opencode-types";

export interface SessionHierarchyDeps {
  getSession(sessionId: string, directory?: string): Promise<OpenCodeSession>;
}

/** Caches session ancestry and hydrates missing owner-to-root lineages for shared policies. */
export class SessionHierarchy {
  private readonly sessionsById = new Map<string, OpenCodeSession>();
  private readonly parentBySessionId = new Map<string, string | undefined>();
  private readonly sessionsWithKnownParent = new Set<string>();
  private readonly directoryBySessionId = new Map<string, string | undefined>();
  private readonly pendingSessions = new Map<string, Promise<OpenCodeSession>>();

  constructor(private readonly deps: SessionHierarchyDeps) {}

  /** Caches session metadata; authoritative snapshots can remove stale parent relationships. */
  cache(sessions: OpenCodeSession[], authoritative = false): void {
    for (const session of sessions) {
      if (!session?.id) continue;
      const parentId = this.readParentId(session);
      const directory = this.readDirectory(session);
      if (authoritative || parentId !== undefined) {
        this.parentBySessionId.set(session.id, parentId);
        this.sessionsWithKnownParent.add(session.id);
      }
      const previous = this.sessionsById.get(session.id);
      let cached = authoritative || !previous ? session : { ...previous, ...session };
      const knownParentId = this.parentBySessionId.get(session.id);
      if (!authoritative && knownParentId && !this.readParentId(cached)) cached = { ...cached, parentID: knownParentId };
      this.sessionsById.set(session.id, cached);
      if (directory !== undefined || !this.directoryBySessionId.has(session.id)) {
        this.directoryBySessionId.set(session.id, directory);
      }
    }
  }

  /** Exposes cached parent relationships to pure inherited-policy resolvers. */
  get parents(): ReadonlyMap<string, string | undefined> {
    return this.parentBySessionId;
  }

  /** Returns whether authoritative parent metadata is already cached for a session. */
  hasParent(sessionId: string): boolean {
    return this.sessionsWithKnownParent.has(sessionId);
  }

  /** Returns one cached parent id, if the session is known to be a subagent. */
  parentId(sessionId: string): string | undefined {
    return this.parentBySessionId.get(sessionId);
  }

  /** Returns the best known directory for a session. */
  directory(sessionId: string): string | undefined {
    return this.directoryBySessionId.get(sessionId);
  }

  /** Returns cached session metadata or hydrates it once from the v1 session endpoint. */
  async getSession(sessionId: string, directory?: string): Promise<OpenCodeSession> {
    const cached = this.sessionsById.get(sessionId);
    if (cached && this.sessionsWithKnownParent.has(sessionId)) return cached;
    const effectiveDirectory = this.directoryBySessionId.get(sessionId) ?? directory;
    const key = `${effectiveDirectory ?? ""}\u0000${sessionId}`;
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;
    const request = this.loadSession(key, sessionId, effectiveDirectory);
    this.pendingSessions.set(key, request);
    return request;
  }

  /** Hydrates and caches one session while releasing its shared in-flight slot on settlement. */
  private async loadSession(key: string, sessionId: string, directory?: string): Promise<OpenCodeSession> {
    try {
      const session = await this.deps.getSession(sessionId, directory);
      this.cache([session], true);
      return session;
    } finally {
      this.pendingSessions.delete(key);
    }
  }

  /** Hydrates a cycle-safe owner-to-root lineage, retaining the resolved prefix on upper lookup failure. */
  async lineage(sessionId: string, directory?: string): Promise<OpenCodeSession[]> {
    const lineage: OpenCodeSession[] = [];
    const visited = new Set<string>();
    let current: string | undefined = sessionId;
    while (current && !visited.has(current)) {
      visited.add(current);
      let session: OpenCodeSession;
      try {
        session = await this.getSession(current, this.directoryBySessionId.get(current) ?? directory);
      } catch (error) {
        if (lineage.length === 0) throw error;
        break;
      }
      lineage.push(session);
      current = this.parentBySessionId.get(current);
    }
    return lineage;
  }

  /** Reads canonical and tolerated legacy parent-id fields from session metadata. */
  private readParentId(session: OpenCodeSession): string | undefined {
    if (typeof session.parentID === "string" && session.parentID.trim()) return session.parentID;
    const legacy = session.parentId;
    return typeof legacy === "string" && legacy.trim() ? legacy : undefined;
  }

  /** Reads canonical and tolerated alternate working-directory fields from session metadata. */
  private readDirectory(session: OpenCodeSession): string | undefined {
    if (typeof session.directory === "string" && session.directory.trim()) return session.directory;
    const cwd = session.cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
  }
}
