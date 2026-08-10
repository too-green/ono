import { setIcon } from "obsidian";

import type { DiffFileSummary } from "../../../diff-utils";
import type { OpenCodeMessageBundle } from "../../../services/opencode-types";
import { capitalized, elapsedDurationLabel, messageId, messageTime, modelLabel } from "../message-helpers";
import { readObject, readString } from "../json-helpers";

export type MessageRole = "assistant" | "user";

export interface MessageMetaCallbacks {
  /** Returns true when a message id is currently queued for send. */
  isQueued: (messageId: string) => boolean;
  /** Fork the session after the given assistant message id. */
  onFork: (messageId: string) => void;
  /** Request a rewind to the given user message bundle. */
  onRewind: (bundle: OpenCodeMessageBundle) => void;
}

export interface RewindBoundaryProps {
  /** Current revert message id, or undefined when no rewind boundary is active. */
  revertMessageId?: string;
  /** Files affected by the rewind. */
  revertDiffFiles: DiffFileSummary[];
  /** Restore the next rewound turn. */
  onRedo: () => void;
}

export interface AssistantMetaOptions {
  /** Whether this row represents the assistant turn that is currently active. */
  working: boolean;
  /** Start of the complete assistant turn, normally the preceding user message creation time. */
  startedAt?: number;
  /** End of the complete assistant turn, normally the final assistant message completion time. */
  completedAt?: number;
  /** Last assistant message id used as the fork boundary; absent before the first assistant message exists. */
  forkMessageId?: string;
}

/** Renders the small meta row beneath a message (agent/model/time, copy, fork/rewind actions); called by `TimelineRenderer`. */
export function renderMessageMeta(
  container: HTMLElement,
  bundle: OpenCodeMessageBundle,
  role: MessageRole,
  copyText: string,
  callbacks: MessageMetaCallbacks,
  assistantOptions?: AssistantMetaOptions,
): HTMLElement {
  const meta = container.createDiv({ cls: `opencode-session-view__message-meta opencode-session-view__message-meta--${role}` });
  if (role === "assistant" && assistantOptions?.working) {
    meta.addClass("opencode-session-view__message-meta--working");
    meta.setAttr("aria-busy", "true");
    meta.createSpan({ cls: "opencode-session-view__message-working-indicator", attr: { "aria-hidden": "true" } });
  }
  if (role === "assistant") renderAssistantMetaText(meta, bundle, assistantOptions);
  else {
    const items = userMetaItems(bundle);
    if (items.length > 0) meta.createSpan({ text: items.join(" · "), cls: "opencode-session-view__message-meta-text" });
  }
  if (role === "user" && callbacks.isQueued(messageId(bundle))) {
    meta.createSpan({ text: "QUEUED", cls: "opencode-session-view__queued-badge is-visible" });
  }
  if (role === "assistant" && assistantOptions?.working) return meta;
  const copyAvailable = !!copyText.trim();
  if (copyAvailable) {
    const copyLabel = role === "assistant" ? "Copy assistant turn" : "Copy user message";
    const copy = meta.createEl("button", { attr: { "aria-label": copyLabel }, cls: "opencode-session-view__message-action clickable-icon" });
    setIcon(copy, "copy");
    copy.addEventListener("click", async (event) => {
      event.stopPropagation();
      await navigator.clipboard.writeText(copyText);
      setIcon(copy, "check");
      window.setTimeout(() => setIcon(copy, "copy"), 1400);
    });
  }
  if (role === "assistant") {
    const fork = meta.createEl("button", { attr: { "aria-label": "Fork session after this assistant turn" }, cls: "opencode-session-view__message-action clickable-icon" });
    const forkMessageId = assistantOptions ? assistantOptions.forkMessageId : messageId(bundle);
    fork.disabled = !forkMessageId;
    if (fork.disabled) fork.title = "Available when the assistant turn finishes";
    setIcon(fork, "git-fork");
    fork.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!fork.disabled && forkMessageId) callbacks.onFork(forkMessageId);
    });
  }
  if (role === "user") {
    const rewind = meta.createEl("button", { attr: { "aria-label": "Rewind session to this message" }, cls: "opencode-session-view__message-action clickable-icon" });
    setIcon(rewind, "undo-2");
    rewind.addEventListener("click", (event) => {
      event.stopPropagation();
      callbacks.onRewind(bundle);
    });
  }
  return meta;
}

