# Automated Obsidian Streaming Benchmark

The runner profiles deterministic replay without requiring manual Electron DevTools work. It uses Obsidian's Electron CDP endpoint for the selected vault and macOS process tools for the complete Obsidian process tree.

## Prerequisites

1. Load the plugin build being measured in the `sandbox` vault.
2. Keep its OpenCode server URL set to `http://127.0.0.1:4097`.
3. Leave the recorded session tabs in the same workspace layout used during capture.
4. Stop any manually running record/replay proxy on port `4097`.
5. Close unrelated work where possible; the runner will gracefully restart Obsidian.

## Run

```bash
npm run benchmark:run -- \
  --tape .benchmark-recordings/4-session-turn.json \
  --vault sandbox \
  --iterations 3
```

The command automatically restarts Obsidian, restores `sandbox`, identifies that vault's renderer, waits for every recorded session view, starts all profilers, releases paused SSE replay, waits for completion, and writes private reports. Each later iteration resets replay and reloads the renderer. Obsidian is relaunched normally afterward.

For a quick wiring smoke test, use one accelerated iteration:

```bash
npm run benchmark:run -- \
  --tape .benchmark-recordings/4-session-turn.json \
  --vault sandbox \
  --iterations 1 \
  --speed 10
```

Use the same tape, iteration count, speed, layout, power mode, and profiler settings before and after a code change.

## Power And GPU

Add protected macOS counters with:

```bash
npm run benchmark:run -- \
  --tape .benchmark-recordings/4-session-turn.json \
  --vault sandbox \
  --iterations 3 \
  --power
```

macOS requests an administrator password once before restarting Obsidian. The runner then captures system CPU/GPU/package power estimates, approximate joules, thermal diagnostics, raw per-process energy-impact/GPU-time output, and Obsidian app-group CPU/memory/relative `POWER`.

`powermetrics` wattage is whole-system. The relative `POWER` value is similar to Activity Monitor's current Energy Impact but is not watts. Raw reports are retained because fields vary by macOS release and Apple Silicon model.

## Reports

Artifacts are written under `.benchmark-results/<timestamp>-<commit>/`:

```text
summary.md
summary.json
run-01.json
cpu-profile-01.json
powermetrics-01.txt    # only with --power
```

Recordings and reports are ignored by Git and written with user-only permissions. They may contain source paths and profiler function names. Use at least three iterations and compare medians; five are preferable when variation is high.
