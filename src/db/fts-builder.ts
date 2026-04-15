/**
 * FTS index builder — converts codebase-intelligence.json into FTS5 rows.
 *
 * One row per file: aggregates all endpoints, symbols, and descriptions
 * associated with that file so BM25 can rank files, not individual records.
 *
 * This is what fixes cases like csharp-auth-001 where the current linear
 * scorer misses Users/Login.cs because "auth" doesn't appear literally in
 * the file path — BM25 + porter stemmer ranks it via "login" + "user" + module.
 */

import path from "node:path";
import type { SqliteSpecsStore } from "./sqlite-specs-store.js";
import { normPath } from "./sqlite-specs-store.js";

const SOURCE_EXTS = new Set([".py",".ts",".tsx",".js",".jsx",".go",".java",".cs",".rb",".rs",".cpp",".c",".h",".php",".swift",".kt"]);
// Only filter true noise — dependency trees and test-only dirs.
// examples/, docs/, fixtures/ may contain real source files.
const NOISE_RE = /(?:^|\/)(?:test|tests|spec|specs|__pycache__|node_modules|vendor|\.git|\.tox|\.venv|venv)\//i;

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTS.has(ext) && !NOISE_RE.test(filePath);
}

export type FTSRow = {
  file_path: string;
  symbol_name: string;  // all symbols in this file, space-separated
  endpoint: string;     // all routes touching this file, space-separated
  body: string;         // description / docstring text
  module: string;
};

/**
 * Build FTS rows from a raw codebase-intelligence object.
 * The intel object is the parsed JSON from codebase-intelligence.json —
 * no schema changes, same structure as today.
 */
export function buildFTSRows(intel: any): FTSRow[] {
  // Per-file accumulators
  const files = new Map<string, FTSRow>();

  function getRow(filePath: string, module = ""): FTSRow | null {
    if (!isSourceFile(filePath)) return null;
    const normalised = normPath(filePath);
    if (!files.has(normalised)) {
      files.set(normalised, { file_path: normalised, symbol_name: "", endpoint: "", body: "", module });
    }
    return files.get(normalised)!;
  }

  function appendToken(row: FTSRow, field: keyof FTSRow, token: string) {
    if (!token) return;
    (row[field] as string) += (row[field] ? " " : "") + token;
  }

  // ── API registry: endpoints → files ──────────────────────────────────────
  for (const [route, entry] of Object.entries<any>(intel.api_registry ?? {})) {
    if (!entry.file) continue;
    const row = getRow(entry.file, entry.module ?? "");
    if (!row) continue;
    appendToken(row, "endpoint", route);
    appendToken(row, "symbol_name", entry.handler ?? "");
    if (entry.request_schema)  appendToken(row, "body", entry.request_schema);
    if (entry.response_schema) appendToken(row, "body", entry.response_schema);
    for (const sc of entry.service_calls ?? []) appendToken(row, "body", sc);
  }

  // ── Model registry: ORM models → files ───────────────────────────────────
  for (const [name, entry] of Object.entries<any>(intel.model_registry ?? {})) {
    if (!entry.file) continue;
    const row = getRow(entry.file, entry.module ?? "");
    if (!row) continue;
    appendToken(row, "symbol_name", name);
    for (const f of entry.fields ?? [])         appendToken(row, "body", f);
    for (const r of entry.relationships ?? [])  appendToken(row, "body", r);
  }

  // ── Enum registry ─────────────────────────────────────────────────────────
  for (const [name, entry] of Object.entries<any>(intel.enum_registry ?? {})) {
    if (!entry.file) continue;
    const row = getRow(entry.file, "");
    if (!row) continue;
    appendToken(row, "symbol_name", name);
    for (const v of entry.values ?? []) appendToken(row, "body", v);
  }

  // ── Service map: module files ─────────────────────────────────────────────
  for (const svc of intel.service_map ?? []) {
    for (const filePath of svc.files ?? []) {
      const row = getRow(filePath, svc.name ?? "");
      if (!row) continue;
      appendToken(row, "module", svc.name ?? "");
      for (const dep of svc.dependencies ?? []) appendToken(row, "body", dep);
    }
  }

  // ── Frontend pages ────────────────────────────────────────────────────────
  for (const page of intel.frontend_pages ?? []) {
    const filePath = page.file ?? page.component ?? page.path;
    if (!filePath) continue;
    const row = getRow(filePath, "frontend");
    if (!row) continue;
    appendToken(row, "endpoint", page.path ?? "");
    appendToken(row, "symbol_name", page.component ?? "");
    for (const api of page.api_calls ?? [])    appendToken(row, "body", api);
    for (const c of page.components ?? [])     appendToken(row, "body", c);
  }

  // ── Background tasks ──────────────────────────────────────────────────────
  for (const task of intel.background_tasks ?? []) {
    if (!task.file) continue;
    const row = getRow(task.file, task.module ?? "");
    if (!row) continue;
    appendToken(row, "symbol_name", task.name ?? "");
    appendToken(row, "body", task.queue ?? "");
  }

  return Array.from(files.values());
}

