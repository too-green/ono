import assert from "node:assert/strict";
import test from "node:test";

import { injectDetachOnUnload, parseFootprint } from "./cli.mjs";

test("injects the historical unload regression exactly once", () => {
  const source = "onunload() {\n    logger.setDebugEnabled(false);\n    dispose();\n}\n";
  const injected = injectDetachOnUnload(source);
  assert.match(injected, /detachLeavesOfType\(VIEW_TYPE_OPENCODE_SESSIONS_PANEL\)/);
  assert.match(injected, /detachLeavesOfType\(VIEW_TYPE_OPENCODE_SESSION\)/);
  assert.throws(() => injectDetachOnUnload(injected), /already detaches/);
});

test("parses macOS renderer footprint counters", () => {
  const source = [
    "Renderer [42]: 64-bit    Footprint: 527518408 B (16384 bytes per page)",
    "527518408 B   142704640 B    61292544 B    14893056 B      34068    TOTAL",
    "    phys_footprint: 525781704 B",
    "    phys_footprint_peak: 1072941816 B",
  ].join("\n");
  assert.deepEqual(parseFootprint(source), {
    footprintBytes: 527518408,
    dirtyBytes: 527518408,
    swappedBytes: 142704640,
    cleanBytes: 61292544,
    reclaimableBytes: 14893056,
    physicalBytes: 525781704,
    peakPhysicalBytes: 1072941816,
  });
});
