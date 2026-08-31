import { describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";

interface TitleHarness {
  app: { workspace: { trigger: ReturnType<typeof vi.fn> } };
  containerEl: HTMLElement;
  leaf: { updateHeader: ReturnType<typeof vi.fn>; parent: { updateHeader: ReturnType<typeof vi.fn> } };
  model: { sessionId?: string; sessionDirectory?: string; sessionTitle?: string };
  plugin: { renameSession: ReturnType<typeof vi.fn> };
  getDisplayText: ReturnType<typeof vi.fn>;
  decorateSessionHeader(): void;
  applySessionTitle(title: string): void;
  refreshLeafTitle(): void;
  beginInlineTitleRename(container: HTMLElement, clickPoint?: { x: number; y: number }): void;
}

/** Builds a prototype-backed SessionView harness for isolated native-title lifecycle tests. */
function setup(): { view: TitleHarness; titleEl: HTMLElement; leafUpdate: ReturnType<typeof vi.fn>; parentUpdate: ReturnType<typeof vi.fn> } {
  const leafEl = document.createElement("div");
  leafEl.className = "workspace-leaf";
  const titleEl = document.createElement("div");
  titleEl.className = "view-header-title";
  const containerEl = document.createElement("div");
  leafEl.append(titleEl, containerEl);
  document.body.appendChild(leafEl);
  const leafUpdate = vi.fn();
  const parentUpdate = vi.fn();
  const view = Object.create(SessionView.prototype) as TitleHarness;
  Object.assign(view, {
    app: { workspace: { trigger: vi.fn() } },
    containerEl,
    leaf: { updateHeader: leafUpdate, parent: { updateHeader: parentUpdate } },
    model: { sessionId: "session-1", sessionDirectory: "/workspace" },
    plugin: { renameSession: vi.fn(async () => undefined) },
    getDisplayText: vi.fn(() => "Original title"),
    decorateSessionHeader: vi.fn(),
  });
  return { view, titleEl, leafUpdate, parentUpdate };
}

/** Drains pending promise turns so async commit paths settle before assertions. */
async function flushAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

const keydown = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { key, bubbles: true });

describe("SessionView native title editing", () => {
  it("defers header refresh while the rename editor is active", () => {
    const { view, titleEl, leafUpdate, parentUpdate } = setup();

    view.beginInlineTitleRename(titleEl);
    titleEl.textContent = "Draft title";
    view.refreshLeafTitle();

    expect(titleEl.getAttribute("contenteditable")).toBe("true");
    expect(titleEl.textContent).toBe("Draft title");
    expect(leafUpdate).not.toHaveBeenCalled();
    expect(parentUpdate).not.toHaveBeenCalled();
    expect(view.decorateSessionHeader).toHaveBeenCalledOnce();
  });

  it("reverts the title without saving when Escape is pressed", () => {
    const { view, titleEl } = setup();

    view.beginInlineTitleRename(titleEl);
    titleEl.textContent = "Discarded draft";
    titleEl.dispatchEvent(keydown("Escape"));

    expect(view.plugin.renameSession).not.toHaveBeenCalled();
    expect(titleEl.getAttribute("contenteditable")).toBeNull();
    expect(titleEl.textContent).toBe("Original title");
    expect(view.model.sessionTitle).toBe("Original title");
  });

  it("saves through the plugin on Enter", async () => {
    const { view, titleEl } = setup();

    view.beginInlineTitleRename(titleEl);
    titleEl.textContent = "Renamed title";
    titleEl.dispatchEvent(keydown("Enter"));
    await flushAsync();

    expect(view.plugin.renameSession).toHaveBeenCalledWith("session-1", "Renamed title", "/workspace");
    expect(titleEl.getAttribute("contenteditable")).toBeNull();
  });

  it("saves through the plugin on blur, like clicking outside the title", async () => {
    const { view, titleEl } = setup();

    view.beginInlineTitleRename(titleEl);
    titleEl.textContent = "Blurred title";
    titleEl.dispatchEvent(new FocusEvent("blur"));
    await flushAsync();

    expect(view.plugin.renameSession).toHaveBeenCalledWith("session-1", "Blurred title", "/workspace");
  });

  it("cancels instead of saving when external DOM removal causes blur", async () => {
    const { view, titleEl } = setup();

    view.beginInlineTitleRename(titleEl);
    titleEl.textContent = "Partial title";
    titleEl.remove();
    titleEl.dispatchEvent(new FocusEvent("blur"));
    await flushAsync();

    expect(view.plugin.renameSession).not.toHaveBeenCalled();
    expect(view.model.sessionTitle).toBe("Original title");
  });

  it("reverts the title and shows a native error tooltip when the rename fails", async () => {
    vi.useFakeTimers();
    try {
      const { view, titleEl } = setup();
      view.plugin.renameSession = vi.fn(async () => {
        throw new Error("Session name cannot be empty.");
      });

      view.beginInlineTitleRename(titleEl);
      titleEl.textContent = "Bad title";
      titleEl.dispatchEvent(keydown("Enter"));
      await flushAsync();

      expect(view.model.sessionTitle).toBe("Original title");
      expect(titleEl.textContent).toBe("Original title");
      const tooltip = document.body.querySelector<HTMLElement>(".tooltip.mod-error.mod-wide");
      expect(tooltip?.textContent).toBe("Session name cannot be empty.");
      expect(tooltip?.querySelector(".tooltip-arrow")).toBeTruthy();

      vi.advanceTimersByTime(4_000);
      expect(document.body.querySelector(".tooltip.mod-error.mod-wide")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
