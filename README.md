# ONO - Obsidian Native OpenCode

An [OpenCode](https://opencode.ai) client that lives inside Obsidian with a UX made to feel native to the Obsidian app. It uses your vault's theme to render OpenCode sessions and offers a Sessions Panel made to feel like home (read: Files panel).

## What's so "Obsidian-Native" about it?

If you give this a spin, try the following:
1. Rename a session by clicking its title in Obsidian's Title Bar just like you would rename a file
2. Keyboard-navigate the Sessions Panel just like you would the core Files panel (Arrow-keys to navigate, Enter/Return to rename, Spacebar to open a session, Spacebar on Directory row to create a new session)
3. Tile the session tabs just like you would file tabs (or just close them, you can get notified when the session is done)
4. Move a session from one worktree to another by simply dragging it in the Sessions Panel and dropping on the target worktree.
5. Obsidian commands for New Session, Archive Session, cycle favorite models, agent modes etc

## Features

- **Full session workflow** — create sessions, prompt, stream responses, fork, undo, redo, archive, slash commands 
- **Worktree management and session transfer** — create, remove, and reset worktrees from the panel, with active-session checks and destructive-action confirmations; startup readiness is tracked via server events
- **Obsidian-native UI and UX**
	- Assistant responses render using your selected Obsidian theme.
	- Sessions open in workspace tabs, can be tiled just like file tabs.
	- Moving a session between worktrees works like drag and drop
- **Session notifications** — system notifications or Obsidian notices, per event type (attention needed, session error, turn finished), with a test button
- **Context bar** — a neat customizable context progress bar with configurable thresholds
- **Multiple projects** — open as many project directories as you like; worktrees of the same repository group automatically

## Install

Requirements: Obsidian desktop (1.6+), opencode v1 (1.18.29+) 
Currently only available via [BRAT](https://github.com/TfTHacker/obsidian42-brat)

1. Install BRAT from the community plugin directory and enable it
2. BRAT settings → **Add Beta plugin** → `too-green/ono`
3. Enable **ONO** in your community plugins list

> As of v0.1.0 OpenCode v2 beta API is not explicitly supported
## Getting started

1. Start your opencode server:
   ```sh
   opencode serve
   ```
2. In Obsidian, open **Settings → ONO**, set the server URL (defaults to `http://127.0.0.1:4096`), add a username/password if your server uses basic auth, and hit **Test connection**
3. Open the sessions panel, add a project directory, and create a session
4. Optional: pick your IDE in settings, then use the **Open project in IDE** command (bind a hotkey to it) whenever you need the terminal, git UI, or file explorer

## Known limitations

- The diff viewer is functional but basic — improvements are planned
- There is no built-in project file browser yet; the **Open project in IDE** command is the intended escape hatch
- Worktree management and session-move support use opencode's experimental API, it may break between OpenCode versions until those endpoints are stabilized in OpenCode
- Remote servers work with one caveat. As of v0.1.0, a native file picker pops up when you click to open a new directory in the sessions panel, which only lets you choose from your client device's local storage. 

License: [MIT](LICENSE)
