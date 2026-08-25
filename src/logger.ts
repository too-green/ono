const LOG_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type LogMethod = (typeof LOG_METHODS)[number];

export interface LogContext {
  attempt?: number;
  count?: number;
  delayMs?: number;
  durationMs?: number;
  error?: unknown;
  eventType?: string;
  method?: LogMethod;
  operation?: string;
  reconnected?: boolean;
  route?: string;
  status?: number;
}

interface LogSink {
  debug(message: string, context?: object): void;
  error(message: string, context?: object): void;
  warn(message: string, context?: object): void;
}

const IDENTIFIER_PATTERN = /[^a-zA-Z0-9_.:-]/g;
const RESOURCE_ROUTE_PATTERN = /\/(session|permission|question)\/[^/\s]+/g;
const MESSAGE_ROUTE_PATTERN = /(\/session\/:id\/message)\/[^/\s]+/g;
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "DataCloneError",
  "Error",
  "EvalError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "OpenCodeHttpError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);
const SAFE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_INVALID_URL",
  "ERR_NETWORK",
]);
// Keep this privacy allowlist aligned with the OpenCode v1 Event union and v1 question events used by the plugin.
const SAFE_EVENT_TYPES = new Set([
  "command.executed",
  "file.edited",
  "file.watcher.updated",
  "installation.update-available",
  "installation.updated",
  "lsp.client.diagnostics",
  "lsp.updated",
  "message.part.delta",
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  "permission.asked",
  "permission.replied",
  "permission.updated",
  "project.updated",
  "pty.created",
  "pty.deleted",
  "pty.exited",
  "pty.updated",
  "question.asked",
  "question.rejected",
  "question.replied",
  "server.connected",
  "server.heartbeat",
  "server.instance.disposed",
  "session.compacted",
  "session.created",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.idle",
  "session.status",
  "session.updated",
  "todo.updated",
  "tui.command.execute",
  "tui.prompt.append",
  "tui.toast.show",
  "vcs.branch.updated",
]);

/** Emits privacy-safe plugin diagnostics to the Obsidian developer console. */
export class PluginLogger {
  private debugEnabled = false;

  constructor(private readonly sink: LogSink = console) {}

  /** Enables or disables verbose diagnostics without changing warning and error output. */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /** Reports whether verbose diagnostics are currently enabled. */
  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }

  /** Emits an allowlisted diagnostic only while debug logging is enabled. */
  debug(component: string, event: string, context?: LogContext): void {
    if (!this.debugEnabled) return;
    this.write("debug", component, event, context);
  }

  /** Emits a recoverable failure without exposing raw errors or request data. */
  warn(component: string, event: string, context?: LogContext): void {
    this.write("warn", component, event, context);
  }

  /** Emits an unrecoverable failure without exposing raw errors or request data. */
  error(component: string, event: string, context?: LogContext): void {
    this.write("error", component, event, context);
  }

  /** Writes one normalized entry to the configured console-compatible sink. */
  private write(level: keyof LogSink, component: string, event: string, context?: LogContext): void {
    const message = `[opencode-plugin:${this.identifier(component)}] ${this.eventLabel(event)}`;
    const safeContext = this.safeContext(context);
    if (Object.keys(safeContext).length > 0) this.sink[level](message, safeContext);
    else this.sink[level](message);
  }

  /** Copies only explicitly supported scalar metadata into a console-safe object. */
  private safeContext(context?: LogContext): Record<string, boolean | number | string> {
    if (!context) return {};
    const safe: Record<string, boolean | number | string> = {};
    this.copyFiniteNumber(safe, "attempt", context.attempt);
    this.copyFiniteNumber(safe, "count", context.count);
    this.copyFiniteNumber(safe, "delayMs", context.delayMs);
    this.copyFiniteNumber(safe, "durationMs", context.durationMs);
    if (context.eventType) safe.eventType = SAFE_EVENT_TYPES.has(context.eventType) ? context.eventType : "unknown";
    if (context.method && LOG_METHODS.includes(context.method)) safe.method = context.method;
    if (context.operation) safe.operation = this.identifier(context.operation);
    if (typeof context.reconnected === "boolean") safe.reconnected = context.reconnected;
    if (context.route) safe.route = this.routeTemplate(context.route);
    this.copyFiniteNumber(safe, "status", context.status);

    if (context.error !== undefined) {
      const error = this.errorContext(context.error);
      if (safe.status === undefined && error.status !== undefined) safe.status = error.status;
      safe.errorName = error.errorName;
      if (error.errorCode !== undefined) safe.errorCode = error.errorCode;
    }
    return safe;
  }

  /** Adds one finite numeric field while rejecting arbitrary objects and non-finite values. */
  private copyFiniteNumber(target: Record<string, boolean | number | string>, key: string, value: unknown): void {
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  }

  /** Reduces a thrown value to an allowlisted error class, network code, and numeric status. */
  private errorContext(error: unknown): { errorName: string; errorCode?: string; status?: number } {
    if (!(error instanceof Error)) return { errorName: typeof error === "string" ? "ThrownString" : "UnknownError" };
    const context: { errorName: string; errorCode?: string; status?: number } = {
      errorName: SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error",
    };
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) context.errorCode = code;
    const status = (error as Error & { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) context.status = status;
    return context;
  }

  /** Converts endpoint paths to templates so session, request, and message IDs are never logged. */
  private routeTemplate(route: string): string {
    return route
      .split(/[?#]/, 1)[0]!
      .replace(RESOURCE_ROUTE_PATTERN, "/$1/:id")
      .replace(MESSAGE_ROUTE_PATTERN, "$1/:messageId")
      .slice(0, 120);
  }

  /** Normalizes internal component and metadata identifiers to a bounded safe alphabet. */
  private identifier(value: string): string {
    return value.replace(IDENTIFIER_PATTERN, "_").slice(0, 80) || "unknown";
  }

  /** Normalizes the fixed developer-authored event label without accepting line breaks. */
  private eventLabel(value: string): string {
    return value.replace(/[\r\n]+/g, " ").slice(0, 120) || "event";
  }
}

export const logger = new PluginLogger();
