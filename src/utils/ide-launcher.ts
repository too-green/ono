/**
 * IDE/editor discovery and launch engine.
 *
 * Ported from the renderer-native approach used by the paseo desktop client
 * (`packages/desktop/src/features/editor-targets/runtime.ts`): Node `child_process`
 * + `fs` only, no Electron IPC bridge — which matches an Obsidian plugin renderer.
 * macOS launch strategy mirrors the opencode desktop app (`open-in-app.tsx`):
 * CLI-first, then `open -a "<bundle>" <path>` fallback. The registry is the union
 * of editors surfaced by openchamber, opencode, and paseo.
 *
 * Referenced by `src/settings.ts` (settings dropdown), `main.ts` (command launch),
 * and `src/views/SessionView.ts` (session-context menu item icon/label).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type IdePlatform = "darwin" | "win32" | "linux";

export type IdeKind = "editor" | "file-manager";

export interface IdeDescriptor {
  /** Stable id persisted in `settings.openIde`. */
  id: string;
  /** Display label for menus and the settings dropdown. */
  label: string;
  /** Lucide icon id rendered next to the configured IDE in menus and settings. */
  icon: string;
  /** macOS bundle name used for `open -a` and `/Applications/<macApp>.app` detection. */
  macApp?: string;
  /** Per-platform CLI command candidates; the first resolvable on PATH wins. */
  cli?: {
    darwin?: string[];
    win32?: string[];
    linux?: string[];
  };
  /** Platforms where the IDE is offered; others hide it from detection/settings. */
  platforms: IdePlatform[];
  /** `file-manager` targets open via Electron `shell.openPath` instead of a CLI. */
  kind: IdeKind;
}

/**
 * Canonical default IDE id.
 *
 * The reference clients default to the system file manager (openchamber/opencode)
 * or the first detected editor (paseo). This plugin targets opencode users, who
 * almost always have VS Code or a fork installed, so VS Code is the most useful
 * out-of-the-box default. Users can change it in settings; the dropdown lists
 * only detected editors so the choice stays valid.
 */
export const DEFAULT_OPEN_IDE_ID = "vscode";

/**
 * Union of editors surfaced by the openchamber, opencode, and paseo clients.
 * Order is intentional: VS Code family first, then lightweight editors, then
 * JetBrains, then platform IDEs, then system file managers.
 */
