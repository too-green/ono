import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModelSelectionMenu,
  reorderFavoritesList,
  type FavoriteModelRef,
  type ModelEntry,
  type ModelSelectionMenuConfig,
} from "./ModelSelectionMenu";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by the model selection menu. */
function installObsidianDomMethods(): void {
  const create = function (this: HTMLElement, tag: string, options: DomOptions = {}): HTMLElement {
    const element = document.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    this.appendChild(element);
    return element;
  };
  Object.defineProperties(HTMLElement.prototype, {
    createDiv: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "div", options); } },
    createSpan: { configurable: true, value: function (this: HTMLElement, options?: DomOptions) { return create.call(this, "span", options); } },
    createEl: { configurable: true, value: function (this: HTMLElement, tag: string, options?: DomOptions) { return create.call(this, tag, options); } },
    addClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); } },
    removeClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); } },
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
  });
}

interface MenuHarness {
  menu: ModelSelectionMenu;
  config: ModelSelectionMenuConfig;
  favoriteRows(): HTMLElement[];
  favoriteNames(): string[];
}

/** Builds a menu with three favorited models and a plugin-style in-place mutating reorder callback. */
function buildMenu(): MenuHarness {
  const entries: ModelEntry[] = [
    { providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", variants: [] },
    { providerID: "openai", modelID: "gpt-5", name: "GPT-5", variants: [] },
    { providerID: "google", modelID: "gemini-pro", name: "Gemini Pro", variants: [] },
  ];
  const favorites: FavoriteModelRef[] = entries.map((e) => ({ providerID: e.providerID, modelID: e.modelID }));
  const config: ModelSelectionMenuConfig = {
    entries,
    selectedModel: undefined,
    favorites,
    anchorEl: document.body.createDiv(),
    onSelect: vi.fn(),
    onToggleFavorite: vi.fn(),
    // Mimics the plugin callback which mutates the shared array in place
    onReorderFavorites: vi.fn((next: FavoriteModelRef[]) => { favorites.splice(0, favorites.length, ...next); }),
  };
  return {
    menu: new ModelSelectionMenu(config),
    config,
    favoriteRows: () => Array.from(document.body.querySelectorAll<HTMLElement>(".opencode-model-menu__row.is-favorite-row")),
    favoriteNames: () => Array.from(document.body.querySelectorAll<HTMLElement>(".opencode-model-menu__row.is-favorite-row .opencode-model-menu__row-name")).map((el) => el.textContent ?? ""),
  };
}

/** Dispatches a drag event on a row with a stubbed dataTransfer and 10px-tall rect at top 0. */
function dispatchDrag(row: HTMLElement, type: string, clientY = 0): void {
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 0, height: 10 } as DOMRect);
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" } });
  row.dispatchEvent(event);
}

const menus: ModelSelectionMenu[] = [];

describe("ModelSelectionMenu favourites drag-and-drop", () => {
  beforeEach(() => {
    installObsidianDomMethods();
  });

  afterEach(() => {
    for (const menu of menus.splice(0)) menu.close();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("reorders via reorderFavoritesList for every direction", () => {
    expect(reorderFavoritesList(["a", "b", "c"], 0, 2, true)).toEqual(["b", "c", "a"]);
    expect(reorderFavoritesList(["a", "b", "c"], 2, 0, false)).toEqual(["c", "a", "b"]);
    expect(reorderFavoritesList(["a", "b", "c"], 0, 1, false)).toEqual(["a", "b", "c"]);
    expect(reorderFavoritesList(["a", "b", "c"], 1, 1, true)).toEqual(["a", "b", "c"]);
  });

  it("moves the first favourite after the last on drop", () => {
    const harness = buildMenu();
    menus.push(harness.menu);
    const [first, , last] = harness.favoriteRows();
    expect(harness.favoriteNames()).toEqual(["Claude Sonnet", "GPT-5", "Gemini Pro"]);

    dispatchDrag(first, "dragstart");
    dispatchDrag(last, "dragover", 8);
    dispatchDrag(last, "drop", 8);

    expect(harness.config.onReorderFavorites).toHaveBeenCalledWith([
      { providerID: "openai", modelID: "gpt-5" },
      { providerID: "google", modelID: "gemini-pro" },
      { providerID: "anthropic", modelID: "claude-sonnet" },
    ]);
    expect(harness.favoriteNames()).toEqual(["GPT-5", "Gemini Pro", "Claude Sonnet"]);
  });

  it("moves the last favourite before the first on drop", () => {
    const harness = buildMenu();
    menus.push(harness.menu);
    const [first] = harness.favoriteRows();
    const last = harness.favoriteRows()[2];

    dispatchDrag(last, "dragstart");
    dispatchDrag(first, "dragover", 2);
    dispatchDrag(first, "drop", 2);

    expect(harness.config.onReorderFavorites).toHaveBeenCalledWith([
      { providerID: "google", modelID: "gemini-pro" },
      { providerID: "anthropic", modelID: "claude-sonnet" },
      { providerID: "openai", modelID: "gpt-5" },
    ]);
    expect(harness.favoriteNames()).toEqual(["Gemini Pro", "Claude Sonnet", "GPT-5"]);
  });

  it("shows insertion indicators during dragover and clears them on drop", () => {
    const harness = buildMenu();
    menus.push(harness.menu);
    const [first, second] = harness.favoriteRows();

    dispatchDrag(first, "dragstart");
    dispatchDrag(second, "dragover", 8);
    expect(second.classList.contains("drop-after")).toBe(true);

    dispatchDrag(second, "dragover", 2);
    expect(second.classList.contains("drop-after")).toBe(false);
    expect(second.classList.contains("drop-before")).toBe(true);

    dispatchDrag(second, "drop", 2);
    expect(second.classList.contains("drop-before")).toBe(false);
    expect(first.classList.contains("is-dragging")).toBe(false);
  });

  it("ignores drops without a preceding dragstart", () => {
    const harness = buildMenu();
    menus.push(harness.menu);
    const [first] = harness.favoriteRows();

    dispatchDrag(first, "drop", 8);

    expect(harness.config.onReorderFavorites).not.toHaveBeenCalled();
    expect(harness.favoriteNames()).toEqual(["Claude Sonnet", "GPT-5", "Gemini Pro"]);
  });
});
