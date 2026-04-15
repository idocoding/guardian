/**
 * Golden search tests — driven directly from benchmark task files.
 *
 * Tests guardian search quality WITHOUT any AI/LLM calls:
 *   searchWithGraph()  — file-level recall (GT file in top-N results)
 *   searchSymbols()    — symbol recall (GT function in top-N symbols)
 *   searchSymbols()    — location precision (GT line within ±5)
 *
 * Data sources:
 *   tests/benchmark/deep-tasks.jsonl         (50 tasks, all three GT levels)
 *   tests/benchmark/multi-codebase-tasks.jsonl (116 tasks, file + symbol GT)
 *
 * Tests auto-skip when the bench-repo guardian.db doesn't exist (CI without
 * pre-built repos passes cleanly). Run locally after:
 *   node dist/cli.js extract --backend sqlite --output bench-repos/<repo>/.specs bench-repos/<repo>
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SqliteSpecsStore } from "../../src/db/sqlite-specs-store.js";

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(import.meta.dirname, "../..");
const FILE_RECALL = 10;  // GT file must appear in top-N searchWithGraph results
const SYM_RECALL  = 30;  // GT symbol must appear in top-N searchSymbols results
const LINE_TOL    = 5;   // ±N lines for location precision

// ── Task types ────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  description?: string;
  query: string;
  ground_truth_files: string[];
  ground_truth_symbols?: string[];
  ground_truth_locations?: Array<{ file: string; name: string; line: number }>;
  specs_dir: string;
  level?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadTasks(relPath: string): Task[] {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, "utf8")
    .split("\n")
    .filter(l => l.trim() && !l.startsWith("//"))
    .map(l => {
      try { return JSON.parse(l) as Task; }
      catch { return null; }
    })
    .filter(Boolean) as Task[];
}

/** Normalise to bare repo-relative path for comparison. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** True if any result file matches the GT file (exact or suffix). */
function fileMatch(resultPaths: string[], gtFile: string): boolean {
  const n = norm(gtFile);
  return resultPaths.some(p => {
    const rn = norm(p);
    return rn === n || rn.endsWith("/" + n) || n.endsWith("/" + rn);
  });
}

/** True if any result symbol matches the GT symbol (case-insensitive). */
function symbolMatch(resultNames: string[], gtSymbol: string): boolean {
  const g = gtSymbol.toLowerCase().trim();
  return resultNames.some(n => {
    const rn = n.toLowerCase().trim();
    // exact, or method suffix: "SessionInterface.open_session" matches "open_session"
    return rn === g || rn.endsWith("." + g) || rn.endsWith("#" + g);
  });
}


// ── Store cache (one store per specs_dir across all tests) ────────────────────

const storeCache = new Map<string, SqliteSpecsStore | null>();

async function getStore(specsDir: string): Promise<SqliteSpecsStore | null> {
  if (storeCache.has(specsDir)) return storeCache.get(specsDir)!;
  const abs = path.resolve(ROOT, specsDir);
  const db  = path.join(abs, "guardian.db");
  if (!fs.existsSync(db)) { storeCache.set(specsDir, null); return null; }
  const store = new SqliteSpecsStore(abs);
  await store.init();
  storeCache.set(specsDir, store);
  return store;
}

// ── Load tasks ────────────────────────────────────────────────────────────────

// Golden set: deep-tasks only — carefully crafted navigation queries with
// verified file, symbol, and line-number ground truth. These are regression tests.
const deepTasks = loadTasks("tests/benchmark/deep-tasks.jsonl");

// Multi-codebase: file recall only, filtered to:
//   - bench-repos only (no local VSCode project paths that vary per machine)
//   - description-based tasks (drop git-hash commit-message tasks)
const multiTasks = loadTasks("tests/benchmark/multi-codebase-tasks.jsonl")
  .filter(t => t.specs_dir.startsWith("bench-repos/"))   // stable paths only
  .filter(t => !/-[0-9a-f]{7,}$/.test(t.id));            // drop git-hash tasks

// Group by specs_dir so each repo gets its own describe block.
function groupByRepo(tasks: Task[]) {
  const m = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!m.has(t.specs_dir)) m.set(t.specs_dir, []);
    m.get(t.specs_dir)!.push(t);
  }
  return m;
}

