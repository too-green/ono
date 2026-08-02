import { OpenCodeEventStream, type OpenCodeEventHandlers, type OpenCodeEventSubscription } from "./opencode-events";
import { OpenCodeHttpClient } from "./opencode-http";
import type {
  JsonObject,
  OpenCodeCommandInput,
  OpenCodeCreateSessionInput,
  OpenCodeFindFilesParams,
  OpenCodeFindTextParams,
  OpenCodeHealth,
  OpenCodeListMessagesParams,
  OpenCodeListSessionsParams,
  OpenCodeMessagePage,
  OpenCodeListToolsParams,
  OpenCodeMessageBundle,
  OpenCodePermissionReply,
  OpenCodePermissionRequest,
  OpenCodePromptInput,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeRevertSessionInput,
  OpenCodeSession,
  OpenCodeUpdateSessionInput,
} from "./opencode-types";

export interface OpenCodeServerConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}

export class OpenCodeService {
  private readonly http: OpenCodeHttpClient;
  private readonly events: OpenCodeEventStream;

  constructor(config: OpenCodeServerConfig) {
    this.http = new OpenCodeHttpClient(config);
    this.events = new OpenCodeEventStream(this.http);
  }

  /** Disposes long-lived connections; referenced by the Obsidian plugin unload hook. */
  dispose(): void {
    this.events.close();
  }

  /** Reads server health and version from `GET /global/health`. */
  health(signal?: AbortSignal): Promise<OpenCodeHealth> {
    return this.http.get<OpenCodeHealth>("/global/health", undefined, signal);
  }

  /** Subscribes to directory-scoped bus events from `GET /event?directory=...`. */
  subscribeToEvents(handlers: OpenCodeEventHandlers, directory?: string): OpenCodeEventSubscription {
    return this.events.subscribe(handlers, directory);
  }

  /** Lists known projects from `GET /project`; optional directory triggers OpenCode's backend resolver. */
  listProjects(directory?: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/project", { directory });
  }

  /** Reads the current OpenCode project from `GET /project/current`; referenced by the open-directory flow. */
  getCurrentProject(directory?: string): Promise<JsonObject> {
    return this.http.get<JsonObject>("/project/current", { directory });
  }

  /** Reads current path metadata from `GET /path`. */
  getPath(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/path");
  }

  /** Reads VCS metadata from `GET /vcs`. */
  getVcs(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/vcs");
  }

  /** Reads OpenCode config metadata from `GET /config`. */
  getConfig(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/config");
  }

  /** Lists configured providers from `GET /config/providers`. */
  listConfigProviders(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/config/providers");
  }

  /** Lists provider registry state from `GET /provider`. */
  listProviders(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/provider");
  }

  /** Lists provider auth methods from `GET /provider/auth`. */
  listProviderAuth(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/provider/auth");
  }

  /** Lists sessions from `GET /session` without creating or mutating sessions. */
  listSessions(params?: OpenCodeListSessionsParams): Promise<OpenCodeSession[]> {
    return this.http.get<OpenCodeSession[]>("/session", params);
  }

  /** Reads status for all sessions from `GET /session/status`. */
  getSessionStatus(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/session/status");
  }

