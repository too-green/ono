import type { OpenCodeServerConfig } from "./services/opencode-service";

export interface OpenCodePluginSettings {
  server: OpenCodeServerConfig;
  openedDirectories: string[];
  groupContextTools: boolean;
  showReasoningBlocks: boolean;
}

export const DEFAULT_OPENCODE_SETTINGS: OpenCodePluginSettings = {
  server: {
    baseUrl: "http://127.0.0.1:4096",
  },
  openedDirectories: [],
  groupContextTools: false,
  showReasoningBlocks: true,
};
