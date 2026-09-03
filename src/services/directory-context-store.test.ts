import { describe, expect, it, vi } from "vitest";

import { DirectoryContextStore, type DirectoryContextClient } from "./directory-context-store";

/** Creates an externally resolvable promise for in-flight invalidation tests. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

/** Builds a typed client with observable project and VCS requests. */
function client(): DirectoryContextClient & {
  getCurrentProject: ReturnType<typeof vi.fn>;
  getVcs: ReturnType<typeof vi.fn>;
} {
  return {
    getCurrentProject: vi.fn(async (directory?: string) => ({ id: "project", worktree: directory ?? "/default" })),
    getVcs: vi.fn(async () => ({ branch: "feature/server", default_branch: "main" })),
  };
}

describe("DirectoryContextStore", () => {
  it("deduplicates and caches project and VCS requests per directory", async () => {
    const api = client();
    const readLocalGit = vi.fn(() => ({ branch: "main", githubRepository: "owner/repository" }));
    const store = new DirectoryContextStore(() => api, readLocalGit);

    const [context, project, vcs] = await Promise.all([
      store.get("/repo/worktree"),
      store.getProject("/repo/worktree/"),
      store.getVcs("/REPO/worktree"),
    ]);

    expect(context).toEqual({
      directory: "/repo/worktree",
      project: { id: "project", worktree: "/repo/worktree" },
      vcs: { branch: "feature/server", default_branch: "main" },
      git: { branch: "feature/server", githubRepository: "owner/repository" },
    });
    expect(project.id).toBe("project");
    expect(vcs.branch).toBe("feature/server");
    expect(api.getCurrentProject).toHaveBeenCalledOnce();
    expect(api.getVcs).toHaveBeenCalledOnce();
    expect(readLocalGit).toHaveBeenCalledOnce();

    await store.get("/repo/worktree");
    expect(api.getCurrentProject).toHaveBeenCalledOnce();
    expect(api.getVcs).toHaveBeenCalledOnce();
    expect(readLocalGit).toHaveBeenCalledOnce();
  });

  it("does not cache failed requests", async () => {
    const api = client();
    api.getVcs.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ branch: "main" });
    const store = new DirectoryContextStore(() => api);

    await expect(store.getVcs("/repo")).rejects.toThrow("offline");
    await expect(store.getVcs("/repo")).resolves.toEqual({ branch: "main" });
    expect(api.getVcs).toHaveBeenCalledTimes(2);
  });

  it("invalidates only VCS metadata after a branch event", async () => {
    const api = client();
    const store = new DirectoryContextStore(() => api);
    await store.get("/repo");

    store.handleEvent("/repo", { type: "vcs.branch.updated", properties: { branch: "next" } });
    await store.get("/repo");

    expect(api.getCurrentProject).toHaveBeenCalledOnce();
    expect(api.getVcs).toHaveBeenCalledTimes(2);
  });

  it("invalidates all metadata after a project event", async () => {
    const api = client();
    const store = new DirectoryContextStore(() => api);
    await store.get("/repo");

    store.handleEvent("/repo", { type: "project.updated" });
    await store.get("/repo");

    expect(api.getCurrentProject).toHaveBeenCalledTimes(2);
    expect(api.getVcs).toHaveBeenCalledTimes(2);
  });

  it("replaces an in-flight result after the cache is cleared", async () => {
    const first = deferred<{ id: string; worktree: string }>();
    const api = client();
    api.getCurrentProject
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ id: "new-project", worktree: "/repo" });
    const store = new DirectoryContextStore(() => api);
    const pending = store.getProject("/repo");

    store.clear();
    first.resolve({ id: "old-project", worktree: "/repo" });

    await expect(pending).resolves.toEqual({ id: "new-project", worktree: "/repo" });
    expect(api.getCurrentProject).toHaveBeenCalledTimes(2);
  });
});
