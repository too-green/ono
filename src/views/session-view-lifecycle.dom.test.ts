import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "./SessionView";
import { SessionViewModel } from "./session/session-view-model";

type DomOptions = { text?: string; cls?: string; attr?: Record<string, string> };

/** Installs the Obsidian HTMLElement helpers used by SessionView lifecycle states. */
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
    empty: { configurable: true, value: function (this: HTMLElement) { this.replaceChildren(); } },
    removeClass: { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); } },
  });
}

interface LifecycleHarness {
  model: SessionViewModel;
  contentEl: HTMLElement;
  leaf: { detach: ReturnType<typeof vi.fn> };
  composer: { onSessionStatusChanged: ReturnType<typeof vi.fn> };
  stream: { disconnect: ReturnType<typeof vi.fn> };
  island: { unbind: ReturnType<typeof vi.fn> };
  docks: { resetQueue: ReturnType<typeof vi.fn> };
  timeline: { clearDisclosureState: ReturnType<typeof vi.fn> };
  scroll: { clearJumpButtonReference: ReturnType<typeof vi.fn>; disableFollowLatest: ReturnType<typeof vi.fn> };
  descendantChildrenCache: Map<string, unknown>;
  plugin: { forgetSessionState: ReturnType<typeof vi.fn> };
  refreshSessionStateChrome: ReturnType<typeof vi.fn>;
  sessionBindingVersion: number;
  canonicalRequestVersion: number;
  loadingSessionId?: string;
  applyConnectionState(connected: boolean): void;
  applySessionDeleted(): void;
  resetTimelineState(options?: { preserveSubmission?: boolean }): void;
}

/** Builds a prototype-backed SessionView harness for connection and deletion DOM tests. */
function setup(): LifecycleHarness {
  const model = new SessionViewModel();
  model.sessionId = "session-1";
  model.currentSession = { id: "session-1" };
  const view = Object.create(SessionView.prototype) as LifecycleHarness;
  Object.assign(view, {
    model,
    contentEl: document.createElement("div"),
    leaf: { detach: vi.fn() },
    composer: { onSessionStatusChanged: vi.fn() },
    stream: { disconnect: vi.fn() },
    island: { unbind: vi.fn() },
    docks: { resetQueue: vi.fn() },
    timeline: { clearDisclosureState: vi.fn() },
    scroll: { clearJumpButtonReference: vi.fn(), disableFollowLatest: vi.fn() },
    descendantChildrenCache: new Map(),
    plugin: { forgetSessionState: vi.fn(async () => undefined) },
    refreshSessionStateChrome: vi.fn(),
    sessionBindingVersion: 4,
    canonicalRequestVersion: 7,
    loadingSessionId: "session-1",
  });
  document.body.appendChild(view.contentEl);
  return view;
}

describe("SessionView connection lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    installObsidianDomMethods();
  });

  it("adds and removes the non-blocking reconnect banner in place", () => {
    const view = setup();
    const shell = view.contentEl.createDiv({ cls: "opencode-session-view__shell" });
    const timeline = shell.createDiv({ cls: "opencode-session-view__timeline" });
    view.applyConnectionState(false);
    const banner = shell.querySelector(".opencode-session-view__connection-banner");
    expect(banner?.textContent).toContain("Reconnecting to opencode server");
    expect(banner?.nextElementSibling).toBe(timeline);
    expect(view.composer.onSessionStatusChanged).toHaveBeenCalledOnce();

    view.applyConnectionState(true);
    expect(shell.querySelector(".opencode-session-view__connection-banner")).toBeNull();
  });

  it("replaces a deleted session with a closeable terminal state", () => {
    const view = setup();
    view.model.sessionBusy = true;
    view.model.sessionError = { error: { name: "APIError" }, message: "Failed" };
    view.contentEl.createDiv({ cls: "opencode-session-view__shell" });
    view.applySessionDeleted();
    expect(view.model.sessionDeleted).toBe(true);
    expect(view.model.sessionBusy).toBe(false);
    expect(view.model.sessionError).toBeUndefined();
    expect(view.sessionBindingVersion).toBe(5);
    expect(view.canonicalRequestVersion).toBe(8);
    expect(view.loadingSessionId).toBeUndefined();
    expect(view.contentEl.textContent).toContain("Session no longer exists");
    expect(view.stream.disconnect).toHaveBeenCalledOnce();
    expect(view.island.unbind).toHaveBeenCalledOnce();
    expect(view.plugin.forgetSessionState).toHaveBeenCalledWith(["session-1"]);

    view.contentEl.querySelector<HTMLButtonElement>("button")!.click();
    expect(view.leaf.detach).toHaveBeenCalledOnce();
  });

  it("preserves the in-flight submission guard during draft promotion reset", () => {
    const view = setup();
    view.model.submittingPrompt = true;
    view.resetTimelineState({ preserveSubmission: true });
    expect(view.model.submittingPrompt).toBe(true);
  });

  it("does not recreate composer state when a forgotten server-session tab closes", async () => {
    const persistDraft = vi.fn();
    const dispose = vi.fn();
    const model = new SessionViewModel();
    model.sessionId = "archived";
    const view = Object.create(SessionView.prototype) as unknown as { onClose(): Promise<void> };
    Object.assign(view, {
      model,
      plugin: {
        isUnloadingSessionViews: () => false,
        shouldPersistSessionState: () => false,
      },
      composer: { persistDraft, dispose },
      stream: { dispose },
      scroll: { dispose },
      variants: { dispose },
      slash: { dispose },
      island: { dispose },
      markdownPatcher: { dispose },
      timeline: { dispose },
      docks: { dispose },
      contentEl: document.createElement("div"),
      containerEl: document.createElement("div"),
      dismissTitleErrorTooltip: vi.fn(),
      clearSessionHeaderDecoration: vi.fn(),
      sessionBindingVersion: 0,
    });

    await view.onClose();

    expect(persistDraft).not.toHaveBeenCalled();
  });
});
