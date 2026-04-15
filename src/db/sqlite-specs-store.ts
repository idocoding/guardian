/**
 * SqliteSpecsStore — SQLite implementation of SpecsStore.
 *
 * Stores everything that was previously scattered across .specs/machine/*.json
 * and .specs/human/*.md into a single guardian.db file.
 *
 * Schema:
 *   specs        — blob storage for all machine intelligence files
 *   docs         — human-readable doc sections (markdown)
 *   metrics_log  — append-only event log (replaces mcp-metrics.jsonl)
 *   search_fts   — FTS5 virtual table built from specs content (extra index)
 *
 * Tier gating is stored per-row; the caller passes a tier filter when reading.
 * This is the foundation for the pro/enterprise access control layer.
 */

import Database from "better-sqlite3";
import path from "node:path";
import type {
  SpecsStore,
  SpecEntry,
  DocEntry,
  MetricEvent,
  SpecFormat,
  Tier,
} from "./specs-store.js";
import type { FTSRow } from "./fts-builder.js";

/**
 * Normalise a file path to a canonical repo-relative form.
 * Used consistently by the FTS builder, dep-graph builder, and search query.
 * All paths stored in guardian.db go through this function.
 *
 *   "flask-full/src/flask/sessions.py"      → "src/flask/sessions.py"
 *   "django/django/contrib/auth.py"         → "django/contrib/auth.py"
 *   "sqlalchemy/lib/sqlalchemy/sql/base.py" → "lib/sqlalchemy/sql/base.py"
 */
