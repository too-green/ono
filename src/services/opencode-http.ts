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

export class OpenCodeHttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenCodeHttpClientConfig) {
    this.baseUrl = new URL(config.baseUrl.replace(/\/$/, ""));
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Performs a JSON GET request; referenced by all read-only OpenCode service methods. */
  async get<T>(path: string, query?: object, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");

    if (!this.config.fetchImpl) return this.getWithObsidianRequestUrl<T>(path, query);

    return this.getWithFetch<T>(path, query, signal);
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
  private async getWithObsidianRequestUrl<T>(path: string, query?: object): Promise<T> {
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

    return response.json as T;
  }

  /** Performs GET with an injected fetch implementation for tests or non-Obsidian contexts. */
  private async getWithFetch<T>(path: string, query?: object, signal?: AbortSignal): Promise<T> {
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
    if (contentType.includes("application/json")) return (await response.json()) as T;
    return (await response.text()) as T;
  }
}
