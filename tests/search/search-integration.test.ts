/**
 * Integration tests: verify guardian search returns expected files.
 *
 * These tests require guardian.db to be pre-built:
 *   npm run build && bash scripts/build-all-guardian-dbs.sh
 *
 * Each test is skipped automatically if guardian.db doesn't exist,
 * so CI without pre-built DBs passes cleanly.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SqliteSpecsStore } from "../../src/db/sqlite-specs-store.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BENCH = path.join(ROOT, "bench-repos");
const FIXTURES = path.resolve(ROOT, "../VSCode/fixtures-specguard");

function dbPath(specsDir: string) {
  return path.join(specsDir, "guardian.db");
}

/** Open store, run test fn, close. Skip if guardian.db doesn't exist. */
function searchTest(
  label: string,
  specsDir: string,
  query: string,
  expectedPattern: RegExp,
  topN = 5,
) {
  const db = dbPath(specsDir);
  const exists = fs.existsSync(db);
  it.skipIf(!exists)(`[${label}] "${query}" → /${expectedPattern.source}/`, async () => {
    const store = new SqliteSpecsStore(specsDir);
    await store.init();
    try {
      const results = store.searchWithGraph(query, topN);
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map(r => r.file_path);
      const matched = paths.some(p => expectedPattern.test(p));
      if (!matched) {
        console.log(`  Top results for "${query}":`, paths);
      }
      expect(matched).toBe(true);
    } finally {
      await store.close();
    }
  });
}

// ── flask (pallets) ──────────────────────────────────────────────────────────
// Flask is a framework library — no "login/auth" built in. Test framework concepts.
describe("flask", () => {
  const specs = path.join(BENCH, "flask-full/.specs");
  searchTest("flask", specs, "teardown context",      /ctx|app|context/i);
  searchTest("flask", specs, "session cookie",        /session|cookie/i);
  searchTest("flask", specs, "view dispatch request", /views|scaffold|blueprint/i);
  searchTest("flask", specs, "error logging debug",   /log|debug|ctx/i);
  searchTest("flask", specs, "blueprint scaffold",    /blueprint|scaffold/i);
});

// ── fastapi ──────────────────────────────────────────────────────────────────
describe("fastapi", () => {
  const specs = path.join(BENCH, "fastapi/.specs");
  searchTest("fastapi", specs, "background task",         /background/i);
  searchTest("fastapi", specs, "dependency injection",    /depend/i);
  searchTest("fastapi", specs, "websocket connection",    /websocket/i);
  searchTest("fastapi", specs, "security oauth2",         /security|oauth/i);
  searchTest("fastapi", specs, "request validation",      /router|validation|request/i);
});

// ── fastify ──────────────────────────────────────────────────────────────────
describe("fastify", () => {
  const specs = path.join(BENCH, "fastify/.specs");
  searchTest("fastify", specs, "content type parser",     /content.type|parser/i);
  searchTest("fastify", specs, "error handling",          /error/i);
  searchTest("fastify", specs, "http2 server",            /http2|server/i);
  searchTest("fastify", specs, "logger",                  /log/i);
  searchTest("fastify", specs, "route handler",           /route|plugin/i);
});

// ── express ──────────────────────────────────────────────────────────────────
// Express examples/ are filtered (noise). Test core lib files.
describe("express", () => {
  const specs = path.join(BENCH, "express/.specs");
  searchTest("express", specs, "application router",      /application|express/i);
  searchTest("express", specs, "request response send",   /request|response/i);
  searchTest("express", specs, "view render",             /view|utils/i);
});

// ── gin ───────────────────────────────────────────────────────────────────────
describe("gin", () => {
  const specs = path.join(BENCH, "gin/.specs");
  searchTest("gin", specs, "context render",              /context|render/i);
  searchTest("gin", specs, "pdf renderer",                /pdf|render/i);
  searchTest("gin", specs, "middleware abort",            /middleware|abort/i);
  searchTest("gin", specs, "router group",                /router|engine/i);
});

// ── nestjs ────────────────────────────────────────────────────────────────────
describe("nestjs", () => {
  const specs = path.join(BENCH, "nestjs/.specs");
  searchTest("nestjs", specs, "nest factory module",      /nest.factory|factory/i);
  searchTest("nestjs", specs, "module entry export",      /module|index/i);
});

// ── django ────────────────────────────────────────────────────────────────────
describe("django", () => {
  const specs = path.join(BENCH, "django/.specs");
  searchTest("django", specs, "query expression",         /expression|query/i);
  searchTest("django", specs, "database schema",          /schema|backend|migration/i);
  searchTest("django", specs, "prefetch queryset",        /prefetch|query/i);
  searchTest("django", specs, "staticfiles storage",      /static|storage/i);
  searchTest("django", specs, "mail message",             /mail|message/i);
});

// ── drf (encode) ──────────────────────────────────────────────────────────────
describe("drf", () => {
  const specs = path.join(BENCH, "drf/.specs");
  searchTest("drf", specs, "serializer field",            /serializer|field/i);
  searchTest("drf", specs, "auth token model",            /auth|token/i);
  searchTest("drf", specs, "schema inspector field map",  /schema|inspect|field/i);
});

// ── sqlalchemy ────────────────────────────────────────────────────────────────
describe("sqlalchemy", () => {
  const specs = path.join(BENCH, "sqlalchemy/.specs");
  searchTest("sqlalchemy", specs, "hybrid property",      /hybrid/i);
  searchTest("sqlalchemy", specs, "mutable tracking",     /mutable/i);
  searchTest("sqlalchemy", specs, "sql compiler",         /compiler/i);
  searchTest("sqlalchemy", specs, "generic association",  /association|generic/i);
});

// ── spring petclinic ──────────────────────────────────────────────────────────
describe("spring-petclinic", () => {
  const specs = path.join(BENCH, "spring-petclinic/.specs");
  searchTest("spring", specs, "pet controller owner",     /pet|owner|controller/i);
  searchTest("spring", specs, "named entity",             /named|entity/i);
  searchTest("spring", specs, "visit appointment",        /visit|appointment/i);
});

// ── go-realworld ──────────────────────────────────────────────────────────────
describe("go-realworld", () => {
  const specs = path.join(FIXTURES, "go-realworld/.specs");
  searchTest("go-realworld", specs, "article router",     /articles/i);
  searchTest("go-realworld", specs, "user auth middleware", /users|middleware/i);
  searchTest("go-realworld", specs, "validator",          /validator/i);
});

// ── csharp-realworld ──────────────────────────────────────────────────────────
describe("csharp-realworld", () => {
  const specs = path.join(FIXTURES, "csharp-realworld/.specs");
  searchTest("csharp", specs, "article create edit",      /Article/i);
  searchTest("csharp", specs, "user login register",      /User|Login/i);
});

// ── java-realworld ────────────────────────────────────────────────────────────
describe("java-realworld", () => {
  const specs = path.join(FIXTURES, "java-realworld/.specs");
  searchTest("java", specs, "article api favorite",       /Article/i);
  searchTest("java", specs, "user jwt service",           /User|Jwt|user/i);
});
