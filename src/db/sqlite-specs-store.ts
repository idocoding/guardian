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
        // Gentle nudge: [0.7, 1.0] — hubs are demoted by at most 30%.
        // BM25 relevance still dominates; this is a tiebreaker, not a hard filter.
        quality = 0.7 + 0.3 * authority;
      }

      // bm25 is negative (more negative = better). Multiplying by quality < 1
      // moves the score toward 0 — making low-quality files rank worse.
      const combined = r.rank * quality;

      return { file_path: r.file_path, symbol_name: r.symbol_name, rank: combined, imports, used_by };
    });

    reranked.sort((a, b) => a.rank - b.rank);
    return reranked.slice(0, limit);
  }
}
