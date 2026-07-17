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
  private abort?: AbortController;

  constructor(private readonly http: OpenCodeHttpClient) {}

  /** Subscribes to OpenCode server-sent events; referenced by future live session/sidebar stores. */
  subscribe(handlers: OpenCodeEventHandlers): OpenCodeEventSubscription {
    this.close();
    this.abort = new AbortController();
    void this.readLoop(this.abort, handlers);
    return { close: () => this.close() };
  }

  /** Stops the current SSE reader when plugin views or plugin lifecycle dispose the stream. */
  close(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Maintains the GET-only SSE connection with bounded reconnect backoff. */
  private async readLoop(controller: AbortController, handlers: OpenCodeEventHandlers): Promise<void> {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        await this.readOnce(controller, handlers);
        attempt = 0;
      } catch (error) {
        if (controller.signal.aborted) return;
        handlers.onError?.(error);
        const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30000;
        attempt += 1;
        handlers.onReconnect?.(attempt, delayMs);
        await this.sleep(delayMs, controller.signal);
      }
    }
  }

  /** Reads and parses one `/event` SSE response from the OpenCode server. */
  private async readOnce(controller: AbortController, handlers: OpenCodeEventHandlers): Promise<void> {
    const response = await fetch(this.http.url("/event"), {
      method: "GET",
      headers: this.http.headers({ Accept: "text/event-stream" }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed with ${response.status}`);

    handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) this.emitChunk(chunk, handlers);
    }
  }

  /** Emits a decoded SSE data chunk as an OpenCode event. */
  private emitChunk(chunk: string, handlers: OpenCodeEventHandlers): void {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    handlers.onEvent(JSON.parse(data) as OpenCodeEvent);
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
