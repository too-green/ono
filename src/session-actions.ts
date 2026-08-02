import { App, Modal, Setting } from "obsidian";

export interface SessionArchiveNode {
  id: string;
  title: string;
  directory?: string;
  archived: boolean;
  children: SessionArchiveNode[];
}

/** Opens the native-style text dialog used by non-inline session rename entry points. */
export function requestSessionTitle(app: App, currentTitle: string): Promise<string | undefined> {
  return new Promise((resolve) => new RenameSessionModal(app, currentTitle, resolve).open());
}

/** Opens the archive confirmation that lists the target session and every unarchived descendant. */
export function confirmSessionArchive(app: App, tree: SessionArchiveNode): Promise<boolean> {
  return new Promise((resolve) => new ArchiveSessionModal(app, tree, resolve).open());
}

/** Opens the confirmation for an already-staged v1 session rewind. */
export function confirmSessionRewind(app: App, messagePreview: string): Promise<boolean> {
  return new Promise((resolve) => new RewindSessionModal(app, messagePreview, resolve).open());
}

class RenameSessionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly currentTitle: string,
    private readonly resolve: (title: string | undefined) => void,
  ) {
    super(app);
  }

  /** Builds the rename field and native modal action row. */
  onOpen(): void {
    this.setTitle("Rename session");
    let value = this.currentTitle;
    const form = this.contentEl.createEl("form");
    const name = new Setting(form).setName("Session name");
    let input: HTMLInputElement | undefined;
    name.addText((text) => {
      input = text.inputEl;
      text.setValue(value).onChange((next) => {
        value = next;
      });
    });

    const buttons = form.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.finish(undefined));
    buttons.createEl("button", { text: "Save", cls: "mod-cta", attr: { type: "submit" } });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = value.trim();
      if (!title) {
        input?.focus();
        return;
      }
      this.finish(title);
    });

    window.setTimeout(() => {
      input?.focus();
      input?.select();
    }, 0);
  }

  /** Resolves cancellation when the modal closes by Escape or outside click. */
  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(undefined);
  }

  /** Resolves the dialog once and closes it. */
  private finish(title: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(title);
    this.close();
  }
}

class ArchiveSessionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly tree: SessionArchiveNode,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  /** Builds the destructive confirmation and recursive affected-session list. */
  onOpen(): void {
    const count = this.countUnarchived(this.tree);
    this.setTitle(count === 1 ? "Archive session?" : `Archive ${count} sessions?`);
    this.contentEl.createEl("p", {
      text: count === 1 ? "This session will no longer appear in the agents panel." : "This session and its descendants will no longer appear in the agents panel.",
    });
    const list = this.contentEl.createEl("ul");
    this.renderTree(list, this.tree);

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    const archive = buttons.createEl("button", { text: "Archive", cls: "mod-warning" });
    archive.addEventListener("click", () => this.finish(true));
    window.setTimeout(() => cancel.focus(), 0);
  }

  /** Resolves cancellation when the modal closes without an action. */
  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  /** Renders unarchived descendants as a nested native list. */
  private renderTree(container: HTMLUListElement, node: SessionArchiveNode): void {
    if (node.archived) {
      for (const child of node.children) this.renderTree(container, child);
      return;
    }
    const item = container.createEl("li", { text: node.title });
    const visibleChildren = node.children.filter((child) => this.countUnarchived(child) > 0);
    if (visibleChildren.length === 0) return;
    const children = item.createEl("ul");
    for (const child of visibleChildren) this.renderTree(children, child);
  }

  /** Counts sessions that the archive operation will mutate. */
  private countUnarchived(node: SessionArchiveNode): number {
    return (node.archived ? 0 : 1) + node.children.reduce((total, child) => total + this.countUnarchived(child), 0);
  }

  /** Resolves the dialog once and closes it. */
  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

class RewindSessionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly messagePreview: string,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  /** Builds the rewind boundary preview and native modal action row. */
  onOpen(): void {
    this.setTitle("Rewind session?");
    this.contentEl.createEl("p", { text: "Rewind to:" });
    this.contentEl.createEl("blockquote", { text: this.messagePreview });
    this.contentEl.createEl("p", { text: "This message and everything after it will be rewound, including file changes." });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    const rewind = buttons.createEl("button", { text: "Rewind", cls: "mod-warning" });
    rewind.addEventListener("click", () => this.finish(true));
    window.setTimeout(() => cancel.focus(), 0);
  }

  /** Clears the staged rewind when the modal closes without confirmation. */
  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  /** Resolves the modal once and closes it. */
  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}
