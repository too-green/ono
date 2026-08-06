import type { Component } from "obsidian";

/**
 * Minimal DOM-event registration surface that collaborators depend on.
 *
 * `registerDomEvent` is inherited from Obsidian's `Component` and only works on
 * the `ItemView` itself; cleanup is automatic via Obsidian's view lifecycle.
 * `SessionView.makeRegistrar()` returns an object whose `registerDomEvent`
 * delegates to the view, so collaborators never need a typed `SessionView` ref.
 *
 * Reference: `docs/product-spec/Founding Principles/Obsidian Native UI and UX`.
 */
export type DomEventRegistrar = Pick<Component, "registerDomEvent">;
