# OpenCode Benchmark Proxy

This local-only proxy records one real plugin run and later replays its HTTP and SSE traffic deterministically. It is intended for before/after streaming performance measurements in Obsidian.

## Record A Turn

Start the real OpenCode server, then run:

```bash
npm run benchmark:record -- \
  --upstream http://127.0.0.1:4096 \
  --tape .benchmark-recordings/long-turn.json
```

Then:

1. Point the plugin server URL at `http://127.0.0.1:4097`. Keep the same OpenCode password so its `Authorization` header can be forwarded upstream.
2. Reload the plugin and open the session/layout that the benchmark should reproduce.
3. Submit the turn through the plugin and wait until the session becomes idle and canonical synchronization finishes.
4. Stop the proxy with `Ctrl-C`. This flushes the tape, including an SSE connection that remains open.

The first proxied prompt automatically clears setup/heartbeat SSE bytes and rebases event timing to prompt submission. For a turn started outside this plugin, manually trigger capture immediately before the workload:

```bash
curl -X POST \
  -H "x-opencode-benchmark-token: <printed-token>" \
  http://127.0.0.1:4097/__opencode_benchmark/capture
```

Use a fresh tape for each scenario, such as `short-turn.json`, `long-turn.json`, and `three-concurrent-turns.json`. Pass `--overwrite` only when intentionally replacing a tape.

## Replay A Turn

Run:

```bash
npm run benchmark:replay -- \
  --tape .benchmark-recordings/long-turn.json
```

Keep the plugin pointed at `http://127.0.0.1:4097`, then reload the plugin and reopen the recorded layout. Do not submit the prompt again: the recorded SSE response starts automatically when the plugin reconnects to `/event`.

Replay uses the original timing by default. `--speed 2` replays at twice the recorded speed for stress testing, but before/after measurements must use the same speed.

Automated profilers can pass `--paused`, connect and start measurement, then release SSE playback with:

```bash
curl -X POST \
  -H "x-opencode-benchmark-token: <printed-token>" \
  http://127.0.0.1:4097/__opencode_benchmark/start
```

## Repeat A Run

Restarting replay is the cleanest reset. A running replay can also be reset with the control token printed at startup:

```bash
curl -X POST \
  -H "x-opencode-benchmark-token: <printed-token>" \
  http://127.0.0.1:4097/__opencode_benchmark/reset
```

Reset closes active SSE playback and rewinds every recorded request cursor. Reload the plugin/session afterward so its HTTP request sequence also starts from the beginning.

Status endpoints expose counts only:

```text
GET /__opencode_benchmark/status
```

## Matching Behavior

- Requests match by HTTP method, canonical path/query, request-body SHA-256, and body length.
- Request bodies and authorization headers are forwarded but never stored. The `auth_token` query value is also redacted.
- Repeated identical requests consume recorded responses in order.
- Session message-list reads stay pinned to their first pre-turn snapshot so canonical refreshes cannot reveal final text before SSE playback reaches it.
- After recorded REST `GET` responses are exhausted, replay retains the final response as the canonical snapshot.
- `/event` never repeats an exhausted recording automatically.
- Response status, headers, raw bytes, chunk boundaries, relative timing, and open/end/error behavior are preserved.

A `409` means the replaying plugin made a request that the recording did not contain. Re-record using the same open tabs, vault, plugin configuration, and startup sequence.

## Privacy

Tapes are sensitive. SSE and response bytes can contain prompts, generated text, absolute paths, tool output, diffs, and image data. `.benchmark-recordings/` is ignored by Git, tapes are written with user-only permissions, and they should not be shared without manual inspection and redaction.

The proxy binds only to loopback. State-changing control routes require a random per-process token.
