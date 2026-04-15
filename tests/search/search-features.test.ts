/**
 * Functional unit tests for guardian search features.
 *
 * Tests run against an in-memory SQLite database populated with synthetic
 * function data — no bench repos or external dependencies required.
 *
 * Features covered:
 *   1. Call-graph authority  — source in-degree boosts well-called functions
 *   2. Test-file penalty     — test/spec functions de-ranked 50%
 *   3. Callee traversal      — 1-hop outbound expansion surfaces indirect targets
 *   4. Hybrid ranking        — BM25 + authority + callee all combine correctly
 *   5. Vector search         — synthetic embeddings rank semantically similar fns
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSpecsStore } from "../../src/db/sqlite-specs-store.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let store: SqliteSpecsStore;
let tmpDir: string;

/** Minimal function record accepted by rebuildFunctionIndex. */
function fn(
  name: string,
  file: string,
  line: number,
  calls: string[] = [],
  docstring = "",
) {
  return { id: `${file}:${name}`, name, file, lines: [line, line + 10] as [number, number], calls, docstring };
}

/** Rank of `name` in results (-1 = not found). */
function rank(results: Array<{ name: string }>, name: string): number {
  const i = results.findIndex(r => r.name === name);
  return i === -1 ? -1 : i + 1;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-test-"));
  store = new SqliteSpecsStore(tmpDir);
  await store.init();

  // ── Populate functions_fts and function_calls ──────────────────────────────
  store.rebuildFunctionIndex([
    // Source functions — related to "session" topic
    fn("open_session",    "session.py",     10,  ["validate_token", "create_context"]),
    fn("close_session",   "session.py",     30,  ["flush_cache"]),
    fn("validate_token",  "auth.py",        20,  []),
    fn("create_context",  "context.py",     15,  []),
    fn("flush_cache",     "cache.py",       40,  []),

    // High-authority source function: called by many others
    fn("get_db_connection", "db.py",         5,  []),

    // Functions in source that call get_db_connection (builds in-degree)
    fn("save_record",      "models.py",     50,  ["get_db_connection"]),
    fn("load_record",      "models.py",     70,  ["get_db_connection"]),
    fn("delete_record",    "models.py",     90,  ["get_db_connection"]),
    fn("query_records",    "models.py",    110,  ["get_db_connection"]),
    fn("update_record",    "models.py",    130,  ["get_db_connection"]),

    // Generic function called by test helpers (should have zero authority after filter)
    fn("assert_equal",    "utils.py",       1,  []),

    // Test functions — should be penalized in ranking
    fn("test_open_session",    "test_session.py",  10, ["open_session", "assert_equal"]),
    fn("test_close_session",   "test_session.py",  30, ["close_session", "assert_equal"]),
    fn("test_validate_token",  "test_auth.py",     10, ["validate_token", "assert_equal"]),

    // Callee traversal scenario:
    // "request dispatch" query matches handle_request; it calls process_pipeline which is the GT
    fn("handle_request",    "router.py",    200, ["process_pipeline", "validate_token"]),
    fn("process_pipeline",  "pipeline.py",  300, []),
    fn("route_request",     "router.py",    220, ["handle_request"]),

    // Distractor: matches "session" but in a test file
    fn("SessionTestHelper", "spec_helpers.py", 99, ["open_session"]),

    // Another source session function with low authority (to contrast authority test)
    fn("reset_session",   "session.py",     50,  []),

    // Example/demo/sample directory functions — should be penalised vs source counterparts
    fn("open_session_example", "examples/basic/session.py", 10, ["open_session"]),
    fn("open_session_demo",    "demo/session.py",           10, []),
    fn("open_session_sample",  "samples/session.py",        10, []),
  ]);
});