/**
 * Merge all data from architecture.snapshot into the FTS row map.
 * Covers: endpoints, data_models, enums, tasks, module files + exports.
 * This is the main enrichment for library repos with few intel entries.
 */
export function mergeArchitectureRows(rows: Map<string, FTSRow>, arch: any): void {
  function upsert(filePath: string, module = ""): FTSRow | null {
    if (!filePath) return null;
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext) || NOISE_RE.test(filePath)) return null;
    const norm = normPath(filePath);
    if (!rows.has(norm)) rows.set(norm, { file_path: norm, symbol_name: "", endpoint: "", body: "", module });
    return rows.get(norm)!;
  }
  function add(row: FTSRow, field: keyof FTSRow, token: string) {
    if (!token) return;
    (row[field] as string) += (row[field] ? " " : "") + token;
  }

  // ── arch.endpoints[] ─────────────────────────────────────────────────────
  for (const ep of arch.endpoints ?? []) {
    const row = upsert(ep.file, ep.module ?? "");
    if (!row) continue;
    add(row, "endpoint", ep.path ?? "");
    add(row, "endpoint", ep.method ?? "");
    add(row, "symbol_name", ep.handler ?? "");
    for (const sc of ep.service_calls ?? []) add(row, "body", sc);
  }

  // ── arch.data_models[] ───────────────────────────────────────────────────
  for (const m of arch.data_models ?? []) {
    const row = upsert(m.file, m.module ?? "");
    if (!row) continue;
    add(row, "symbol_name", m.name ?? "");
    for (const f of m.fields ?? [])        add(row, "body", f);
    for (const r of m.relationships ?? []) add(row, "body", r);
  }

  // ── arch.enums[] ─────────────────────────────────────────────────────────
  for (const e of arch.enums ?? []) {
    const row = upsert(e.file, "");
    if (!row) continue;
    add(row, "symbol_name", e.name ?? "");
    for (const v of e.values ?? []) add(row, "body", v);
  }

  // ── arch.tasks[] (background tasks / celery / etc.) ──────────────────────
  for (const t of arch.tasks ?? []) {
    const row = upsert(t.file, t.module ?? "");
    if (!row) continue;
    add(row, "symbol_name", t.name ?? "");
    add(row, "body", t.queue ?? "");
  }

  // ── arch.modules[].files + exports ────────────────────────────────────────
  // mod.exports is [{file, symbols: string[], exports: [...]}], not a flat string array
  for (const mod of arch.modules ?? []) {
    for (const filePath of mod.files ?? []) {
      const row = upsert(filePath, mod.id ?? mod.name ?? "");
      if (!row) continue;
      if (mod.id && !row.module) row.module = mod.id;
    }
    for (const expEntry of mod.exports ?? []) {
      // expEntry may be a string (old format) or {file, symbols} (new format)
      if (typeof expEntry === "string") {
        const row = upsert(expEntry, mod.id ?? "");
        if (row) add(row, "symbol_name", expEntry);
      } else if (expEntry && typeof expEntry === "object") {
        const row = upsert(expEntry.file ?? "", mod.id ?? "");
        if (!row) continue;
        for (const sym of expEntry.symbols ?? []) {
          if (typeof sym === "string") add(row, "symbol_name", sym);
        }
      }
    }
  }

  // ── arch.frontend_files[] ────────────────────────────────────────────────
  for (const ff of arch.frontend_files ?? []) {
    const filePath = ff.file ?? ff;
    upsert(typeof filePath === "string" ? filePath : "", "frontend");
  }
}

