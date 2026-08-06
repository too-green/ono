/** Pure POSIX path manipulation for display/collapse logic. Extracted from SessionView for unit testing. */

/**
 * Normalizes POSIX paths without relying on Node's path module (Obsidian renderer can't trust it).
 * Resolves `.` and `..`, strips duplicate slashes, preserves leading `/` and leading `../` segments.
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
}

/** Checks path containment on segment boundaries. */
export function isInsidePath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
}

/** Returns a relative path from the root to the target; empty if they are equal. */
export function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\/$/, "");
  return path === normalizedRoot ? "" : path.slice(normalizedRoot.length + 1);
}

/** Splits display paths while preserving the slash after a muted prefix. */
export function splitPath(path: string): { prefix: string; basename: string } {
  const normalized = path.replace(/\/$/, "");
  if (normalized === "") return { prefix: "", basename: "/" };
  if (normalized === "~") return { prefix: "", basename: "~" };
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { prefix: "", basename: normalized };
  return { prefix: normalized.slice(0, index + 1), basename: normalized.slice(index + 1) };
}

/** Returns the final segment of a path for root/session-directory fallbacks. */
export function basename(path: string): string {
  return splitPath(path).basename;
}

/** Returns the desktop user's home directory when available in Obsidian/Electron. */
export function homeDirectory(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? normalizePath(home) : undefined;
}

/** Replaces the current user's home directory with ~ for shorter external absolute paths. */
export function compactHomePath(path: string): string {
  const home = homeDirectory();
  if (!home) return path;
  const normalizedHome = home.replace(/\/$/, "");
  if (path === normalizedHome) return "~";
  if (path.startsWith(`${normalizedHome}/`)) return `~/${path.slice(normalizedHome.length + 1)}`;
  return path;
}

/** Resolves relative paths against the OpenCode session directory before normalizing dot segments. */
export function toAbsolutePath(rawPath: string, sessionDirectory?: string): string {
  if (rawPath === "~" || rawPath.startsWith("~/")) {
    const home = homeDirectory();
    if (home) return normalizePath(rawPath === "~" ? home : `${home}/${rawPath.slice(2)}`);
  }
  if (rawPath.startsWith("/")) return normalizePath(rawPath);
  if (!sessionDirectory) return normalizePath(rawPath);
  return normalizePath(`${sessionDirectory}/${rawPath}`);
}

/**
 * Returns a short display path: relative to sessionDirectory when inside it, otherwise ~/ for home
 * paths, otherwise the absolute path. `sessionDirectory` is the OpenCode session's working dir.
 */
export function displayPath(rawPath: string, sessionDirectory?: string): string {
  const absolute = toAbsolutePath(rawPath, sessionDirectory);
  const root = sessionDirectory ? normalizePath(sessionDirectory) : undefined;
  if (root && isInsidePath(absolute, root)) return relativePath(root, absolute) || basename(absolute);
  return compactHomePath(absolute);
}
