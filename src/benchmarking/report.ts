/**
 * Guardian-Bench report formatter
 *
 * Renders BenchmarkSummary into human-readable text and JSON outputs.
 * Designed for arXiv paper table extraction.
 */

import type { BenchmarkSummary, BenchmarkTaskResult } from "./types.js";

export type ReportFormat = "text" | "json" | "markdown";

export function renderReport(summary: BenchmarkSummary, format: ReportFormat = "text"): string {
  if (format === "json") return JSON.stringify(summary, null, 2);
  if (format === "markdown") return renderMarkdown(summary);
  return renderText(summary);
}

// ── Text ──────────────────────────────────────────────────────────────────────

function renderText(summary: BenchmarkSummary): string {
  const { aggregate: agg, total_tasks, completed_tasks, failed_tasks } = summary;
  const lines: string[] = [];

  lines.push("Guardian-Bench Results");
  lines.push("=".repeat(60));
  lines.push(`Guardian version : ${summary.guardian_version}`);
  lines.push(`Generated        : ${summary.generated_at}`);
  lines.push(`Tasks            : ${completed_tasks}/${total_tasks} completed, ${failed_tasks} failed`);
  lines.push("");

  lines.push("Search Recall (k=5)");
  lines.push("-".repeat(40));
  lines.push(`  Mean precision@5  : ${pct(agg.search_recall.mean_precision_at_5)}`);
  lines.push(`  Mean recall@5     : ${pct(agg.search_recall.mean_recall_at_5)}`);
  lines.push(`  Mean F1@5         : ${pct(agg.search_recall.mean_f1_at_5)}`);
  lines.push(`  Any-hit rate      : ${pct(agg.search_recall.any_hit_rate)}`);
  lines.push("");

  lines.push("Token Efficiency");
  lines.push("-".repeat(40));
  lines.push(`  Mean ratio        : ${agg.token_efficiency.mean_efficiency_ratio.toFixed(3)}`);
  lines.push(`  Median ratio      : ${agg.token_efficiency.median_efficiency_ratio.toFixed(3)}`);
  lines.push(`  Mean tokens saved : ${agg.token_efficiency.mean_tokens_saved.toLocaleString()}`);
  lines.push(`  Total tokens saved: ${agg.token_efficiency.total_tokens_saved.toLocaleString()}`);
  lines.push("");

  lines.push("Drift Score");
  lines.push("-".repeat(40));
  lines.push(`  Mean drift increase    : ${agg.drift_score.mean_drift_increase.toFixed(3)}`);
  lines.push(`  Tasks with patch       : ${agg.drift_score.tasks_with_patch}`);
  lines.push(`  Stable post-patch      : ${agg.drift_score.tasks_with_stable_post_patch}`);
  lines.push("");

  lines.push("Context Coverage");
  lines.push("-".repeat(40));
  lines.push(`  Mean coverage     : ${pct(agg.context_coverage.mean_coverage)}`);
  lines.push(`  Full coverage rate: ${pct(agg.context_coverage.full_coverage_rate)}`);
  lines.push("");

  if (summary.results.some(r => r.error)) {
    lines.push("Failed Tasks");
    lines.push("-".repeat(40));
    for (const r of summary.results.filter(r => r.error)) {
      lines.push(`  [${r.task_id}] ${r.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Markdown (paper table style) ─────────────────────────────────────────────

function renderMarkdown(summary: BenchmarkSummary): string {
  const { aggregate: agg } = summary;
  const lines: string[] = [];

  lines.push(`# Guardian-Bench Results`);
  lines.push(``);
  lines.push(`**Guardian version:** ${summary.guardian_version} | **Tasks:** ${summary.completed_tasks}/${summary.total_tasks} | **Generated:** ${summary.generated_at}`);
  lines.push(``);

  lines.push(`## Aggregate Metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Search Recall — Precision@5 | ${pct(agg.search_recall.mean_precision_at_5)} |`);
  lines.push(`| Search Recall — Recall@5 | ${pct(agg.search_recall.mean_recall_at_5)} |`);
  lines.push(`| Search Recall — F1@5 | ${pct(agg.search_recall.mean_f1_at_5)} |`);
  lines.push(`| Search Recall — Any-Hit Rate | ${pct(agg.search_recall.any_hit_rate)} |`);
  lines.push(`| Token Efficiency — Mean Ratio | ${agg.token_efficiency.mean_efficiency_ratio.toFixed(3)}× |`);
  lines.push(`| Token Efficiency — Median Ratio | ${agg.token_efficiency.median_efficiency_ratio.toFixed(3)}× |`);
  lines.push(`| Token Efficiency — Mean Tokens Saved | ${agg.token_efficiency.mean_tokens_saved.toLocaleString()} |`);
  lines.push(`| Drift Score — Mean Increase | ${agg.drift_score.mean_drift_increase.toFixed(3)} |`);
  lines.push(`| Context Coverage — Mean | ${pct(agg.context_coverage.mean_coverage)} |`);
  lines.push(`| Context Coverage — Full Coverage Rate | ${pct(agg.context_coverage.full_coverage_rate)} |`);
  lines.push(``);

  lines.push(`## Per-Task Results`);
  lines.push(``);
  lines.push(`| Task | Repo | P@5 | R@5 | F1@5 | Eff.Ratio | Coverage |`);
  lines.push(`|------|------|-----|-----|------|-----------|----------|`);
  for (const r of summary.results) {
    const m = r.metrics;
    lines.push(
      `| ${r.task_id} | ${r.repo} ` +
      `| ${pct(m.search_recall.precision_at_k)} ` +
      `| ${pct(m.search_recall.recall_at_k)} ` +
      `| ${pct(m.search_recall.f1_at_k)} ` +
      `| ${m.token_efficiency.efficiency_ratio.toFixed(3)}× ` +
      `| ${pct(m.context_coverage.coverage)} |`
    );
  }
  lines.push(``);

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Extract per-task rows suitable for pandas/CSV */
export function toCSV(summary: BenchmarkSummary): string {
  const header = [
    "task_id", "repo", "language", "source",
    "precision_at_5", "recall_at_5", "f1_at_5", "any_hit",
    "efficiency_ratio", "tokens_saved",
    "drift_increase", "context_coverage",
    "duration_ms", "error",
  ].join(",");

  const rows = summary.results.map(r => {
    const m = r.metrics;
    return [
      r.task_id,
      r.repo,
      r.language ?? "",
      r.source ?? "",
      m.search_recall.precision_at_k,
      m.search_recall.recall_at_k,
      m.search_recall.f1_at_k,
      m.search_recall.files_found.length > 0 ? 1 : 0,
      m.token_efficiency.efficiency_ratio,
      m.token_efficiency.tokens_saved,
      m.drift_score.drift_increase ?? "",
      m.context_coverage.coverage,
      r.duration_ms,
      r.error ? `"${r.error.replace(/"/g, "'")}"` : "",
    ].join(",");
  });

  return [header, ...rows].join("\n");
}
