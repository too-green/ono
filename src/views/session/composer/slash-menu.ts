import type { JsonObject } from "../../../services/opencode-types";
import type { SessionViewModel } from "../session-view-model";
import { readObject, readString } from "../json-helpers";

/** All possible built-in functional slash commands. Visibility is filtered per-session by `visibleBuiltinCommands()`. */
const ALL_BUILTIN_COMMANDS: { name: string; description: string }[] = [
  { name: "compact", description: "Compact session context into a summary" },
  { name: "undo", description: "Rewind to the previous user message" },
  { name: "redo", description: "Restore the next rewound turn" },
  { name: "fork", description: "Fork the session from the latest message" },
  { name: "share", description: "Share the session" },
  { name: "unshare", description: "Unshare the session" },
];

/** Reads the command identifier from loose command-list entries. Shared by slash-menu and (Phase 4b) `parseSlashCommand`. */
export function commandName(command: JsonObject): string | undefined {
  return readString(command, ["name", "id", "command"]);
}

/** Returns built-in commands visible under current config + session state. Mirrors TUI/GUI gating logic. */
export function visibleBuiltinCommands(currentSession: JsonObject | undefined, serverConfig: JsonObject | undefined): { name: string; description: string }[] {
  const shareEnabled = readString(serverConfig ?? {}, ["share"]) !== "disabled";
  const shareObj = currentSession ? readObject(currentSession, "share") : undefined;
  const revertObj = currentSession ? readObject(currentSession, "revert") : undefined;
  const sessionShared = !!shareObj?.url;
  const canRedo = !!revertObj?.messageID;
  return ALL_BUILTIN_COMMANDS.filter((cmd) => {
    if (cmd.name === "share") return shareEnabled;
    if (cmd.name === "unshare") return shareEnabled && sessionShared;
    if (cmd.name === "redo") return canRedo;
    return true;
  });
}

