import { setIcon } from "obsidian";
import type { OpenCodeModelRef } from "../services/opencode-types";
import { setProviderIcon } from "../utils/provider-icons";

/** Pre-computed model entry passed in by SessionView for the selection menu. */
export interface ModelEntry {
  providerID: string;
  modelID: string;
  name: string;
  variants: string[];
}

/** A favorited model (+ optional variant) pair stored in plugin settings. */
export interface FavoriteModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

/** Configuration passed by SessionView when opening the model selection menu. */
export interface ModelSelectionMenuConfig {
  entries: ModelEntry[];
  selectedModel: OpenCodeModelRef | undefined;
  favorites: FavoriteModelRef[];
  anchorEl: HTMLElement;
  onSelect: (ref: OpenCodeModelRef) => void;
  onToggleFavorite: (ref: FavoriteModelRef) => void;
}

/** Normalizes variant labels for off-style reasoning presets. */
function variantLabel(variant: string): string {
  const norm = variant.toLowerCase().replace(/[_-]+/g, " ").trim();
  if (norm === "none" || norm === "off" || norm === "disabled" || norm === "no reasoning") return "off";
  return variant;
}

/** Stable key for comparing model + variant refs. */
function refKey(ref: { providerID: string; modelID: string; variant?: string }): string {
  return `${ref.providerID}/${ref.modelID}/${ref.variant ?? ""}`;
}

/**
 * Custom floating popover for model selection with search, favourites, provider
 * grouping, star toggle, and variant submenus.
 *
 * Built as plain DOM because Obsidian's Menu API lacks submenus, search inputs,
 * and dual-icon rows. Referenced by SessionView.showModelMenu().
 */
export class ModelSelectionMenu {
  private popoverEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private listEl: HTMLElement;
  private config: ModelSelectionMenuConfig;
  private rows: HTMLElement[] = [];
  private highlightedRow: HTMLElement | null = null;
  private submenuEl: HTMLElement | null = null;
  private submenuHideTimer: number | null = null;
  private outsideClickHandler: (event: MouseEvent) => void;
  private keydownHandler: (event: KeyboardEvent) => void;
  private resizeHandler: () => void;

  constructor(config: ModelSelectionMenuConfig) {
    this.config = config;
    this.popoverEl = document.body.createDiv({ cls: "opencode-model-menu" });

    // -- Search bar --
    const searchWrap = this.popoverEl.createDiv({ cls: "opencode-model-menu__search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "opencode-model-menu__search-icon" });
    setIcon(searchIcon, "search");
    this.searchEl = searchWrap.createEl("input", {
      cls: "opencode-model-menu__search",
      attr: { type: "text", placeholder: "Search models\u2026", spellcheck: "false", autocomplete: "off" },
    });

    // -- Scrollable list --
    this.listEl = this.popoverEl.createDiv({ cls: "opencode-model-menu__list" });

    // -- Wire events --
    this.searchEl.addEventListener("input", () => this.renderList(this.searchEl.value));
    this.outsideClickHandler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!this.popoverEl.contains(target) && !this.submenuEl?.contains(target)) this.close();
    };
    this.keydownHandler = (event: KeyboardEvent) => this.handleKeydown(event);
    this.resizeHandler = () => { this.positionPopover(); this.repositionSubmenu(); };
    document.addEventListener("mousedown", this.outsideClickHandler, true);
    document.addEventListener("keydown", this.keydownHandler, true);
    window.addEventListener("resize", this.resizeHandler);

    this.renderList("");
    this.positionPopover();
    window.setTimeout(() => this.searchEl.focus(), 0);
  }

  // ── Positioning ──────────────────────────────────────────────

  /** Places the popover below the anchor, clamped to the viewport. */
  private positionPopover(): void {
    const rect = this.config.anchorEl.getBoundingClientRect();
    const menuWidth = 340;
    const maxMenuHeight = 420;
    let left = rect.left;
    let top = rect.bottom + 4;

    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    if (left < 8) left = 8;
    if (top + maxMenuHeight > window.innerHeight - 8) top = Math.max(8, rect.top - maxMenuHeight - 4);

    this.popoverEl.style.left = `${left}px`;
    this.popoverEl.style.top = `${top}px`;
    this.popoverEl.style.width = `${menuWidth}px`;
  }

  /** Hides the submenu on viewport changes since positions become stale. */
  private repositionSubmenu(): void {
    this.hideSubmenu();
  }

  // ── Rendering ────────────────────────────────────────────────

