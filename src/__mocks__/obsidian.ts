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
  static history: Array<{ message: unknown; duration?: number }> = [];

  constructor(message?: unknown, duration?: number) {
    Notice.history.push({ message, duration });
  }
}

export class Component {
  load() {}
  unload() {}
  register() {
    return () => {};
  }
  addChild<T>(component: T): T {
    return component;
  }
  removeChild<T>(component: T): T {
    return component;
  }
}

export class App {}

export class Plugin extends Component {}

export abstract class AbstractInputSuggest<T> {
  constructor(_app?: unknown, _input?: unknown) {}
  onSelect(_callback: (value: T) => unknown) { return this; }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, element: HTMLElement): void;
}

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
  setHeading() { return this; }
  setClass() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
  addExtraButton() { return this; }
  addSearch() { return this; }
  addToggle() { return this; }
  addText() { return this; }
  addComponent<T>(_callback: (el: HTMLElement) => T): this { return this; }
}

export class SecretComponent {
  constructor(_app?: unknown, _containerEl?: unknown) {}
  setValue(_value: string) { return this; }
  onChange(_callback: (value: string) => unknown) { return this; }
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

export class MenuItem {
  title = "";
  icon = "";
  disabled = false;
  checked = false;
  callback?: () => unknown;

  /** Records a menu title and preserves Obsidian's fluent API in tests. */
  setTitle(title: string) { this.title = title; return this; }
  /** Records a menu icon and preserves Obsidian's fluent API in tests. */
  setIcon(icon: string) { this.icon = icon; return this; }
  /** Records disabled state and preserves Obsidian's fluent API in tests. */
  setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
  /** Records checked state and preserves Obsidian's fluent API in tests. */
  setChecked(checked: boolean) { this.checked = checked; return this; }
  /** Records the click handler and preserves Obsidian's fluent API in tests. */
  onClick(callback: () => unknown) { this.callback = callback; return this; }
}

export class Menu {
  static instances: Menu[] = [];
  readonly items: Array<MenuItem | "separator"> = [];
  shownAt?: MouseEvent;

  constructor() {
    Menu.instances.push(this);
  }

  /** Adds one configurable menu item to the test menu. */
  addItem(configure: (item: MenuItem) => unknown) {
    const item = new MenuItem();
    configure(item);
    this.items.push(item);
    return this;
  }

  /** Adds one separator marker to the test menu. */
  addSeparator() { this.items.push("separator"); return this; }

  /** Records where the menu would be shown in Obsidian. */
  showAtMouseEvent(event: MouseEvent) { this.shownAt = event; return this; }
}

export const Platform = { isMacOS: false, isWin: false, isMobile: false };

export const requestUrl = async (): Promise<Record<string, unknown>> => ({});

export class Modal {
  titleEl = typeof document === "undefined" ? {} as HTMLElement : document.createElement("div");
  contentEl = typeof document === "undefined" ? {} as HTMLElement : document.createElement("div");

  constructor(_app?: unknown) {}

  /** Mirrors Obsidian's fluent modal title setter in tests. */
  setTitle(title: string) { this.titleEl.textContent = title; return this; }
  /** Invokes the modal lifecycle hook in tests. */
  open() { this.onOpen(); }
  /** Invokes the modal close lifecycle hook in tests. */
  close() { this.onClose(); }
  /** Default no-op open hook overridden by concrete modals. */
  onOpen() {}
  /** Default no-op close hook overridden by concrete modals. */
  onClose() {}
}

export class SuggestModal<T> extends Modal {
  inputEl = typeof document === "undefined" ? {} as HTMLInputElement : document.createElement("input");
  resultContainerEl = typeof document === "undefined" ? {} as HTMLElement : document.createElement("div");
  emptyStateText = "";

  setPlaceholder(_placeholder: string) {}
}

export class FuzzySuggestModal<T> extends SuggestModal<T> {}

export const setIcon = (): void => undefined;
export const getIconIds = (): string[] => [];
