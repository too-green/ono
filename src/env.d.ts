/**
 * Compile-time build-mode flag injected by esbuild (`esbuild.config.mjs` define): true only in
 * `npm run build:benchmark` output; dev and production builds compile it to false so benchmark
 * wiring is dead-code-eliminated and plugin construction keeps the live `OpenCodeService`.
 */
declare const OPENCODE_BENCHMARK_BUILD: boolean;