  /** Rebuilds the scrollable list, optionally filtered by search text. */
  private renderList(searchText: string): void {
    this.hideSubmenu();
    this.listEl.empty();
    this.rows = [];
    this.highlightedRow = null;

    const query = searchText.toLowerCase().trim();
    const { entries, favorites } = this.config;

    // -- Favourites section (only when search is empty) --
    if (!query && favorites.length > 0) {
      this.addSectionHeader("Favourites");
      for (const fav of favorites) {
        const entry = entries.find((e) => e.providerID === fav.providerID && e.modelID === fav.modelID);
        if (!entry) continue;
        this.addFavoriteRow(entry, fav.variant);
      }
      this.listEl.createDiv({ cls: "opencode-model-menu__separator" });
    }

    // -- Provider sections --
    const filtered = query
      ? entries.filter((e) => e.name.toLowerCase().includes(query) || e.providerID.toLowerCase().includes(query))
      : entries;

    const byProvider = new Map<string, ModelEntry[]>();
    for (const entry of filtered) {
      const group = byProvider.get(entry.providerID) ?? [];
      group.push(entry);
      byProvider.set(entry.providerID, group);
    }

    let first = true;
    for (const [providerID, models] of byProvider) {
      if (!first) this.listEl.createDiv({ cls: "opencode-model-menu__separator" });
      first = false;
      this.addSectionHeader(providerID);
      for (const entry of models) this.addModelRow(entry);
    }

    if (this.rows.length === 0) {
      this.listEl.createDiv({ cls: "opencode-model-menu__empty", text: "No models found" });
    } else {
      this.setHighlight(this.rows[0]);
    }
  }

  /** Adds a non-interactive section label. */
  private addSectionHeader(label: string): void {
    this.listEl.createDiv({ cls: "opencode-model-menu__section-header", text: label });
  }

  /**
   * Adds a row in the Favourites section.
   * Clicking selects the model (+variant) directly because the row represents
   * a specific model-variant pair (per spec).
   */
  private addFavoriteRow(entry: ModelEntry, variant: string | undefined): void {
    const isOff = variant && ["none", "off", "disabled"].includes(variant.toLowerCase().replace(/[_-]/g, " "));
    const displayName = variant ? `${entry.name} (${isOff ? "off" : variant})` : entry.name;
    const row = this.createRow(entry, displayName, variant, true);
    this.listEl.appendChild(row);
    this.rows.push(row);
  }

  /**
   * Adds a row under a Provider section.
   * Clicking selects the model only if it has no variants; models with variants
   * require selecting from the hover submenu (per spec).
   * The star icon on every row toggles favorite status.
   */
  private addModelRow(entry: ModelEntry): void {
    const hasVariants = entry.variants.length > 0;
    const isSelected = this.isModelSelected(entry);
    const row = this.listEl.createDiv({
      cls: ["opencode-model-menu__row", hasVariants ? "has-variants" : ""].filter(Boolean).join(" "),
    });
    row.dataset.providerID = entry.providerID;
    row.dataset.modelID = entry.modelID;
    if (isSelected) row.addClass("is-selected");

    // Provider/model icon
    const iconEl = row.createSpan({ cls: "opencode-model-menu__row-icon" });
    setProviderIcon(iconEl, entry.providerID);

    // Model name
    row.createSpan({ cls: "opencode-model-menu__row-name", text: entry.name });

    // Currently-selected check mark
    if (isSelected) {
      const checkEl = row.createSpan({ cls: "opencode-model-menu__row-check" });
      setIcon(checkEl, "check");
    }

    // Star toggle — only shown on models WITHOUT variants.
    // Models with variants have their star in the submenu variant rows instead.
    let starEl: HTMLElement | null = null;
    if (!hasVariants) {
      const isFav = this.isFavorite(entry, undefined);
      starEl = row.createSpan({ cls: ["opencode-model-menu__row-star", isFav ? "is-favorite" : ""].join(" ") });
      setIcon(starEl, "star");
      starEl.title = "Toggle favorite";
    }

    // Variant submenu arrow
    if (hasVariants) {
      const arrowEl = row.createSpan({ cls: "opencode-model-menu__row-arrow" });
      setIcon(arrowEl, "chevron-right");
    }

    // -- Mouse interactions --
    row.addEventListener("mouseenter", () => {
      this.setHighlight(row);
      if (hasVariants) this.showSubmenu(row, entry);
      else this.hideSubmenu();
    });

    row.addEventListener("click", (event) => {
      // Clicking star toggles favorite
      if (starEl?.contains(event.target as Node)) {
        event.stopPropagation();
        this.toggleFavorite(entry, undefined);
        return;
      }
      // Clicking model without variants selects it
      if (!hasVariants) {
        this.selectModel(entry, undefined);
      }
      // Models with variants: click does nothing, user must use submenu
    });

    this.rows.push(row);
  }

