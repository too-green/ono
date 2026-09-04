import { describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";

import { OpenCodeService } from "./opencode-service";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, requestUrl: vi.fn() };
});

/** Returns the JSON response expected by each worktree API operation. */
function worktreeResponse(method: string, pathname: string): unknown {
  if (method === "GET") return ["/repo/feature"];
  if (method === "POST" && pathname.endsWith("/reset")) return true;
  if (method === "DELETE") return true;
  return { name: "feature", branch: "feature", directory: "/repo/feature" };
}

describe("OpenCodeService v1 worktree API", () => {
  it("scopes list, create, remove, and reset to the remote project directory", async () => {
    vi.mocked(requestUrl).mockImplementation(async (request) => {
      const url = new URL(request.url);
      const json = worktreeResponse(request.method ?? "GET", url.pathname);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        json,
        text: JSON.stringify(json),
        arrayBuffer: new ArrayBuffer(0),
      };
    });
    const service = new OpenCodeService({ baseUrl: "https://remote.example" });

    await expect(service.listWorktrees("/repo")).resolves.toEqual(["/repo/feature"]);
    await expect(service.createWorktree("/repo", { name: "feature", startCommand: "npm install" })).resolves.toMatchObject({
      directory: "/repo/feature",
    });
    await expect(service.removeWorktree("/repo", { directory: "/repo/feature" })).resolves.toBe(true);
    await expect(service.resetWorktree("/repo", { directory: "/repo/feature" })).resolves.toBe(true);
    service.dispose();

    const calls = vi.mocked(requestUrl).mock.calls.map(([request]) => ({
      url: request.url,
      method: request.method,
      body: request.body,
    }));
    expect(calls).toEqual([
      { url: "https://remote.example/experimental/worktree?directory=%2Frepo", method: "GET", body: undefined },
      {
        url: "https://remote.example/experimental/worktree?directory=%2Frepo",
        method: "POST",
        body: JSON.stringify({ name: "feature", startCommand: "npm install" }),
      },
      {
        url: "https://remote.example/experimental/worktree?directory=%2Frepo",
        method: "DELETE",
        body: JSON.stringify({ directory: "/repo/feature" }),
      },
      {
        url: "https://remote.example/experimental/worktree/reset?directory=%2Frepo",
        method: "POST",
        body: JSON.stringify({ directory: "/repo/feature" }),
      },
    ]);
  });
});
