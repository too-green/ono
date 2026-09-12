import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

import { parseFootprint } from "../benchmark-runner/macos-memory.mjs";

/** Streaming parser for repeated reports emitted by `footprint --sample`. */
export class FootprintStreamParser {
  constructor(target, intervalSeconds = 1) {
    this.target = target;
    this.intervalMs = intervalSeconds * 1_000;
    this.buffer = "";
    this.current = undefined;
    this.samples = [];
  }

  /** Consumes an arbitrary text chunk from footprint stdout. */
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  /** Flushes the final partial line and complete report. */
  finish() {
    if (this.buffer) this.consumeLine(this.buffer);
    this.buffer = "";
    this.commitCurrent();
    return this.samples;
  }

  /** Reduces one line into a timestamped native report. */
  consumeLine(line) {
    const marker = line.match(/^Time:\s+(.+)$/);
    if (marker) {
      this.commitCurrent();
      const parsedTime = Date.parse(marker[1]);
      this.current = {
        sampledAt: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString(),
        lines: [line],
      };
      return;
    }
    if (!this.current) return;
    this.current.lines.push(line);
    if (/^\s*phys_footprint_peak:/.test(line)) this.commitCurrent();
  }

  /** Parses and stores one complete report while rejecting non-report shutdown text. */
  commitCurrent() {
    if (!this.current) return;
    const source = this.current.lines.join("\n");
    const metrics = parseFootprint(source);
    if (metrics.physicalBytes !== undefined) {
      const previous = this.samples.at(-1);
      const intervalSincePreviousMs = previous ? Date.parse(this.current.sampledAt) - Date.parse(previous.sampledAt) : undefined;
      this.samples.push({
        ordinal: this.samples.length,
        sampledAt: this.current.sampledAt,
        role: this.target.role,
        pid: this.target.pid,
        intervalSincePreviousMs,
        cadenceDelayed: intervalSincePreviousMs !== undefined && intervalSincePreviousMs > this.intervalMs * 1.5,
        memory: metrics,
      });
    }
    this.current = undefined;
  }
}

/** Runs one native continuous footprint stream for an exact process. */
export class FootprintSampler {
  constructor(target, rawPath, stderrPath, intervalSeconds = 1) {
    this.target = target;
    this.rawPath = rawPath;
    this.stderrPath = stderrPath;
    this.intervalSeconds = intervalSeconds;
    this.parser = new FootprintStreamParser(target, intervalSeconds);
    this.child = undefined;
    this.exit = undefined;
    this.rawStream = undefined;
    this.stderrStream = undefined;
  }

  /** Starts repeated detailed VM accounting with line-buffered raw artifacts. */
  start() {
    this.rawStream = createWriteStream(this.rawPath, { mode: 0o600 });
    this.stderrStream = createWriteStream(this.stderrPath, { mode: 0o600 });
    const args = [
      "--sample", String(this.intervalSeconds),
      "--pid", String(this.target.pid),
      "--wide",
      "--swapped",
      "--wired",
      "--format", "bytes",
    ];
    this.child = spawn("/usr/bin/footprint", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.rawStream.write(chunk);
      this.parser.push(chunk);
    });
    this.child.stderr.on("data", (chunk) => this.stderrStream.write(chunk));
    this.exit = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  /** Waits for the first complete native memory report before replay begins. */
  async waitForFirstSample(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.parser.samples.length > 0) return;
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`${this.target.role} footprint exited before producing a sample. See ${this.stderrPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${this.target.role} footprint produced no parseable sample within ${timeoutMs / 1000} seconds.`);
  }

  /** Fails when the native sampler exits unexpectedly during an active recording. */
  assertRunning() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(`${this.target.role} footprint stopped during the benchmark. See ${this.stderrPath}.`);
    }
  }

  /** Stops sampling, closes raw artifacts, and returns every parsed memory report. */
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child) return [];
    const stoppedByRecorder = child.exitCode === null && child.signalCode === null;
    if (stoppedByRecorder) child.kill("SIGINT");
    let result;
    let exitError;
    try {
      result = await this.exit;
    } catch (error) {
      exitError = error;
    } finally {
      this.rawStream.end();
      this.stderrStream.end();
      await Promise.all([finished(this.rawStream), finished(this.stderrStream)]);
    }
    const samples = this.parser.finish();
    if (exitError) throw exitError;
    if (!stoppedByRecorder || samples.length === 0) {
      throw new Error(`${this.target.role} footprint exited unexpectedly with status ${result?.code ?? result?.signal ?? "unknown"}. See ${this.stderrPath}.`);
    }
    return samples;
  }
}