  /** Creates a self-contained row element for the Favourites section. */
  private createRow(entry: ModelEntry, displayName: string, variant: string | undefined, isFavoriteRow: boolean): HTMLElement {
    const isSelected = this.isSameModel(entry, variant);
    const row = document.createElement("div");
    row.addClass("opencode-model-menu__row");
    if (isSelected) row.addClass("is-selected");
    if (isFavoriteRow) row.addClass("is-favorite-row");
    row.dataset.providerID = entry.providerID;
    row.dataset.modelID = entry.modelID;
    if (variant) row.dataset.variant = variant;

    const iconEl = row.createSpan({ cls: "opencode-model-menu__row-icon" });
    setProviderIcon(iconEl, entry.providerID);

    row.createSpan({ cls: "opencode-model-menu__row-name", text: displayName });

    if (isSelected) {
      const checkEl = row.createSpan({ cls: "opencode-model-menu__row-check" });
      setIcon(checkEl, "check");
    }

    // Star is always filled in favorites section
    const starEl = row.createSpan({ cls: "opencode-model-menu__row-star is-favorite" });
    setIcon(starEl, "star");

    row.addEventListener("mouseenter", () => {
      this.setHighlight(row);
      this.hideSubmenu();
    });

    row.addEventListener("click", (event) => {
      if (starEl.contains(event.target as Node)) {
        event.stopPropagation();
        this.toggleFavorite(entry, variant);
        return;
      }
      // Favorite rows select directly (model + variant)
      this.selectModel(entry, variant);
    });

    return row;
  }

  // ── Submenu ──────────────────────────────────────────────────

  /** Shows the variant submenu floating to the right of the given row. */
  private showSubmenu(rowEl: HTMLElement, entry: ModelEntry): void {
    this.cancelHideSubmenu();
    if (this.submenuEl && this.submenuEl.dataset.entryKey === refKey(entry)) return;
    this.hideSubmenu();

    const submenu = document.body.createDiv({ cls: "opencode-model-menu__submenu" });
    submenu.dataset.entryKey = refKey(entry);

    // "Default" option (variant = undefined)
    this.addSubmenuItem(submenu, entry, "Default", undefined);

    // Each variant
    for (const variant of entry.variants) {
      this.addSubmenuItem(submenu, entry, variantLabel(variant), variant);
    }

    // Position next to the row, clamping within viewport
    const rect = rowEl.getBoundingClientRect();
    const submenuWidth = 160;
    let left = rect.right + 2;
    if (left + submenuWidth > window.innerWidth - 8) left = rect.left - submenuWidth - 2;
    submenu.style.left = `${Math.max(8, left)}px`;
    submenu.style.top = `${rect.top}px`;
    submenu.style.minWidth = `${submenuWidth}px`;

    submenu.addEventListener("mouseenter", () => this.cancelHideSubmenu());
    submenu.addEventListener("mouseleave", () => this.scheduleHideSubmenu());

    this.submenuEl = submenu;
  }

  /** Adds one clickable variant option (with star toggle) to the submenu. */
  private addSubmenuItem(submenu: HTMLElement, entry: ModelEntry, label: string, variant: string | undefined): void {
    const isSelected = this.isSameModel(entry, variant);
    const isFav = this.isFavorite(entry, variant);
    const item = submenu.createDiv({
      cls: ["opencode-model-menu__submenu-item", isSelected ? "is-selected" : ""].filter(Boolean).join(" "),
    });
    item.createSpan({ cls: "opencode-model-menu__submenu-item-label", text: label });

    // Favorite toggle for this model+variant pair
    const starEl = item.createSpan({ cls: ["opencode-model-menu__submenu-item-star", isFav ? "is-favorite" : ""].join(" ") });
    setIcon(starEl, "star");

    if (isSelected) {
      const check = item.createSpan({ cls: "opencode-model-menu__submenu-item-check" });
      setIcon(check, "check");
    }

    item.addEventListener("click", (event) => {
      // Clicking star toggles favorite for this model+variant pair
      if (starEl.contains(event.target as Node)) {
        event.stopPropagation();
        this.toggleFavorite(entry, variant);
        this.refreshSubmenuSelection(entry);
        return;
      }
      this.selectModel(entry, variant);
    });
  }

  /** Re-shows the submenu after list re-render so star/selection states update. */
  private refreshSubmenuSelection(entry: ModelEntry): void {
    const row = this.rows.find((r) => r.dataset.providerID === entry.providerID && r.dataset.modelID === entry.modelID);
    if (row) this.showSubmenu(row, entry);
  }

