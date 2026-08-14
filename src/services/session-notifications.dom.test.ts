import { afterEach, describe, expect, it, vi } from "vitest";

import { isElementVisibleInFocusedWindow } from "./session-notifications";

/** Creates a connected pane-sized element with controllable Obsidian visibility. */
function createVisiblePane(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  element.isShown = vi.fn(() => true);
  element.getBoundingClientRect = vi.fn(() => ({
    x: 10,
    y: 10,
    top: 10,
    right: 410,
    bottom: 310,
    left: 10,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  }));
  return element;
}

describe("isElementVisibleInFocusedWindow", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("accepts a rendered split or expanded-sidebar pane in the focused window", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(isElementVisibleInFocusedWindow(createVisiblePane())).toBe(true);
  });

  it("rejects background tabs, collapsed panes, and panes in unfocused windows", () => {
    const element = createVisiblePane();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    element.isShown = vi.fn(() => false);
    expect(isElementVisibleInFocusedWindow(element)).toBe(false);

    element.isShown = vi.fn(() => true);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(isElementVisibleInFocusedWindow(element)).toBe(false);
  });
});
