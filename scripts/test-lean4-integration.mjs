/**
 * Integration test: run adapters against real project files.
 * Covers Lean4 (ast-lean) + C#/Go/Java (fixtures-specguard).
 * Usage: node scripts/test-lean4-integration.mjs
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const { runAdapter, ADAPTERS, getAdapterForFile } = await import(`${ROOT}/dist/adapters/index.js`);
const { buildFunctionIntelligence } = await import(`${ROOT}/dist/extract/function-intel.js`);

// ── File walker ────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "bin", "obj", ".venv", "__pycache__", "build"]);

async function walkSourceFiles(dir) {
  const results = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) results.push(...await walkSourceFiles(full));
    } else if (entry.isFile() && getAdapterForFile(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Project runner ─────────────────────────────────────────────────────────

async function runProject(label, projectDir) {
  if (!existsSync(projectDir)) {
    console.log(`\nSKIP ${label} — directory not found: ${projectDir}`);
    return null;
  }

  const files = await walkSourceFiles(projectDir);
  if (files.length === 0) {
    console.log(`\nSKIP ${label} — no source files found`);
    return null;
  }

  const allFunctions = [];
  const allEndpoints = [];
  const allModels = [];
  const errors = [];
  const byLang = {};
  const kindCounts = {};
  let totalSorry = 0;

  for (const filePath of files) {
    const adapter = getAdapterForFile(path.basename(filePath));
    if (!adapter) continue;
    let source;
    try { source = await readFile(filePath, "utf8"); } catch { continue; }
    let result;
    try {
      result = runAdapter(adapter, filePath, source);
    } catch (err) {
      errors.push(`${path.relative(projectDir, filePath)}: ${err.message}`);
      continue;
    }
    allFunctions.push(...(result.functions ?? []));
    allEndpoints.push(...result.endpoints);
    allModels.push(...result.models);

    const lang = adapter.name;
    if (!byLang[lang]) byLang[lang] = { files: 0, functions: 0, endpoints: 0, models: 0 };
    byLang[lang].files++;
    byLang[lang].functions += (result.functions ?? []).length;
    byLang[lang].endpoints += result.endpoints.length;
    byLang[lang].models += result.models.length;

    for (const fn of (result.functions ?? [])) {
      kindCounts[fn.kind ?? "unknown"] = (kindCounts[fn.kind ?? "unknown"] ?? 0) + 1;
      if (fn.hasSorry) totalSorry++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`PROJECT: ${label}`);
  console.log(`  Source files : ${files.length}`);
  console.log(`  Endpoints    : ${allEndpoints.length}`);
  console.log(`  Models       : ${allModels.length}`);
  console.log(`  Functions    : ${allFunctions.length}`);
  if (totalSorry > 0) console.log(`  Sorry        : ${totalSorry}`);
  if (errors.length > 0) console.log(`  Parse errors : ${errors.length}`);

  // Per-language breakdown
  for (const [lang, stats] of Object.entries(byLang)) {
    console.log(`  [${lang}] files=${stats.files} fns=${stats.functions} eps=${stats.endpoints} models=${stats.models}`);
  }

  // Function kind breakdown (non-trivial kinds only)
  const kindStr = Object.entries(kindCounts).map(([k, v]) => `${k}:${v}`).join(", ");
  if (kindStr) console.log(`  Kinds        : ${kindStr}`);

  // Sample endpoints
  if (allEndpoints.length > 0) {
    console.log(`  Sample endpoints:`);
    for (const ep of allEndpoints.slice(0, 5)) {
      console.log(`    ${ep.method.padEnd(7)} ${ep.path.padEnd(40)} → ${ep.handler}`);
    }
    if (allEndpoints.length > 5) console.log(`    … +${allEndpoints.length - 5} more`);
  }

  // Sample models
  if (allModels.length > 0) {
    console.log(`  Sample models:`);
    for (const m of allModels.slice(0, 5)) {
      console.log(`    ${(m.framework ?? "").padEnd(15)} ${m.name}`);
    }
    if (allModels.length > 5) console.log(`    … +${allModels.length - 5} more`);
  }

  // Sample functions
  if (allFunctions.length > 0) {
    console.log(`  Sample functions:`);
    for (const fn of allFunctions.slice(0, 5)) {
      const async_ = fn.isAsync ? "async " : "";
      console.log(`    L${String(fn.lines[0]).padStart(5)} ${async_}${fn.name} (${path.relative(projectDir, fn.file)})`);
    }
    if (allFunctions.length > 5) console.log(`    … +${allFunctions.length - 5} more`);
  }

  // Parse errors
  if (errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of errors.slice(0, 3)) console.log(`    ✗ ${e}`);
  }

  // Function intelligence
  if (allFunctions.length > 0) {
    let intel;
    try {
      intel = buildFunctionIntelligence(allFunctions);
    } catch (err) {
      console.log(`  ✗ buildFunctionIntelligence crashed: ${err.message}`);
      return { allFunctions, allEndpoints, allModels, errors };
    }
    const indexKeys = Object.keys(intel.literal_index);
    const callGraphSize = Object.keys(intel.call_graph).length;
    console.log(`  Literal index: ${indexKeys.length} keys`);
    console.log(`  Call graph   : ${callGraphSize} nodes`);

    // Show most-connected functions
    const topCalled = Object.entries(intel.call_graph)
      .filter(([, v]) => v.called_by.length > 0)
      .sort(([, a], [, b]) => b.called_by.length - a.called_by.length)
      .slice(0, 3);
    if (topCalled.length > 0) {
      console.log(`  Most called  :`);
      for (const [name, entry] of topCalled) {
        console.log(`    ${name} ← called by ${entry.called_by.length} function(s)`);
      }
    }
  }

  return { allFunctions, allEndpoints, allModels, errors };
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log(`Guardian function-intel integration test`);
console.log(`Adapters registered: ${ADAPTERS.map(a => a.name).join(", ")}\n`);

const results = await Promise.all([
  // Lean4
  runProject("ast-lean (Lean4 / Mathlib)", "/Users/harishkumar/KagazKala/VSCode/ast-lean"),
  // Fixture projects
  runProject("csharp-realworld (C# ASP.NET Core)", "/Users/harishkumar/KagazKala/VSCode/fixtures-specguard/csharp-realworld"),
  runProject("go-realworld (Go Gin)", "/Users/harishkumar/KagazKala/VSCode/fixtures-specguard/go-realworld"),
  runProject("java-realworld (Java Spring Boot)", "/Users/harishkumar/KagazKala/VSCode/fixtures-specguard/java-realworld"),
]);

// ── Cross-project summary ──────────────────────────────────────────────────

const valid = results.filter(Boolean);
const totalFns  = valid.reduce((s, r) => s + r.allFunctions.length, 0);
const totalEps  = valid.reduce((s, r) => s + r.allEndpoints.length, 0);
const totalMods = valid.reduce((s, r) => s + r.allModels.length, 0);
const totalErrs = valid.reduce((s, r) => s + r.errors.length, 0);

console.log(`\n${"═".repeat(60)}`);
console.log(`CROSS-PROJECT TOTALS`);
console.log(`  Projects : ${valid.length}`);
console.log(`  Endpoints: ${totalEps}`);
console.log(`  Models   : ${totalMods}`);
console.log(`  Functions: ${totalFns}`);
console.log(`  Errors   : ${totalErrs}`);

if (totalErrs > 0) {
  console.log(`\n⚠  ${totalErrs} parse error(s) — see per-project output above`);
} else {
  console.log(`\n✓ Integration test complete — no crashes, no parse errors.`);
}
