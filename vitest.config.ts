import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // The real `obsidian` package ships type declarations but no resolvable runtime entry.
      // Vitest needs a stub so modules importing it can be transformed in unit tests.
      obsidian: fileURLToPath(new URL("./src/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      // Pure helpers only. DOM-heavy block/streaming modules get coverage via Phase 5c DOM suites.
      include: ["src/views/session/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
    environmentMatchGlobs: [
      ["src/**/*.dom.test.ts", "jsdom"],
    ],
  },
});
