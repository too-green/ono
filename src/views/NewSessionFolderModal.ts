import { FuzzySuggestModal, setIcon, type App, type FuzzyMatch } from "obsidian";
import type OpenCodePlugin from "../../main";
import type { GitInfo } from "../utils/git-info";

/** One opened directory enriched with the metadata rendered in its picker row. */
export interface FolderSuggestion {
  directory: string;
  projectName?: string;
  git?: GitInfo;
}

/** Returns the final path segment of a normalized, forward-slashed directory. */
function basename(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return segment ?? directory;
}

/**
 * Builds one enriched suggestion per opened directory.
 *
 * Branches and project names come from the server. Optional repository and
 * linked-worktree metadata is enriched from the local filesystem when present.
 */
export async function loadFolderSuggestions(plugin: OpenCodePlugin): Promise<FolderSuggestion[]> {
  return Promise.all(
    plugin.getOpenedDirectories().map(async (directory): Promise<FolderSuggestion> => {
      const context = await plugin.directoryContexts.get(directory);
      return {
        directory,
        projectName: typeof context.project?.name === "string" && context.project.name ? context.project.name : undefined,
        git: context.git,
      };
    }),
  );
}

/**
 * Native fuzzy-search picker listing every opened folder with git branch,
 * worktree, and project metadata; choosing one opens a draft session tab.
 *
 * Referenced by the plugin's "Create new session in an opened folder" command.
 */
export class NewSessionFolderModal extends FuzzySuggestModal<FolderSuggestion> {
  constructor(
    app: App,
    private readonly suggestions: FolderSuggestion[],
    private readonly onChoose: (directory: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Select a folder for the new session\u2026");
    this.emptyStateText = "No folders are currently opened in the sessions panel.";
  }

  /** Returns the pre-enriched opened-directory rows; referenced by the fuzzy engine. */
  getItems(): FolderSuggestion[] {
    return this.suggestions;
  }

  /** Matches folder name, project, branch, and full path text; referenced by the fuzzy engine. */
  getItemText(item: FolderSuggestion): string {
    return [basename(item.directory), item.projectName, item.git?.branch, item.directory].filter(Boolean).join(" ");
  }

  /** Renders the info-rich folder row with branch chip and muted metadata line. */
  renderSuggestion(match: FuzzyMatch<FolderSuggestion>, el: HTMLElement): void {
    const item = match.item;
    const row = el.createDiv({ cls: "opencode-folder-modal__row" });
    const icon = row.createSpan({ cls: "opencode-folder-modal__row-icon" });
    setIcon(icon, "folder");

    const content = row.createDiv({ cls: "opencode-folder-modal__row-content" });
    const primary = content.createDiv({ cls: "opencode-folder-modal__row-primary" });
    primary.createSpan({ text: basename(item.directory), cls: "opencode-folder-modal__row-name" });
    if (item.git?.branch) {
      const branch = primary.createSpan({
        cls: "opencode-folder-modal__row-branch",
        attr: { "aria-label": item.git.detached ? "Detached HEAD" : `Branch ${item.git.branch}` },
      });
      const branchIcon = branch.createSpan({ cls: "opencode-folder-modal__row-branch-icon" });
      setIcon(branchIcon, "git-branch");
      branch.createSpan({ text: item.git.branch });
    }

    const metadata = [item.projectName, item.git?.worktreeOf ? `worktree of ${basename(item.git.worktreeOf)}` : undefined, item.directory]
      .filter(Boolean)
      .join(" \u00B7 ");
    content.createDiv({ text: metadata, cls: "opencode-folder-modal__row-secondary" });
  }

  /** Opens a client-only draft session tab in the chosen folder. */
  onChooseItem(item: FolderSuggestion): void {
    this.onChoose(item.directory);
  }
}
