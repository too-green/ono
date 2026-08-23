import * as fs from "fs";
import * as path from "path";

/** Git repository metadata read purely from the filesystem, without spawning git. */
export interface GitInfo {
  /** Branch display name, or a short commit sha when HEAD is detached. */
  branch?: string;
  /** True when HEAD points directly at a commit instead of a branch. */
  detached?: boolean;
  /** Main repository path when this directory is a linked git worktree. */
  worktreeOf?: string;
}

/** Reads branch and linked-worktree metadata for a directory; undefined when it is not a git repository. Referenced by NewSessionFolderModal. */
export function readGitInfo(directory: string): GitInfo | undefined {
  const info: GitInfo = {};

  // -- resolve the .git entry (directory for normal repos, pointer file for linked worktrees) --
  const dotGitPath = path.join(directory, ".git");
  let gitDir: string;
  try {
    const stats = fs.lstatSync(dotGitPath);
    if (stats.isDirectory()) {
      gitDir = dotGitPath;
    } else if (stats.isFile()) {
      const resolved = resolveGitDirFile(dotGitPath, directory);
      if (!resolved) return undefined;
      gitDir = resolved.gitDir;
      info.worktreeOf = resolved.mainWorktree;
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }

  // -- read HEAD for the branch/detached commit --
  const head = readHeadBranch(gitDir);
  if (head) Object.assign(info, head);

  return info.branch === undefined && info.worktreeOf === undefined ? undefined : info;
}

/** Parses a linked worktree's `.git` pointer file (`gitdir: <main>/.git/worktrees/<name>`). */
function resolveGitDirFile(dotGitPath: string, directory: string): { gitDir: string; mainWorktree: string | undefined } | undefined {
  let gitDir: string | undefined;
  try {
    const content = fs.readFileSync(dotGitPath, "utf8");
    gitDir = content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
  if (!gitDir) return undefined;
  if (!path.isAbsolute(gitDir)) gitDir = path.resolve(directory, gitDir);

  // gitDir has the shape <main>/.git/worktrees/<name>; validate before deriving the main repo path.
  const worktreesDir = path.dirname(gitDir);
  if (path.basename(worktreesDir) !== "worktrees") return { gitDir, mainWorktree: undefined };
  return { gitDir, mainWorktree: path.dirname(path.dirname(worktreesDir)) };
}

/** Reads `HEAD` inside a git dir and classifies it as a branch name or detached sha. */
function readHeadBranch(gitDir: string): { branch: string; detached?: boolean } | undefined {
  let head: string | undefined;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!head) return undefined;
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return { branch: ref[1] };
  const otherRef = head.match(/^ref:\s*(.+)$/);
  if (otherRef) return { branch: otherRef[1] };
  if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: head.slice(0, 7), detached: true };
  return undefined;
}
