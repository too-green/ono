/**
 * Shared domain-state bag for the session view.
 *
 * The shell (`SessionView`) owns one instance; collaborators (scroll, request docks,
 * composer, streaming, timeline) read/write shared fields by reference. Each
 * collaborator declares its own deps interface and never holds a typed reference
 * to the shell or to each other — this object is the only coupling surface.
 *
 * Controller-private state (timers, DOM refs, rAF handles, menu instances, etc.)
 * stays off-model and lives on its owning controller.
 *
 * Migration: Phase 1.5 of `docs/tmp/SessionView Decomposition Plan.md`.
 * Behavior-preserving — storage location only; method ownership unchanged.
 */
import type { JsonObject, OpenCodeMessageBundle, OpenCodeModelRef, OpenCodePermissionRequest, OpenCodeQuestionRequest } from "../../services/opencode-types";
import type { DiffFileSummary } from "../../diff-utils";

export class SessionViewModel {
  // ---- identity
  /** Active session id; undefined while showing a draft or before first load. */
  sessionId?: string;
  /** Active session title shown in the tab header; falls back to id when unset. */
  sessionTitle?: string;
  /** Absolute path of the active session's working directory; surfaced to slash actions. */
  sessionDirectory?: string;
  /** Draft id when the view is showing an unsaved composer draft; undefined once promoted. */
  draftId?: string;
  /** Working directory to use while the view is still a draft (before session promotion). */
  draftDirectory?: string;

  // ---- data
  /** Latest canonical session envelope from `session.get`. */
  currentSession?: JsonObject;
  /** Locally materialized message bundles; reconciled against stream events. */
  loadedMessages: OpenCodeMessageBundle[] = [];
  /** Pagination cursor for older messages; undefined when no more pages exist. */
  olderCursor?: string;
  /** True once the full history has been loaded; gates further backward pagination. */
  historyComplete = true;
  /** Session id captured at the last full timeline render; mismatch triggers a repaint. */
  renderedSessionId?: string;
  /** Files affected by a staged rewind; surfaced via the rewind boundary UI. */
  revertDiffFiles: DiffFileSummary[] = [];

  // ---- catalogs
  /** Cached agent definitions for the composer's agent picker. */
  availableAgents: JsonObject[] = [];
  /** Cached model definitions for the composer's model picker. */
  availableModels: JsonObject[] = [];
  /** Cached built-in server commands surfaced by the slash menu. */
  availableCommands: JsonObject[] = [];
  /** Server config envelope; drives permission defaults and provider metadata. */
  serverConfig?: JsonObject;
  /** Currently selected composer agent short name. */
  selectedAgent?: string;
  /** Currently selected composer model reference. */
  selectedModel?: OpenCodeModelRef;

  // ---- shared status / in-flight
  /** Active session status type string (busy / idle / error / etc.) from session events. */
  sessionStatusType = "idle";
  /** True while the session is actively producing output (mirrors `isActiveSessionStatus(sessionStatusType)`). */
  sessionBusy = false;
  /** True between sendComposerPrompt start and the first stream event / failure. */
  submittingPrompt = false;
  /** True while a rewind request is in flight; disables rewind UI affordances. */
  rewindInFlight = false;
  /** True while loading an older message page; prevents overlapping pagination. */
  loadingOlder = false;

  // ---- shared interaction
  /** True while the timeline auto-scrolls to follow the latest streamed token. */
  followLatest = false;

  // ---- shared domain: pending requests
  /** Pending permission requests surfaced by the request dock. */
  pendingPermissions: OpenCodePermissionRequest[] = [];
  /** Pending question requests surfaced by the request dock. */
  pendingQuestions: OpenCodeQuestionRequest[] = [];

  // ---- queue
  /** Server-assigned ids of queued user messages awaiting processing. */
  queuedMessageIds = new Set<string>();
  /** Count of queued user messages without a server id yet (submitted but unacknowledged). */
  pendingQueuedUserMessages = 0;

  /**
   * Stable persistence key for the composer's draft/attachments/mute state.
   *
   * Returns the active session id when one is bound, otherwise `draft:<draftId>`
   * while the view is showing an unsaved draft, otherwise undefined. Pure
   * function of identity state; safe to read from any collaborator.
   */
  get composerStorageKey(): string | undefined {
    return this.sessionId ?? (this.draftId ? `draft:${this.draftId}` : undefined);
  }
}