/**
 * Merge function-intelligence.json entries into the FTS row map.
 * Each function becomes a symbol_name token on its file's row.
 */
export function mergeFunctionIntelRows(rows: Map<string, FTSRow>, funcIntel: any): void {
  function upsert(filePath: string): FTSRow | null {
    if (!filePath) return null;
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext) || NOISE_RE.test(filePath)) return null;
    const norm = normPath(filePath);
    if (!rows.has(norm)) rows.set(norm, { file_path: norm, symbol_name: "", endpoint: "", body: "", module: "" });
    return rows.get(norm)!;
  }

  for (const fn of funcIntel.functions ?? []) {
    const row = upsert(fn.file ?? "");
    if (!row) continue;
    if (fn.name) row.symbol_name += (row.symbol_name ? " " : "") + fn.name;
    if (fn.docstring) row.body += (row.body ? " " : "") + fn.docstring;
    for (const p of fn.params ?? []) row.body += " " + p;
    for (const c of fn.calls ?? [])  row.body += " " + c;
  }
}

/**
 * Build import edges from arch.dependencies.file_graph.
 * Returns normalized {file, imports} pairs for all source-to-source edges.
 */
export function buildDepEdges(arch: any): Array<{ file: string; imports: string }> {
  const edges: Array<{ file: string; imports: string }> = [];
  const graph = arch?.dependencies?.file_graph;
  if (!graph) return edges;

  // file_graph may be a list of {from, to} edges (new format)
  // or a dict of {file: {imports: []}} (old format)
  if (Array.isArray(graph)) {
    for (const edge of graph) {
      const from = edge.from ?? edge.file;
      const to   = edge.to   ?? edge.imports;
      if (typeof from !== "string" || typeof to !== "string") continue;
      if (!isSourceFile(from) || !isSourceFile(to)) continue;
      const normFrom = normPath(from);
      const normTo   = normPath(to);
      edges.push({ file: normFrom, imports: normTo });
    }
  } else {
    for (const [file, info] of Object.entries<any>(graph)) {
      if (!isSourceFile(file)) continue;
      const normFile = normPath(file);
      const deps: string[] = info.imports ?? info.dependencies ?? [];
      for (const imp of deps) {
        if (typeof imp !== "string" || !isSourceFile(imp)) continue;
        edges.push({ file: normFile, imports: normPath(imp) });
      }
    }
  }
  return edges;
}

/**
 * Populate the FTS5 search_fts table + file_deps graph from all extract output.
 *   intel      — parsed codebase-intelligence.json
 *   arch       — parsed architecture.snapshot.yaml (optional)
 *   funcIntel  — parsed function-intelligence.json (optional)
 */
