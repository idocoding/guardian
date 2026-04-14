/**
 * Search Recall Metric
 *
 * Measures how well guardian_search surfaces the files and symbols
 * that the correct solution actually touches (ground truth).
 *
 * Uses the codebase-intelligence.json search logic (same as MCP guardian_search)
 * plus the richer architecture.snapshot.yaml for file-level recall.
 *
 * Paper metric: precision@k, recall@k, F1@k (default k=5)
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SearchRecallResult } from "../types.js";

const DEFAULT_K = 5;

type IntelDoc = {
  api_registry?: Record<string, { file?: string; handler?: string; path?: string; service_calls?: string[]; module?: string }>;
  model_registry?: Record<string, { name?: string; file?: string; fields?: string[] }>;
  service_map?: Array<{ id: string; exports?: string[]; files?: string[]; imports?: string[] }>;
  enum_registry?: Record<string, { name?: string; file?: string; values?: string[] }>;
  background_tasks?: Array<{ name?: string; file?: string; kind?: string }>;
  frontend_pages?: Array<{ path?: string; component?: string; api_calls?: string[] }>;
};

type FuncIntelDoc = {
  functions?: Array<{
    name: string;
    file: string;
    calls?: string[];
    stringLiterals?: string[];
    isAsync?: boolean;
  }>;
};

/**
 * Run search against codebase-intelligence.json + function-intelligence.json
 * and score recall against the ground-truth files and symbols from a benchmark task.
 */
export async function measureSearchRecall(params: {
  specsDir: string;
  query: string;
  groundTruthFiles: string[];
  groundTruthSymbols?: string[];
  k?: number;
}): Promise<SearchRecallResult> {
  const { specsDir, query, groundTruthFiles, groundTruthSymbols = [], k = DEFAULT_K } = params;

  const intelPath = path.join(specsDir, "machine", "codebase-intelligence.json");
  let intel: IntelDoc;
  try {
    const raw = await fs.readFile(intelPath, "utf8");
    intel = JSON.parse(raw);
  } catch {
    return emptyResult(k, groundTruthFiles, groundTruthSymbols);
  }

  // Also load function-intelligence.json if available (same as guardian_search MCP tool)
  let funcIntel: FuncIntelDoc | null = null;
  try {
    const funcRaw = await fs.readFile(path.join(specsDir, "machine", "function-intelligence.json"), "utf8");
    funcIntel = JSON.parse(funcRaw);
  } catch { /* optional */ }

  const { resultFiles, resultSymbols } = searchIntel(intel, funcIntel, query, k * 4);

  // Normalize ground truth for comparison (basename + full path both accepted)
  const gtFilesNorm = groundTruthFiles.map(normalizeFilePath);
  const gtSymbolsNorm = groundTruthSymbols.map((s) => s.toLowerCase());

  const topKFiles = resultFiles.slice(0, k);
  const topKSymbols = resultSymbols.slice(0, k);

  const filesFound = gtFilesNorm.filter((gt) =>
    topKFiles.some((r) => filePathMatches(r, gt))
  );
  const filesMissed = gtFilesNorm.filter((gt) =>
    !topKFiles.some((r) => filePathMatches(r, gt))
  );
  const symbolsFound = gtSymbolsNorm.filter((gt) =>
    topKSymbols.some((r) => r.toLowerCase() === gt)
  );
  const symbolsMissed = gtSymbolsNorm.filter((gt) =>
    !topKSymbols.some((r) => r.toLowerCase() === gt)
  );

  const truePositives = filesFound.length;
  const precision = topKFiles.length > 0 ? truePositives / Math.min(k, topKFiles.length) : 0;
  const recall = gtFilesNorm.length > 0 ? truePositives / gtFilesNorm.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision_at_k: round(precision),
    recall_at_k: round(recall),
    f1_at_k: round(f1),
    k,
    files_found: filesFound,
    files_missed: filesMissed,
    symbols_found: symbolsFound,
    symbols_missed: symbolsMissed,
    result_files: topKFiles,
    result_symbols: topKSymbols,
  };
}

// ── Internal search (mirrors mcp-serve.ts search() but returns structured data) ──