  /** Removes the submenu element. */
  private hideSubmenu(): void {
    this.submenuEl?.remove();
    this.submenuEl = null;
  }

  /** Delays submenu hide to allow mouse to cross the gap between row and submenu. */
  private scheduleHideSubmenu(): void {
    this.submenuHideTimer = window.setTimeout(() => this.hideSubmenu(), 200);
  }

  /** Cancels a pending submenu hide. */
  private cancelHideSubmenu(): void {
    if (this.submenuHideTimer !== null) {
      window.clearTimeout(this.submenuHideTimer);
      this.submenuHideTimer = null;
    }
  }

  // ── Keyboard navigation ──────────────────────────────────────

  /** Handles keyboard navigation within the popover. */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.toggleFavoriteOnHighlight();
      return;
    }
  }

  /** Moves the highlight by delta (+1 or -1), wrapping at boundaries. */
  private moveHighlight(delta: number): void {
    if (this.rows.length === 0) return;
    const idx = this.highlightedRow ? this.rows.indexOf(this.highlightedRow) : -1;
    let next = idx + delta;
    if (next < 0) next = 0;
    if (next >= this.rows.length) next = this.rows.length - 1;
    this.setHighlight(this.rows[next]);
    this.rows[next].scrollIntoView({ block: "nearest" });
  }

  /** Sets the highlighted row, removing highlight from the previous one. */
  private setHighlight(row: HTMLElement): void {
    this.highlightedRow?.removeClass("is-highlighted");
    this.highlightedRow = row;
    row.addClass("is-highlighted");
  }

  /** Toggles favorite on the currently highlighted row. */
  private toggleFavoriteOnHighlight(): void {
    if (!this.highlightedRow) return;
    const entry = this.readEntryFromRow(this.highlightedRow);
    if (!entry) return;
    const variant = this.highlightedRow.dataset.variant;
    this.toggleFavorite(entry, variant);
  }

  /** Reads the ModelEntry from a row's data attributes. */
  private readEntryFromRow(row: HTMLElement): ModelEntry | undefined {
    const providerID = row.dataset.providerID;
    const modelID = row.dataset.modelID;
    if (!providerID || !modelID) return undefined;
    return this.config.entries.find((e) => e.providerID === providerID && e.modelID === modelID);
  }

  // ── Actions ──────────────────────────────────────────────────

  /** Selects a model (+ optional variant) and closes the menu. */
  private selectModel(entry: ModelEntry, variant: string | undefined): void {
    const ref: OpenCodeModelRef = { providerID: entry.providerID, modelID: entry.modelID };
    if (variant) ref.variant = variant;
    this.config.onSelect(ref);
    this.close();
  }

  /** Toggles favorite status and re-renders the list. */
  private toggleFavorite(entry: ModelEntry, variant: string | undefined): void {
    // onToggleFavorite synchronously mutates the favorites array before its internal await
    this.config.onToggleFavorite({ providerID: entry.providerID, modelID: entry.modelID, variant });
    this.renderList(this.searchEl.value);
  }

  // ── Predicates ───────────────────────────────────────────────

  /** True when the entry matches the currently selected model (ignoring variant). */
  private isModelSelected(entry: ModelEntry): boolean {
    const sel = this.config.selectedModel;
    return !!sel && sel.providerID === entry.providerID && sel.modelID === entry.modelID;
  }

  /** True when the entry + variant exactly matches the currently selected model. */
  private isSameModel(entry: ModelEntry, variant?: string): boolean {
    const sel = this.config.selectedModel;
    if (!sel) return false;
    if (sel.providerID !== entry.providerID || sel.modelID !== entry.modelID) return false;
    return (sel.variant ?? undefined) === (variant ?? undefined);
  }

  /** True when a model (+ optional variant) is in the favorites list. */
  private isFavorite(entry: ModelEntry, variant: string | undefined): boolean {
    return this.config.favorites.some(
      (f) => f.providerID === entry.providerID && f.modelID === entry.modelID && (f.variant ?? undefined) === (variant ?? undefined),
    );
  }

  // ── Teardown ─────────────────────────────────────────────────

  /** Removes the popover and all listeners. */
  close(): void {
    this.hideSubmenu();
    this.popoverEl.remove();
    document.removeEventListener("mousedown", this.outsideClickHandler, true);
    document.removeEventListener("keydown", this.keydownHandler, true);
    window.removeEventListener("resize", this.resizeHandler);
  }
}
