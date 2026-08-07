/**
 * Test stub for the `obsidian` module. The real package ships type declarations
 * and lives only inside Obsidian's runtime; vitest needs a resolvable module so
 * imports like `MarkdownRenderer`, `setIcon`, `Notice`, and `Component` don't
 * blow up suite loading. Each export is a permissive no-op or factory.
 */

export class MarkdownRenderer {
  static renderMarkdown = async (): Promise<void> => undefined;
}

export class Notice {
  constructor(_message?: unknown) {}
}

export class Component {
  load() {}
  unload() {}
  register() {
    return () => {};
  }
}

export class App {}

export class Plugin extends Component {}

export class PluginSettingTab extends Component {
  containerEl = typeof document === "undefined" ? ({} as HTMLElement) : document.createElement("div");

  constructor(_app?: unknown, _plugin?: unknown) {
    super();
  }
}

export class Setting {
  constructor(_containerEl?: unknown) {}
  setName() { return this; }
  setDesc() { return this; }
  addToggle() { return this; }
  addText() { return this; }
}

export class WorkspaceLeaf {}

export class ItemView extends Component {
  app: unknown;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  leaf: unknown;

  constructor(leaf: { app?: unknown }) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = typeof document === "undefined" ? ({} as HTMLElement) : document.createElement("div");
    this.contentEl = typeof document === "undefined" ? ({} as HTMLElement) : document.createElement("div");
    if (typeof document !== "undefined") this.containerEl.appendChild(this.contentEl);
  }
}

export class Menu {}

export const Platform = { isMacOS: false, isWin: false, isMobile: false };

export const requestUrl = async (): Promise<Record<string, unknown>> => ({});

export class Modal {
  titleEl = typeof document === "undefined" ? {} : document.createElement("div");
  contentEl = typeof document === "undefined" ? {} : document.createElement("div");

  constructor(_app?: unknown) {}

  open() {}
}

export const setIcon = (): void => undefined;
