/**
 * Guardian-Bench runner
 *
 * Processes a JSONL file of BenchmarkTask entries, computes all 4 metrics
 * for each task, and returns a BenchmarkSummary.
 *
 * Metrics are fully offline — no LLM API calls required.
 */

import fs from "node:fs/promises";
import { measureSearchRecall } from "./metrics/search-recall.js";
import { measureTokenEfficiency } from "./metrics/token-efficiency.js";
import { measureDriftScore } from "./metrics/drift-score.js";
import { measureContextCoverage } from "./metrics/context-coverage.js";
import type {
  BenchmarkTask,
  BenchmarkTaskResult,
  BenchmarkSummary,
  BenchmarkAggregate,
  TokenEfficiencyResult,
  DriftScoreResult,
} from "./types.js";

export type RunnerOptions = {
  tasksFile: string;
  /** Override specsDir for all tasks (useful for single-repo benchmarks) */
  specsDir?: string;
  /** Override repoDir for all tasks */
  repoDir?: string;
  /** k for precision/recall (default 5) */
  k?: number;
  /** Max parallel tasks (default 4) */
  concurrency?: number;
  /** Progress callback */
  onProgress?: (completed: number, total: number, result: BenchmarkTaskResult) => void;
};

export async function runBenchmark(options: RunnerOptions): Promise<BenchmarkSummary> {
  const { tasksFile, specsDir, repoDir, k = 5, concurrency = 4 } = options;

  // Load tasks from JSONL
  const raw = await fs.readFile(tasksFile, "utf8");
  const tasks: BenchmarkTask[] = raw
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("//"))
    .map(l => JSON.parse(l) as BenchmarkTask);

  const results: BenchmarkTaskResult[] = [];
  let completed = 0;

  // Process tasks with limited concurrency
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(task => runTask(task, { specsDir, repoDir, k }))
    );
    for (const r of batchResults) {
      results.push(r);
      completed++;
      options.onProgress?.(completed, tasks.length, r);
    }
  }

  const guardianVersion = await readPackageVersion();
  const summary = buildSummary(results, guardianVersion);
  return summary;
}

async function runTask(
  task: BenchmarkTask,
  opts: { specsDir?: string; repoDir?: string; k: number }
): Promise<BenchmarkTaskResult> {
  const start = Date.now();
  const specsDir = opts.specsDir ?? task.specs_dir ?? ".specs";
  const repoDir = opts.repoDir ?? task.repo_dir;

  try {
    const [searchRecall, tokenEfficiency, driftScore, contextCoverage] = await Promise.all([
      measureSearchRecall({
        specsDir,
        query: task.query,
        groundTruthFiles: task.ground_truth_files,
        groundTruthSymbols: task.ground_truth_symbols,
        k: opts.k,
      }),
      measureTokenEfficiency({
        specsDir,
        groundTruthFiles: task.ground_truth_files,
        repoDir,
      }),
      measureDriftScore({
        specsDir,
        patch: task.patch,
      }),
      measureContextCoverage({
        specsDir,
        groundTruthFiles: task.ground_truth_files,
        groundTruthSymbols: task.ground_truth_symbols,
      }),
    ]);

    return {
      task_id: task.id,
      repo: task.repo,
      language: task.language,
      source: task.source,
      specs_dir: specsDir,
      metrics: { search_recall: searchRecall, token_efficiency: tokenEfficiency, drift_score: driftScore, context_coverage: contextCoverage },
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const emptyEfficiency: TokenEfficiencyResult = {
      mcp_tokens: 0, raw_file_tokens: 0, efficiency_ratio: 0,
      tokens_saved: 0, raw_file_bytes: 0, mcp_response_bytes: 0,
    };
    const emptyDrift: DriftScoreResult = {
      baseline_delta: null, post_patch_delta: null, drift_increase: null,
      baseline_status: "error", post_patch_status: "error", patch_applied: false,
    };
    return {
      task_id: task.id,
      repo: task.repo,
      language: task.language,
      source: task.source,
      specs_dir: specsDir,
      metrics: {
        search_recall: { precision_at_k: 0, recall_at_k: 0, f1_at_k: 0, k: opts.k, files_found: [], files_missed: task.ground_truth_files, symbols_found: [], symbols_missed: task.ground_truth_symbols ?? [], result_files: [], result_symbols: [] },
        token_efficiency: emptyEfficiency,
        drift_score: emptyDrift,
        context_coverage: { coverage: 0, modules_mentioned: [], modules_missing: [], files_mentioned: 0, files_total: task.ground_truth_files.length },
      },
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSummary(results: BenchmarkTaskResult[], guardianVersion: string): BenchmarkSummary {
  const completed = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);

  const aggregate: BenchmarkAggregate = {
    search_recall: {
      mean_precision_at_5: mean(completed.map(r => r.metrics.search_recall.precision_at_k)),
      mean_recall_at_5: mean(completed.map(r => r.metrics.search_recall.recall_at_k)),
      mean_f1_at_5: mean(completed.map(r => r.metrics.search_recall.f1_at_k)),
      any_hit_rate: completed.length > 0
        ? completed.filter(r => r.metrics.search_recall.files_found.length > 0).length / completed.length
        : 0,
    },
    token_efficiency: {
      mean_efficiency_ratio: mean(completed.map(r => r.metrics.token_efficiency.efficiency_ratio)),
      median_efficiency_ratio: median(completed.map(r => r.metrics.token_efficiency.efficiency_ratio)),
      mean_tokens_saved: mean(completed.map(r => r.metrics.token_efficiency.tokens_saved)),
      total_tokens_saved: sum(completed.map(r => r.metrics.token_efficiency.tokens_saved)),
    },
    drift_score: {
      mean_drift_increase: mean(
        completed
          .map(r => r.metrics.drift_score.drift_increase)
          .filter((v): v is number => v !== null)
      ),
      tasks_with_stable_post_patch: completed.filter(
        r => r.metrics.drift_score.post_patch_status === "stable"
      ).length,
      tasks_with_patch: completed.filter(r => r.metrics.drift_score.patch_applied).length,
    },
    context_coverage: {
      mean_coverage: mean(completed.map(r => r.metrics.context_coverage.coverage)),
      full_coverage_rate: completed.length > 0
        ? completed.filter(r => r.metrics.context_coverage.coverage >= 1.0).length / completed.length
        : 0,
    },
  };

  return {
    generated_at: new Date().toISOString(),
    guardian_version: guardianVersion,
    total_tasks: results.length,
    completed_tasks: completed.length,
    failed_tasks: failed.length,
    aggregate,
    results,
  };
}

async function readPackageVersion(): Promise<string> {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url).pathname;
    const raw = await fs.readFile(pkgPath, "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return round(val);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
