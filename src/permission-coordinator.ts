import type { OpenCodeService } from "./services/opencode-service";
import type { OpenCodePermissionRequest, OpenCodeSession } from "./services/opencode-types";
import { resolveSessionAutoApprove, type SessionAutoApproveState } from "./session-auto-approve";
import type { SessionHierarchy } from "./session-hierarchy";

type PermissionService = Pick<OpenCodeService, "replyPermission">;
type PendingPermissionState = "evaluating" | "surfaced" | "responding";

interface PendingPermission {
  request: OpenCodePermissionRequest;
  directory?: string;
  state: PendingPermissionState;
}

export interface PermissionCoordinatorDeps {
  getSettings: () => Readonly<Record<string, boolean>>;
  getService: () => PermissionService;
  hierarchy: SessionHierarchy;
  onSurface: (request: OpenCodePermissionRequest, directory?: string) => void;
  onSettled: (requestId: string) => void;
  onRespondingChanged: () => void;
  onError: (error: unknown) => void;
}

const SETTLED_REQUEST_LIMIT = 1_000;

/** Owns inherited auto-approve resolution and single-shot permission replies across duplicate streams. */
export class PermissionCoordinator {
  private readonly pendingByRequestId = new Map<string, PendingPermission>();
  private readonly respondingRequestIds = new Set<string>();
  private readonly settledRequestIds = new Set<string>();

  constructor(private readonly deps: PermissionCoordinatorDeps) {}

  /** Caches session parent and directory metadata; authoritative snapshots can remove stale parents. */
  cacheSessionHierarchy(sessions: OpenCodeSession[], authoritative = false): void {
    this.deps.hierarchy.cache(sessions, authoritative);
  }

  /** Returns the effective policy from currently cached ancestry. */
  getState(sessionId: string | undefined): SessionAutoApproveState {
    if (!sessionId) return { enabled: false, inherited: false };
    return resolveSessionAutoApprove(this.deps.getSettings(), sessionId, this.deps.hierarchy.parents);
  }

  /** Fetches missing ancestors before returning the effective policy, failing closed. */
  async hydrateState(sessionId: string, directory?: string): Promise<SessionAutoApproveState> {
    if (sessionId.startsWith("draft:")) return this.getState(sessionId);
    const visited = new Set<string>();
    let current: string | undefined = sessionId;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (Object.prototype.hasOwnProperty.call(this.deps.getSettings(), current)) break;
      if (!this.deps.hierarchy.hasParent(current)) {
        try {
          await this.deps.hierarchy.getSession(current, this.deps.hierarchy.directory(current) ?? directory);
        } catch {
          return { enabled: false, inherited: false };
        }
      }
      current = this.deps.hierarchy.parentId(current);
    }
    return this.getState(sessionId);
  }

  /** Computes the explicit value needed to invert a session's effective policy. */
  async overrideForToggle(sessionId: string, directory?: string): Promise<boolean | undefined> {
    const current = await this.hydrateState(sessionId, directory);
    const parentId = this.deps.hierarchy.parentId(sessionId);
    const inherited = parentId ? await this.hydrateState(parentId, directory) : { enabled: false };
    const enabled = !current.enabled;
    return enabled === inherited.enabled ? undefined : enabled;
  }

  /** Deduplicates one permission event and evaluates it before any view surfaces it. */
  route(request: OpenCodePermissionRequest, directory?: string): void {
    if (!request.id || !request.sessionID || this.settledRequestIds.has(request.id)) return;
    const existing = this.pendingByRequestId.get(request.id);
    if (existing) {
      existing.request = request;
      existing.directory ??= directory;
      if (existing.state === "surfaced" && this.getState(request.sessionID).enabled) void this.resolve(request.id);
      return;
    }
    this.pendingByRequestId.set(request.id, { request, directory, state: "evaluating" });
    void this.resolve(request.id);
  }

  /** True while a request is being policy-evaluated, auto-replied, or recently settled. */
  shouldSuppress(requestId: string): boolean {
    if (this.settledRequestIds.has(requestId)) return true;
    const state = this.pendingByRequestId.get(requestId)?.state;
    return state === "evaluating" || state === "responding";
  }

  /** Claims any permission/question response globally so duplicate controls cannot submit together. */
  beginResponse(requestId: string): boolean {
    if (this.respondingRequestIds.has(requestId)) return false;
    this.respondingRequestIds.add(requestId);
    this.deps.onRespondingChanged();
    return true;
  }

  /** Releases a failed manual response and restores every visible copy. */
  finishResponse(requestId: string): void {
    this.respondingRequestIds.delete(requestId);
    this.deps.onRespondingChanged();
  }

  /** Returns whether any view or automatic policy is responding to the request. */
  isResponding(requestId: string): boolean {
    return this.respondingRequestIds.has(requestId);
  }

  /** Settles a permission/question and removes all visible copies through the plugin boundary. */
  settle(requestId: string | undefined): void {
    if (!requestId) return;
    this.respondingRequestIds.delete(requestId);
    if (this.pendingByRequestId.delete(requestId)) this.rememberSettled(requestId);
    this.deps.onSettled(requestId);
  }

  /** Re-evaluates surfaced requests after an explicit policy changes. */
  async reconcile(): Promise<void> {
    await Promise.all(
      [...this.pendingByRequestId]
        .filter(([, pending]) => pending.state === "surfaced")
        .map(([requestId]) => this.resolve(requestId)),
    );
  }

  /** Resolves and, when enabled, replies to one pending permission exactly once. */
  private async resolve(requestId: string): Promise<void> {
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending || pending.state === "responding") return;
    pending.state = "evaluating";
    const directory = this.deps.hierarchy.directory(pending.request.sessionID) ?? pending.directory;
    const policy = await this.hydrateState(pending.request.sessionID, directory);
    const current = this.pendingByRequestId.get(requestId);
    if (!current || this.settledRequestIds.has(requestId)) return;
    if (!policy.enabled) {
      current.state = "surfaced";
      this.deps.onSurface(current.request, this.deps.hierarchy.directory(current.request.sessionID) ?? current.directory);
      return;
    }
    if (!this.beginResponse(requestId)) {
      current.state = "surfaced";
      return;
    }
    current.state = "responding";
    try {
      await this.deps.getService().replyPermission(requestId, "once", this.deps.hierarchy.directory(current.request.sessionID) ?? current.directory);
      this.settle(requestId);
    } catch (error) {
      current.state = "surfaced";
      this.finishResponse(requestId);
      this.deps.onSurface(current.request, this.deps.hierarchy.directory(current.request.sessionID) ?? current.directory);
      this.deps.onError(error);
    }
  }

  /** Keeps a bounded recent-ID window so delayed duplicate events cannot recreate settled requests. */
  private rememberSettled(requestId: string): void {
    this.settledRequestIds.add(requestId);
    while (this.settledRequestIds.size > SETTLED_REQUEST_LIMIT) {
      const oldest = this.settledRequestIds.values().next().value;
      if (!oldest) break;
      this.settledRequestIds.delete(oldest);
    }
  }
}
