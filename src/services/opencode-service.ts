import { OpenCodeEventStream, type OpenCodeEventHandlers, type OpenCodeEventSubscription } from "./opencode-events";
import { OpenCodeHttpClient } from "./opencode-http";
import type {
  JsonObject,
  OpenCodeFindFilesParams,
  OpenCodeFindTextParams,
  OpenCodeHealth,
  OpenCodeListMessagesParams,
  OpenCodeListSessionsParams,
  OpenCodeListToolsParams,
  OpenCodeMessageBundle,
  OpenCodeSession,
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

  /** Subscribes to bus events from `GET /event` for future live UI reconciliation. */
  subscribeToEvents(handlers: OpenCodeEventHandlers): OpenCodeEventSubscription {
    return this.events.subscribe(handlers);
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
  getSession(sessionId: string): Promise<OpenCodeSession> {
    return this.http.get<OpenCodeSession>(`/session/${encodeURIComponent(sessionId)}`);
  }

  /** Lists child sessions from `GET /session/:id/children`. */
  listSessionChildren(sessionId: string): Promise<OpenCodeSession[]> {
    return this.http.get<OpenCodeSession[]>(`/session/${encodeURIComponent(sessionId)}/children`);
  }

  /** Reads a session todo list from `GET /session/:id/todo`. */
  getSessionTodo(sessionId: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  /** Reads session diff metadata from `GET /session/:id/diff`. */
  getSessionDiff(sessionId: string, messageId?: string): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>(`/session/${encodeURIComponent(sessionId)}/diff`, { messageID: messageId });
  }

  /** Lists message bundles from `GET /session/:id/message`. */
  listMessages(sessionId: string, params?: OpenCodeListMessagesParams): Promise<OpenCodeMessageBundle[]> {
    return this.http.get<OpenCodeMessageBundle[]>(`/session/${encodeURIComponent(sessionId)}/message`, params);
  }

  /** Reads one message bundle from `GET /session/:id/message/:messageID`. */
  getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessageBundle> {
    return this.http.get<OpenCodeMessageBundle>(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
  }

  /** Lists slash commands from `GET /command`. */
  listCommands(): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/command");
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

  /** Lists available agents using `GET /agent`. */
  listAgents(): Promise<JsonObject[]> {
    return this.http.get<JsonObject[]>("/agent");
  }
}
