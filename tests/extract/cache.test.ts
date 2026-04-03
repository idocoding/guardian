import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hashContent,
  loadBackendExtractionCache,
  saveBackendExtractionCache,
} from "../../src/extract/cache.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "cache");

async function scaffold() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
}
async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("hashContent", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = hashContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    expect(hashContent("test")).toBe(hashContent("test"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("loadBackendExtractionCache", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("returns empty cache when no file exists", async () => {
    const result = await loadBackendExtractionCache({
      projectRoot: FIXTURE_DIR,
      config: {},
    });
    expect(result.cache.files).toEqual({});
    expect(result.cache.version).toContain("specguard-backend-cache");
    expect(result.cachePath).toContain("file-hashes.json");
  });

  it("returns empty cache when version mismatches", async () => {
    const cachePath = path.join(FIXTURE_DIR, "specs-out", ".cache", "file-hashes.json");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: "old-version",
        configHash: "whatever",
        files: { "a.ts": { hash: "abc" } },
      })
    );

    const result = await loadBackendExtractionCache({
      projectRoot: FIXTURE_DIR,
      config: {},
    });
    expect(result.cache.files).toEqual({});
  });
});

describe("saveBackendExtractionCache + loadBackendExtractionCache round-trip", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("saves and loads cache correctly", async () => {
    const { cachePath, cache } = await loadBackendExtractionCache({
      projectRoot: FIXTURE_DIR,
      config: { docs: { mode: "full" } },
    });

    cache.files["test.ts"] = {
      hash: "abc123",
      mtime: Date.now(),
      language: "javascript",
      importUsages: [],
      exports: ["foo"],
      exportDetails: [],
      endpoints: [],
      dataModels: [],
      tasks: [],
      enums: [],
      constants: [],
      endpointModelUsage: [],
    } as any;

    await saveBackendExtractionCache(cachePath, cache);

    const reloaded = await loadBackendExtractionCache({
      projectRoot: FIXTURE_DIR,
      config: { docs: { mode: "full" } },
    });
    expect(reloaded.cache.files["test.ts"]).toBeDefined();
    expect(reloaded.cache.files["test.ts"].hash).toBe("abc123");
  });
});