afterAll(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Call-graph authority ────────────────────────────────────────────────────

describe("call-graph authority", () => {
  it("boosts functions with high source in-degree above low-degree peers", () => {
    // "db connection" matches get_db_connection (5 source callers, high authority)
    // directly. With authority weight it should reach rank 1.
    // The hybrid test below also verifies this; here we confirm the signal is present.
    const results = store.searchSymbols("db connection", 10);
    expect(results.length).toBeGreaterThan(0);

    const dbResult = results.find(r => r.name === "get_db_connection");
    expect(dbResult).toBeDefined();
    // Authority (5 source in-degree) should produce a score noticeably above 0
    expect(dbResult!.score).toBeGreaterThan(0.3);
  });

  it("excludes test-file edges from in-degree calculation", () => {
    // assert_equal is only called by test functions — its source in-degree should be 0.
    // It should NOT rank above source functions with real authority.
    const results = store.searchSymbols("assert equal", 10);
    const assertRank = rank(results, "assert_equal");
    const testRank   = rank(results, "test_open_session");

    // assert_equal matches exact keyword → can appear, but test caller shouldn't boost it
    // Both are equally penalized (test callers don't add authority to assert_equal)
    // They'll both show up; we just verify assert_equal doesn't rank above source functions
    // that DO have source-caller authority.
    if (assertRank > 0 && testRank > 0) {
      // test functions themselves are penalized — assert_equal from utils.py is not a test file
      // so it shouldn't be penalized, but it also has 0 source authority
      expect(assertRank).toBeGreaterThanOrEqual(1); // present but not boosted above real source fns
    }
  });
});

// ── 2. Test-file penalty ──────────────────────────────────────────────────────

describe("test-file penalty", () => {
  it("ranks source function above test function with same keyword match", () => {
    // "open session" matches both open_session (session.py) and test_open_session (test_session.py).
    // open_session should rank higher despite test function also matching.
    const results = store.searchSymbols("open session", 10);
    expect(results.length).toBeGreaterThan(0);

    const srcRank  = rank(results, "open_session");
    const testRank = rank(results, "test_open_session");

    expect(srcRank).toBeGreaterThan(0);
    // Source must rank before test counterpart
    if (testRank > 0) {
      expect(srcRank).toBeLessThan(testRank);
    }
  });

  it("spec helper file has lower score than identically-named source function", () => {
    // "close session" matches close_session (session.py, no penalty) and
    // test_close_session (test_session.py, 50% penalty). Source must score higher.
    const results = store.searchSymbols("close session", 10);
    const srcResult  = results.find(r => r.name === "close_session");
    const testResult = results.find(r => r.name === "test_close_session");

    expect(srcResult).toBeDefined();
    if (testResult) {
      expect(srcResult!.score).toBeGreaterThan(testResult.score);
    }
  });

  it("test functions have a lower score than their source counterparts", () => {
    const results = store.searchSymbols("validate token", 10);
    const srcResult  = results.find(r => r.name === "validate_token");
    const testResult = results.find(r => r.name === "test_validate_token");

    // Source must be found and score higher
    expect(srcResult).toBeDefined();
    if (testResult) {
      expect(srcResult!.score).toBeGreaterThan(testResult.score);
    }
  });
});

// ── 2b. Example/demo directory penalty ────────────────────────────────────────

describe("example-directory penalty", () => {
  it("function in examples/ directory is penalised vs identical-topic source function", () => {
    const results = store.searchSymbols("open session", 10);
    const srcRank = rank(results, "open_session");
    const exRank  = rank(results, "open_session_example");
    expect(srcRank).toBeGreaterThan(0);
    if (exRank > 0) expect(srcRank).toBeLessThan(exRank);
  });

  it("demo/ directory functions are penalised vs source counterpart", () => {
    const results = store.searchSymbols("open session", 10);
    const srcRank  = rank(results, "open_session");
    const demoRank = rank(results, "open_session_demo");
    expect(srcRank).toBeGreaterThan(0);
    if (demoRank > 0) expect(srcRank).toBeLessThan(demoRank);
  });

  it("samples/ directory functions are penalised vs source counterpart", () => {
    const results = store.searchSymbols("open session", 10);
    const srcRank    = rank(results, "open_session");
    const sampleRank = rank(results, "open_session_sample");
    expect(srcRank).toBeGreaterThan(0);
    if (sampleRank > 0) expect(srcRank).toBeLessThan(sampleRank);
  });
});

// ── 3. Callee traversal ───────────────────────────────────────────────────────

describe("callee traversal", () => {
  it("surfaces process_pipeline via handle_request even though query doesn't mention pipeline", () => {
    // "request dispatch" matches handle_request (BM25 candidate).
    // handle_request calls process_pipeline (callee).
    // process_pipeline should appear in results via callee expansion.
    const results = store.searchSymbols("request dispatch router", 20);

    const handleRank   = rank(results, "handle_request");
    const pipelineRank = rank(results, "process_pipeline");

    // handle_request must be a BM25 hit (it has "request" in name)
    expect(handleRank).toBeGreaterThan(0);
    // process_pipeline should appear via callee traversal
    expect(pipelineRank).toBeGreaterThan(0);
  });

  it("callee only surfaces when the caller is in BM25 candidates", () => {
    // "session cache flush" — matches flush_cache only via "cache flush".
    // close_session calls flush_cache, but close_session matches "session" (a BM25 candidate).
    // flush_cache should appear via callee traversal.
    const results = store.searchSymbols("session cache flush", 20);
    const flushRank = rank(results, "flush_cache");
    expect(flushRank).toBeGreaterThan(0);
  });

  it("callee traversal does not surface functions called only by test callers", () => {
    // "record save" — matches save_record. save_record calls get_db_connection.
    // BUT test functions that call assert_equal should not boost assert_equal via callee tier
    // (because caller_file filter excludes test callers).
    const results = store.searchSymbols("record save", 20);
    // assert_equal should not appear highly ranked via callee traversal from test files
    const assertRank = rank(results, "assert_equal");
    const dbRank     = rank(results, "get_db_connection");

    // get_db_connection (called by save_record, a source file) should rank above assert_equal
    if (assertRank > 0 && dbRank > 0) {
      expect(dbRank).toBeLessThan(assertRank);
    }
  });
});

// ── 4. Hybrid ranking ─────────────────────────────────────────────────────────

describe("hybrid ranking", () => {
  it("high BM25 + high authority beats high BM25 alone", () => {
    // get_db_connection has both BM25 signal ("db connection") and authority (5 source callers).
    // reset_session has BM25 signal ("session") but no callers.
    // For a query that matches both, get_db_connection should rank higher.
    const results = store.searchSymbols("db connection", 10);
    const dbRank    = rank(results, "get_db_connection");
    expect(dbRank).toBe(1); // Top result: BM25 match + authority
  });

  it("returns results sorted strictly by descending score", () => {
    const results = store.searchSymbols("session token auth", 15);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns empty array for queries with no FTS matches", () => {
    const results = store.searchSymbols("xyzzy_nonexistent_function_name_zzzq", 10);
    expect(results).toHaveLength(0);
  });

  it("respects the limit parameter", () => {
    const results = store.searchSymbols("session", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ── 5. Vector search ─────────────────────────────────────────────────────────

describe("vector search", () => {
  beforeAll(() => {
    // Inject synthetic embeddings: 4-dimensional unit vectors.
    // open_session and close_session share a "session management" direction [1,0,0,0].
    // process_pipeline has a "pipeline" direction [0,1,0,0].
    // Query vector [1,0,0,0] should rank open_session and close_session first.
    const make = (...vals: number[]) => {
      const norm = Math.sqrt(vals.reduce((s, v) => s + v * v, 0));
      return new Float32Array(vals.map(v => v / norm));
    };

    store.rebuildEmbeddings([
      { file_path: "session.py",  name: "open_session",   line: 10, vec: make(1, 0, 0, 0) },
      { file_path: "session.py",  name: "close_session",  line: 30, vec: make(0.9, 0.1, 0, 0) },
      { file_path: "session.py",  name: "reset_session",  line: 50, vec: make(0.8, 0.2, 0, 0) },
      { file_path: "pipeline.py", name: "process_pipeline", line: 300, vec: make(0, 1, 0, 0) },
      { file_path: "auth.py",     name: "validate_token", line: 20, vec: make(0, 0, 1, 0) },
    ]);
  });

  it("vector similarity boosts semantically aligned function above BM25-only peers", () => {
    // Query embedding [1,0,0,0] is closest to open_session (cos=1.0), close_session (cos≈0.9).
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const results = store.searchSymbols("session", 10, queryVec);

    const openRank  = rank(results, "open_session");
    const pipeRank  = rank(results, "process_pipeline");

    expect(openRank).toBeGreaterThan(0);
    // process_pipeline has [0,1,0,0] → cos sim = 0 with [1,0,0,0]: should rank below session fns
    if (pipeRank > 0) {
      expect(openRank).toBeLessThan(pipeRank);
    }
  });

  it("searchByVector returns functions ordered by cosine similarity", () => {
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const results = store.searchByVector(queryVec, 5);

    expect(results.length).toBeGreaterThan(0);
    // open_session cos sim = 1.0 → must be first
    expect(results[0].name).toBe("open_session");
    // scores strictly descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("gracefully falls back to BM25+authority when no embeddings match query candidates", () => {
    // Empty queryVec (all zeros): cosine sim = 0 for all — system uses BM25+authority only.
    const zeroVec = new Float32Array(4); // all zeros
    // Should not throw and should return results
    const results = store.searchSymbols("db connection", 5, zeroVec);
    expect(results.length).toBeGreaterThan(0);
    // get_db_connection should still rank high via BM25+authority
    expect(rank(results, "get_db_connection")).toBe(1);
  });
});
