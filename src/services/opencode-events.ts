import * as http from "http";
import * as https from "https";
import type { IncomingMessage, RequestOptions } from "http";
import { logger } from "../logger";
import type { OpenCodeHttpClient } from "./opencode-http";
import type { OpenCodeEvent } from "./opencode-types";

export interface OpenCodeEventSubscription {
  close(): void;
}

export interface OpenCodeEventHandlers {
  onEvent(event: OpenCodeEvent, directory?: string): void;
  onOpen?(): void;
  onError?(error: unknown): void;
  onReconnect?(attempt: number, delayMs: number): void;
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const STABLE_CONNECTION_MS = 30_000;

export class OpenCodeEventStream {
  private readonly connections = new Map<string, { abort: AbortController; handlers: Set<OpenCodeEventHandlers>; directory?: string; global?: boolean }>();
  private http: OpenCodeHttpClient;

  constructor(http: OpenCodeHttpClient) {
    this.http = http;
  }

  /** Adds a subscriber to the shared SSE connection used by all plugin views. */
  subscribe(handlers: OpenCodeEventHandlers, directory?: string): OpenCodeEventSubscription {
    const key = directory ?? "";
    let connection = this.connections.get(key);
    if (!connection) {
      connection = { abort: new AbortController(), handlers: new Set(), directory };
      this.connections.set(key, connection);
      void this.readLoop(key, connection.abort);
    }
    connection.handlers.add(handlers);
    return {
      close: () => {
        const active = this.connections.get(key);
        active?.handlers.delete(handlers);
        if (active && active.handlers.size === 0) this.stopConnection(key);
      },
    };
  }

  /** Adds a subscriber to the server-wide v1 event stream used by cross-directory worktree events. */
  subscribeGlobal(handlers: OpenCodeEventHandlers): OpenCodeEventSubscription {
    const key = "\u0000global";
    let connection = this.connections.get(key);
    if (!connection) {
      connection = { abort: new AbortController(), handlers: new Set(), global: true };
      this.connections.set(key, connection);
      void this.readLoop(key, connection.abort);
    }
    connection.handlers.add(handlers);
    return {
      close: () => {
        const active = this.connections.get(key);
        active?.handlers.delete(handlers);
        if (active && active.handlers.size === 0) this.stopConnection(key);
      },
    };
  }

  /** Stops the current SSE reader when plugin views or plugin lifecycle dispose the stream. */
  close(): void {
    for (const connection of this.connections.values()) connection.handlers.clear();
    for (const key of [...this.connections.keys()]) this.stopConnection(key);
  }

  /** Re-points the stream at a replacement HTTP client and reconnects without dropping subscribers. */
  reset(http: OpenCodeHttpClient): void {
    this.http = http;
    for (const [key, connection] of this.connections) {
      connection.abort.abort();
      const controller = new AbortController();
      connection.abort = controller;
      void this.readLoop(key, controller);
    }
  }

  /** Stops the underlying connection without mutating subscriber bookkeeping. */
  private stopConnection(key: string): void {
    const connection = this.connections.get(key);
    connection?.abort.abort();
    this.connections.delete(key);
  }

  /** Maintains the GET-only SSE connection with bounded reconnect backoff. */
  private async readLoop(key: string, controller: AbortController): Promise<void> {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const connectedMs = await this.readOnce(key, controller);
        if (controller.signal.aborted) return;
        if (connectedMs >= STABLE_CONNECTION_MS) attempt = 0;
        throw new Error("OpenCode event stream closed");
      } catch (error) {
        if (controller.signal.aborted) return;
        const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30000;
        logger.warn("sse", "connection failed", { attempt: attempt + 1, delayMs, error });
        this.forEachHandler(key, (handler) => handler.onError?.(error));
        attempt += 1;
        this.forEachHandler(key, (handler) => handler.onReconnect?.(attempt, delayMs));
        await this.sleep(delayMs, controller.signal);
      }
    }
  }

  /** Reads and parses one `/event` SSE response from the OpenCode server. */
  private async readOnce(key: string, controller: AbortController): Promise<number> {
    const connection = this.connections.get(key);
    const url = connection?.global
      ? this.http.url("/global/event")
      : this.http.url("/event", { directory: connection?.directory });
    logger.debug("sse", "connecting");
    const startedAt = Date.now();
    await this.readWithNodeHttp(key, url, controller);
    return Date.now() - startedAt;
  }

  /** Streams SSE over Node HTTP to avoid renderer fetch CORS failures in Obsidian desktop. */
  private readWithNodeHttp(key: string, url: string, controller: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;
      const options: RequestOptions = {
        method: "GET",
        headers: this.headersRecord(this.http.headers({ Accept: "text/event-stream" })),
      };
      let settled = false;
      let buffer = "";

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", abortRequest);
        callback();
      };

      const request = transport.request(parsedUrl, options, (response: IncomingMessage) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          settle(() => reject(new Error(`OpenCode event stream failed with ${statusCode}`)));
          return;
        }

        logger.debug("sse", "connection opened", { status: statusCode });
        this.forEachHandler(key, (handler) => handler.onOpen?.());
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (controller.signal.aborted) return;
          buffer += chunk;
          buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const eventChunk of chunks) this.emitChunk(key, eventChunk);
        });
        response.on("end", () => settle(resolve));
        response.on("error", (error) => settle(() => reject(error)));
      });

      const abortRequest = (): void => {
        request.destroy(new DOMException("Request aborted", "AbortError"));
        settle(resolve);
      };

      request.on("error", (error) => {
        if (controller.signal.aborted) settle(resolve);
        else settle(() => reject(error));
      });
      controller.signal.addEventListener("abort", abortRequest, { once: true });
      request.end();
    });
  }

  /** Converts browser HeadersInit into a plain object accepted by Node HTTP requests. */
  private headersRecord(headers: HeadersInit): Record<string, string> {
    const record: Record<string, string> = {};
    new Headers(headers).forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  /** Emits a decoded SSE data chunk as an OpenCode event. */
  private emitChunk(key: string, chunk: string): void {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      logger.warn("sse", "event parse failed", { error });
      return;
    }
    const connection = this.connections.get(key);
    const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const rawEvent = connection?.global ? envelope?.payload : payload;
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return;
    const event = rawEvent as OpenCodeEvent;
    const directory = connection?.global && typeof envelope?.directory === "string" ? envelope.directory : connection?.directory;
    if (logger.isDebugEnabled() && event.type !== "server.heartbeat" && event.type !== "message.part.delta") {
      logger.debug("sse", "event received", { eventType: event.type });
    }
    this.forEachHandler(key, (handler) => handler.onEvent(event, directory));
  }

  /** Iterates over a snapshot so handlers may unsubscribe while processing an event. */
  private forEachHandler(key: string, callback: (handler: OpenCodeEventHandlers) => void): void {
    const connection = this.connections.get(key);
    if (!connection) return;
    for (const handler of [...connection.handlers]) {
      try {
        callback(handler);
      } catch (error) {
        logger.error("sse", "subscriber failed", { error });
      }
    }
  }

  /** Sleeps between reconnect attempts while respecting stream cancellation. */
  private sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        globalThis.clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = globalThis.setTimeout(finish, delayMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
