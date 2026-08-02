import { requestUrl } from "obsidian";

export interface OpenCodeHttpClientConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
}

export class OpenCodeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

/** Logs an OpenCode service call failure and returns the fallback value, so views can degrade without hiding 4xx/5xx failures; `scope` is a generic context (directory or session ID) included in the log. */
export function logServiceError<T>(fallback: T, label: string, scope?: string): (error: unknown) => T {
  return (error: unknown) => {
    const detail =
      error instanceof OpenCodeHttpError
        ? { status: error.status, body: error.responseText.slice(0, 200) }
        : error instanceof Error
          ? { message: error.message, name: error.name }
          : { message: String(error) };
    console.warn("[opencode-plugin:view] service call failed", { label, scope, ...detail });
    return fallback;
  };
}

export class OpenCodeHttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenCodeHttpClientConfig) {
    this.baseUrl = new URL(config.baseUrl.replace(/\/$/, ""));
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Performs a JSON GET request; referenced by all read-only OpenCode service methods. */
  async get<T>(path: string, query?: object, signal?: AbortSignal): Promise<T> {
    return (await this.getResponse<T>(path, query, signal)).json;
  }

  /** Performs a JSON GET request and returns headers for cursor-based endpoints. */
  async getResponse<T>(path: string, query?: object, signal?: AbortSignal): Promise<{ json: T; headers: Record<string, string> }> {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");

    if (!this.config.fetchImpl) return this.getWithObsidianRequestUrl<T>(path, query);

    return this.getWithFetch<T>(path, query, signal);
  }

  /** Performs a JSON POST request; referenced by mutating OpenCode session actions. */
  async post<T>(path: string, payload?: unknown, query?: object, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (!this.config.fetchImpl) return this.mutateWithObsidianRequestUrl<T>("POST", path, payload, query);
    return this.mutateWithFetch<T>("POST", path, payload, query, signal);
  }

  /** Performs a JSON PATCH request; referenced by session rename and archival. */
  async patch<T>(path: string, payload: unknown, query?: object, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (!this.config.fetchImpl) return this.mutateWithObsidianRequestUrl<T>("PATCH", path, payload, query);
    return this.mutateWithFetch<T>("PATCH", path, payload, query, signal);
  }

  /** Performs a JSON DELETE request; referenced by session unshare. */
  async delete<T>(path: string, query?: object): Promise<T> {
    if (!this.config.fetchImpl) return this.deleteWithObsidianRequestUrl<T>(path, query);
    return this.deleteWithFetch<T>(path, query);
  }

  /** Creates an absolute server URL with encoded query parameters for GET endpoints. */
  url(path: string, query?: object): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Builds Basic Auth headers when the server is configured with credentials. */
  headers(extra?: HeadersInit): HeadersInit {
    const headers = new Headers(extra);
    if (this.config.password) {
      const username = this.config.username ?? "opencode";
      headers.set("Authorization", `Basic ${btoa(`${username}:${this.config.password}`)}`);
    }
    return headers;
  }

  /** Performs GET through Obsidian's network helper to avoid renderer CORS failures. */
  private async getWithObsidianRequestUrl<T>(path: string, query?: object): Promise<{ json: T; headers: Record<string, string> }> {
    const headers: Record<string, string> = {};
    new Headers(this.headers()).forEach((value, key) => {
      headers[key] = value;
    });

    const response = await requestUrl({
      url: this.url(path, query),
      method: "GET",
      headers,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new OpenCodeHttpError(`OpenCode GET ${path} failed with ${response.status}`, response.status, response.text);
    }

    return { json: response.json as T, headers: response.headers };
  }

  /** Performs a JSON body mutation through Obsidian's network helper to avoid renderer CORS failures. */
  private async mutateWithObsidianRequestUrl<T>(method: "POST" | "PATCH", path: string, payload?: unknown, query?: object): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    new Headers(this.headers()).forEach((value, key) => {
      headers[key] = value;
    });

    const response = await requestUrl({
      url: this.url(path, query),
      method,
      headers,
      body: JSON.stringify(payload ?? {}),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new OpenCodeHttpError(`OpenCode ${method} ${path} failed with ${response.status}`, response.status, response.text);
    }

    return (response.text ? response.json : undefined) as T;
  }

  /** Performs DELETE through Obsidian's network helper to avoid renderer CORS failures. */
  private async deleteWithObsidianRequestUrl<T>(path: string, query?: object): Promise<T> {
    const headers: Record<string, string> = {};
    new Headers(this.headers()).forEach((value, key) => {
      headers[key] = value;
    });

    const response = await requestUrl({
      url: this.url(path, query),
      method: "DELETE",
      headers,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new OpenCodeHttpError(`OpenCode DELETE ${path} failed with ${response.status}`, response.status, response.text);
    }

    return (response.text ? response.json : undefined) as T;
  }

  /** Performs GET with an injected fetch implementation for tests or non-Obsidian contexts. */
  private async getWithFetch<T>(path: string, query?: object, signal?: AbortSignal): Promise<{ json: T; headers: Record<string, string> }> {
    const response = await this.fetchImpl(this.url(path, query), {
      method: "GET",
      headers: this.headers(),
      signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new OpenCodeHttpError(`OpenCode GET ${path} failed with ${response.status}`, response.status, responseText);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const json = contentType.includes("application/json") ? ((await response.json()) as T) : ((await response.text()) as T);
    return { json, headers };
  }

  /** Performs a JSON body mutation with an injected fetch implementation for tests or non-Obsidian contexts. */
  private async mutateWithFetch<T>(method: "POST" | "PATCH", path: string, payload?: unknown, query?: object, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(this.url(path, query), {
      method,
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payload ?? {}),
      signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new OpenCodeHttpError(`OpenCode ${method} ${path} failed with ${response.status}`, response.status, responseText);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? ((await response.json()) as T) : ((await response.text()) as T);
  }

  /** Performs DELETE with an injected fetch implementation for tests or non-Obsidian contexts. */
  private async deleteWithFetch<T>(path: string, query?: object): Promise<T> {
    const response = await this.fetchImpl(this.url(path, query), {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new OpenCodeHttpError(`OpenCode DELETE ${path} failed with ${response.status}`, response.status, responseText);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? ((await response.json()) as T) : ((await response.text()) as T);
  }
}
