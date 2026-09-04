import { FuzzySuggestModal, Modal, Setting, setIcon, type App, type FuzzyMatch } from "obsidian";
import type { OpenCodeCreateWorktreeInput } from "../services/opencode-types";

export type WorktreeDestructiveAction = "remove" | "reset";

/** Returns a compact display name for local or remote worktree paths. */
function basename(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? directory;
}

/** Removes blank optional fields before submitting a worktree creation request. */
export function normalizeWorktreeCreationInput(name: string, startCommand: string): OpenCodeCreateWorktreeInput {
  const normalizedName = name.trim();
  const normalizedCommand = startCommand.trim();
  return {
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedCommand ? { startCommand: normalizedCommand } : {}),
  };
}

/** Opens the form used to create an OpenCode-managed worktree. */
export function requestWorktreeCreation(app: App): Promise<OpenCodeCreateWorktreeInput | undefined> {
  return new Promise((resolve) => new CreateWorktreeModal(app, resolve).open());
}

/** Opens the destructive confirmation shared by worktree removal and reset. */
export function confirmWorktreeAction(app: App, action: WorktreeDestructiveAction, directory: string): Promise<boolean> {
  return new Promise((resolve) => new WorktreeConfirmationModal(app, action, directory, resolve).open());
}

/** Native fuzzy picker for unopened worktrees already known to the v1 server. */
export class ExistingWorktreeModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly directories: string[],
    private readonly onChoose: (directory: string) => void,
  ) {
    super(app);
    this.setTitle("Open existing worktree");
    this.setPlaceholder("Select an existing worktree...");
    this.emptyStateText = "No unopened OpenCode-managed worktrees were found.";
  }

  /** Adds the v1 discovery limitation above the native fuzzy picker. */
  onOpen(): void {
    super.onOpen();
    const note = document.createElement("p");
    note.className = "opencode-worktree-modal__note";
    note.textContent = "OpenCode v1 can only discover worktrees previously managed by OpenCode.";
    this.contentEl.prepend(note);
  }

  /** Returns unopened server-managed worktree directories to the fuzzy engine. */
  getItems(): string[] {
    return this.directories;
  }

  /** Matches both the worktree folder name and full remote path. */
  getItemText(directory: string): string {
    return `${basename(directory)} ${directory}`;
  }

  /** Renders a native folder-style worktree suggestion. */
  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    const row = el.createDiv({ cls: "opencode-folder-modal__row" });
    const icon = row.createSpan({ cls: "opencode-folder-modal__row-icon" });
    setIcon(icon, "git-branch");
    const content = row.createDiv({ cls: "opencode-folder-modal__row-content" });
    content.createDiv({ text: basename(match.item), cls: "opencode-folder-modal__row-name" });
    content.createDiv({ text: match.item, cls: "opencode-folder-modal__row-secondary" });
  }

  /** Opens the selected existing worktree in the sessions panel. */
  onChooseItem(directory: string): void {
    this.onChoose(directory);
  }
}

class CreateWorktreeModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly resolve: (input: OpenCodeCreateWorktreeInput | undefined) => void,
  ) {
    super(app);
  }

  /** Builds the optional name and startup-command fields. */
  onOpen(): void {
    this.setTitle("Create worktree");
    this.contentEl.createEl("p", { text: "The new opencode/* branch starts from the project worktree's current HEAD." });
    const form = this.contentEl.createEl("form");
    let name = "";
    let startCommand = "";
    let nameInput: HTMLInputElement | undefined;

    new Setting(form)
      .setName("Name")
      .setDesc("Optional. OpenCode generates a name when left blank.")
      .addText((text) => {
        nameInput = text.inputEl;
        text.setPlaceholder("feature-name").onChange((value) => { name = value; });
      });
    new Setting(form)
      .setName("Startup command")
      .setDesc("Optional command run after the project's configured startup command.")
      .addText((text) => text.setPlaceholder("npm install").onChange((value) => { startCommand = value; }));

    const buttons = form.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.finish(undefined));
    buttons.createEl("button", { text: "Create", cls: "mod-cta", attr: { type: "submit" } });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.finish(normalizeWorktreeCreationInput(name, startCommand));
    });
    window.setTimeout(() => nameInput?.focus(), 0);
  }

  /** Resolves an outside-click or Escape close as cancellation. */
  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(undefined);
  }

  /** Resolves the creation request once and closes the modal. */
  private finish(input: OpenCodeCreateWorktreeInput | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(input);
    this.close();
  }
}

class WorktreeConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly action: WorktreeDestructiveAction,
    private readonly directory: string,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  /** Builds the reset or removal warning with the exact affected directory. */
  onOpen(): void {
    const removing = this.action === "remove";
    this.setTitle(removing ? "Remove worktree?" : "Reset worktree?");
    this.contentEl.createEl("p", {
      text: removing
        ? "This permanently deletes the worktree directory, its uncommitted changes, and its branch."
        : "This permanently discards tracked and untracked changes, resets the worktree to the default branch, and archives its existing sessions.",
    });
    this.contentEl.createEl("code", { text: this.directory });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    buttons.createEl("button", { text: removing ? "Remove" : "Reset", cls: "mod-warning" })
      .addEventListener("click", () => this.finish(true));
    window.setTimeout(() => cancel.focus(), 0);
  }

  /** Resolves an outside-click or Escape close as cancellation. */
  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  /** Resolves the destructive decision once and closes the modal. */
  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}
