import type { OpenCodeService } from "./opencode-service";
import type { OpenCodeCreateWorktreeInput, OpenCodeWorktree } from "./opencode-types";

export type WorktreeManagementClient = Pick<
  OpenCodeService,
  "listWorktrees" | "createWorktree" | "removeWorktree" | "resetWorktree"
>;

/** Provides UI-independent worktree workflows backed exclusively by the OpenCode v1 API. */
export class WorktreeManagementService {
  constructor(private readonly getClient: () => WorktreeManagementClient) {}

  /** Lists managed worktree directories for one project root. */
  list(projectDirectory: string): Promise<string[]> {
    return this.getClient().listWorktrees(this.requireDirectory(projectDirectory, "Project"));
  }

  /** Creates a managed worktree and returns its server-assigned identity. */
  create(projectDirectory: string, input?: OpenCodeCreateWorktreeInput): Promise<OpenCodeWorktree> {
    return this.getClient().createWorktree(this.requireDirectory(projectDirectory, "Project"), input);
  }

  /** Removes a managed worktree and its branch without allowing the primary workspace as the target. */
  remove(projectDirectory: string, worktreeDirectory: string): Promise<boolean> {
    const directories = this.requireManagedDirectories(projectDirectory, worktreeDirectory);
    return this.removeListedWorktree(directories);
  }

  /** Removes one validated worktree after confirming it remains server-managed. */
  private async removeListedWorktree(directories: { project: string; worktree: string }): Promise<boolean> {
    await this.requireListedWorktree(directories);
    return await this.getClient().removeWorktree(directories.project, { directory: directories.worktree });
  }

  /** Resets a managed worktree to the project's default branch without touching the primary workspace. */
  reset(projectDirectory: string, worktreeDirectory: string): Promise<boolean> {
    const directories = this.requireManagedDirectories(projectDirectory, worktreeDirectory);
    return this.resetListedWorktree(directories);
  }

  /** Resets one validated worktree after confirming it remains server-managed. */
  private async resetListedWorktree(directories: { project: string; worktree: string }): Promise<boolean> {
    await this.requireListedWorktree(directories);
    return await this.getClient().resetWorktree(directories.project, { directory: directories.worktree });
  }

  /** Confirms destructive targets against the server's project-scoped worktree registry. */
  private async requireListedWorktree(directories: { project: string; worktree: string }): Promise<void> {
    const worktrees = await this.getClient().listWorktrees(directories.project);
    if (!worktrees.some((directory) => this.pathKey(directory) === this.pathKey(directories.worktree))) {
      throw new Error("The target directory is not a managed worktree for this project.");
    }
  }

  /** Validates project and target directories before destructive worktree operations. */
  private requireManagedDirectories(projectDirectory: string, worktreeDirectory: string): { project: string; worktree: string } {
    const project = this.requireDirectory(projectDirectory, "Project");
    const worktree = this.requireDirectory(worktreeDirectory, "Worktree");
    if (this.pathKey(project) === this.pathKey(worktree)) {
      throw new Error("The primary workspace cannot be removed or reset.");
    }
    return { project, worktree };
  }

  /** Rejects missing directory scope so remote requests cannot silently fall back to the server process directory. */
  private requireDirectory(directory: string, label: string): string {
    if (!directory.trim()) throw new Error(`${label} directory is required.`);
    return directory;
  }

  /** Normalizes separators and trailing slashes for primary-workspace safety checks. */
  private pathKey(directory: string): string {
    const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory;
    return normalized.toLowerCase();
  }
}
