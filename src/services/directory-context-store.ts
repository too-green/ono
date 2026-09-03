import type { GitInfo } from "../utils/git-info";
import { readGitInfo, withServerBranch } from "../utils/git-info";
import type { OpenCodeEvent, OpenCodeProject, OpenCodeVcsInfo } from "./opencode-types";

export interface DirectoryContext {
  directory?: string;
  project?: OpenCodeProject;
  vcs?: OpenCodeVcsInfo;
  /** Server-authoritative branch plus optional local repository enrichment. */
  git?: GitInfo;
}

export interface DirectoryContextClient {
  getCurrentProject(directory?: string): Promise<OpenCodeProject>;
  getVcs(directory?: string): Promise<OpenCodeVcsInfo>;
}

interface DirectoryContextEntry {
  localGit?: GitInfo;
  localGitLoaded: boolean;
  project?: OpenCodeProject;
  projectPromise?: Promise<OpenCodeProject>;
  projectRevision: number;
  vcs?: OpenCodeVcsInfo;
  vcsPromise?: Promise<OpenCodeVcsInfo>;
  vcsRevision: number;
}

/** Caches server-backed metadata for directory consumers without persisting derived state. */
export class DirectoryContextStore {
  private readonly entries = new Map<string, DirectoryContextEntry>();

  constructor(
    private readonly getClient: () => DirectoryContextClient,
    private readonly readLocalGit: (directory: string) => GitInfo | undefined = readGitInfo,
  ) {}

  /** Returns a best-effort metadata snapshot; referenced by folder and draft context. */
  async get(directory?: string): Promise<DirectoryContext> {
    const [projectResult, vcsResult] = await Promise.allSettled([
      this.getProject(directory),
      this.getVcs(directory),
    ]);
    const project = projectResult.status === "fulfilled" ? projectResult.value : undefined;
    const vcs = vcsResult.status === "fulfilled" ? vcsResult.value : undefined;
    return {
      directory,
      project,
      vcs,
      git: withServerBranch(this.getLocalGit(directory), vcs?.branch),
    };
  }

  /** Returns the cached directory-scoped project or shares one in-flight server request. */
  getProject(directory?: string): Promise<OpenCodeProject> {
    const key = this.directoryKey(directory);
    const entry = this.entry(key);
    if (entry.project) return Promise.resolve(entry.project);
    if (entry.projectPromise) return entry.projectPromise;
    const revision = entry.projectRevision;
    const promise = this.getClient().getCurrentProject(directory).then((project) => {
      if (revision !== entry.projectRevision || this.entries.get(key) !== entry) return this.getProject(directory);
      entry.project = project;
      return project;
    });
    entry.projectPromise = promise;
    void promise.then(
      () => this.clearPromise(key, entry, "projectPromise", promise),
      () => this.clearPromise(key, entry, "projectPromise", promise),
    );
    return promise;
  }

  /** Returns cached directory-scoped VCS metadata or shares one in-flight server request. */
  getVcs(directory?: string): Promise<OpenCodeVcsInfo> {
    const key = this.directoryKey(directory);
    const entry = this.entry(key);
    if (entry.vcs) return Promise.resolve(entry.vcs);
    if (entry.vcsPromise) return entry.vcsPromise;
    const revision = entry.vcsRevision;
    const promise = this.getClient().getVcs(directory).then((vcs) => {
      if (revision !== entry.vcsRevision || this.entries.get(key) !== entry) return this.getVcs(directory);
      entry.vcs = vcs;
      return vcs;
    });
    entry.vcsPromise = promise;
    void promise.then(
      () => this.clearPromise(key, entry, "vcsPromise", promise),
      () => this.clearPromise(key, entry, "vcsPromise", promise),
    );
    return promise;
  }

  /** Invalidates cached metadata and immediately returns a replacement snapshot. */
  refresh(directory?: string): Promise<DirectoryContext> {
    this.invalidate(directory);
    return this.get(directory);
  }

  /** Invalidates and reloads only project metadata; referenced by reconnect recovery. */
  refreshProject(directory?: string): Promise<OpenCodeProject> {
    this.invalidate(directory, "project");
    return this.getProject(directory);
  }

  /** Invalidates and reloads only VCS metadata for consumers requiring an explicit refresh. */
  refreshVcs(directory?: string): Promise<OpenCodeVcsInfo> {
    this.invalidate(directory, "vcs");
    return this.getVcs(directory);
  }

  /** Invalidates metadata affected by one directory-scoped OpenCode event. */
  handleEvent(directory: string, event: OpenCodeEvent): void {
    if (event.type === "vcs.branch.updated") this.invalidate(directory, "vcs");
    if (event.type === "project.updated") this.invalidate(directory);
  }

  /** Evicts all metadata for one directory; referenced by directory removal and reconnect handling. */
  invalidate(directory?: string, resource?: "project" | "vcs"): void {
    const key = this.directoryKey(directory);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (!resource) {
      this.entries.delete(key);
      return;
    }
    if (resource === "project") {
      entry.projectRevision += 1;
      delete entry.project;
      delete entry.projectPromise;
    } else {
      entry.vcsRevision += 1;
      delete entry.vcs;
      delete entry.vcsPromise;
    }
  }

  /** Clears all metadata when the backing server changes or the plugin unloads. */
  clear(): void {
    this.entries.clear();
  }

  /** Returns the mutable cache entry for a normalized directory key. */
  private entry(key: string): DirectoryContextEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created: DirectoryContextEntry = { localGitLoaded: false, projectRevision: 0, vcsRevision: 0 };
    this.entries.set(key, created);
    return created;
  }

  /** Reads optional local enrichment once per directory cache lifetime. */
  private getLocalGit(directory?: string): GitInfo | undefined {
    if (!directory) return undefined;
    const entry = this.entry(this.directoryKey(directory));
    if (!entry.localGitLoaded) {
      entry.localGit = this.readLocalGit(directory);
      entry.localGitLoaded = true;
    }
    return entry.localGit;
  }

  /** Clears one settled request without disturbing a newer replacement request. */
  private clearPromise<K extends "projectPromise" | "vcsPromise">(
    key: string,
    entry: DirectoryContextEntry,
    property: K,
    promise: NonNullable<DirectoryContextEntry[K]>,
  ): void {
    if (this.entries.get(key) === entry && entry[property] === promise) delete entry[property];
  }

  /** Mirrors plugin path normalization so equivalent directory spellings share metadata. */
  private directoryKey(directory?: string): string {
    if (!directory) return "";
    return (directory.replace(/\\/g, "/").replace(/\/+$/, "") || directory).toLowerCase();
  }
}
