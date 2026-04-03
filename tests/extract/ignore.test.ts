import { describe, it, expect } from "vitest";
import { createIgnoreMatcher } from "../../src/extract/ignore.js";
import type { SpecGuardConfig } from "../../src/config.js";

describe("createIgnoreMatcher", () => {
  const baseRoot = "/project";

  it("ignores dot-prefixed directories", () => {
    const config: SpecGuardConfig = {};
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredDir(".git", "/project/.git")).toBe(true);
    expect(matcher.isIgnoredDir(".next", "/project/.next")).toBe(true);
    expect(matcher.isIgnoredDir(".vscode", "/project/.vscode")).toBe(true);
  });

  it("does not ignore regular directories", () => {
    const config: SpecGuardConfig = {};
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredDir("src", "/project/src")).toBe(false);
    expect(matcher.isIgnoredDir("lib", "/project/lib")).toBe(false);
  });

  it("ignores configured directory names", () => {
    const config: SpecGuardConfig = {
      ignore: { directories: ["node_modules", "dist", "build"] },
    };
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredDir("node_modules", "/project/node_modules")).toBe(true);
    expect(matcher.isIgnoredDir("dist", "/project/dist")).toBe(true);
    expect(matcher.isIgnoredDir("build", "/project/build")).toBe(true);
  });

  it("ignores configured directory names at any depth", () => {
    const config: SpecGuardConfig = {
      ignore: { directories: ["__pycache__"] },
    };
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(
      matcher.isIgnoredDir("__pycache__", "/project/src/deep/__pycache__")
    ).toBe(true);
  });

  it("isIgnoredPath ignores files under ignored directories", () => {
    const config: SpecGuardConfig = {
      ignore: { directories: ["node_modules"] },
    };
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredPath("node_modules/express/index.js")).toBe(true);
    expect(matcher.isIgnoredPath("src/app.ts")).toBe(false);
  });

  it("isIgnoredPath supports explicit path ignoring", () => {
    const config: SpecGuardConfig = {
      ignore: {
        directories: [],
        paths: ["vendor/legacy"],
      },
    };
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredPath("vendor/legacy/old.js")).toBe(true);
    expect(matcher.isIgnoredPath("vendor/current/new.js")).toBe(false);
  });

  it("handles empty config gracefully", () => {
    const config: SpecGuardConfig = {};
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredPath("src/app.ts")).toBe(false);
    expect(matcher.isIgnoredPath("")).toBe(false);
  });

  it("normalizes relative paths with ./ prefix", () => {
    const config: SpecGuardConfig = {
      ignore: { directories: ["dist"] },
    };
    const matcher = createIgnoreMatcher(config, baseRoot);
    expect(matcher.isIgnoredPath("./dist/bundle.js")).toBe(true);
  });
});
