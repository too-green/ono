import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_OPEN_IDE_ID,
  IDE_REGISTRY,
  currentPlatform,
  detectInstalledIdes,
  getIdeById,
  getIdeOrDefault,
  isIdeInstalled,
  resolveCommand,
} from "./ide-launcher";

describe("ide-launcher registry", () => {
  it("exposes unique ids", () => {
    const ids = IDE_REGISTRY.map((ide) => ide.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every descriptor declares at least one platform and a kind", () => {
    for (const ide of IDE_REGISTRY) {
      expect(ide.platforms.length).toBeGreaterThan(0);
      expect(["editor", "file-manager"]).toContain(ide.kind);
    }
  });

  it("the canonical default id resolves to a real descriptor", () => {
    expect(getIdeById(DEFAULT_OPEN_IDE_ID)?.id).toBe(DEFAULT_OPEN_IDE_ID);
  });
});

describe("ide-launcher lookups", () => {
  it("returns undefined for unknown ids", () => {
    expect(getIdeById("nope")).toBeUndefined();
    expect(getIdeById(undefined)).toBeUndefined();
  });

  it("falls back to the canonical default when the id is missing", () => {
    expect(getIdeOrDefault(undefined).id).toBe(DEFAULT_OPEN_IDE_ID);
    expect(getIdeOrDefault("missing").id).toBe(DEFAULT_OPEN_IDE_ID);
  });

  it("returns the configured descriptor when present", () => {
    expect(getIdeOrDefault("cursor").id).toBe("cursor");
  });
});

describe("ide-launcher platform", () => {
  it("returns one of the supported platforms", () => {
    expect(["darwin", "win32", "linux"]).toContain(currentPlatform());
  });
});

describe("ide-launcher resolveCommand", () => {
  it("returns undefined when no candidates are given", () => {
    expect(resolveCommand(undefined, "linux")).toBeUndefined();
    expect(resolveCommand([], "linux")).toBeUndefined();
  });

  it("resolves a binary placed on a fake PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-launcher-"));
    const bin = path.join(dir, "fake-editor");
    fs.writeFileSync(bin, "", { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(resolveCommand(["fake-editor", "missing"], "linux")).toBe(bin);
    } finally {
      process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes Windows executable extensions when the candidate has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-launcher-"));
    const exe = path.join(dir, "fake.cmd");
    fs.writeFileSync(exe, "", { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(resolveCommand(["fake"], "win32")).toBe(exe);
    } finally {
      process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ide-launcher detection", () => {
  it("file-manager targets are always available on their own platform and absent elsewhere", () => {
    const finder = getIdeById("finder")!;
    expect(isIdeInstalled(finder, "darwin")).toBe(true);
    expect(isIdeInstalled(finder, "win32")).toBe(false);
    expect(isIdeInstalled(finder, "linux")).toBe(false);
  });

  it("an editor with no CLI or bundle on a clean PATH is not detected", () => {
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      // textmate is macOS-bundle-only; with a bogus bundle name check it stays false here.
      expect(isIdeInstalled(getIdeById("xcode")!, "win32")).toBe(false);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("detectInstalledIdes only returns platform-appropriate descriptors", () => {
    for (const ide of detectInstalledIdes()) {
      expect(ide.platforms).toContain(currentPlatform());
    }
  });
});
