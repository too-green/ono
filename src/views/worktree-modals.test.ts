import { describe, expect, it, vi } from "vitest";

import { ExistingWorktreeModal, normalizeWorktreeCreationInput } from "./WorktreeModals";

describe("worktree modal inputs", () => {
  it("omits blank optional creation fields", () => {
    expect(normalizeWorktreeCreationInput("  ", "\n")).toEqual({});
    expect(normalizeWorktreeCreationInput(" Feature A ", " npm install ")).toEqual({
      name: "Feature A",
      startCommand: "npm install",
    });
  });

  it("lists only supplied unopened worktrees and exposes the v1 limitation", () => {
    const choose = vi.fn();
    const modal = new ExistingWorktreeModal({} as never, ["/repo/feature-a", "/repo/feature-b"], choose);

    expect(modal.getItems()).toEqual(["/repo/feature-a", "/repo/feature-b"]);
    expect(modal.getItemText("/repo/feature-a")).toBe("feature-a /repo/feature-a");
    expect(modal.emptyStateText).toContain("OpenCode-managed");
    modal.onChooseItem("/repo/feature-b");
    expect(choose).toHaveBeenCalledWith("/repo/feature-b");
  });
});
