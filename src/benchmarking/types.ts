/**
 * Guardian-Bench types
 *
 * Task format is JSONL, one task per line — compatible with HuggingFace datasets.
 * Results are structured for direct inclusion in paper tables.
 *
 * Benchmark dimensions (all offline, no LLM API required):
 *   1. Search Recall    — precision/recall of guardian_search vs ground-truth files
 *   2. Token Efficiency — MCP response tokens vs reading ground-truth files directly
 *   3. Drift Score      — architectural drift increase after applying a patch
 *   4. Context Coverage — how much of architecture-context.md covers the task's modules
 */

// ── Task format ──────────────────────────────────────────────────────────────

export type BenchmarkTask = {
  /** Unique task ID, e.g. "django__django-11099" (SWE-bench compatible) */
  id: string;
  /** GitHub repo slug, e.g. "django/django" */
  repo: string;
  /** Commit SHA of the base state (before patch) */
  commit?: string;
  /** Human-readable description of the problem */
  description: string;
  /** Natural language query to issue to guardian_search */
  query: string;
  /** Files the correct solution touches (ground truth) */
  ground_truth_files: string[];
  /** Exported symbols relevant to the fix */
  ground_truth_symbols?: string[];
  /** Unified diff of the correct solution (for drift metric) */
  patch?: string;
  /** Programming language of the task */
  language?: "python" | "typescript" | "go" | "java" | "cpp" | string;
  /** Where this task was sourced from */
  source?: "apex-swe-observability" | "apex-swe-integration" | "swe-bench" | "manual" | string;
  /** Path to the pre-extracted .specs directory for this repo */
  specs_dir?: string;
  /** Path to the repo root (needed for token efficiency + drift) */
  repo_dir?: string;
};

// ── Per-metric result types ───────────────────────────────────────────────────

export type SearchRecallResult = {
  /** Fraction of returned results that are in ground truth */
  precision_at_k: number;
  /** Fraction of ground truth files surfaced in top-k results */
  recall_at_k: number;
  /** Harmonic mean of precision and recall */
  f1_at_k: number;
  /** k value used (default 5) */
  k: number;
  /** Ground-truth files found in top-k results */
  files_found: string[];
  /** Ground-truth files NOT found in top-k results */
  files_missed: string[];
  /** Ground-truth symbols found in results */
  symbols_found: string[];
  /** Ground-truth symbols NOT found */
  symbols_missed: string[];
  /** All result file paths returned by guardian_search */
  result_files: string[];
  /** All result symbols returned by guardian_search */
  result_symbols: string[];
};

export type TokenEfficiencyResult = {
  /** Estimated tokens in guardian MCP responses (orient + search) */
  mcp_tokens: number;
  /** Estimated tokens if agent read all ground-truth files directly */
  raw_file_tokens: number;
  /** mcp_tokens / raw_file_tokens — lower = more efficient */
  efficiency_ratio: number;
  /** raw_file_tokens - mcp_tokens */
  tokens_saved: number;
  /** Total bytes of ground-truth files */
  raw_file_bytes: number;
  /** Total bytes of MCP responses */
  mcp_response_bytes: number;
};

export type DriftScoreResult = {
  /** Drift delta before patch applied */
  baseline_delta: number | null;
  /** Drift delta after patch applied */
  post_patch_delta: number | null;
  /** Increase in drift (lower = patch respected architecture) */
  drift_increase: number | null;
  /** Drift status before patch */
  baseline_status: string;
  /** Drift status after patch */
  post_patch_status: string;
  /** Whether a patch was provided and applied */
  patch_applied: boolean;
};

export type ContextCoverageResult = {
  /** Fraction of ground-truth modules mentioned in architecture-context.md (0.0–1.0) */
  coverage: number;
  /** Module IDs mentioned in context */
  modules_mentioned: string[];
  /** Module IDs of ground-truth files that are NOT mentioned */
  modules_missing: string[];
  /** Number of ground-truth files mentioned (by path or basename) */
  files_mentioned: number;
  /** Total ground-truth files */
  files_total: number;
};

// ── Task result ───────────────────────────────────────────────────────────────

export type BenchmarkTaskResult = {
  task_id: string;
  repo: string;
  language?: string;
  source?: string;
  specs_dir: string;
  metrics: {
    search_recall: SearchRecallResult;
    token_efficiency: TokenEfficiencyResult;
    drift_score: DriftScoreResult;
    context_coverage: ContextCoverageResult;
  };
  /** Wall clock time in ms to compute all metrics */
  duration_ms: number;
  error?: string;
};

// ── Aggregate summary (goes into paper tables) ────────────────────────────────

export type BenchmarkAggregate = {
  search_recall: {
    mean_precision_at_5: number;
    mean_recall_at_5: number;
    mean_f1_at_5: number;
    /** Fraction of tasks where at least 1 ground-truth file was found */
    any_hit_rate: number;
  };
  token_efficiency: {
    mean_efficiency_ratio: number;
    median_efficiency_ratio: number;
    mean_tokens_saved: number;
    total_tokens_saved: number;
  };
  drift_score: {
    mean_drift_increase: number;
    tasks_with_stable_post_patch: number;
    tasks_with_patch: number;
  };
  context_coverage: {
    mean_coverage: number;
    full_coverage_rate: number;
  };
};

export type BenchmarkSummary = {
  generated_at: string;
  guardian_version: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  aggregate: BenchmarkAggregate;
  /** Per-task results for drill-down */
  results: BenchmarkTaskResult[];
};
