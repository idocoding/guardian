/**
 * Tests for path deduplication in populateFTSIndex.
 *
 * Captures two real issues found in toolbaux_guardian itself:
 *
 * 1. When backendRoot = "./src", the architecture snapshot stores some paths
 *    relative to backendRoot ("db/store.ts") and others relative to the
 *    workspace root ("src/db/store.ts"). populateFTSIndex must merge these
 *    into the longer workspace-relative path only.
 *
 * 2. The isSourceFile filter in fts-builder does not exclude benchmark or
 *    third-party repo directories by design — those must be excluded via
 *    guardian.config.json ignore.directories. This test documents that
 *    behaviour so any future change to NOISE_RE is intentional.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSpecsStore } from "../../src/db/sqlite-specs-store.js";
import { populateFTSIndex } from "../../src/db/fts-builder.js";

// ── Helpers ────────────────────────────────────────────────────────────────

let store: SqliteSpecsStore;
let tmpDir: string;

// Each test gets a fresh store so rebuilds don't bleed across tests.
beforeEach(async () => {
  if (store) await store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-dedup-test-"));
  store = new SqliteSpecsStore(tmpDir);
  await store.init();
});

afterAll(async () => {
  if (store) await store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Path deduplication ──────────────────────────────────────────────────

describe("populateFTSIndex — path deduplication", () => {
  it("merges backendRoot-relative path into workspace-relative path (no duplicate)", () => {
    // Simulates the real case: arch.modules stores "src/db/store.ts" (workspace-relative)
    // while arch.frontend_files stores "db/store.ts" (backendRoot-relative, missing "src/").
    const arch = {
      modules: [
        {
          id: "db",
          files: ["src/db/store.ts"],
          exports: [{ file: "src/db/store.ts", symbols: ["Store"] }],
        },
      ],
      frontend_files: [
        "db/store.ts",  // same file, relative to backendRoot instead of workspace root
      ],
    };

    populateFTSIndex(store, {}, arch);

    const paths = store.listIndexedFilePaths();
    const storeEntries = paths.filter(p => p.includes("db/store.ts"));

    // Must appear exactly once — as the longer workspace-relative "src/db/store.ts"
    expect(storeEntries).toHaveLength(1);
    expect(storeEntries[0]).toBe("src/db/store.ts");
  });

  it("merges multiple backendRoot-relative duplicates in one pass", () => {
    // Simulates: commands/init.ts + commands/search.ts from frontend_files
    // vs src/commands/init.ts + src/commands/search.ts from modules.
    const arch = {
      modules: [
        {
          id: "commands",
          files: ["src/commands/init.ts", "src/commands/search.ts"],
          exports: [],
        },
      ],
      frontend_files: [
        "commands/init.ts",    // shorter form of src/commands/init.ts
        "commands/search.ts",  // shorter form of src/commands/search.ts
      ],
    };

    populateFTSIndex(store, {}, arch);

    const paths = store.listIndexedFilePaths();
    const initEntries   = paths.filter(p => p.endsWith("commands/init.ts"));
    const searchEntries = paths.filter(p => p.endsWith("commands/search.ts"));

    expect(initEntries).toHaveLength(1);
    expect(initEntries[0]).toBe("src/commands/init.ts");

    expect(searchEntries).toHaveLength(1);
    expect(searchEntries[0]).toBe("src/commands/search.ts");
  });

  it("does not collapse paths that are genuinely different files", () => {
    // "src/cache.ts" and "db/cache.ts" share the "cache.ts" suffix but
    // "src/cache.ts" does NOT end with "/db/cache.ts", so both must survive.
    const arch = {
      modules: [
        { id: "src", files: ["src/cache.ts"], exports: [] },
        { id: "db",  files: ["db/cache.ts"],  exports: [] },
      ],
      frontend_files: [],
    };

    populateFTSIndex(store, {}, arch);

    const paths = store.listIndexedFilePaths();
    const cacheEntries = paths.filter(p => p.endsWith("cache.ts"));

    expect(cacheEntries).toHaveLength(2);
    expect(cacheEntries).toContain("src/cache.ts");
    expect(cacheEntries).toContain("db/cache.ts");
  });

  it("longer path wins even when shorter path has more tokens", () => {
    // The shorter path carries a unique symbol that should be merged into the longer path.
    const arch = {
      modules: [
        {
          id: "auth",
          files: ["src/auth/service.ts"],
          exports: [{ file: "src/auth/service.ts", symbols: ["AuthService"] }],
        },
      ],
      endpoints: [
        // endpoint stored with backendRoot-relative path
        { path: "/login", method: "POST", handler: "loginHandler", file: "auth/service.ts", module: "auth" },
      ],
      frontend_files: ["auth/service.ts"],
    };

    populateFTSIndex(store, {}, arch);

    const paths = store.listIndexedFilePaths();
    const authEntries = paths.filter(p => p.includes("auth/service.ts"));

    // Only workspace-relative path should exist
    expect(authEntries).toHaveLength(1);
    expect(authEntries[0]).toBe("src/auth/service.ts");
  });
});

// ── 2. NOISE_RE scope — what is and isn't filtered ─────────────────────────

describe("populateFTSIndex — source file filtering", () => {
  it("excludes node_modules, .git, vendor, __pycache__, venv paths", () => {
    const intel = {
      api_registry: {
        "GET /real": { file: "src/app.ts",                     handler: "realHandler",   module: "" },
        "GET /nm":   { file: "node_modules/express/index.js",  handler: "nmHandler",     module: "" },
        "GET /git":  { file: ".git/hooks/pre-commit",          handler: "gitHandler",    module: "" },
        "GET /vnd":  { file: "vendor/django/handlers.py",      handler: "vendorHandler", module: "" },
        "GET /venv": { file: ".venv/lib/requests/__init__.py", handler: "venvHandler",   module: "" },
        "GET /pyc":  { file: "src/__pycache__/app.cpython.pyc",handler: "pycHandler",   module: "" },
      },
    };

    populateFTSIndex(store, intel);

    const paths = store.listIndexedFilePaths();
    expect(paths).toContain("src/app.ts");
    expect(paths.some(p => p.includes("node_modules"))).toBe(false);
    expect(paths.some(p => p.includes(".git"))).toBe(false);
    expect(paths.some(p => p.includes("vendor"))).toBe(false);
    expect(paths.some(p => p.includes(".venv"))).toBe(false);
    expect(paths.some(p => p.includes("__pycache__"))).toBe(false);
  });

  it("does NOT auto-exclude benchmark or third-party repo directories", () => {
    // bench-repos/, thirdparty/ are NOT in NOISE_RE by design.
    // Exclusion must be configured via guardian.config.json ignore.directories.
    // This test documents the current behaviour so a future NOISE_RE change is intentional.
    // Note: paths like "external/lib/X" are normalized to "lib/X" by normPath (strips
    // leading segment before known source dir "lib/") — use flat structures to avoid this.
    const intel = {
      api_registry: {
        "GET /bench": { file: "bench-repos/django/views.py",  handler: "djangoView",   module: "" },
        "GET /third": { file: "thirdparty/somelib/helpers.py", handler: "thirdHelper",  module: "" },
      },
    };

    populateFTSIndex(store, intel);

    const paths = store.listIndexedFilePaths();
    // bench-repos and thirdparty ARE indexed — user must add them to ignore.directories
    expect(paths.some(p => p.startsWith("bench-repos/"))).toBe(true);
    expect(paths.some(p => p.startsWith("thirdparty/"))).toBe(true);
  });

  it("excludes test and spec files but indexes source files alongside them", () => {
    // NOISE_RE covers: test/, tests/, spec/, specs/, __pycache__/, node_modules/, vendor/, .git/, .tox/, .venv/, venv/
    // Note: __mocks__/ is NOT in NOISE_RE — mock files are indexed (they may contain real logic).
    const intel = {
      api_registry: {
        "GET /src":  { file: "src/handler.py",              handler: "handle",     module: "" },
        "GET /tst":  { file: "tests/test_handler.py",       handler: "testHandle", module: "" },
        "GET /spec": { file: "src/auth/spec/auth.test.ts",  handler: "authTest",   module: "" },
        "GET /tox":  { file: ".tox/py39/site-packages/pytest/config.py", handler: "toxHandler", module: "" },
      },
    };

    populateFTSIndex(store, intel);

    const paths = store.listIndexedFilePaths();
    expect(paths).toContain("src/handler.py");
    expect(paths.some(p => p.includes("test_handler"))).toBe(false);
    expect(paths.some(p => p.includes("auth.test.ts"))).toBe(false);
    expect(paths.some(p => p.includes(".tox"))).toBe(false);
  });

  it("non-source extensions are excluded", () => {
    const intel = {
      api_registry: {
        "GET /ts":   { file: "src/app.ts",        handler: "tsHandler",   module: "" },
        "GET /json": { file: "src/config.json",   handler: "jsonHandler", module: "" },
        "GET /md":   { file: "docs/README.md",    handler: "mdHandler",   module: "" },
        "GET /yml":  { file: ".github/ci.yml",    handler: "ymlHandler",  module: "" },
      },
    };

    populateFTSIndex(store, intel);

    const paths = store.listIndexedFilePaths();
    expect(paths).toContain("src/app.ts");
    expect(paths.some(p => p.endsWith(".json"))).toBe(false);
    expect(paths.some(p => p.endsWith(".md"))).toBe(false);
    expect(paths.some(p => p.endsWith(".yml"))).toBe(false);
  });
});
