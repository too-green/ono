import { describe, expect, it, vi } from "vitest";

import type OpenCodePlugin from "../../main";
import { loadFolderSuggestions } from "./NewSessionFolderModal";

describe("loadFolderSuggestions", () => {
  it("uses each directory's shared context snapshot", async () => {
    const get = vi.fn(async (directory: string) => ({
      directory,
      project: { id: "project-1", name: "Plugin", worktree: "/canonical/main" },
      vcs: { branch: "feature/remote", default_branch: "main" },
      git: { branch: "feature/remote", githubRepository: "owner/repository" },
    }));
    const plugin = {
      getOpenedDirectories: vi.fn(() => ["/remote/worktree"]),
      directoryContexts: { get },
    } as unknown as OpenCodePlugin;

    await expect(loadFolderSuggestions(plugin)).resolves.toEqual([{
      directory: "/remote/worktree",
      projectName: "Plugin",
      git: { branch: "feature/remote", githubRepository: "owner/repository" },
    }]);
    expect(get).toHaveBeenCalledWith("/remote/worktree");
  });
});
