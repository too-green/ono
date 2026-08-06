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

export class Modal {
  titleEl = typeof document === "undefined" ? {} : document.createElement("div");
  contentEl = typeof document === "undefined" ? {} : document.createElement("div");

  constructor(_app?: unknown) {}

  open() {}
}

export const setIcon = (): void => undefined;