/** Renders the v1 rewind boundary, affected files, and redo action after the visible timeline head; called by `TimelineRenderer`. */
export function renderRewindBoundary(container: HTMLElement, props: RewindBoundaryProps): void {
  const messageId = props.revertMessageId;
  if (!messageId) return;
  const boundary = container.createDiv({ cls: "opencode-session-view__rewind-boundary", attr: { "data-rewind-message-id": messageId } });
  const header = boundary.createDiv({ cls: "opencode-session-view__rewind-header" });
  const title = header.createDiv({ cls: "opencode-session-view__rewind-title" });
  const icon = title.createSpan({ cls: "opencode-session-view__rewind-icon" });
  setIcon(icon, "undo-2");
  title.createSpan({ text: "Session rewound" });

  const redo = header.createEl("button", { cls: "opencode-session-view__rewind-redo", attr: { "aria-label": "Restore the next rewound turn" } });
  setIcon(redo, "redo-2");
  redo.createSpan({ text: "Redo" });
  redo.addEventListener("click", () => props.onRedo());

  if (props.revertDiffFiles.length === 0) {
    boundary.createDiv({ text: "No files affected", cls: "opencode-session-view__rewind-empty" });
    return;
  }
  const files = boundary.createDiv({ cls: "opencode-session-view__rewind-files" });
  for (const file of props.revertDiffFiles) {
    const row = files.createDiv({ cls: "opencode-session-view__rewind-file" });
    row.createSpan({ text: file.file, cls: "opencode-session-view__rewind-file-path", attr: { title: file.file } });
    const stats = row.createSpan({ cls: "opencode-session-view__rewind-file-stats" });
    if (file.additions > 0) stats.createSpan({ text: `+${file.additions}`, cls: "opencode-session-view__rewind-file-additions" });
    if (file.deletions > 0) stats.createSpan({ text: `-${file.deletions}`, cls: "opencode-session-view__rewind-file-deletions" });
  }
}

/** Builds the lean user-message metadata fields from message time. */
function userMetaItems(bundle: OpenCodeMessageBundle): string[] {
  const time = messageTime(bundle);
  return time ? [new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(time)] : [];
}

/** Renders assistant metadata as independently updateable items for the live duration clock. */
function renderAssistantMetaText(meta: HTMLElement, bundle: OpenCodeMessageBundle, options: AssistantMetaOptions | undefined): void {
  const duration = elapsedDurationLabel(options?.startedAt, options?.working ? Date.now() : options?.completedAt);
  const items: Array<{ text: string; className?: string; startedAt?: number }> = [
    capitalized(readString(bundle.info, ["agent"])),
    modelLabel(bundle.info),
  ].filter((item): item is string => !!item).map((text) => ({ text }));
  if (duration) items.push({ text: duration, className: "opencode-session-view__message-meta-duration", startedAt: options?.working ? options.startedAt : undefined });
  const error = readObject(bundle.info, "error");
  if (readString(error ?? {}, ["name", "type"]) === "MessageAbortedError") items.push({ text: "Interrupted" });
  if (items.length === 0) return;

  const text = meta.createSpan({ cls: "opencode-session-view__message-meta-text" });
  for (const [index, item] of items.entries()) {
    const cls = ["opencode-session-view__message-meta-item", item.className].filter(Boolean).join(" ");
    const prefix = index === 0 ? "" : " · ";
    const attr = item.startedAt === undefined ? undefined : { "data-turn-started-at": String(item.startedAt), "data-meta-prefix": prefix };
    text.createSpan({ text: `${prefix}${item.text}`, cls, attr });
  }
}
