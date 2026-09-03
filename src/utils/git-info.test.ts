import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readGitInfo, withServerBranch } from "./git-info";

/** Creates an empty temp directory suitable for one test's fake repository. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-git-info-"));
}

describe("readGitInfo", () => {
  it("returns undefined when the directory is not a git repository", () => {
    expect(readGitInfo(tempDir())).toBeUndefined();
  });

  it("reads the branch from a normal repository's HEAD", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature/loop\n");
    expect(readGitInfo(dir)).toEqual({ branch: "feature/loop" });
  });

  it("reads a GitHub repository identity from the origin remote", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(dir, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:openchamber/openchamber.git\n');

    expect(readGitInfo(dir)).toEqual({ branch: "main", githubRepository: "openchamber/openchamber" });
  });

  it("falls back to another GitHub remote when origin is not GitHub", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(dir, ".git", "config"), [
      '[remote "upstream"]',
      "\turl = https://github.com/anomalyco/opencode.git",
      '[remote "origin"]',
      "\turl = https://example.com/local.git",
      "",
    ].join("\n"));

    expect(readGitInfo(dir)).toEqual({ branch: "main", githubRepository: "anomalyco/opencode" });
  });

  it("reports a short sha with detached=true for a detached HEAD", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    expect(readGitInfo(dir)).toEqual({ branch: "0123456", detached: true });
  });

  it("reads branch and main worktree from a linked worktree pointer file", () => {
    const main = tempDir();
    const worktree = tempDir();
    const gitDir = path.join(main, ".git", "worktrees", "feature");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(main, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/owner/repository.git\n');
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(readGitInfo(worktree)).toEqual({ branch: "feature", githubRepository: "owner/repository", worktreeOf: main });
  });

  it("resolves a relative gitdir pointer against the worktree directory", () => {
    const parent = tempDir();
    const main = path.join(parent, "main");
    const worktree = path.join(parent, "wt");
    const gitDir = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(readGitInfo(worktree)).toEqual({ branch: "main", worktreeOf: main });
  });

  it("returns undefined when the pointer file has no gitdir entry", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".git"), "garbage\n");
    expect(readGitInfo(dir)).toBeUndefined();
  });

  it("still reports the branch when the pointer does not follow the worktrees layout", () => {
    const dir = tempDir();
    const gitDir = tempDir();
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/dev\n");
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
    expect(readGitInfo(dir)).toEqual({ branch: "dev" });
  });
});

describe("withServerBranch", () => {
  it("uses the server branch while preserving local repository metadata", () => {
    expect(withServerBranch({ branch: "main", detached: true, githubRepository: "owner/repository" }, "feature/remote")).toEqual({
      branch: "feature/remote",
      githubRepository: "owner/repository",
    });
  });

  it("does not use a local branch when the server provides none", () => {
    expect(withServerBranch({ branch: "main" }, undefined)).toBeUndefined();
  });
});