  /** Reads one session from `GET /session/:id`. */
  getSession(sessionId: string, directory?: string): Promise<OpenCodeSession> {
    return this.http.get<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}`, { directory });
  }

  /** Creates a session through `POST /session`; referenced by the agents panel new-session placeholder. */
  createSession(input?: OpenCodeCreateSessionInput, directory?: string): Promise<OpenCodeSession> {
    return this.http.post<OpenCodeSession>("/session", input ?? {}, { directory });
  }

  /** Updates a session through v1 `PATCH /session/:id`; referenced by rename and archival actions. */
  updateSession(sessionId: string, input: OpenCodeUpdateSessionInput, directory?: string): Promise<OpenCodeSession> {
    return this.http.patch<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}`, input, { directory });
  }

  /** Sets v1 session archival metadata; recursive descendant traversal remains a client responsibility. */
  archiveSession(sessionId: string, archivedAt: number, directory?: string): Promise<OpenCodeSession> {
    return this.updateSession(sessionId, { time: { archived: archivedAt } }, directory);
  }

  /** Sends a non-blocking prompt through `POST /session/:id/prompt_async`; referenced by the composer. */
  sendPromptAsync(sessionId: string, input: OpenCodePromptInput, directory?: string): Promise<void> {
    return this.http.post<void>(`/session/${encodeURIComponent(sessionId)}/prompt_async`, input, { directory });
  }

  /** Aborts an active session through `POST /session/:id/abort`; referenced by the composer stop button. */
  abortSession(sessionId: string, directory?: string): Promise<boolean> {
    return this.http.post<boolean>(`/session/${encodeURIComponent(sessionId)}/abort`, {}, { directory });
  }

  /** Runs a slash command through `POST /session/:id/command`; referenced by composer `/` submission. */
  runCommand(sessionId: string, input: OpenCodeCommandInput, directory?: string): Promise<OpenCodeMessageBundle> {
    return this.http.post<OpenCodeMessageBundle>(`/session/${encodeURIComponent(sessionId)}/command`, input, { directory });
  }

  /** Compacts session context via `POST /session/:id/summarize`; referenced by the `/compact` built-in command. */
  summarizeSession(sessionId: string, directory?: string): Promise<JsonObject> {
    return this.http.post<JsonObject>(`/session/${encodeURIComponent(sessionId)}/summarize`, {}, { directory });
  }

  /** Stages a v1 rewind at one message and applies its file rollback; referenced by message rewind and `/undo`. */
  revertSession(sessionId: string, input: OpenCodeRevertSessionInput, directory?: string): Promise<OpenCodeSession> {
    return this.http.post<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}/revert`, input, { directory });
  }

  /** Clears a v1 rewind marker and restores its messages/files; referenced by rewind cancel and redo. */
  unrevertSession(sessionId: string, directory?: string): Promise<OpenCodeSession> {
    return this.http.post<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}/unrevert`, {}, { directory });
  }

  /** Shares a session via `POST /session/:id/share`; referenced by the `/share` built-in command. */
  shareSession(sessionId: string, directory?: string): Promise<JsonObject> {
    return this.http.post<JsonObject>(`/session/${encodeURIComponent(sessionId)}/share`, {}, { directory });
  }

  /** Unshares a session via `DELETE /session/:id/share`; referenced by the `/unshare` built-in command. */
  unshareSession(sessionId: string, directory?: string): Promise<JsonObject> {
    return this.http.delete<JsonObject>(`/session/${encodeURIComponent(sessionId)}/share`, { directory });
  }

  /** Forks a session via `POST /session/:id/fork`; referenced by the `/fork` built-in command. */
  forkSession(sessionId: string, directory?: string, messageId?: string): Promise<OpenCodeSession> {
    return this.http.post<OpenCodeSession>(
      `/session/${encodeURIComponent(sessionId)}/fork`,
      messageId ? { messageID: messageId } : {},
      { directory },
    );
  }

  /** Lists pending permission requests from `GET /permission`; referenced by the session permission dock. */
  listPermissionRequests(directory?: string): Promise<OpenCodePermissionRequest[]> {
    return this.http.get<OpenCodePermissionRequest[]>("/permission", { directory });
  }

  /** Replies to one permission request through `POST /permission/:id/reply`; referenced by permission buttons. */
  replyPermission(requestId: string, reply: OpenCodePermissionReply, directory?: string): Promise<boolean> {
    return this.http.post<boolean>(`/permission/${encodeURIComponent(requestId)}/reply`, { reply }, { directory });
  }

  /** Lists pending question requests from `GET /question`; referenced by the session question dock. */
  listQuestionRequests(directory?: string): Promise<OpenCodeQuestionRequest[]> {
    return this.http.get<OpenCodeQuestionRequest[]>("/question", { directory });
  }

  /** Answers one question request through `POST /question/:id/reply`; referenced by the question dock submit action. */
  replyQuestion(requestId: string, answers: OpenCodeQuestionAnswer[], directory?: string): Promise<boolean> {
    return this.http.post<boolean>(`/question/${encodeURIComponent(requestId)}/reply`, { answers }, { directory });
  }

  /** Rejects one question request through `POST /question/:id/reject`; referenced by the question dock reject action. */
  rejectQuestion(requestId: string, directory?: string): Promise<boolean> {
    return this.http.post<boolean>(`/question/${encodeURIComponent(requestId)}/reject`, {}, { directory });
  }

  /** Lists child sessions from `GET /session/:id/children`. */
  listSessionChildren(sessionId: string, directory?: string): Promise<OpenCodeSession[]> {
    return this.http.get<OpenCodeSession[]>(`/session/${encodeURIComponent(sessionId)}/children`, { directory });
  }

  /** Reads a session todo list from `GET /session/:id/todo`. */
  getSessionTodo(sessionId: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  /** Reads directory-scoped session diff metadata from `GET /session/:id/diff`. */
  getSessionDiff(sessionId: string, messageId?: string, directory?: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>(`/session/${encodeURIComponent(sessionId)}/diff`, { messageID: messageId, directory });
  }

  /** Lists all message bundles from `GET /session/:id/message`; referenced by full-session side panels. */
  async listMessages(sessionId: string, params?: OpenCodeListMessagesParams): Promise<OpenCodeMessageBundle[]> {
    const payload = await this.http.get<OpenCodeMessageBundle[] | { data?: OpenCodeMessageBundle[] }>(`/session/${encodeURIComponent(sessionId)}/message`, params);
    return Array.isArray(payload) ? payload : payload.data ?? [];
  }

  /** Reads one normalized cursor page from `GET /session/:id/message`; referenced by lazy session timelines. */
  async listMessagePage(sessionId: string, params?: OpenCodeListMessagesParams): Promise<OpenCodeMessagePage> {
    const query = { limit: params?.limit, before: params?.cursor };
    const response = await this.http.getResponse<OpenCodeMessageBundle[] | { data?: OpenCodeMessageBundle[]; cursor?: { previous?: string; next?: string } }>(
      `/session/${encodeURIComponent(sessionId)}/message`,
      query,
    );
    const payload = response.json;
    const headerCursor = response.headers["x-next-cursor"] ?? response.headers["X-Next-Cursor"];
    if (Array.isArray(payload)) return { messages: payload, olderCursor: headerCursor, complete: !headerCursor };
    return {
      messages: payload.data ?? [],
      olderCursor: payload.cursor?.next ?? headerCursor,
      newerCursor: payload.cursor?.previous,
      complete: !(payload.cursor?.next ?? headerCursor),
    };
  }

  /** Reads one message bundle from `GET /session/:id/message/:messageID`. */
  getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessageBundle> {
    return this.http.get<OpenCodeMessageBundle>(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
  }

  /** Lists slash commands from `GET /command`. */
  listCommands(directory?: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/command", { directory });
  }

  /** Searches file contents using `GET /find`. */
  findText(params: OpenCodeFindTextParams): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/find", params);
  }

  /** Finds files and directories using `GET /find/file`. */
  findFiles(params: OpenCodeFindFilesParams): Promise<string[]> {
    return this.http.get<string[]>("/find/file", params);
  }

  /** Finds workspace symbols using `GET /find/symbol`. */
  findSymbols(query: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/find/symbol", { query });
  }

  /** Lists directory entries using `GET /file`. */
  listFiles(path: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/file", { path });
  }

  /** Reads file content using `GET /file/content`. */
  readFile(path: string): Promise<JsonObject> {
    return this.http.get<JsonObject>("/file/content", { path });
  }

  /** Reads tracked-file status using `GET /file/status`. */
  getFileStatus(): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/file/status");
  }

  /** Lists experimental tool IDs using `GET /experimental/tool/ids`. */
  listToolIds(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/experimental/tool/ids");
  }

  /** Lists model tools using `GET /experimental/tool`. */
  listTools(params: OpenCodeListToolsParams): Promise<JsonObject> {
    return this.http.get<JsonObject>("/experimental/tool", params);
  }

  /** Reads LSP status using `GET /lsp`. */
  getLspStatus(): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/lsp");
  }

  /** Reads formatter status using `GET /formatter`. */
  getFormatterStatus(): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/formatter");
  }

  /** Reads MCP status using `GET /mcp`. */
  getMcpStatus(): Promise<JsonObject> {
    return this.http.get<JsonObject>("/mcp");
  }

  /** Lists directory-scoped agents using `GET /agent`; referenced by composer selection. */
  listAgents(directory?: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/agent", { directory });
  }

  /** Lists configured models by flattening `GET /config/providers`; referenced by composer model/variant selection. */
  async listModels(directory?: string): Promise<JsonObject[]> {
    const payload = await this.http.get<JsonObject>("/config/providers", { directory });
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    return providers.flatMap((provider) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
      const providerObject = provider as JsonObject;
      const providerID = typeof providerObject.id === "string" ? providerObject.id : undefined;
      const models = providerObject.models;
      if (!models || typeof models !== "object" || Array.isArray(models)) return [];
      return Object.values(models).flatMap((model) => {
        if (!model || typeof model !== "object" || Array.isArray(model)) return [];
        const modelObject = model as JsonObject;
        return [{ ...modelObject, providerID: typeof modelObject.providerID === "string" ? modelObject.providerID : providerID }];
      });
    });
  }
}
