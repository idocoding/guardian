/**
 * SpecsStore — IO adapter interface for guardian spec files.
 *
 * All reads and writes of .specs content flow through this interface.
 * Two implementations exist:
 *   - FileSpecsStore  (default today) — reads/writes individual files on disk
 *   - SqliteSpecsStore               — reads/writes a single guardian.db
 *
 * Callers never reference the filesystem or SQLite directly; they use
 * this interface. Switching storage backends requires zero changes outside
 * this module.
 */

export type SpecFormat = "json" | "yaml" | "jsonl" | "text";
export type Tier = "free" | "pro" | "enterprise";

/** A single stored spec artifact (replaces one file on disk). */
export interface SpecEntry {
  name: string;       // e.g. "codebase-intelligence", "architecture.snapshot"
  format: SpecFormat;
  content: string;    // raw file content — identical to what was written to disk
  tier: Tier;
  updatedAt: number;  // unix ms
}

/** A human-readable doc section (replaces one .specs/human/*.md file). */
export interface DocEntry {
  id: string;         // e.g. "overview", "module:src/extract", "api:POST /users"
  section: string;    // "overview" | "module" | "api" | "function" | "drift"
  title: string;
  body: string;       // markdown
  tier: Tier;
  updatedAt: number;
}

/** A single metrics event (replaces one line in mcp-metrics.jsonl). */
export interface MetricEvent {
  ts: number;
  event: string;
  payload: string;    // JSON string
}

/**
 * Core IO adapter interface.
 * All methods are async to support both file IO and SQLite (which can be sync
 * but wrapping in async keeps the interface uniform).
 */
export interface SpecsStore {
  // ── Spec blobs ────────────────────────────────────────────────────────────
  readSpec(name: string): Promise<SpecEntry | null>;
  writeSpec(name: string, content: string, format: SpecFormat, tier?: Tier): Promise<void>;
  listSpecs(): Promise<string[]>;
  hasSpec(name: string): Promise<boolean>;

  // ── Human docs ────────────────────────────────────────────────────────────
  readDoc(id: string): Promise<DocEntry | null>;
  writeDoc(entry: Omit<DocEntry, "updatedAt">): Promise<void>;
  listDocs(section?: string): Promise<DocEntry[]>;

  // ── Metrics log ───────────────────────────────────────────────────────────
  appendMetric(event: string, payload: object): Promise<void>;
  readMetrics(limit?: number): Promise<MetricEvent[]>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Called once after construction to set up tables / directories. */
  init(): Promise<void>;
  /** Release connections / file handles. */
  close(): Promise<void>;
}
