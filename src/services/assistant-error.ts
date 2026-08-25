import type { JsonObject } from "./opencode-types";

/** Returns whether a v1 assistant error represents a user-requested interruption. */
export function isAssistantAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const value = error as JsonObject;
  return value.name === "MessageAbortedError" || value.type === "MessageAbortedError";
}

/** Extracts a concise user-facing message from a v1 assistant or `session.error` payload. */
export function assistantErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "Session stopped with an error.";
  const value = error as JsonObject;
  if (isAssistantAbortError(value)) return "Session was aborted.";
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const message = (data as JsonObject).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return "Session stopped with an error.";
}

/** Returns whether an assistant error should render as a failure rather than interruption metadata. */
export function isDisplayableAssistantError(error: unknown): boolean {
  return error !== undefined && error !== null && !isAssistantAbortError(error);
}

export interface AssistantErrorDiagnostic {
  label: string;
  value: string;
}

/** Builds a sanitized v1 diagnostic summary without provider bodies, headers, metadata, or signed URLs. */
export function assistantErrorDiagnostics(error: unknown): AssistantErrorDiagnostic[] {
  if (!error || typeof error !== "object" || Array.isArray(error)) return [];
  const value = error as JsonObject;
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data as JsonObject : {};
  const details: AssistantErrorDiagnostic[] = [];
  const add = (label: string, candidate: unknown, maxLength = 300): void => {
    if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") return;
    const text = String(candidate).trim();
    if (text) details.push({ label, value: text.slice(0, maxLength) });
  };
  add("Error type", value.name ?? value.type, 100);
  add("Message", data.message ?? value.message, 500);
  add("Provider", data.providerID, 100);
  add("Status code", data.statusCode, 20);
  if (typeof data.isRetryable === "boolean") add("Retryable", data.isRetryable ? "Yes" : "No");
  add("Structured-output retries", data.retries, 20);
  return details;
}

/** Formats sanitized assistant diagnostics for the explicit copy action in Session View. */
export function assistantErrorDiagnosticsText(error: unknown): string {
  return assistantErrorDiagnostics(error).map(({ label, value }) => `${label}: ${value}`).join("\n");
}