export function normPath(p: string): string {
  // Strip leading reponame/src/ → src/
  p = p.replace(/^[^/]+\/src\//, "src/");
  // Strip double-prefix X/X/ → X/ (package namespace matches repo clone dir)
  const dm = p.match(/^([^/]+)\/\1\//);
  if (dm) return p.slice(dm[1].length + 1);
  // Strip leading repo segment when followed by a known source-directory name
  if (/^[^/]+\/(?:lib|examples|pkg|packages|apps|internal|cmd|src)\//i.test(p)) {
    p = p.slice(p.indexOf("/") + 1);
  }
  return p;
}

/**
 * Split camelCase and snake_case identifiers into individual tokens so the
 * porter stemmer can match partial terms.
 *   getUserById  → "get user by id"
 *   auth_service → "auth service"
 */
function splitIdentifiers(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

/**
 * Normalise a callee name by stripping receiver/object/package prefix.
 * "engine.handleHTTPRequest" → "handleHTTPRequest"
 * "self.add_to_class"       → "add_to_class"
 * "apps.get_model"          → "get_model"
 * "fmt.Println"             → "Println"
 * "bare_name"               → "bare_name"  (unchanged)
 */
function normalizeCallee(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot >= 0) {
    const bare = name.slice(lastDot + 1);
    if (bare && /^[A-Za-z_]\w*$/.test(bare)) return bare;
  }
  return name;
}

/**
 * Extract meaningful directory-segment tokens from a file path.
 * "fastapi/dependencies/utils.py" → "fastapi dependencies"
 * "lib/router/layer.js"           → "router layer"
 *
 * Skips generic segments that add noise but no recall value.
 */
const PATH_NOISE = new Set([
  "src", "lib", "app", "pkg", "internal", "cmd", "api", "dist", "build",
  "test", "tests", "spec", "specs", "docs", "doc", "examples", "example",
  "scripts", "utils", "helpers", "common", "shared", "core", "main",
]);
function filePathTokens(fp: string): string {
  return fp
    .split("/")
    .slice(0, -1)                                // exclude the filename itself
    .filter(s => s && !PATH_NOISE.has(s.toLowerCase()))
    .map(splitIdentifiers)
    .join(" ");
}

/** L2 norm of a Float32Array. */
function vecNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** Cosine similarity between two unit-normalised Float32Arrays. */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

export const DB_FILENAME = "guardian.db";

export class SqliteSpecsStore implements SpecsStore {
  private db!: Database.Database;

  constructor(private readonly storeDir: string) {}

  async init(): Promise<void> {
    const dbPath = path.join(this.storeDir, DB_FILENAME);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this._migrate();
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  // ── Spec blobs ─────────────────────────────────────────────────────────────

  async readSpec(name: string): Promise<SpecEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM specs WHERE name = ?")
      .get(name) as SpecEntry | undefined;
    return row ?? null;
  }

  async writeSpec(name: string, content: string, format: SpecFormat, tier: Tier = "free"): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO specs (name, format, content, tier, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          content    = excluded.content,
          format     = excluded.format,
          tier       = excluded.tier,
          updated_at = excluded.updated_at
      `)
      .run(name, format, content, tier, Date.now());
  }

  async listSpecs(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT name FROM specs ORDER BY name")
      .all() as { name: string }[];
    return rows.map(r => r.name);
  }

  async hasSpec(name: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM specs WHERE name = ?")
      .get(name);
    return !!row;
  }

  // ── Human docs ─────────────────────────────────────────────────────────────

  async readDoc(id: string): Promise<DocEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM docs WHERE id = ?")
      .get(id) as DocEntry | undefined;
    return row ?? null;
  }

  async writeDoc(entry: Omit<DocEntry, "updatedAt">): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO docs (id, section, title, body, tier, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          section    = excluded.section,
          title      = excluded.title,
          body       = excluded.body,
          tier       = excluded.tier,
          updated_at = excluded.updated_at
      `)
      .run(entry.id, entry.section, entry.title, entry.body, entry.tier, Date.now());
  }

  async listDocs(section?: string): Promise<DocEntry[]> {
    if (section) {
      return this.db
        .prepare("SELECT * FROM docs WHERE section = ? ORDER BY id")
        .all(section) as DocEntry[];
    }
    return this.db
      .prepare("SELECT * FROM docs ORDER BY section, id")
      .all() as DocEntry[];
  }

  // ── Metrics log ────────────────────────────────────────────────────────────

  async appendMetric(event: string, payload: object): Promise<void> {
    this.db
      .prepare("INSERT INTO metrics_log (ts, event, payload) VALUES (?, ?, ?)")
      .run(Date.now(), event, JSON.stringify(payload));
  }

  async readMetrics(limit = 1000): Promise<MetricEvent[]> {
    return this.db
      .prepare("SELECT * FROM metrics_log ORDER BY id DESC LIMIT ?")
      .all(limit) as MetricEvent[];
  }

  // ── FTS search (extra index, no equivalent in FileSpecsStore) ─────────────

  /**
   * Rebuild the FTS5 search index from extracted codebase data.
   *
   * Each row is one file. Symbol names and endpoints are pre-expanded with
   * splitIdentifiers() so "getUserById" becomes "get user by id" before
   * the porter stemmer runs — this gives sub-token recall without trigrams.
   *
   * Column BM25 weights (bm25 args, lower = more important):
   *   file_path(1), symbol_name(2), endpoint(3), body(4), module(5)
   *   weights:   1.0             0.5             0.7        1.0      0.6
   */
  rebuildSearchIndex(rows: FTSRow[]): void {
    this.db.prepare("DELETE FROM search_fts").run();
    const insert = this.db.prepare(
      "INSERT INTO search_fts (file_path, symbol_name, endpoint, body, module) VALUES (?, ?, ?, ?, ?)"
    );
    const insertAll = this.db.transaction((items: FTSRow[]) => {
      for (const r of items) {
        insert.run(
          r.file_path,
          splitIdentifiers(r.symbol_name),
          splitIdentifiers(r.endpoint),
          r.body,
          r.module ?? "",
        );
      }
    });
    insertAll(rows);
  }

  /** BM25-ranked full-text search over the indexed content. */
  searchFTS(query: string, limit = 20): Array<{ file_path: string; symbol_name: string; rank: number }> {
    const tokens = this._buildTokens(query);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.join(" OR ");

    try {
      return this.db
        .prepare(`
          SELECT file_path, symbol_name,
                 bm25(search_fts, 1.0, 0.5, 0.7, 1.0, 0.6) AS rank
          FROM search_fts
          WHERE search_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(ftsQuery, limit) as Array<{ file_path: string; symbol_name: string; rank: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Score how well a query maps to indexed codebase content.
   *
   * Returns a 0–1 confidence score and a short reason string.
   * Useful for:
   *   - Filtering low-quality benchmark tasks
   *   - Returning confidence alongside guardian_search results
   *   - Advising agents when a query needs reformulation
   *
   * Three signals (each 0–1, combined with weights):
   *   token_coverage  0.4 — fraction of query tokens that hit anything in the index
   *   top_bm25        0.4 — strength of the best match (normalised from BM25 score)
   *   result_cluster  0.2 — do top results cluster in one module (high) or scatter (low)?
   */
  querySignal(query: string): { score: number; confidence: "high" | "medium" | "low"; reason: string } {
    const tokens = this._buildTokens(query);
    if (tokens.length === 0) {
      return { score: 0, confidence: "low", reason: "query produced no searchable tokens" };
    }

    // English stop words that appear everywhere — don't count as code signal.
    const STOP = new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","day","get","has","him","his","how","its","let","may","new","now","old","see","two","use","way","who","did","man","use","say","she","than","then","them","these","they","this","will","with","have","from","that","been","each","into","like","make","more","other","over","same","such","take","than","them","then","they","this","when","your","also","back","came","come","does","even","find","give","good","here","just","keep","kind","last","left","life","long","much","must","name","need","next","only","open","own","part","plan","play","put","read","real","said","show","side","some","tell","time","very","well","went","what","with","work","year","change","update","remove","add","fix","like","file","files","other","also"]);

    // Domain-specific tokens: those NOT in the stop list.
    const domainTokens = tokens.filter(t => !STOP.has(t.replace(/\*$/, "")));

    // ── Signal 1: domain token coverage ──────────────────────────────────
    // Only count tokens that are domain-specific AND match SOURCE files (not config).
    const SOURCE_EXT_RE = /\.(py|ts|tsx|js|jsx|go|java|cs|rb|rs|cpp|c|php|swift|kt)$/;
    let domainHits = 0;
    for (const tok of domainTokens) {
      try {
        const row = this.db.prepare(
          "SELECT file_path FROM search_fts WHERE search_fts MATCH ? LIMIT 5"
        ).all(tok) as { file_path: string }[];
        // Token must hit at least one actual source file (not config/build)
        if (row.some(r => SOURCE_EXT_RE.test(r.file_path))) domainHits++;
      } catch { /* skip */ }
    }
    const tokenCoverage = domainTokens.length > 0 ? domainHits / domainTokens.length : 0;

    // ── Signal 2: joint match strength ───────────────────────────────────
    // Use AND (not OR) to find files matching ALL domain tokens together.
    // Joint co-occurrence in one file means the query is specific, not coincidental.
    let jointStrength = 0;
    if (domainTokens.length > 0) {
      try {
        const andQuery = domainTokens.join(" AND ");
        const row = this.db.prepare(`
          SELECT bm25(search_fts, 1.0, 0.5, 0.7, 1.0, 0.6) AS rank, file_path
          FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT 1
        `).get(andQuery) as { rank: number; file_path: string } | undefined;
        if (row && SOURCE_EXT_RE.test(row.file_path)) {
          // Clamp [-15, 0] → [1, 0]
          jointStrength = Math.min(1, Math.max(0, -row.rank / 8));
        }
      } catch {
        // AND query failed (no joint match) → fall back to OR top score
        try {
          const orQuery = domainTokens.join(" OR ");
          const row = this.db.prepare(`
            SELECT bm25(search_fts, 1.0, 0.5, 0.7, 1.0, 0.6) AS rank, file_path
            FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT 1
          `).get(orQuery) as { rank: number; file_path: string } | undefined;
          if (row && SOURCE_EXT_RE.test(row.file_path)) {
            // OR match is weaker signal — scale down by 50%
            jointStrength = Math.min(0.5, Math.max(0, -row.rank / 16));
          }
        } catch { /* skip */ }
      }
    }

    // ── Signal 3: result clustering ───────────────────────────────────────
    let clustering = 0;
    try {
      const orQuery = domainTokens.length > 0 ? domainTokens.join(" OR ") : tokens.join(" OR ");
      const rows = this.db.prepare(`
        SELECT file_path FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 5
      `).all(orQuery) as { file_path: string }[];
      const srcRows = rows.filter(r => SOURCE_EXT_RE.test(r.file_path));
      if (srcRows.length > 1) {
        const dirs = srcRows.map(r => r.file_path.split("/").slice(0, -1).join("/"));
        const unique = new Set(dirs).size;
        clustering = 1 - (unique - 1) / Math.max(srcRows.length - 1, 1);
      } else if (srcRows.length === 1) {
        clustering = 1;
      }
    } catch { /* skip */ }

    const score = tokenCoverage * 0.35 + jointStrength * 0.45 + clustering * 0.2;
    const confidence = score >= 0.55 ? "high" : score >= 0.25 ? "medium" : "low";

    const noCodeTokens = domainTokens.length === 0;
    const reason = noCodeTokens
      ? "query contains only generic English words, no code-domain terms"
      : tokenCoverage < 0.3
      ? `only ${Math.round(tokenCoverage * 100)}% of domain tokens match indexed source files`
      : jointStrength < 0.15
      ? "tokens don't co-occur in any single source file — query is too generic"
      : clustering < 0.3
      ? "matching files scatter across unrelated modules — query is ambiguous"
      : `${Math.round(tokenCoverage * 100)}% domain coverage, strong co-occurrence match`;

    return { score: Math.round(score * 100) / 100, confidence, reason };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Build FTS5 token list from a natural language query. */
  private _buildTokens(query: string): string[] {
    return splitIdentifiers(query)
      .split(/\s+/)
      .filter(t => t.length > 1)
      .map(t => `${t.replace(/[^a-z0-9]/g, "")}*`)
      .filter(Boolean);
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS specs (
        name        TEXT PRIMARY KEY,
        format      TEXT NOT NULL,
        content     TEXT NOT NULL,
        tier        TEXT NOT NULL DEFAULT 'free',
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS docs (
        id          TEXT PRIMARY KEY,
        section     TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        tier        TEXT NOT NULL DEFAULT 'free',
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS docs_section ON docs(section);

      CREATE TABLE IF NOT EXISTS metrics_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        event       TEXT NOT NULL,
        payload     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS metrics_log_ts ON metrics_log(ts);

      CREATE TABLE IF NOT EXISTS file_deps (
        file     TEXT NOT NULL,
        imports  TEXT NOT NULL,
        PRIMARY KEY (file, imports)
      );

      CREATE INDEX IF NOT EXISTS file_deps_reverse ON file_deps(imports);
    `);

    // FTS5 table — recreate if module column is missing (no ALTER TABLE for virtual tables).
    // search_fts is always rebuilt on extract, so drop+recreate is safe.
    const existing = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='search_fts'")
      .get() as { sql: string } | undefined;

    if (!existing?.sql?.includes("module")) {
      this.db.exec(`
        DROP TABLE IF EXISTS search_fts;
        CREATE VIRTUAL TABLE search_fts USING fts5(
          file_path,
          symbol_name,
          endpoint,
          body,
          module,
          tokenize='porter unicode61'
        );
      `);
    }

    // Per-function FTS table — one row per function/class/symbol with line number.
    // file_path and line are UNINDEXED (stored but not tokenised); name + body are searched.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
        file_path UNINDEXED,
        line      UNINDEXED,
        name,
        body,
        tokenize='porter unicode61'
      );
    `);

    // Call-graph edges — caller → callee name mapping.
    // caller_file stored so test callers can be excluded from in-degree authority ranking.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS function_calls (
        caller_name  TEXT NOT NULL,
        callee_name  TEXT NOT NULL,
        caller_file  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (caller_name, callee_name)
      );
      CREATE INDEX IF NOT EXISTS function_calls_callee ON function_calls(callee_name);
    `);
    // Migration: add caller_file column to existing DBs that predate this schema.
    try {
      this.db.exec("ALTER TABLE function_calls ADD COLUMN caller_file TEXT NOT NULL DEFAULT ''");
    } catch { /* column already exists — fine */ }
    // Migration: normalise dotted callee names from older extractions.
    // "engine.handleHTTPRequest" → "handleHTTPRequest", "self.method" → "method", etc.
    // Uses UPDATE OR IGNORE to skip rows that would violate the (caller_name, callee_name) PK.
    // Filters exclude Go parenthetical expressions: "(**time.Time)", "(*t).Equal", etc.
    try {
      this.db.exec(`
        UPDATE OR IGNORE function_calls
        SET callee_name = SUBSTR(callee_name, INSTR(callee_name, '.') + 1)
        WHERE INSTR(callee_name, '.') > 0
          AND INSTR(callee_name, '(') = 0
          AND INSTR(callee_name, ' ') = 0
          AND INSTR(SUBSTR(callee_name, INSTR(callee_name, '.') + 1), '.') = 0
          AND INSTR(SUBSTR(callee_name, INSTR(callee_name, '.') + 1), ')') = 0
      `);
    } catch { /* non-critical */ }

    // Vector embeddings for semantic (non-keyword) search.
    // vec is a Float32Array stored as BLOB (dim=256, model=text-embedding-3-small).
    // Optional — only populated when OPENAI_API_KEY is present during extract.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS function_embeddings (
        file_path  TEXT NOT NULL,
        name       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        vec        BLOB NOT NULL,
        PRIMARY KEY (file_path, name, line)
      );
    `);

    // ── Normalised fact tables (DB-first backend, Phase 1) ─────────────────────
    //
    // These tables store raw extracted facts with no rendering or formatting.
    // Human docs and machine docs remain derived views generated from these facts.
    // Future: generate.ts and context.ts read from these tables instead of files.

    this.db.exec(`
      -- Full FunctionRecord — one row per extracted function/method/symbol.
      -- calls, string_lits, regex_pats are JSON arrays (compact, no pretty-print).
      CREATE TABLE IF NOT EXISTS functions_raw (
        file_path    TEXT NOT NULL,
        name         TEXT NOT NULL,
        line_start   INTEGER NOT NULL,
        line_end     INTEGER NOT NULL,
        language     TEXT NOT NULL DEFAULT '',
        is_async     INTEGER NOT NULL DEFAULT 0,
        docstring    TEXT NOT NULL DEFAULT '',
        calls        TEXT NOT NULL DEFAULT '[]',
        string_lits  TEXT NOT NULL DEFAULT '[]',
        regex_pats   TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (file_path, name, line_start)
      );

      -- API endpoint registry — one row per route/handler pair.
      -- service_calls is a JSON array.
      CREATE TABLE IF NOT EXISTS endpoints_raw (
        method          TEXT NOT NULL DEFAULT '',
        path            TEXT NOT NULL,
        handler         TEXT NOT NULL DEFAULT '',
        file_path       TEXT NOT NULL DEFAULT '',
        module          TEXT NOT NULL DEFAULT '',
        service_calls   TEXT NOT NULL DEFAULT '[]',
        request_schema  TEXT NOT NULL DEFAULT '',
        response_schema TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (method, path)
      );

      -- ORM/data-model registry — one row per model/schema.
      -- fields and relationships are JSON arrays.
      CREATE TABLE IF NOT EXISTS models_raw (
        name           TEXT PRIMARY KEY,
        file_path      TEXT NOT NULL DEFAULT '',
        module         TEXT NOT NULL DEFAULT '',
        fields         TEXT NOT NULL DEFAULT '[]',
        relationships  TEXT NOT NULL DEFAULT '[]'
      );

      -- Structural intelligence per module — one row per SI report.
      -- Populated by rebuildModuleMetrics() called from guardian intel --backend sqlite.
      CREATE TABLE IF NOT EXISTS module_metrics (
        module           TEXT PRIMARY KEY,
        depth_level      TEXT NOT NULL DEFAULT '',
        propagation      TEXT NOT NULL DEFAULT '',
        compressible     TEXT NOT NULL DEFAULT '',
        pattern          TEXT NOT NULL DEFAULT '',
        confidence       REAL NOT NULL DEFAULT 0,
        confidence_level TEXT NOT NULL DEFAULT '',
        nodes            INTEGER NOT NULL DEFAULT 0,
        edges            INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // ── Per-function index ──────────────────────────────────────────────────────

  /**
   * Populate functions_fts and function_calls from FunctionRecord data.
   * One row per function/class/symbol — enables line-level search + call-graph authority.
   */
  rebuildFunctionIndex(functions: Array<{
    id: string;
    name: string;
    file: string;
    lines: [number, number];
    calls?: string[];
    stringLiterals?: string[];
    regexPatterns?: string[];
    docstring?: string;
    isAsync?: boolean;
    language?: string;
  }>): void {
    this.db.prepare("DELETE FROM functions_fts").run();
    this.db.prepare("DELETE FROM function_calls").run();
    this.db.prepare("DELETE FROM functions_raw").run();
    const insFts = this.db.prepare(
      "INSERT INTO functions_fts (file_path, line, name, body) VALUES (?, ?, ?, ?)"
    );
    const insCall = this.db.prepare(
      "INSERT OR IGNORE INTO function_calls (caller_name, callee_name, caller_file) VALUES (?, ?, ?)"
    );
    const insRaw = this.db.prepare(`
      INSERT OR REPLACE INTO functions_raw
        (file_path, name, line_start, line_end, language, is_async, docstring, calls, string_lits, regex_pats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const fn of functions) {
        const fp = normPath(fn.file);
        const line = String(fn.lines[0]);
        // Store the original name for display and symbolMatch comparison.
        // FTS5 porter/unicode61 tokenizer splits on '_' naturally;
        // camelCase tokens are added to body so porter stemming applies to them too.
        const pathToks = filePathTokens(fp);
        const bodyParts = [
          splitIdentifiers(fn.name),          // camelCase expansion for FTS recall
          pathToks,                            // dir segments: "fastapi dependencies" etc.
          ...(fn.calls ?? []).map(c => splitIdentifiers(normalizeCallee(c))),
          ...(fn.stringLiterals ?? []),
          fn.docstring ?? "",
        ].join(" ");
        insFts.run(fp, line, fn.name, bodyParts);
        // Store call edges — normalise callee names to bare identifiers so the JOIN
        // in searchSymbols matches function names (strips "engine.", "self.", etc.).
        for (const callee of fn.calls ?? []) {
          const bare = normalizeCallee(callee);
          if (bare && bare !== fn.name) insCall.run(fn.name, bare, fp);
        }
        // Normalised fact row — all fields stored losslessly, no rendering.
        insRaw.run(
          fp,
          fn.name,
          fn.lines[0],
          fn.lines[1],
          fn.language ?? "",
          fn.isAsync ? 1 : 0,
          fn.docstring ?? "",
          JSON.stringify(fn.calls ?? []),
          JSON.stringify(fn.stringLiterals ?? []),
          JSON.stringify(fn.regexPatterns ?? []),
        );
      }
    })();
  }

  /**
   * Store structural-intelligence reports per module.
   * Called from `guardian intel --backend sqlite` after reading structural-intelligence.json.
   * Idempotent: replaces all rows on each call.
   */
  rebuildModuleMetrics(reports: Array<{
    feature: string;
    structure: { nodes: number; edges: number };
    confidence: { value: number; level: string };
    classification: { depth_level: string; propagation: string; compressible: string };
    recommendation: { primary: { pattern: string } };
  }>): void {
    this.db.prepare("DELETE FROM module_metrics").run();
    const ins = this.db.prepare(`
      INSERT OR REPLACE INTO module_metrics
        (module, depth_level, propagation, compressible, pattern, confidence, confidence_level, nodes, edges)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const r of reports) {
        ins.run(
          r.feature,
          r.classification.depth_level,
          r.classification.propagation,
          r.classification.compressible,
          r.recommendation.primary.pattern,
          r.confidence.value,
          r.confidence.level,
          r.structure.nodes,
          r.structure.edges,
        );
      }
    })();
  }

  /**
   * Read all module_metrics rows — used by generate/context to load SI reports from DB.
   */
  readModuleMetrics(): Array<{
    module: string;
    depth_level: string;
    propagation: string;
    compressible: string;
    pattern: string;
    confidence: number;
    confidence_level: string;
    nodes: number;
    edges: number;
  }> {
    try {
      return this.db.prepare("SELECT * FROM module_metrics ORDER BY module").all() as Array<{
        module: string; depth_level: string; propagation: string; compressible: string;
        pattern: string; confidence: number; confidence_level: string; nodes: number; edges: number;
      }>;
    } catch {
      return [];
    }
  }

  /**
   * Store API endpoint facts.
   * Called from populateFTSIndex() after reading intel/arch objects.
   * Idempotent: replaces all rows on each call.
   */
  rebuildEndpointsRaw(endpoints: Array<{
    method: string;
    path: string;
    handler?: string;
    file_path?: string;
    module?: string;
    service_calls?: string[];
    request_schema?: string;
    response_schema?: string;
  }>): void {
    this.db.prepare("DELETE FROM endpoints_raw").run();
    const ins = this.db.prepare(`
      INSERT OR REPLACE INTO endpoints_raw
        (method, path, handler, file_path, module, service_calls, request_schema, response_schema)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const ep of endpoints) {
        ins.run(
          ep.method ?? "",
          ep.path,
          ep.handler ?? "",
          normPath(ep.file_path ?? ""),
          ep.module ?? "",
          JSON.stringify(ep.service_calls ?? []),
          ep.request_schema ?? "",
          ep.response_schema ?? "",
        );
      }
    })();
  }

  /**
   * Store ORM/data-model facts.
   * Called from populateFTSIndex() after reading intel/arch objects.
   * Idempotent: replaces all rows on each call.
   */
  rebuildModelsRaw(models: Array<{
    name: string;
    file_path?: string;
    module?: string;
    fields?: string[];
    relationships?: string[];
  }>): void {
    this.db.prepare("DELETE FROM models_raw").run();
    const ins = this.db.prepare(`
      INSERT OR REPLACE INTO models_raw
        (name, file_path, module, fields, relationships)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const m of models) {
        ins.run(
          m.name,
          normPath(m.file_path ?? ""),
          m.module ?? "",
          JSON.stringify(m.fields ?? []),
          JSON.stringify(m.relationships ?? []),
        );
      }
    })();
  }

  /**
   * Store vector embeddings for semantic search.
   * vec is a Float32Array serialised as Buffer (dim=256, text-embedding-3-small).
   */
  rebuildEmbeddings(rows: Array<{
    file_path: string;
    name: string;
    line: number;
    vec: Float32Array;
  }>): void {
    this.db.prepare("DELETE FROM function_embeddings").run();
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO function_embeddings (file_path, name, line, vec) VALUES (?, ?, ?, ?)"
    );
    this.db.transaction(() => {
      for (const r of rows) {
        ins.run(r.file_path, r.name, r.line, Buffer.from(r.vec.buffer));
      }
    })();
  }

  /**
   * Vector similarity search — returns top-k functions closest to the query embedding.
   * Cosine similarity computed in JS over all stored embeddings (fast for <100k functions).
   */
  searchByVector(queryVec: Float32Array, limit = 20): Array<{
    file_path: string;
    name: string;
    line: number;
    score: number;
  }> {
    type EmbRow = { file_path: string; name: string; line: number; vec: Buffer };
    let all: EmbRow[];
    try {
      all = this.db.prepare(
        "SELECT file_path, name, line, vec FROM function_embeddings"
      ).all() as EmbRow[];
    } catch {
      return [];
    }
    if (all.length === 0) return [];

    // Normalise query vector once.
    const qNorm = vecNorm(queryVec);
    if (qNorm === 0) return [];
    const qUnit = queryVec.map(v => v / qNorm) as Float32Array;

    const scored = all.map(row => {
      const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
      return { file_path: row.file_path, name: row.name, line: row.line, score: cosineSim(qUnit, vec) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Hybrid symbol search: BM25 + call-graph authority + callee traversal + optional vector.
   *
   * Three-tier candidate pool:
   *   1. BM25 candidates  — direct FTS matches, scored by bm25_norm + auth_norm + vec_sim
   *   2. Callee expansion — 1-hop outbound callees of BM25 candidates (source-only),
   *                         scored by callee_hits_norm + auth_norm + vec_sim.
   *                         Surfaces functions called BY what matches the query (e.g.
   *                         "resolve dependency injection" → surfaces solve_dependencies
   *                         called by the route handler BM25 match).
   *
   * Ranking formula:
   *   BM25 tier:   W_BM25 * bm25_norm   + W_AUTH * auth_norm + W_VEC * vec_sim
   *   Callee tier: W_CALLEE * hits_norm  + W_AUTH * auth_norm + W_VEC * vec_sim
   *
   * Test-file penalty: 0.5× applied to any result whose file matches test/spec/bench/mock.
   */
  searchSymbols(
    query: string,
    limit = 10,
    queryVec?: Float32Array,
  ): Array<{
    file_path: string;
    name: string;
    line: number;
    score: number;
  }> {
    const tokens = this._buildTokens(query);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.join(" OR ");

    // Pull a wider candidate pool so reranking has enough material.
    const candidateLimit = Math.max(limit * 5, 60);

    // ── Tier 1: BM25 candidates with source-only in-degree ───────────────────
    type FtsRow = { file_path: string; line: string; name: string; bm25: number; indegree: number };
    let rows: FtsRow[];
    try {
      rows = this.db.prepare(`
        WITH candidates AS (
          SELECT file_path, line, name,
                 bm25(functions_fts, 0.2, 1.0, 0.5) AS bm25
          FROM functions_fts
          WHERE functions_fts MATCH ?
          ORDER BY bm25
          LIMIT ?
        )
        SELECT c.file_path, c.line, c.name, c.bm25,
               COUNT(CASE
                 WHEN fc.caller_file NOT LIKE '%test%'
                  AND fc.caller_file NOT LIKE '%spec%'
                  AND fc.caller_file NOT LIKE '%mock%'
                  AND fc.caller_file NOT LIKE '%fixture%'
                  AND fc.caller_file NOT LIKE '%example%'
                  AND fc.caller_file NOT LIKE '%demo%'
                  AND fc.caller_file NOT LIKE '%sample%'
                 THEN 1 END) AS indegree
        FROM candidates c
        LEFT JOIN function_calls fc ON fc.callee_name = c.name
        GROUP BY c.file_path, c.line, c.name, c.bm25
        ORDER BY c.bm25
      `).all(ftsQuery, candidateLimit) as FtsRow[];
    } catch {
      return [];
    }
    if (rows.length === 0) return [];

    // ── Tier 2: 1-hop callee expansion from BM25 candidates ──────────────────
    // Walk outbound call edges (source callers only) to find functions called BY
    // the BM25 matches. callee_hits = number of BM25 candidates that call this.
    type CalleeRow = { file_path: string; line: string; name: string; callee_hits: number };
    const bm25Names   = rows.map(r => r.name);
    const bm25NameSet = new Set(bm25Names);
    let calleeRows: CalleeRow[] = [];
    if (bm25Names.length > 0) {
      try {
        // Limit IN clause to avoid excess query plan cost on large candidate pools.
        const callerNames = bm25Names.slice(0, 30);
        const phs = callerNames.map(() => "?").join(",");
        calleeRows = this.db.prepare(`
          SELECT f.file_path, f.line, f.name,
                 COUNT(*) AS callee_hits
          FROM function_calls fc
          JOIN functions_fts f ON f.name = fc.callee_name
          WHERE fc.caller_name IN (${phs})
            AND fc.caller_file NOT LIKE '%test%'
            AND fc.caller_file NOT LIKE '%spec%'
            AND fc.caller_file NOT LIKE '%mock%'
            AND fc.caller_file NOT LIKE '%fixture%'
            AND fc.caller_file NOT LIKE '%example%'
            AND fc.caller_file NOT LIKE '%demo%'
            AND fc.caller_file NOT LIKE '%sample%'
          GROUP BY f.file_path, f.line, f.name
          ORDER BY callee_hits DESC
          LIMIT ?
        `).all(...callerNames, 40) as CalleeRow[];
      } catch { /* graceful — callee expansion is additive only */ }
    }

    // Build the callee membership set BEFORE removing BM25 overlap.
    // This is used to apply a score bonus to BM25-tier functions that are also
    // call-graph targets (e.g. handleHTTPRequest: low BM25 rank, but called by ServeHTTP).
    const calleeNameSet = new Set(calleeRows.map(r => r.name));

    // Remove BM25 names from the separate callee tier to avoid double-counting.
    calleeRows = calleeRows.filter(r => !bm25NameSet.has(r.name));

    // ── Normalisation scalars ─────────────────────────────────────────────────
    // BM25: negative (more negative = better), invert then normalise.
    const bm25Scores = rows.map(r => -r.bm25);
    const bm25Max    = Math.max(...bm25Scores);
    const bm25Min    = Math.min(...bm25Scores);
    const bm25Range  = bm25Max - bm25Min || 1;

    // In-degree: BM25 tier only (callees don't carry their own in-degree here).
    const indegreeMax = Math.max(...rows.map(r => r.indegree)) || 1;

    // Callee hits: normalise by pool size so a single edge (1 of N candidates) = tiny score.
    // This prevents callee expansion from flooding results when the BM25 signal is weak.
    const maxCalleeHits = Math.max(bm25Names.slice(0, 30).length, 1);

    // ── Vector scores (optional) ──────────────────────────────────────────────
    const vecScores = new Map<string, number>();
    if (queryVec) {
      const allNames   = new Set([...bm25Names, ...calleeRows.map(r => r.name)]);
      const vecResults = this.searchByVector(queryVec, candidateLimit * 2);
      for (const v of vecResults) {
        if (allNames.has(v.name)) vecScores.set(`${v.file_path}::${v.name}::${v.line}`, v.score);
      }
    }
    const hasVec = vecScores.size > 0;

    // ── Weight tables ─────────────────────────────────────────────────────────
    const W_BM25   = hasVec ? 0.50 : 0.70;
    const W_AUTH   = hasVec ? 0.20 : 0.30;
    const W_VEC    = hasVec ? 0.30 : 0.00;
    // Callee tier: scored on hit count + vector (no separate in-degree).
    const W_CALLEE = hasVec ? 0.35 : 0.45;
    const W_CA_VEC  = hasVec ? 0.30 : 0.00;
    // Callee bonus: applied only to BM25-tier functions with WEAK BM25 signal (bm25Norm < 0.20)
    // that also appear in the callee expansion. This targets long-tail pool members like
    // handleHTTPRequest (rank ~90/150) without boosting already-competitive functions
    // (e.g. render_template at rank ~40) which could displace authority-ranked results.
    const W_CALLEE_BONUS   = 0.28;
    const CALLEE_BM25_THRESHOLD = 0.20;  // only boost if bm25Norm below this

    // ── Test/example-file penalty ─────────────────────────────────────────────
    // Applied 0.5× to test files and example/demo/sample directories.
    // Checks both the filename AND all directory segments so that files like
    // "examples/static-files/index.js" are caught even if their basename is generic.
    const TEST_PENALTY = 0.50;
    const isNonSourceFile = (fp: string) => {
      const parts = fp.split("/");
      const filename = parts[parts.length - 1] ?? fp;
      return /test|spec|bench|mock|fixture/i.test(filename) ||
             parts.some(p => /^examples?$|^demos?$|^samples?$/i.test(p));
    };

    // ── Score BM25 tier ───────────────────────────────────────────────────────
    const scored: Array<{ file_path: string; name: string; line: number; score: number }> = rows.map(r => {
      const bm25Norm    = ((-r.bm25) - bm25Min) / bm25Range;
      const authNorm    = r.indegree / indegreeMax;
      const key         = `${r.file_path}::${r.name}::${r.line}`;
      const vecSim      = vecScores.get(key) ?? 0;
      // Callee bonus only applies to source-file functions (test files are already penalised).
      const calleeBonus = (!isNonSourceFile(r.file_path) && calleeNameSet.has(r.name)
                           && bm25Norm < CALLEE_BM25_THRESHOLD)
        ? W_CALLEE_BONUS : 0;
      const raw  = W_BM25 * bm25Norm + W_AUTH * authNorm + W_VEC * vecSim + calleeBonus;
      return { file_path: r.file_path, name: r.name, line: parseInt(r.line, 10),
               score: isNonSourceFile(r.file_path) ? raw * TEST_PENALTY : raw };
    });

    // ── Score callee tier (functions NOT in BM25 pool) and merge ─────────────
    for (const r of calleeRows) {
      const hitsNorm = r.callee_hits / maxCalleeHits;
      const key      = `${r.file_path}::${r.name}::${r.line}`;
      const vecSim   = vecScores.get(key) ?? 0;
      const raw      = W_CALLEE * hitsNorm + W_CA_VEC * vecSim;
      scored.push({ file_path: r.file_path, name: r.name, line: parseInt(r.line, 10),
                    score: isNonSourceFile(r.file_path) ? raw * TEST_PENALTY : raw });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ── Dependency graph ────────────────────────────────────────────────────────

  /** Replace all import edges (run once per guardian extract --backend sqlite). */
  rebuildDeps(edges: Array<{ file: string; imports: string }>): void {
    const del = this.db.prepare("DELETE FROM file_deps");
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO file_deps (file, imports) VALUES (?, ?)"
    );
    this.db.transaction(() => {
      del.run();
      for (const e of edges) ins.run(e.file, e.imports);
    })();
  }

  /**
   * BM25 search + dependency-graph quality reranking.
   *
   * Ranking model (inspired by HITS / PageRank applied to code):
   *   - Source files are "authorities": many files import them (high used_by count)
   *   - Test/example files are "hubs": they import source files but nothing imports them
   *
   * Quality score = authority_ratio = used_by / (used_by + imports)
   * Combined score = bm25_rank / quality   (bm25 is negative; dividing dampens hubs)
   *
   * This naturally demotes test/example files without hardcoding path patterns.
   * Files with no dependency data get a neutral quality (0.7) to avoid over-penalising
   * isolated scripts or newly-added files not yet in the graph.
   */
  searchWithGraph(
    query: string,
    limit = 5,
  ): Array<{
    file_path: string;
    symbol_name: string;
    rank: number;
    imports: string[];
    used_by: string[];
    matching_symbols: string[];
  }> {
    const tokens = this._buildTokens(query);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.join(" OR ");

    // Fetch a wider candidate pool so reranking has enough material.
    const candidateLimit = Math.max(limit * 4, 60);

    type Row = { file_path: string; symbol_name: string; rank: number; imports_: string | null; used_by_: string | null };
    let rows: Row[];
    try {
      rows = this.db.prepare(`
        WITH candidates AS (
          SELECT file_path, symbol_name,
                 bm25(search_fts, 1.0, 0.5, 0.7, 1.0, 0.6) AS rank
          FROM search_fts
          WHERE search_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        )
        SELECT
          c.file_path,
          c.symbol_name,
          c.rank,
          GROUP_CONCAT(DISTINCT d.imports) AS imports_,
          GROUP_CONCAT(DISTINCT r.file)    AS used_by_
        FROM candidates c
        LEFT JOIN file_deps d ON d.file    = c.file_path
        LEFT JOIN file_deps r ON r.imports = c.file_path
        GROUP BY c.file_path, c.symbol_name, c.rank
        ORDER BY c.rank
      `).all(ftsQuery, candidateLimit) as Row[];
    } catch {
      return [];
    }

    // Build a set of bare query stems for matching_symbols computation.
    // Strip the trailing '*' added by _buildTokens so we can do prefix matching.
    const queryStems = tokens.map(t => t.replace(/\*$/, ""));

    // Apply quality reranking using dependency-graph authority score.
    const reranked = rows.map(r => {
      const imports = r.imports_ ? r.imports_.split(",").filter(Boolean) : [];
      const used_by = r.used_by_ ? r.used_by_.split(",").filter(Boolean) : [];
      const usedByN  = used_by.length;
      const importsN = imports.length;

      let quality: number;
      if (usedByN === 0 && importsN === 0) {
        // No dependency data — preserve BM25 rank entirely.
        quality = 1.0;
      } else {
        // authority_ratio ∈ [0, 1]: 1.0 = pure authority (many things import this file)
        //                            0.0 = pure hub (imports many, nothing imports it)
        const authority = usedByN / (usedByN + importsN);
        // Range [0.7, 1.0]: hub files that import many things but aren't imported
        // get a slight penalty vs authority files. Explicit path penalty handles examples.
        quality = 0.7 + 0.3 * authority;
      }

      // Path-based hard penalty for example/demo/sample directories — belt-and-suspenders
      // on top of the authority demotion, for repos where dep graph may be sparse.
      const pathParts = r.file_path.split("/");
      if (pathParts.some(p => /^examples?$|^demos?$|^samples?$/i.test(p))) {
        quality *= 0.5;
      }

      // bm25 is negative (more negative = better). Multiplying by quality < 1
      // moves the score toward 0 — making low-quality files rank worse.
      const combined = r.rank * quality;

      // Snippet equivalent: which named symbols in this file match query stems?
      // symbol_name is a space-separated list of all symbols extracted from the file.
      const fileSymbols = r.symbol_name ? r.symbol_name.split(/\s+/).filter(Boolean) : [];
      const matching_symbols = fileSymbols.filter(sym => {
        const symLower = splitIdentifiers(sym); // "isPublished" → "is published"
        return queryStems.some(stem => symLower.includes(stem) || sym.toLowerCase().includes(stem));
      }).slice(0, 6); // cap at 6 per file

      return { file_path: r.file_path, symbol_name: r.symbol_name, rank: combined, imports, used_by, matching_symbols };
    });

    reranked.sort((a, b) => a.rank - b.rank);

    return reranked.slice(0, limit);
  }
}