function searchIntel(intel: IntelDoc, funcIntel: FuncIntelDoc | null, query: string, limit: number): {
  resultFiles: string[];
  resultSymbols: string[];
} {
  const q = query.toLowerCase();
  const fileHits = new Map<string, number>(); // file → score
  const symbolHits = new Map<string, number>(); // symbol → score

  // Endpoints — path/handler weighted higher than service_calls, generic calls filtered
  for (const ep of Object.values(intel.api_registry || {})) {
    const pathScore    = scoreField(q, ep.path    ?? "", 1.0);
    const handlerScore = scoreField(q, ep.handler ?? "", 0.9);
    const callScore    = Math.max(0, ...(ep.service_calls ?? [])
      .filter((s: string) => !isGenericCall(s))
      .map((s: string) => scoreField(q, s, 0.5)));
    const score = Math.max(pathScore, handlerScore, callScore);
    if (score > 0 && ep.file) addHit(fileHits, ep.file, score);
    if (score > 0 && ep.handler) addHit(symbolHits, ep.handler, score);
  }

  // Models
  for (const m of Object.values(intel.model_registry || {})) {
    const nameScore  = scoreField(q, m.name ?? "", 1.0);
    const fieldScore = Math.max(0, ...(m.fields ?? []).map((f: string) => scoreField(q, f, 0.6)));
    const score = Math.max(nameScore, fieldScore);
    if (score > 0 && m.file) addHit(fileHits, m.file, score);
    if (score > 0 && m.name) addHit(symbolHits, m.name, score);
  }

  // Modules: id, imports, exports, files
  for (const mod of intel.service_map || []) {
    const modScore = scoreField(q, mod.id ?? "", 0.8);

    // Exports — symbol names are high specificity
    for (const sym of mod.exports || []) {
      const symScore = scoreField(q, sym, 1.0);
      if (symScore > 0) addHit(symbolHits, sym, symScore);
    }

    // Files — basename weighted higher than full path
    for (const f of mod.files || []) {
      const fileScore = Math.max(
        modScore,
        scoreField(q, path.basename(f), 1.0),  // filename is most specific
        scoreField(q, f, 0.5),                  // full path as fallback
      );
      if (fileScore > 0) addHit(fileHits, f, fileScore);
    }
  }

  // Enums
  for (const en of Object.values(intel.enum_registry || {})) {
    const score = scoreItem(q, [en.name, ...(en.values || [])]);
    if (score > 0 && en.file) addHit(fileHits, en.file, score);
    if (score > 0 && en.name) addHit(symbolHits, en.name, score);
  }

  // Background tasks
  for (const t of intel.background_tasks || []) {
    const score = scoreItem(q, [t.name, t.kind]);
    if (score > 0 && t.file) addHit(fileHits, t.file, score);
    if (score > 0 && t.name) addHit(symbolHits, t.name, score);
  }

  // Frontend pages
  for (const p of intel.frontend_pages || []) {
    const score = scoreItem(q, [p.path, p.component, ...(p.api_calls || [])]);
    if (score > 0 && p.component) addHit(symbolHits, p.component, score);
  }

  // Functions (from function-intelligence.json — same as guardian_search MCP)
  for (const fn of funcIntel?.functions || []) {
    const score = scoreItem(q, [fn.name, ...(fn.calls || []), ...(fn.stringLiterals || [])]);
    if (score > 0 && fn.file) addHit(fileHits, fn.file, score * 0.8); // slightly lower weight than structural
    if (score > 0) addHit(symbolHits, fn.name, score * 0.8);
  }

  const sortedFiles = [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f]) => f);

  const sortedSymbols = [...symbolHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([s]) => s);

  return { resultFiles: sortedFiles, resultSymbols: sortedSymbols };
}

/** Generic service_call patterns that pollute search (service.*, db.*, self.*, etc.) */
function isGenericCall(s: string): boolean {
  const genericPrefixes = ["service.", "self.", "db.", "session.", "response.", "request.", "app.", "router.", "logger.", "config.", "os.", "json.", "re.", "datetime.", "uuid."];
  return genericPrefixes.some(p => s.toLowerCase().startsWith(p));
}

/**
 * Score a query (possibly multi-word) against a field with a specificity weight.
 * weight=1.0 for filenames/symbol names, weight=0.5 for service_calls, etc.
 */
function scoreField(query: string, field: string, weight: number): number {
  const q = query.toLowerCase();
  const low = field.toLowerCase();
  const tokens = q.split(/\s+/).filter(t => t.length >= 3);
  if (low === q) return weight * 1.0;
  if (low.includes(q)) return weight * 0.8;
  if (tokens.length > 1 && tokens.every(t => low.includes(t))) return weight * 0.6;
  // Scale by fraction of tokens matched — more specific matches rank higher
  // 1-token match = 0.3, 2+ tokens = 0.45 (bonus for specificity without penalising long queries)
  const matched = tokens.filter(t => low.includes(t)).length;
  if (matched > 0) return weight * (matched >= 2 ? 0.45 : 0.3);
  return 0;
}

function scoreItem(query: string, fields: (string | undefined)[]): number {
  // Legacy: all fields treated at weight 1.0
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    best = Math.max(best, scoreField(query, f, 1.0));
  }
  return best;
}

function addHit(map: Map<string, number>, key: string, score: number) {
  map.set(key, Math.max(map.get(key) ?? 0, score));
}

function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function filePathMatches(result: string, groundTruth: string): boolean {
  const r = normalizeFilePath(result);
  const g = normalizeFilePath(groundTruth);
  return r === g || r.endsWith("/" + g) || g.endsWith("/" + r) ||
    path.basename(r) === path.basename(g);
}

function emptyResult(k: number, gtFiles: string[], gtSymbols: string[]): SearchRecallResult {
  return {
    precision_at_k: 0, recall_at_k: 0, f1_at_k: 0, k,
    files_found: [], files_missed: gtFiles,
    symbols_found: [], symbols_missed: gtSymbols,
    result_files: [], result_symbols: [],
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