const deepByRepo  = groupByRepo(deepTasks);
const multiByRepo = groupByRepo(multiTasks);

// ── Helper: generate tests for one repo's task list ───────────────────────────

function makeRepoTests(
  specsDir: string,
  tasks: Task[],
  opts: { fileOnly?: boolean } = {},
) {
  const repoLabel = specsDir.split("/").slice(-2, -1)[0] ?? specsDir;
  const dbExists  = fs.existsSync(path.join(ROOT, specsDir, "guardian.db"));

  describe(`[${repoLabel}]`, () => {

    // ── File recall ────────────────────────────────────────────────────────
    describe("file recall", () => {
      for (const task of tasks) {
        it.skipIf(!dbExists)(
          `${task.id} — "${task.query.slice(0, 60)}"`,
          async () => {
            const store = await getStore(specsDir);
            if (!store) return;
            const results = store.searchWithGraph(task.query, FILE_RECALL);
            const paths   = results.map(r => r.file_path);
            const misses  = task.ground_truth_files.filter(
              (gt: string) => !fileMatch(paths, gt),
            );
            if (misses.length > 0) {
              console.log(`  [${task.id}] GT files not found:`, misses);
              console.log(`  Top results:`, paths.slice(0, 5));
            }
            const hits = task.ground_truth_files.length - misses.length;
            expect(hits).toBeGreaterThanOrEqual(
              Math.ceil(task.ground_truth_files.length / 2),
            );
          },
        );
      }
    });

    if (opts.fileOnly) return;

    // ── Symbol recall ──────────────────────────────────────────────────────
    describe("symbol recall", () => {
      for (const task of tasks.filter((t: Task) => t.ground_truth_symbols?.length)) {
        it.skipIf(!dbExists)(
          `${task.id} — expects: [${task.ground_truth_symbols!.join(", ")}]`,
          async () => {
            const store = await getStore(specsDir);
            if (!store) return;
            const results = store.searchSymbols(task.query, SYM_RECALL);
            const names   = results.map(r => r.name);
            const misses  = task.ground_truth_symbols!.filter(
              (gt: string) => !symbolMatch(names, gt),
            );
            if (misses.length > 0) {
              console.log(`  [${task.id}] GT symbols not found:`, misses);
              console.log(`  Top symbols:`, names.slice(0, 10));
            }
            expect(task.ground_truth_symbols!.length - misses.length).toBeGreaterThanOrEqual(1);
          },
        );
      }
    });

    // ── Location precision ─────────────────────────────────────────────────
    describe("location precision", () => {
      for (const task of tasks.filter((t: Task) => t.ground_truth_locations?.length)) {
        it.skipIf(!dbExists)(
          `${task.id} — ${task.ground_truth_locations!.map((l: { name: string; line: number }) => `${l.name}:${l.line}`).join(", ")}`,
          async () => {
            const store = await getStore(specsDir);
            if (!store) return;
            const results = store.searchSymbols(task.query, SYM_RECALL);
            let anyHit = false;
            for (const gt of task.ground_truth_locations! as Array<{ file: string; name: string; line: number }>) {
              if (results.find(r =>
                symbolMatch([r.name], gt.name) && Math.abs(r.line - gt.line) <= LINE_TOL,
              )) { anyHit = true; break; }
            }
            if (!anyHit) {
              const relevant = results.filter(r =>
                (task.ground_truth_locations as Array<{ name: string; line: number }>)
                  .some((gt) => symbolMatch([r.name], gt.name)),
              );
              console.log(`  [${task.id}] GT:`, task.ground_truth_locations);
              console.log(`  Found at:`, relevant.map(r => `${r.name}:${r.line}`));
            }
            expect(anyHit).toBe(true);
          },
        );
      }
    });

  });
}

// ── Golden set: deep-tasks (all three GT levels) ─────────────────────────────

describe("golden search — deep tasks (file + symbol + location)", () => {
  for (const [specsDir, tasks] of deepByRepo) {
    makeRepoTests(specsDir, tasks);
  }
});

// ── Multi-codebase: file recall only (description-based tasks) ───────────────

describe("multi-codebase search — file recall", () => {
  for (const [specsDir, tasks] of multiByRepo) {
    makeRepoTests(specsDir, tasks, { fileOnly: true });
  }
});
