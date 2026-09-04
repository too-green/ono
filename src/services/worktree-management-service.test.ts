import { describe, expect, it, vi } from "vitest";

import { WorktreeManagementService, type WorktreeManagementClient } from "./worktree-management-service";

/** Builds a typed v1 worktree client for service workflow tests. */
function client(): WorktreeManagementClient & Record<keyof WorktreeManagementClient, ReturnType<typeof vi.fn>> {
  return {
    listWorktrees: vi.fn(async () => ["/repo/feature"]),
    createWorktree: vi.fn(async () => ({ name: "feature", branch: "feature", directory: "/repo/feature" })),
    removeWorktree: vi.fn(async () => true),
    resetWorktree: vi.fn(async () => true),
  };
}

describe("WorktreeManagementService", () => {
  it("delegates every workflow to the directory-scoped v1 API", async () => {
    const api = client();
    const service = new WorktreeManagementService(() => api);

    await expect(service.list("/repo")).resolves.toEqual(["/repo/feature"]);
    await expect(service.create("/repo", { name: "feature" })).resolves.toMatchObject({ directory: "/repo/feature" });
    await expect(service.reset("/repo", "/repo/feature")).resolves.toBe(true);
    await expect(service.remove("/repo", "/repo/feature")).resolves.toBe(true);

    expect(api.listWorktrees).toHaveBeenCalledWith("/repo");
    expect(api.createWorktree).toHaveBeenCalledWith("/repo", { name: "feature" });
    expect(api.resetWorktree).toHaveBeenCalledWith("/repo", { directory: "/repo/feature" });
    expect(api.removeWorktree).toHaveBeenCalledWith("/repo", { directory: "/repo/feature" });
  });

  it("rejects missing project scope before contacting the API", async () => {
    const api = client();
    const service = new WorktreeManagementService(() => api);

    expect(() => service.list("  ")).toThrow("Project directory is required.");
    expect(() => service.create("")).toThrow("Project directory is required.");
    expect(api.listWorktrees).not.toHaveBeenCalled();
    expect(api.createWorktree).not.toHaveBeenCalled();
  });

  it("protects the primary workspace across equivalent path spellings", () => {
    const api = client();
    const service = new WorktreeManagementService(() => api);

    expect(() => service.remove("C:\\Repo\\", "c:/repo")).toThrow("The primary workspace cannot be removed or reset.");
    expect(() => service.reset("/repo/", "/repo")).toThrow("The primary workspace cannot be removed or reset.");
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(api.resetWorktree).not.toHaveBeenCalled();
  });

  it("rejects destructive targets that are not registered to the project", async () => {
    const api = client();
    const service = new WorktreeManagementService(() => api);

    await expect(service.remove("/repo", "/unrelated")).rejects.toThrow("The target directory is not a managed worktree for this project.");
    await expect(service.reset("/repo", "/unrelated")).rejects.toThrow("The target directory is not a managed worktree for this project.");
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(api.resetWorktree).not.toHaveBeenCalled();
  });
});