export function populateFTSIndex(
  store: SqliteSpecsStore,
  intel: any,
  arch?: any,
  funcIntel?: any,
): void {
  const rowMap = new Map<string, FTSRow>();
  for (const row of buildFTSRows(intel)) rowMap.set(row.file_path, row);
  if (arch)      mergeArchitectureRows(rowMap, arch);
  if (funcIntel) mergeFunctionIntelRows(rowMap, funcIntel);

  // Deduplicate paths where one is a suffix of another — caused when the snapshot
  // stores some paths relative to backendRoot ("db/store.ts") and others relative
  // to the workspace root ("src/db/store.ts"). Keep the longer (workspace-relative)
  // path and merge any unique tokens from the shorter entry into it.
  const paths = Array.from(rowMap.keys());
  for (const shorter of paths) {
    for (const longer of paths) {
      if (shorter === longer) continue;
      if (longer.endsWith("/" + shorter) && rowMap.has(shorter) && rowMap.has(longer)) {
        const s = rowMap.get(shorter)!;
        const l = rowMap.get(longer)!;
        // Merge any tokens the shorter row had that the longer lacks
        for (const field of ["symbol_name", "endpoint", "body", "module"] as const) {
          if (s[field] && !l[field].includes(s[field])) {
            l[field] = l[field] ? l[field] + " " + s[field] : s[field];
          }
        }
        rowMap.delete(shorter);
        break;
      }
    }
  }

  store.rebuildSearchIndex(Array.from(rowMap.values()));

  // Per-function index — enables symbol-level search results with line numbers.
  if (funcIntel?.functions?.length) {
    store.rebuildFunctionIndex(funcIntel.functions);
  }

  // Build dependency graph
  if (arch) {
    const edges = buildDepEdges(arch);
    store.rebuildDeps(edges);
  }

  // ── Normalised fact tables ─────────────────────────────────────────────────
  // Merge arch endpoints + intel api_registry into endpoints_raw.
  // arch.endpoints is the richer source (has method + file); intel.api_registry adds
  // request/response schemas and service_calls that arch may not have.
  const endpointMap = new Map<string, {
    method: string; path: string; handler: string; file_path: string; module: string;
    service_calls: string[]; request_schema: string; response_schema: string;
  }>();
  for (const ep of arch?.endpoints ?? []) {
    const key = `${(ep.method ?? "").toUpperCase()}::${ep.path ?? ""}`;
    if (!ep.path) continue;
    endpointMap.set(key, {
      method: ep.method ?? "",
      path: ep.path,
      handler: ep.handler ?? "",
      file_path: ep.file ?? ep.file_path ?? "",
      module: ep.module ?? "",
      service_calls: ep.service_calls ?? [],
      request_schema: "",
      response_schema: "",
    });
  }
  for (const [route, entry] of Object.entries<any>(intel?.api_registry ?? {})) {
    // route is like "GET /users" or "/users"
    const parts = route.trim().split(/\s+/);
    const method = parts.length >= 2 ? parts[0].toUpperCase() : "";
    const p      = parts.length >= 2 ? parts[1] : parts[0];
    const key = `${method}::${p}`;
    const existing = endpointMap.get(key);
    if (existing) {
      if (entry.request_schema)  existing.request_schema  = entry.request_schema;
      if (entry.response_schema) existing.response_schema = entry.response_schema;
      if (entry.service_calls?.length) existing.service_calls = entry.service_calls;
    } else {
      endpointMap.set(key, {
        method,
        path: p,
        handler: entry.handler ?? "",
        file_path: entry.file ?? "",
        module: entry.module ?? "",
        service_calls: entry.service_calls ?? [],
        request_schema: entry.request_schema ?? "",
        response_schema: entry.response_schema ?? "",
      });
    }
  }
  store.rebuildEndpointsRaw(Array.from(endpointMap.values()));

  // Merge arch data_models + intel model_registry into models_raw.
  const modelMap = new Map<string, {
    name: string; file_path: string; module: string; fields: string[]; relationships: string[];
  }>();
  for (const m of arch?.data_models ?? []) {
    if (!m.name) continue;
    modelMap.set(m.name, {
      name: m.name,
      file_path: m.file ?? m.file_path ?? "",
      module: m.module ?? "",
      fields: m.fields ?? [],
      relationships: m.relationships ?? [],
    });
  }
  for (const [name, entry] of Object.entries<any>(intel?.model_registry ?? {})) {
    const existing = modelMap.get(name);
    if (existing) {
      if (entry.fields?.length)        existing.fields        = entry.fields;
      if (entry.relationships?.length) existing.relationships = entry.relationships;
    } else {
      modelMap.set(name, {
        name,
        file_path: entry.file ?? "",
        module: entry.module ?? "",
        fields: entry.fields ?? [],
        relationships: entry.relationships ?? [],
      });
    }
  }
  store.rebuildModelsRaw(Array.from(modelMap.values()));
}