/** Returns slash commands (server + built-in) matching the token currently being typed at the start of the composer. */
export function slashCommandCandidates(
  textarea: HTMLTextAreaElement,
  availableCommands: JsonObject[],
  currentSession: JsonObject | undefined,
  serverConfig: JsonObject | undefined,
): Array<{ name: string; description?: string }> {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return [];
  const query = match[1].toLowerCase();
  const serverCommands = availableCommands
    .filter((command) => {
      if (readString(command, ["source"]) === "skill") return false;
      const name = commandName(command)?.toLowerCase();
      return name ? name.includes(query) : false;
    })
    .map((command) => ({ name: commandName(command)!, description: readString(command, ["description", "summary"]) }));
  const builtin = visibleBuiltinCommands(currentSession, serverConfig).filter((cmd) => cmd.name.toLowerCase().includes(query));
  return [...serverCommands, ...builtin].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Deps injected by `SessionView` when constructing a `SlashMenuController`.
 *
 * The popover attaches to `document.body`, so the shell must call `dispose()`
 * on close to remove both the DOM node and the capture-phase outside-click
 * listener. The shell provides `onResizeInput` and `onScheduleDraftSave` so
 * `insertSlashCommand` can re-flow the textarea and persist the new draft
 * without owning composer internals.
 */
export interface SlashMenuDeps {
  model: SessionViewModel;
  onResizeInput: (textarea: HTMLTextAreaElement) => void;
  onScheduleDraftSave: () => void;
}

/**
 * Owns the floating slash-command popover above the composer textarea.
 *
 * Controller-private state (`composerSlashMenuEl`, highlight index, row list,
 * outside-click handler) lives here and never leaks into `SessionViewModel`.
 * The shell invokes `update()` on input, `handleKeydown()` on textarea keys,
 * and `hide()` / `dispose()` when the composer is rebuilt or the view closes.
 *
 * Reference: Phase 4a of `docs/tmp/SessionView Decomposition Plan.md`.
 */
export class SlashMenuController {
  private composerSlashMenuEl?: HTMLElement;
  private slashMenuHighlight = -1;
  private slashMenuRows: HTMLElement[] = [];
  private slashMenuOutsideClick?: (event: MouseEvent) => void;

  constructor(private readonly deps: SlashMenuDeps) {}

  /** Shows or refreshes the popover for the current textarea token; hides when no candidates. */
  update(textarea: HTMLTextAreaElement): void {
    const candidates = slashCommandCandidates(textarea, this.deps.model.availableCommands, this.deps.model.currentSession, this.deps.model.serverConfig).slice(0, 8);
    if (candidates.length === 0) {
      this.hide();
      return;
    }
    if (!this.composerSlashMenuEl) {
      this.composerSlashMenuEl = document.body.createDiv({ cls: "opencode-slash-menu" });
      this.slashMenuOutsideClick = (event: MouseEvent) => {
        if (!this.composerSlashMenuEl?.contains(event.target as Node) && event.target !== textarea) this.hide();
      };
      document.addEventListener("mousedown", this.slashMenuOutsideClick, true);
    }
    const menu = this.composerSlashMenuEl;
    menu.empty();
    this.slashMenuRows = [];
    for (const command of candidates) {
      const row = menu.createDiv({ cls: "opencode-slash-menu__row" });
      row.createSpan({ text: `/${command.name}`, cls: "opencode-slash-menu__name" });
      if (command.description) row.createSpan({ text: command.description, cls: "opencode-slash-menu__description" });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSlashCommand(textarea, command.name);
      });
      this.slashMenuRows.push(row);
    }
    this.slashMenuHighlight = 0;
    this.updateSlashMenuHighlight();
    this.positionSlashMenu(textarea);
  }

  /** Handles keyboard navigation for the slash-command popover. Returns true if the event was consumed. */
  handleKeydown(event: KeyboardEvent, textarea: HTMLTextAreaElement): boolean {
    if (!this.composerSlashMenuEl) return false;
    if (event.key === "Escape") {
      this.hide();
      event.preventDefault();
      return true;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.slashMenuHighlight = Math.min(this.slashMenuHighlight + 1, this.slashMenuRows.length - 1);
      this.updateSlashMenuHighlight();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.slashMenuHighlight = Math.max(this.slashMenuHighlight - 1, 0);
      this.updateSlashMenuHighlight();
      return true;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      const row = this.slashMenuRows[this.slashMenuHighlight] ?? this.slashMenuRows[0];
      if (!row) return false;
      event.preventDefault();
      const candidates = slashCommandCandidates(textarea, this.deps.model.availableCommands, this.deps.model.currentSession, this.deps.model.serverConfig);
      const name = candidates[this.slashMenuHighlight]?.name ?? candidates[0]?.name;
      if (name) this.insertSlashCommand(textarea, name);
      return true;
    }
    return false;
  }

  /** Hides and removes the slash menu popover. */
  hide(): void {
    this.composerSlashMenuEl?.remove();
    this.composerSlashMenuEl = undefined;
    this.slashMenuRows = [];
    this.slashMenuHighlight = -1;
    if (this.slashMenuOutsideClick) {
      document.removeEventListener("mousedown", this.slashMenuOutsideClick, true);
      this.slashMenuOutsideClick = undefined;
    }
  }

  /** Drops the popover + outside-click listener; called by `SessionView.onClose`. */
  dispose(): void {
    this.hide();
  }

  // ---- private helpers

  /** Positions the popover above the textarea, clamped to the viewport. */
  private positionSlashMenu(textarea: HTMLTextAreaElement): void {
    if (!this.composerSlashMenuEl) return;
    const rect = textarea.getBoundingClientRect();
    const menuWidth = 360;
    const menuEl = this.composerSlashMenuEl;
    let left = rect.left;
    let top = rect.top - 4;
    menuEl.style.width = `${menuWidth}px`;
    const menuHeight = menuEl.offsetHeight;
    top = Math.max(8, top - menuHeight);
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  /** Applies the highlight class to the current slash menu selection. */
  private updateSlashMenuHighlight(): void {
    this.slashMenuRows.forEach((row, idx) => row.toggleClass("is-highlighted", idx === this.slashMenuHighlight));
    const highlighted = this.slashMenuRows[this.slashMenuHighlight];
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }

  /** Replaces the current slash token with the selected command and leaves room for arguments. */
  private insertSlashCommand(textarea: HTMLTextAreaElement, name: string): void {
    const rest = textarea.value.slice(textarea.selectionStart).replace(/^\S*/, "");
    textarea.value = `/${name} ${rest}`;
    textarea.selectionStart = textarea.selectionEnd = name.length + 2;
    this.deps.onResizeInput(textarea);
    this.hide();
    this.deps.onScheduleDraftSave();
    textarea.focus();
  }
}
