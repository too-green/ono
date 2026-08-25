import { describe, expect, it } from "vitest";

import { assistantErrorDiagnostics, assistantErrorDiagnosticsText, assistantErrorMessage, isAssistantAbortError, isDisplayableAssistantError } from "./assistant-error";

describe("assistant errors", () => {
  it("extracts nested and top-level messages with a safe fallback", () => {
    expect(assistantErrorMessage({ name: "APIError", data: { message: "Provider unavailable" } })).toBe("Provider unavailable");
    expect(assistantErrorMessage({ name: "UnknownError", message: "Unexpected failure" })).toBe("Unexpected failure");
    expect(assistantErrorMessage({ name: "MessageOutputLengthError", data: {} })).toBe("Session stopped with an error.");
  });

  it("separates interruptions from displayable failures", () => {
    const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } };
    expect(isAssistantAbortError(aborted)).toBe(true);
    expect(isDisplayableAssistantError(aborted)).toBe(false);
    expect(assistantErrorMessage(aborted)).toBe("Session was aborted.");
    expect(isDisplayableAssistantError({ name: "APIError" })).toBe(true);
  });

  it("keeps diagnostics useful while excluding raw provider payloads", () => {
    const error = {
      name: "APIError",
      data: {
        message: "Provider unavailable",
        statusCode: 503,
        isRetryable: true,
        responseHeaders: { authorization: "secret" },
        responseBody: "private response",
        metadata: { url: "https://example.com?token=secret" },
      },
    };
    expect(assistantErrorDiagnostics(error)).toEqual([
      { label: "Error type", value: "APIError" },
      { label: "Message", value: "Provider unavailable" },
      { label: "Status code", value: "503" },
      { label: "Retryable", value: "Yes" },
    ]);
    const text = assistantErrorDiagnosticsText(error);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private response");
  });

  it("omits opaque references that may contain provider secrets", () => {
    expect(assistantErrorDiagnosticsText({ name: "UnknownError", data: { ref: "https://errors.example/item/1?token=secret#private" } }))
      .not.toContain("Reference");
    expect(assistantErrorDiagnosticsText({ name: "UnknownError", data: { ref: "incident token=secret" } })).not.toContain("secret");
  });
});
