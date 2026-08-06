import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { basename, compactHomePath, displayPath, homeDirectory, isInsidePath, normalizePath, relativePath, splitPath, toAbsolutePath } from "./path-utils";

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  delete process.env.HOME;
  delete process.env.USERPROFILE;
});

afterEach(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
  else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE;
  else delete process.env.USERPROFILE;
});

describe("normalizePath", () => {
  it("collapses duplicate and trailing slashes on absolute paths", () => {
    expect(normalizePath("/a//b///c/")).toBe("/a/b/c");
  });

  it("resolves . segments", () => {
    expect(normalizePath("/a/./b/./c")).toBe("/a/b/c");
  });

  it("resolves .. segments against the previous real segment", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
    expect(normalizePath("/a/b/c/../../d")).toBe("/a/d");
  });

  it("does not pop past the root on absolute paths", () => {
    expect(normalizePath("/../a")).toBe("/a");
  });

  it("preserves leading .. on relative paths", () => {
    expect(normalizePath("../a/b")).toBe("../a/b");
    expect(normalizePath("a/../../b")).toBe("../b");
  });

  it("returns / for root-only absolute input", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("///")).toBe("/");
  });

  it("returns . for empty/relative-dot input", () => {
    expect(normalizePath("")).toBe(".");
    expect(normalizePath(".")).toBe(".");
    expect(normalizePath("./")).toBe(".");
  });
});

describe("isInsidePath", () => {
  it("returns true when paths are equal", () => {
    expect(isInsidePath("/a/b", "/a/b")).toBe(true);
  });

  it("returns true when path starts with root on a segment boundary", () => {
    expect(isInsidePath("/a/b/c", "/a/b")).toBe(true);
  });

  it("returns false for sibling prefsegment (no partial-segment match)", () => {
    expect(isInsidePath("/a/bbb", "/a/b")).toBe(false);
  });

  it("respects trailing slash on root", () => {
    expect(isInsidePath("/a/b/c", "/a/b/")).toBe(true);
  });
});

describe("relativePath", () => {
  it("returns empty when path equals root", () => {
    expect(relativePath("/a/b", "/a/b")).toBe("");
  });

  it("returns empty when path equals root after trailing-slash trim", () => {
    expect(relativePath("/a/b/", "/a/b")).toBe("");
  });

  it("returns the suffix when path is inside root", () => {
    expect(relativePath("/a/b", "/a/b/c/d")).toBe("c/d");
  });
});

describe("splitPath", () => {
  it("splits an absolute path keeping the slash after the prefix", () => {
    expect(splitPath("/a/b/c.ts")).toEqual({ prefix: "/a/b/", basename: "c.ts" });
  });

  it("returns / for empty input", () => {
    expect(splitPath("")).toEqual({ prefix: "", basename: "/" });
  });

  it("returns ~ for tilde input", () => {
    expect(splitPath("~")).toEqual({ prefix: "", basename: "~" });
  });

  it("returns the whole thing as basename when no slash", () => {
    expect(splitPath("foo.ts")).toEqual({ prefix: "", basename: "foo.ts" });
  });

  it("strips trailing slash before splitting", () => {
    expect(splitPath("/a/b/")).toEqual({ prefix: "/a/", basename: "b" });
  });
});

describe("basename", () => {
  it("returns the final segment via splitPath", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(basename("foo")).toBe("foo");
    expect(basename("/")).toBe("/");
  });
});

describe("homeDirectory", () => {
  it("returns undefined when no HOME/USERPROFILE env vars", () => {
    expect(homeDirectory()).toBeUndefined();
  });

  it("returns normalized HOME when set", () => {
    process.env.HOME = "/Users/someone";
    expect(homeDirectory()).toBe("/Users/someone");
  });

  it("normalizes trailing/duplicate slashes", () => {
    process.env.HOME = "/Users/someone//";
    expect(homeDirectory()).toBe("/Users/someone");
  });

  it("falls back to USERPROFILE", () => {
    process.env.USERPROFILE = "/Users/win";
    expect(homeDirectory()).toBe("/Users/win");
  });
});

describe("compactHomePath", () => {
  beforeEach(() => {
    process.env.HOME = "/Users/me";
  });

  it("returns ~ when path equals home", () => {
    expect(compactHomePath("/Users/me")).toBe("~");
  });

  it("replaces home prefix with ~/", () => {
    expect(compactHomePath("/Users/me/projects/x")).toBe("~/projects/x");
  });

  it("leaves unrelated paths untouched", () => {
    expect(compactHomePath("/var/log")).toBe("/var/log");
  });

  it("does not match partial segment", () => {
    expect(compactHomePath("/Users/mextra")).toBe("/Users/mextra");
  });

  it("returns path unchanged when home is unset", () => {
    delete process.env.HOME;
    expect(compactHomePath("/Users/me/x")).toBe("/Users/me/x");
  });
});

describe("toAbsolutePath", () => {
  beforeEach(() => {
    process.env.HOME = "/Users/me";
  });

  it("resolves ~ against HOME", () => {
    expect(toAbsolutePath("~/foo")).toBe("/Users/me/foo");
    expect(toAbsolutePath("~")).toBe("/Users/me");
  });

  it("passes absolute paths through normalizePath", () => {
    expect(toAbsolutePath("/a//b")).toBe("/a/b");
  });

  it("resolves relative paths against sessionDirectory when provided", () => {
    expect(toAbsolutePath("src/x.ts", "/proj/session")).toBe("/proj/session/src/x.ts");
  });

  it("normalizes relative paths alone when no sessionDirectory", () => {
    expect(toAbsolutePath("a/./b")).toBe("a/b");
  });

  it("falls back to normalizePath(~/foo) when ~ used but no HOME (preserves ~ segment)", () => {
    delete process.env.HOME;
    expect(toAbsolutePath("~/foo")).toBe("~/foo");
  });
});

describe("displayPath", () => {
  beforeEach(() => {
    process.env.HOME = "/Users/me";
  });

  it("returns the relative path when absolute is inside sessionDirectory", () => {
    expect(displayPath("/proj/session/src/x.ts", "/proj/session")).toBe("src/x.ts");
  });

  it("returns the basename when absolute equals sessionDirectory", () => {
    expect(displayPath("/proj/session", "/proj/session")).toBe("session");
  });

  it("compacts home prefix when outside sessionDirectory", () => {
    expect(displayPath("/Users/me/notes/x.md", "/proj/session")).toBe("~/notes/x.md");
  });

  it("compacts home when sessionDirectory is undefined", () => {
    expect(displayPath("/Users/me/notes/x.md")).toBe("~/notes/x.md");
  });

  it("returns absolute path when no sessionDirectory and outside home", () => {
    expect(displayPath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("resolves relative input against sessionDirectory before display logic", () => {
    expect(displayPath("src/x.ts", "/proj/session")).toBe("src/x.ts");
  });
});
