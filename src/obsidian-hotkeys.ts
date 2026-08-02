import { Platform, type App, type Hotkey, type Modifier } from "obsidian";

interface InternalCommand {
  id: string;
  name: string;
}

interface AppWithHotkeys extends App {
  commands?: { commands?: Record<string, InternalCommand> };
  hotkeyManager?: { getHotkeys(commandId: string): Hotkey[] };
}

export const RENAME_CURRENT_FILE_COMMANDS = ["Rename current file", "Edit file title"];
export const DELETE_CURRENT_FILE_COMMANDS = ["Delete current file"];

/** Matches a keyboard event against the user's current hotkeys for a named Obsidian command. */
export function matchesObsidianCommandHotkey(app: App, commandNames: string[], event: KeyboardEvent): boolean {
  const internal = app as AppWithHotkeys;
  const commands = Object.values(internal.commands?.commands ?? {});
  const command = commands.find((candidate) => commandNames.includes(candidate.name));
  if (!command || !internal.hotkeyManager) return false;

  try {
    return internal.hotkeyManager.getHotkeys(command.id).some((hotkey) => matchesHotkey(hotkey, event));
  } catch (error) {
    console.warn("[opencode-plugin:hotkeys] unable to read Obsidian command hotkeys", { command: command.id, error });
    return false;
  }
}

/** Compares one Obsidian hotkey using platform-aware `Mod` semantics and exact modifiers. */
function matchesHotkey(hotkey: Hotkey, event: KeyboardEvent): boolean {
  const modifiers = new Set<Modifier>(hotkey.modifiers);
  const ctrl = modifiers.has("Ctrl") || (!Platform.isMacOS && modifiers.has("Mod"));
  const meta = modifiers.has("Meta") || (Platform.isMacOS && modifiers.has("Mod"));
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.shiftKey !== modifiers.has("Shift") || event.altKey !== modifiers.has("Alt")) return false;

  const expected = hotkey.key.toLowerCase();
  const code = event.code.replace(/^Key|^Digit/, "").toLowerCase();
  return event.key.toLowerCase() === expected || event.code.toLowerCase() === expected || code === expected;
}
