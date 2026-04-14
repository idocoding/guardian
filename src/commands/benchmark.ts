/**
 * `guardian benchmark` — run Guardian-Bench offline evaluation suite
 *
 * Reads a JSONL file of tasks, computes 4 metrics per task (search recall,
 * token efficiency, drift score, context coverage), and writes a report.
 *
 * Usage:
 *   guardian benchmark --tasks tasks.jsonl --specs .specs
 *   guardian benchmark --tasks tasks.jsonl --output results.json --format json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { runBenchmark } from "../benchmarking/runner.js";
import { renderReport, toCSV } from "../benchmarking/report.js";
import type { ReportFormat } from "../benchmarking/report.js";

export type BenchmarkOptions = {
  tasks: string;
  specs?: string;
  repoDir?: string;
  output?: string;
  format?: string;
  k?: string | number;
  concurrency?: string | number;
};

export async function runBenchmarkCommand(options: BenchmarkOptions): Promise<void> {
  const tasksFile = path.resolve(options.tasks);
  const specsDir = options.specs ? path.resolve(options.specs) : undefined;
  const repoDir = options.repoDir ? path.resolve(options.repoDir) : undefined;
  const format = (options.format ?? "text") as ReportFormat | "csv";
  const k = typeof options.k === "string" ? parseInt(options.k, 10) : (options.k ?? 5);
  const concurrency = typeof options.concurrency === "string"
    ? parseInt(options.concurrency, 10)
    : (options.concurrency ?? 4);

  // Validate tasks file
  try {
    await fs.access(tasksFile);
  } catch {
    console.error(`Error: tasks file not found: ${tasksFile}`);
    process.exit(1);
  }

  console.error(`Guardian-Bench: running tasks from ${tasksFile}`);

  const summary = await runBenchmark({
    tasksFile,
    specsDir,
    repoDir,
    k,
    concurrency,
    onProgress(completed, total, result) {
      const status = result.error ? "FAIL" : "OK";
      const f1 = result.metrics.search_recall.f1_at_k.toFixed(3);
      const cov = result.metrics.context_coverage.coverage.toFixed(3);
      console.error(`  [${completed}/${total}] ${status} ${result.task_id} | F1@${k}=${f1} | coverage=${cov}`);
    },
  });

  // Render output
  let output: string;
  if (format === "csv") {
    output = toCSV(summary);
  } else {
    output = renderReport(summary, format === "json" || format === "markdown" ? format : "text");
  }

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output, "utf8");
    console.error(`Wrote results to ${outputPath}`);
  }

  // Always print to stdout
  console.log(output);
}