export const IDE_REGISTRY: IdeDescriptor[] = [
  // ---- VS Code family
  {
    id: "vscode",
    label: "VS Code",
    icon: "code",
    macApp: "Visual Studio Code",
    cli: { darwin: ["code"], win32: ["code.cmd", "code"], linux: ["code"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    icon: "code",
    macApp: "Visual Studio Code - Insiders",
    cli: { darwin: ["code-insiders"], win32: ["code-insiders.cmd", "code-insiders"], linux: ["code-insiders"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    icon: "code",
    macApp: "VSCodium",
    cli: { darwin: ["codium"], win32: ["codium.cmd", "codium"], linux: ["codium"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: "mouse-pointer-click",
    macApp: "Cursor",
    cli: { darwin: ["cursor"], win32: ["cursor.cmd", "cursor"], linux: ["cursor"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    icon: "waves",
    macApp: "Windsurf",
    cli: { darwin: ["windsurf"], win32: ["windsurf.cmd", "windsurf"], linux: ["windsurf"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "zed",
    label: "Zed",
    icon: "zap",
    macApp: "Zed",
    cli: { darwin: ["zeditor", "zed"], win32: ["zed"], linux: ["zed"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "trae",
    label: "Trae",
    icon: "file-code-2",
    macApp: "Trae",
    cli: { darwin: ["trae"], win32: ["trae.cmd", "trae"], linux: ["trae"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "kiro",
    label: "Kiro",
    icon: "bot",
    macApp: "Kiro",
    cli: { darwin: ["kiro"], win32: ["kiro.cmd", "kiro"], linux: ["kiro"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    icon: "rocket",
    macApp: "Antigravity",
    cli: { darwin: ["antigravity", "agy"], win32: ["antigravity.cmd", "antigravity"], linux: ["antigravity", "agy"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  // ---- Lightweight editors
  {
    id: "sublime-text",
    label: "Sublime Text",
    icon: "text-cursor",
    macApp: "Sublime Text",
    cli: { darwin: ["subl"], win32: ["subl"], linux: ["subl"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "textmate",
    label: "TextMate",
    icon: "text-cursor-input",
    macApp: "TextMate",
    platforms: ["darwin"],
    kind: "editor",
  },
  // ---- JetBrains family
  {
    id: "intellij-idea",
    label: "IntelliJ IDEA",
    icon: "braces",
    macApp: "IntelliJ IDEA",
    cli: { darwin: ["idea"], win32: ["idea64", "idea"], linux: ["idea"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "webstorm",
    label: "WebStorm",
    icon: "globe",
    macApp: "WebStorm",
    cli: { darwin: ["webstorm"], win32: ["webstorm64", "webstorm"], linux: ["webstorm"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "pycharm",
    label: "PyCharm",
    icon: "snake",
    macApp: "PyCharm",
    cli: { darwin: ["pycharm"], win32: ["pycharm64", "pycharm"], linux: ["pycharm"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    icon: "file-code-2",
    macApp: "PhpStorm",
    cli: { darwin: ["phpstorm"], win32: ["phpstorm64", "phpstorm"], linux: ["phpstorm"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "rider",
    label: "Rider",
    icon: "square-code",
    macApp: "Rider",
    cli: { darwin: ["rider"], win32: ["rider64", "rider"], linux: ["rider"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "goland",
    label: "GoLand",
    icon: "braces",
    macApp: "GoLand",
    cli: { darwin: ["goland"], win32: ["goland64", "goland"], linux: ["goland"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "rubymine",
    label: "RubyMine",
    icon: "gem",
    macApp: "RubyMine",
    cli: { darwin: ["rubymine"], win32: ["rubymine64", "rubymine"], linux: ["rubymine"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "clion",
    label: "CLion",
    icon: "binary",
    macApp: "CLion",
    cli: { darwin: ["clion"], win32: ["clion64", "clion"], linux: ["clion"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "rustrover",
    label: "RustRover",
    icon: "hammer",
    macApp: "RustRover",
    cli: { darwin: ["rustrover"], win32: ["rustrover64", "rustrover"], linux: ["rustrover"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "datagrip",
    label: "DataGrip",
    icon: "database",
    macApp: "DataGrip",
    cli: { darwin: ["datagrip"], win32: ["datagrip64", "datagrip"], linux: ["datagrip"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "dataspell",
    label: "DataSpell",
    icon: "braces",
    macApp: "DataSpell",
    cli: { darwin: ["dataspell"], win32: ["dataspell64", "dataspell"], linux: ["dataspell"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "aqua",
    label: "Aqua",
    icon: "droplet",
    macApp: "Aqua",
    cli: { darwin: ["aqua"], win32: ["aqua64", "aqua"], linux: ["aqua"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  {
    id: "android-studio",
    label: "Android Studio",
    icon: "smartphone",
    macApp: "Android Studio",
    cli: { win32: ["studio64", "studio"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  // ---- Platform IDEs
  {
    id: "xcode",
    label: "Xcode",
    icon: "hammer",
    macApp: "Xcode",
    platforms: ["darwin"],
    kind: "editor",
  },
  {
    id: "visual-studio",
    label: "Visual Studio",
    icon: "square-code",
    cli: { win32: ["devenv"] },
    platforms: ["win32"],
    kind: "editor",
  },
  {
    id: "eclipse",
    label: "Eclipse",
    icon: "moon",
    macApp: "Eclipse",
    cli: { darwin: ["eclipse"], win32: ["eclipse"], linux: ["eclipse"] },
    platforms: ["darwin", "win32", "linux"],
    kind: "editor",
  },
  // ---- System file managers (open via Electron shell.openPath)
  {
    id: "finder",
    label: "Finder",
    icon: "folder",
    platforms: ["darwin"],
    kind: "file-manager",
  },
  {
    id: "explorer",
    label: "File Explorer",
    icon: "folder",
    platforms: ["win32"],
    kind: "file-manager",
  },
  {
    id: "file-manager",
    label: "File Manager",
    icon: "folder",
    platforms: ["linux"],
    kind: "file-manager",
  },
];

/** Returns the current platform; Obsidian is desktop-only so one of the three always applies. */
export function currentPlatform(): IdePlatform {
  const platform = typeof process !== "undefined" ? process.platform : "";
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "darwin";
}

/** Looks up a descriptor by id; returns undefined for unknown ids. */
export function getIdeById(id: string | undefined): IdeDescriptor | undefined {
  if (!id) return undefined;
  return IDE_REGISTRY.find((ide) => ide.id === id);
}

/** Returns the descriptor for the configured id, falling back to the canonical default. */
export function getIdeOrDefault(id: string | undefined): IdeDescriptor {
  return getIdeById(id) ?? getIdeById(DEFAULT_OPEN_IDE_ID) ?? IDE_REGISTRY[0];
}

function pathDelimiter(platform: IdePlatform): string {
  return platform === "win32" ? ";" : ":";
}

function homeDirectory(): string | undefined {
  return process.env.HOME || process.env.USERPROFILE;
}

function fileExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Resolves the first existing executable on PATH for the given candidate commands.
 * On Windows probes `.exe/.cmd/.bat/.com` extensions; absolute candidates are checked as-is.
 * Pure (fs read-only) so it is unit-testable against a temp directory.
 */
export function resolveCommand(candidates: string[] | undefined, platform: IdePlatform = currentPlatform()): string | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const dirs = (process.env.PATH ?? "").split(pathDelimiter(platform)).filter(Boolean);
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const named = candidate + extension;
      if (path.isAbsolute(named)) {
        if (fileExists(named)) return named;
        continue;
      }
      for (const dir of dirs) {
        const full = path.join(dir, named);
        if (fileExists(full)) return full;
      }
    }
  }
  return undefined;
}

/** Checks whether a macOS `.app` bundle exists in any standard Applications location. */
function macAppBundleExists(macApp: string): boolean {
  const home = homeDirectory();
  const locations = [
    `/Applications/${macApp}.app`,
    `/System/Applications/${macApp}.app`,
    `/System/Applications/Utilities/${macApp}.app`,
    ...(home ? [`${home}/Applications/${macApp}.app`] : []),
  ];
  return locations.some(fileExists);
}

/** Returns true when the IDE is installable on the platform and present on this machine. */
export function isIdeInstalled(ide: IdeDescriptor, platform: IdePlatform = currentPlatform()): boolean {
  if (!ide.platforms.includes(platform)) return false;
  if (ide.kind === "file-manager") return true;
  if (resolveCommand(ide.cli?.[platform], platform)) return true;
  return platform === "darwin" && !!ide.macApp && macAppBundleExists(ide.macApp);
}

/** Returns every registry entry detected on the current machine, in registry order. */
export function detectInstalledIdes(platform: IdePlatform = currentPlatform()): IdeDescriptor[] {
  return IDE_REGISTRY.filter((ide) => isIdeInstalled(ide, platform));
}

/** Spawns a command detached so Obsidian does not wait on the launched editor. */
function spawnDetached(command: string, args: string[], platform: IdePlatform): Promise<void> {
  return new Promise((resolve, reject) => {
    const isCmdScript = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        shell: isCmdScript,
        windowsHide: true,
      });
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.on("error", (err: Error) => settle(err));
    child.on("spawn", () => settle());
    child.unref();
    // Safety net for runtimes that never emit "spawn" before a slow "error".
    setTimeout(() => settle(), 100);
  });
}

/** Opens a folder via Electron's `shell.openPath` (system default file manager). */
async function openInFileManager(directory: string): Promise<void> {
  const electron = require("electron") as { shell?: { openPath: (target: string) => Promise<string> } };
  const shell = electron?.shell;
  if (!shell) throw new Error("Desktop file manager is unavailable.");
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

/**
 * Launches the IDE/editor for a project directory.
 *
 * Strategy: file-manager targets open via `shell.openPath`; editors prefer a CLI
 * resolved on PATH (so the user's editor window rules apply), then fall back to
 * `open -a "<bundle>" <path>` on macOS. Rejects with a user-facing message when
 * nothing is resolvable.
 */
export async function launchIde(ide: IdeDescriptor, directory: string, platform: IdePlatform = currentPlatform()): Promise<void> {
  if (!directory) throw new Error("No project directory is bound to this session.");
  if (ide.kind === "file-manager") {
    await openInFileManager(directory);
    return;
  }
  const command = resolveCommand(ide.cli?.[platform], platform);
  if (command) {
    await spawnDetached(command, [directory], platform);
    return;
  }
  if (platform === "darwin" && ide.macApp) {
    await spawnDetached("/usr/bin/open", ["-a", ide.macApp, directory], platform);
    return;
  }
  throw new Error(`${ide.label} was not found on this system. Install it or pick another IDE in plugin settings.`);
}
