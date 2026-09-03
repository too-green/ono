import WebSocket from "ws";

const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/** Maintains one persistent Chrome DevTools Protocol session for an Obsidian renderer. */
export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", () => this.rejectPending(new Error("CDP connection closed.")));
    socket.on("error", (error) => this.rejectPending(error));
  }

  /** Opens a persistent CDP WebSocket; referenced by renderer target discovery. */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: DEFAULT_CALL_TIMEOUT_MS });
      socket.once("open", () => resolve(new CdpClient(socket)));
      socket.once("error", reject);
    });
  }

  /** Sends one protocol command and resolves its result by request id. */
  call(method, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP connection is not open."));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates JavaScript in the renderer and returns its JSON-compatible value. */
  async evaluate(expression, options = {}) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? true,
      userGesture: false,
    }, options.timeoutMs);
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed.";
      throw new Error(description);
    }
    return result.result?.value;
  }

  /** Subscribes to one unsolicited protocol event. */
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  /** Closes the renderer debugging session and rejects outstanding commands. */
  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
    this.rejectPending(new Error("CDP client closed."));
  }

  /** Routes one WebSocket message to a command promise or event listener. */
  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "CDP error"}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    const listeners = this.listeners.get(message.method);
    if (!listeners) return;
    for (const listener of listeners) listener(message.params ?? {});
  }

  /** Rejects and clears every command waiting on a closed or failed socket. */
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
