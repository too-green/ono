import { describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";

interface TitleHarness {
  app: { workspace: { trigger: ReturnType<typeof vi.fn> } };
  containerEl: HTMLElement;
  leaf: { updateHeader: ReturnType<typeof vi.fn>; parent: { updateHeader: ReturnType<typeof vi.fn> } };
  model: { sessionId?: string; sessionDirectory?: string };
  plugin: { renameSession: ReturnType<typeof vi.fn> };
  getDisplayText: ReturnType<typeof vi.fn>;
  applySessionTitle: ReturnType<typeof vi.fn>;
  decorateSessionHeader: ReturnType<typeof vi.fn>;
  bindNativeTitleRename: ReturnType<typeof vi.fn>;
  refreshLeafTitle(): void;
  beginInlineTitleRename(container: HTMLElement): void;
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
    applySessionTitle: vi.fn(),
    decorateSessionHeader: vi.fn(),
    bindNativeTitleRename: vi.fn(),
  });
  return { view, titleEl, leafUpdate, parentUpdate };
}

describe("SessionView native title editing", () => {
  it("defers header refresh while the rename input is active", () => {
    const { view, titleEl, leafUpdate, parentUpdate } = setup();
    const input = document.createElement("input");
    input.className = "view-header-title-input";
    input.value = "Draft title";
    titleEl.appendChild(input);

    view.refreshLeafTitle();

    expect(titleEl.firstElementChild).toBe(input);
    expect(input.value).toBe("Draft title");
    expect(leafUpdate).not.toHaveBeenCalled();
    expect(parentUpdate).not.toHaveBeenCalled();
    expect(view.decorateSessionHeader).toHaveBeenCalledOnce();
  });

  it("cancels instead of saving when external DOM removal causes blur", async () => {
    const { view, titleEl } = setup();
    view.beginInlineTitleRename(titleEl);
    const input = titleEl.querySelector<HTMLInputElement>(".view-header-title-input")!;
    input.value = "Partial title";

    input.remove();
    input.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();

    expect(view.plugin.renameSession).not.toHaveBeenCalled();
    expect(view.applySessionTitle).toHaveBeenCalledWith("Original title");
  });
});
