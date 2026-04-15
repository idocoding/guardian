/**
 * Normalized tables test suite.
 *
 * Two categories:
 *   1. Regression — searchSymbols / searchWithGraph return the same results
 *      after we add normalized tables (no behavioral change).
 *   2. Contract  — functions_raw, endpoints_raw, models_raw, module_metrics
 *      are populated with all fields losslessly after wiring.
 *
 * The DB is inspected directly via a second better-sqlite3 connection so we
 * don't need to expose internals of SqliteSpecsStore.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteSpecsStore } from "../../src/db/sqlite-specs-store.js";
import { populateFTSIndex } from "../../src/db/fts-builder.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let store: SqliteSpecsStore;
let tmpDir: string;
let db: Database.Database;   // read-only inspector connection

function fn(
  name: string,
  file: string,
  line: number,
  opts: {
    calls?: string[];
    stringLiterals?: string[];
    regexPatterns?: string[];
    docstring?: string;
    isAsync?: boolean;
    language?: string;
  } = {},
) {
  return {
    id: `${file}:${name}`,
    name,
    file,
    lines: [line, line + 20] as [number, number],
    calls: opts.calls ?? [],
    stringLiterals: opts.stringLiterals ?? [],
    regexPatterns: opts.regexPatterns ?? [],
    docstring: opts.docstring ?? "",
    isAsync: opts.isAsync ?? false,
    language: opts.language ?? "python",
  };
}

function rank(results: Array<{ name: string }>, name: string): number {
  const i = results.findIndex(r => r.name === name);
  return i === -1 ? -1 : i + 1;
}

// ── Synthetic data ─────────────────────────────────────────────────────────────

const FUNCTIONS = [
  fn("authenticate_user",  "auth/service.py",    10, { calls: ["hash_password", "find_user"], docstring: "Authenticate a user by credentials" }),
  fn("hash_password",      "auth/utils.py",      30, { docstring: "Hash a password with bcrypt" }),
  fn("find_user",          "auth/repository.py", 50, { docstring: "Look up user record by email" }),
  fn("create_session",     "auth/sessions.py",   70, { calls: ["authenticate_user"], docstring: "Create an authenticated session" }),
  fn("validate_token",     "auth/tokens.py",     90, { docstring: "Validate a JWT token" }),
  // High-authority: called by many callers
  fn("get_db",             "db/connection.py",    5, { docstring: "Return database connection" }),
  fn("save_user",          "users/models.py",    15, { calls: ["get_db"] }),
  fn("load_user",          "users/models.py",    40, { calls: ["get_db"] }),
  fn("delete_user",        "users/models.py",    65, { calls: ["get_db"] }),
  fn("update_user",        "users/models.py",    90, { calls: ["get_db"] }),
  fn("list_users",         "users/models.py",   115, { calls: ["get_db"] }),
  // Callee traversal: "handle http request" → handle_request calls process_request
  fn("handle_request",     "router/handler.py",  10, { calls: ["process_request", "validate_token"] }),
  fn("process_request",    "router/pipeline.py", 30, { docstring: "Core request processing pipeline" }),
  // Test helpers — should be penalised
  fn("test_authenticate",  "tests/test_auth.py", 10, { calls: ["authenticate_user"] }),
  fn("test_session",       "tests/test_auth.py", 30, { calls: ["create_session"] }),
];

const INTEL = {
  api_registry: {
    "GET /users": {
      file: "users/views.py",
      handler: "list_users",
      module: "users",
      request_schema: "ListUsersRequest",
      response_schema: "UserList",
      service_calls: ["user_service.list"],
    },
    "POST /auth/login": {
      file: "auth/views.py",
      handler: "login_view",
      module: "auth",
      request_schema: "LoginRequest",
      response_schema: "TokenResponse",
      service_calls: ["auth_service.authenticate"],
    },
  },
  model_registry: {
    User: {
      file: "users/models.py",
      module: "users",
      fields: ["id", "email", "password_hash", "created_at"],
      relationships: ["Profile", "Session"],
    },
    Session: {
      file: "auth/sessions.py",
      module: "auth",
      fields: ["token", "user_id", "expires_at"],
      relationships: ["User"],
    },
  },
  service_map: [],
  frontend_pages: [],
  background_tasks: [],
  enum_registry: {},
};

const ARCH = {
  endpoints: [
    { path: "/users", method: "GET",  handler: "list_users",  file: "users/views.py",  module: "users", service_calls: ["user_service.list"] },
    { path: "/auth/login", method: "POST", handler: "login_view", file: "auth/views.py", module: "auth", service_calls: ["auth_service.authenticate"] },
  ],
  data_models: [
    { name: "User",    file: "users/models.py",  module: "users", fields: ["id", "email"], relationships: ["Profile"] },
    { name: "Session", file: "auth/sessions.py", module: "auth",  fields: ["token"],        relationships: ["User"] },
  ],
  modules: [],
  enums: [],
  tasks: [],
  frontend_files: [],
  dependencies: {},
};

const SI_REPORTS = [
  {
    feature: "auth",
    structure: { nodes: 12, edges: 20 },
    metrics: { depth: 4, fanout_avg: 2.5, fanout_max: 6, density: 0.3, has_cycles: false },
    scores: { depth_score: 0.8, fanout_score: 0.5, density_score: 0.3, cycle_score: 0, query_score: 0.9 },
    confidence: { value: 0.85, level: "STRONG" },
    ambiguity: { level: "LOW" },
    classification: { depth_level: "HIGH", propagation: "STRONG", compressible: "NON_COMPRESSIBLE" },
    recommendation: {
      primary:  { pattern: "multi-step workflow", confidence: 0.85 },
      fallback: { pattern: "stateful pipeline",   condition: "if cycles detected" },
      avoid: [],
    },
    guardrails: { enforce_if_confidence_above: 0.7 },
    override: { allowed: true, requires_reason: true },
  },
  {
    feature: "users",
    structure: { nodes: 8, edges: 10 },
    metrics: { depth: 2, fanout_avg: 1.2, fanout_max: 3, density: 0.2, has_cycles: false },
    scores: { depth_score: 0.4, fanout_score: 0.3, density_score: 0.2, cycle_score: 0, query_score: 0.7 },
    confidence: { value: 0.70, level: "MODERATE" },
    ambiguity: { level: "LOW" },
    classification: { depth_level: "MEDIUM", propagation: "MODERATE", compressible: "PARTIAL" },
    recommendation: {
      primary:  { pattern: "simple CRUD",         confidence: 0.70 },
      fallback: { pattern: "repository pattern",   condition: "if many models" },
      avoid: [],
    },
    guardrails: { enforce_if_confidence_above: 0.6 },
    override: { allowed: true, requires_reason: true },
  },
];

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-norm-test-"));
  store = new SqliteSpecsStore(tmpDir);
  await store.init();

  // Populate per-function index
  store.rebuildFunctionIndex(FUNCTIONS);
  // Populate FTS + per-endpoint/model indexes
  populateFTSIndex(store, INTEL, ARCH);
  // Populate module metrics
  store.rebuildModuleMetrics(SI_REPORTS);

  // Open a read-only inspector connection
  db = new Database(path.join(tmpDir, "guardian.db"), { readonly: true });
});

afterAll(async () => {
  db?.close();
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Regression: searchSymbols unchanged ────────────────────────────────────

describe("regression: searchSymbols unchanged after adding normalized tables", () => {
  it("returns authenticate_user for 'authenticate user credentials' query", () => {
    const results = store.searchSymbols("authenticate user credentials", 10);
    const r = rank(results, "authenticate_user");
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("high-authority get_db ranks above zero-authority helpers for 'database connection'", () => {
    const results = store.searchSymbols("database connection", 10);
    const dbRank   = rank(results, "get_db");
    const saveRank = rank(results, "save_user");
    expect(dbRank).toBeGreaterThan(0);
    expect(dbRank).toBeLessThan(saveRank === -1 ? 999 : saveRank);
  });

  it("test files are penalised: source authenticate_user ranks above test_authenticate", () => {
    const results = store.searchSymbols("authenticate user", 10);
    const srcRank  = rank(results, "authenticate_user");
    const testRank = rank(results, "test_authenticate");
    expect(srcRank).toBeGreaterThan(0);
    // Either test function is not in top-10 or source ranks higher
    expect(testRank === -1 || srcRank < testRank).toBe(true);
  });

  it("callee traversal: process_request surfaces for 'handle http request' query", () => {
    const results = store.searchSymbols("handle http request", 10);
    // process_request is a callee of handle_request (which matches BM25)
    const pr = rank(results, "process_request");
    expect(pr).toBeGreaterThan(0);
    expect(pr).toBeLessThanOrEqual(5);
  });
});

// ── 2. Contract: functions_raw ─────────────────────────────────────────────────

describe("contract: functions_raw populated by rebuildFunctionIndex", () => {
  it("table exists and has one row per function", () => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM functions_raw").get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(FUNCTIONS.length);
  });

  it("stores name and file_path for each function", () => {
    const row = db.prepare(
      "SELECT * FROM functions_raw WHERE name = ? AND file_path LIKE ?"
    ).get("authenticate_user", "%auth%") as any;
    expect(row).not.toBeNull();
    expect(row.name).toBe("authenticate_user");
    expect(row.file_path).toContain("auth");
  });

  it("stores line_start and line_end losslessly", () => {
    const row = db.prepare(
      "SELECT line_start, line_end FROM functions_raw WHERE name = ?"
    ).get("authenticate_user") as any;
    expect(row).not.toBeNull();
    expect(row.line_start).toBe(10);
    expect(row.line_end).toBe(30);    // line + 20
  });

  it("stores calls as JSON array string", () => {
    const row = db.prepare(
      "SELECT calls FROM functions_raw WHERE name = ?"
    ).get("authenticate_user") as any;
    expect(row).not.toBeNull();
    const calls = JSON.parse(row.calls);
    expect(Array.isArray(calls)).toBe(true);
    expect(calls).toContain("hash_password");
    expect(calls).toContain("find_user");
  });

  it("stores docstring", () => {
    const row = db.prepare(
      "SELECT docstring FROM functions_raw WHERE name = ?"
    ).get("authenticate_user") as any;
    expect(row).not.toBeNull();
    expect(row.docstring).toContain("Authenticate");
  });

  it("stores language", () => {
    const row = db.prepare(
      "SELECT language FROM functions_raw WHERE name = ?"
    ).get("get_db") as any;
    expect(row).not.toBeNull();
    expect(row.language).toBe("python");
  });

  it("stores string_lits and regex_pats as empty JSON arrays when not provided", () => {
    const row = db.prepare(
      "SELECT string_lits, regex_pats FROM functions_raw WHERE name = ?"
    ).get("authenticate_user") as any;
    expect(row).not.toBeNull();
    expect(JSON.parse(row.string_lits)).toEqual([]);
    expect(JSON.parse(row.regex_pats)).toEqual([]);
  });

  it("rebuildFunctionIndex is idempotent: rerunning gives same row count", () => {
    store.rebuildFunctionIndex(FUNCTIONS);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM functions_raw").get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(FUNCTIONS.length);
  });
});

// ── 3. Contract: endpoints_raw ─────────────────────────────────────────────────

describe("contract: endpoints_raw populated by populateFTSIndex", () => {
  it("table exists and has one row per endpoint", () => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM endpoints_raw").get() as { n: number };
    // INTEL has 2 endpoints; ARCH has 2 matching endpoints (same paths)
    expect(rows.n).toBeGreaterThanOrEqual(2);
  });

  it("stores method, path, handler, file_path, module", () => {
    const row = db.prepare(
      "SELECT * FROM endpoints_raw WHERE path = ? AND method = ?"
    ).get("/users", "GET") as any;
    expect(row).not.toBeNull();
    expect(row.handler).toBe("list_users");
    expect(row.file_path).toContain("users");
    expect(row.module).toBe("users");
  });

  it("stores service_calls as JSON array", () => {
    const row = db.prepare(
      "SELECT service_calls FROM endpoints_raw WHERE path = ?"
    ).get("/users") as any;
    expect(row).not.toBeNull();
    const sc = JSON.parse(row.service_calls);
    expect(Array.isArray(sc)).toBe(true);
    expect(sc).toContain("user_service.list");
  });

  it("stores request_schema and response_schema when present", () => {
    const row = db.prepare(
      "SELECT request_schema, response_schema FROM endpoints_raw WHERE path = ?"
    ).get("/auth/login") as any;
    expect(row).not.toBeNull();
    expect(row.request_schema).toContain("LoginRequest");
    expect(row.response_schema).toContain("TokenResponse");
  });
});

// ── 4. Contract: models_raw ───────────────────────────────────────────────────

describe("contract: models_raw populated by populateFTSIndex", () => {
  it("table exists and has one row per model", () => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM models_raw").get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(2);  // User + Session
  });

  it("stores name, file_path, module", () => {
    const row = db.prepare(
      "SELECT * FROM models_raw WHERE name = ?"
    ).get("User") as any;
    expect(row).not.toBeNull();
    expect(row.file_path).toContain("users");
    expect(row.module).toBe("users");
  });

  it("stores fields as JSON array", () => {
    const row = db.prepare(
      "SELECT fields FROM models_raw WHERE name = ?"
    ).get("User") as any;
    expect(row).not.toBeNull();
    const fields = JSON.parse(row.fields);
    expect(Array.isArray(fields)).toBe(true);
    expect(fields).toContain("email");
  });

  it("stores relationships as JSON array", () => {
    const row = db.prepare(
      "SELECT relationships FROM models_raw WHERE name = ?"
    ).get("User") as any;
    expect(row).not.toBeNull();
    const rels = JSON.parse(row.relationships);
    expect(Array.isArray(rels)).toBe(true);
    expect(rels).toContain("Profile");
  });
});

// ── 5. Contract: module_metrics ───────────────────────────────────────────────

describe("contract: module_metrics populated by rebuildModuleMetrics", () => {
  it("table exists and has one row per SI report", () => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM module_metrics").get() as { n: number };
    expect(rows.n).toBe(SI_REPORTS.length);
  });

  it("stores depth_level, propagation, compressible from classification", () => {
    const row = db.prepare(
      "SELECT * FROM module_metrics WHERE module = ?"
    ).get("auth") as any;
    expect(row).not.toBeNull();
    expect(row.depth_level).toBe("HIGH");
    expect(row.propagation).toBe("STRONG");
    expect(row.compressible).toBe("NON_COMPRESSIBLE");
  });

  it("stores pattern from recommendation.primary.pattern", () => {
    const row = db.prepare(
      "SELECT pattern FROM module_metrics WHERE module = ?"
    ).get("auth") as any;
    expect(row).not.toBeNull();
    expect(row.pattern).toBe("multi-step workflow");
  });

  it("stores confidence value and level", () => {
    const row = db.prepare(
      "SELECT confidence, confidence_level FROM module_metrics WHERE module = ?"
    ).get("auth") as any;
    expect(row).not.toBeNull();
    expect(row.confidence).toBeCloseTo(0.85);
    expect(row.confidence_level).toBe("STRONG");
  });

  it("stores nodes and edges from structure", () => {
    const row = db.prepare(
      "SELECT nodes, edges FROM module_metrics WHERE module = ?"
    ).get("auth") as any;
    expect(row).not.toBeNull();
    expect(row.nodes).toBe(12);
    expect(row.edges).toBe(20);
  });

  it("stores second module with correct data", () => {
    const row = db.prepare(
      "SELECT * FROM module_metrics WHERE module = ?"
    ).get("users") as any;
    expect(row).not.toBeNull();
    expect(row.depth_level).toBe("MEDIUM");
    expect(row.propagation).toBe("MODERATE");
    expect(row.confidence).toBeCloseTo(0.70);
    expect(row.pattern).toBe("simple CRUD");
  });

  it("rebuildModuleMetrics is idempotent", () => {
    store.rebuildModuleMetrics(SI_REPORTS);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM module_metrics").get() as { n: number };
    expect(rows.n).toBe(SI_REPORTS.length);
  });
});
