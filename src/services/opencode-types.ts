export type JsonObject = Record<string, unknown>;
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeSession extends JsonObject {
  id: string;
  title?: string;
  projectID?: string;
  parentID?: string;
  directory?: string;
  revert?: OpenCodeSessionRevert;
  time?: { created?: number; updated?: number; archived?: number };
}

export interface OpenCodeProject extends JsonObject {
  id: string;
  worktree: string;
  vcsDir?: string;
  vcs?: "git";
  time?: { created?: number; initialized?: number };
}

export interface OpenCodeVcsInfo extends JsonObject {
  branch?: string;
  default_branch?: string;
}

export interface OpenCodeWorktree extends JsonObject {
  name: string;
  branch?: string;
  directory: string;
}

export interface OpenCodeCreateWorktreeInput {
  name?: string;
  startCommand?: string;
}

export interface OpenCodeWorktreeDirectoryInput {
  directory: string;
}

export interface OpenCodeTodo extends JsonObject {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface OpenCodeSessionRevert extends JsonObject {
  messageID: string;
  partID?: string;
  snapshot?: string;
  diff?: string;
}

export interface OpenCodeRevertSessionInput {
  messageID: string;
  partID?: string;
}

export interface OpenCodeUpdateSessionInput {
  title?: string;
  time?: { archived?: number };
}

export interface OpenCodeMessageBundle extends JsonObject {
  info: JsonObject;
  parts: JsonObject[];
}

export interface OpenCodeEvent {
  type: string;
  properties?: JsonObject;
}

export interface OpenCodeListSessionsParams {
  limit?: number;
  directory?: string;
  scope?: "project";
  path?: string;
  roots?: boolean;
  start?: number;
  search?: string;
}

export interface OpenCodeListMessagesParams {
  limit?: number;
  cursor?: string;
  directory?: string;
}

export interface OpenCodeMessagePage {
  messages: OpenCodeMessageBundle[];
  olderCursor?: string;
  newerCursor?: string;
  complete: boolean;
}

export interface OpenCodeCreateSessionInput {
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
}

export interface OpenCodeModelRef extends JsonObject {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface OpenCodePromptPartInput extends JsonObject {
  type: "text" | "file" | "agent" | "subtask";
}

export interface OpenCodePromptInput {
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  parts: OpenCodePromptPartInput[];
}

export interface OpenCodeCommandInput {
  agent?: string;
  model?: string;
  command: string;
  arguments: string;
  variant?: string;
  parts?: OpenCodePromptPartInput[];
}

export interface OpenCodeSummarizeInput {
  providerID: string;
  modelID: string;
  auto?: boolean;
}

export type OpenCodePermissionReply = "once" | "always" | "reject";

export interface OpenCodePermissionRequest extends JsonObject {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: JsonObject;
  always: string[];
}

export interface OpenCodeQuestionOption extends JsonObject {
  label: string;
  description: string;
}

export interface OpenCodeQuestionInfo extends JsonObject {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface OpenCodeQuestionRequest extends JsonObject {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
}

export type OpenCodeQuestionAnswer = string[];

export interface OpenCodeFindFilesParams {
  query: string;
  type?: "file" | "directory";
  directory?: string;
  limit?: number;
  dirs?: boolean;
}

export interface OpenCodeFindTextParams {
  pattern: string;
}

export interface OpenCodeListToolsParams {
  provider: string;
}
