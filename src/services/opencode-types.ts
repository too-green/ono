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
  time?: { created?: number; updated?: number };
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
}

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
