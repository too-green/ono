import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// Build modes: "" = dev, "production" = release, and the benchmark variants enable
// the in-plugin replay service with either development or release output settings.
const mode = process.argv[2] ?? "";
const release = mode === "production" || mode === "benchmark";
const benchmark = mode === "benchmark" || mode === "benchmark-dev";

await esbuild.build({
  banner: { js: "/* Obsidian OpenCode plugin */" },
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  loader: { ".svg": "text" },
  target: "es2018",
  logLevel: "info",
  sourcemap: release ? false : "inline",
  treeShaking: true,
  define: { OPENCODE_BENCHMARK_BUILD: benchmark ? "true" : "false" },
  outfile: "main.js",
  minify: release,
});
