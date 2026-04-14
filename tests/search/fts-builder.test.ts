/**
 * Unit tests for the FTS index builder.
 *
 * Tests buildFTSRows(), mergeArchitectureRows(), mergeFunctionIntelRows()
 * with synthetic fixtures so they run without any external files.
 */

import { describe, it, expect } from "vitest";
import { buildFTSRows, mergeArchitectureRows, mergeFunctionIntelRows, buildDepEdges } from "../../src/db/fts-builder.js";

// ── buildFTSRows ───────────────────────────────────────────────────────────

describe("buildFTSRows", () => {
  it("indexes api_registry endpoints and handlers", () => {
    const intel = {
      api_registry: {
        "POST /users/login": {
          method: "POST",
          path: "/users/login",
          handler: "login_user",
          file: "src/users/views.py",
          module: "users",
          service_calls: ["UserService.authenticate"],
        },
      },
    };
    const rows = buildFTSRows(intel);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.file_path).toBe("src/users/views.py");
    expect(row.endpoint).toContain("POST /users/login");
    expect(row.symbol_name).toContain("login_user");
    expect(row.body).toContain("UserService.authenticate");
    expect(row.module).toBe("users");
  });

  it("indexes model_registry fields and relationships", () => {
    const intel = {
      model_registry: {
        Article: {
          file: "src/articles/models.py",
          module: "articles",
          fields: ["title", "body", "author_id"],
          relationships: ["User"],
        },
      },
    };
    const rows = buildFTSRows(intel);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.symbol_name).toContain("Article");
    expect(row.body).toContain("title");
    expect(row.body).toContain("User");
  });

  it("skips test and fixture files", () => {
    const intel = {
      api_registry: {
        "GET /health": {
          file: "tests/test_health.py",  // leading tests/ — should be filtered
          module: "",
          handler: "test_health",
        },
        "GET /unit": {
          file: "src/users/tests/test_views.py",  // /tests/ in path — filtered
          module: "",
          handler: "test_view",
        },
        "GET /real": {
          file: "src/health.py",
          module: "",
          handler: "health_check",
        },
      },
    };
    const rows = buildFTSRows(intel);
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe("src/health.py");
  });

  it("deduplicates paths with repo-name prefix", () => {
    // Both refer to the same file — one with repo-prefix, one without
    const intel = {
      api_registry: {
        "GET /auth": {
          file: "flask-full/src/auth/routes.py",
          module: "auth",
          handler: "login",
        },
      },
      model_registry: {
        User: {
          file: "src/auth/routes.py",
          module: "auth",
          fields: ["email"],
        },
      },
    };
    const rows = buildFTSRows(intel);
    // Both normalize to src/auth/routes.py — only one row
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol_name).toContain("login");
    expect(rows[0].symbol_name).toContain("User");
  });
});

// ── mergeArchitectureRows ──────────────────────────────────────────────────

describe("mergeArchitectureRows", () => {
  it("merges endpoints from arch snapshot", () => {
    const rows = new Map();
    const arch = {
      endpoints: [
        {
          path: "/articles",
          method: "GET",
          handler: "list_articles",
          file: "src/articles/views.py",
          module: "articles",
          service_calls: ["ArticleService.list"],
        },
      ],
    };
    mergeArchitectureRows(rows, arch);
    expect(rows.size).toBe(1);
    const row = rows.get("src/articles/views.py")!;
    expect(row.endpoint).toContain("/articles");
    expect(row.symbol_name).toContain("list_articles");
    expect(row.body).toContain("ArticleService.list");
  });

  it("merges module exports as symbol_name (object format)", () => {
    const rows = new Map();
    const arch = {
      modules: [
        {
          id: "users",
          files: ["src/users/service.ts"],
          exports: [
            { file: "src/users/service.ts", symbols: ["UserService", "createUser"] },
          ],
        },
      ],
    };
    mergeArchitectureRows(rows, arch);
    const row = rows.get("src/users/service.ts")!;
    expect(row).toBeDefined();
    expect(row.symbol_name).toContain("UserService");
    expect(row.symbol_name).toContain("createUser");
  });

  it("handles module exports as string format (legacy)", () => {
    const rows = new Map();
    const arch = {
      modules: [
        {
          id: "utils",
          files: [],
          exports: ["src/utils/helpers.ts"],
        },
      ],
    };
    mergeArchitectureRows(rows, arch);
    const row = rows.get("src/utils/helpers.ts")!;
    expect(row).toBeDefined();
  });
});

// ── mergeFunctionIntelRows ─────────────────────────────────────────────────

describe("mergeFunctionIntelRows", () => {
  it("adds function names and docstrings to body", () => {
    const rows = new Map();
    const funcIntel = {
      functions: [
        {
          name: "authenticate_user",
          file: "src/auth/service.py",
          docstring: "Validates credentials and returns JWT token",
          params: ["email", "password"],
          calls: ["jwt.encode", "bcrypt.checkpw"],
        },
      ],
    };
    mergeFunctionIntelRows(rows, funcIntel);
    const row = rows.get("src/auth/service.py")!;
    expect(row).toBeDefined();
    expect(row.symbol_name).toContain("authenticate_user");
    expect(row.body).toContain("Validates credentials and returns JWT token");
    expect(row.body).toContain("jwt.encode");
    expect(row.body).toContain("email");
  });

  it("creates new rows for files not yet in map", () => {
    const rows = new Map();
    mergeFunctionIntelRows(rows, {
      functions: [{ name: "foo", file: "src/foo.py", params: [], calls: [] }],
    });
    expect(rows.size).toBe(1);
  });
});

// ── buildDepEdges ──────────────────────────────────────────────────────────

describe("buildDepEdges", () => {
  it("handles array format {from, to}", () => {
    const arch = {
      dependencies: {
        file_graph: [
          { from: "src/users/views.py", to: "src/users/models.py" },
          { from: "src/users/views.py", to: "src/auth/service.py" },
        ],
      },
    };
    const edges = buildDepEdges(arch);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ file: "src/users/views.py", imports: "src/users/models.py" });
  });

  it("handles dict format {file: {imports: []}}", () => {
    const arch = {
      dependencies: {
        file_graph: {
          "src/articles/views.py": { imports: ["src/articles/models.py", "src/auth/service.py"] },
        },
      },
    };
    const edges = buildDepEdges(arch);
    expect(edges).toHaveLength(2);
  });

  it("skips non-source files", () => {
    const arch = {
      dependencies: {
        file_graph: [
          { from: "src/app.py", to: "tests/test_app.py" }, // leading tests/ — skipped
          { from: "src/app.py", to: "src/tests/test_models.py" }, // /tests/ mid-path — skipped
          { from: "src/app.py", to: "src/models.py" },
        ],
      },
    };
    const edges = buildDepEdges(arch);
    expect(edges).toHaveLength(1);
    expect(edges[0].imports).toBe("src/models.py");
  });

  it("returns empty array when no file_graph", () => {
    expect(buildDepEdges({})).toEqual([]);
    expect(buildDepEdges({ dependencies: {} })).toEqual([]);
  });
});
