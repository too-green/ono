import * as http from "http";
import * as https from "https";
import type { IncomingMessage, RequestOptions } from "http";
import type { OpenCodeHttpClient } from "./opencode-http";
import type { OpenCodeEvent } from "./opencode-types";

export interface OpenCodeEventSubscription {
  close(): void;
}

export interface OpenCodeEventHandlers {
  onEvent(event: OpenCodeEvent): void;
  onOpen?(): void;
  onError?(error: unknown): void;
  onReconnect?(attempt: number, delayMs: number): void;
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

export class OpenCodeEventStream {
  private readonly connections = new Map<string, { abort: AbortController; handlers: Set<OpenCodeEventHandlers>; directory?: string }>();

  constructor(private readonly http: OpenCodeHttpClient) {}

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

  /** Stops the current SSE reader when plugin views or plugin lifecycle dispose the stream. */
  close(): void {
    for (const connection of this.connections.values()) connection.handlers.clear();
    for (const key of [...this.connections.keys()]) this.stopConnection(key);
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
        await this.readOnce(key, controller);
        attempt = 0;
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[opencode-plugin:sse] error", {
          directory: this.connections.get(key)?.directory,
          error,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
        });
        this.forEachHandler(key, (handler) => handler.onError?.(error));
        const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30000;
        attempt += 1;
        this.forEachHandler(key, (handler) => handler.onReconnect?.(attempt, delayMs));
        await this.sleep(delayMs, controller.signal);
      }
    }
  }

  /** Reads and parses one `/event` SSE response from the OpenCode server. */
  private async readOnce(key: string, controller: AbortController): Promise<void> {
    const connection = this.connections.get(key);
    const url = this.http.url("/event", { directory: connection?.directory });
    console.debug("[opencode-plugin:sse] connecting", { directory: connection?.directory, url });
    await this.readWithNodeHttp(key, url, controller);
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

        console.debug("[opencode-plugin:sse] open", { directory: this.connections.get(key)?.directory, status: statusCode });
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
    const event = JSON.parse(data) as OpenCodeEvent;
    if (event.type !== "server.heartbeat") console.debug("[opencode-plugin:sse] event", { directory: this.connections.get(key)?.directory, type: event.type, properties: event.properties });
    this.forEachHandler(key, (handler) => handler.onEvent(event));
  }

  /** Iterates over a snapshot so handlers may unsubscribe while processing an event. */
  private forEachHandler(key: string, callback: (handler: OpenCodeEventHandlers) => void): void {
    const connection = this.connections.get(key);
    if (!connection) return;
    for (const handler of [...connection.handlers]) callback(handler);
  }

  /** Sleeps between reconnect attempts while respecting stream cancellation. */
  private sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
}
