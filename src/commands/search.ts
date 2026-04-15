import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { loadHeatmap, type DriftHeatmap } from "../extract/compress.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../extract/types.js";
import {
  loadFunctionIntelligence,
  type FunctionIntelligence,
} from "../extract/function-intel.js";
import { resolveMachineInputDir } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";

type SearchType = "models" | "endpoints" | "components" | "modules" | "tasks" | "functions" | "files";

export type SearchOptions = {
  input: string;
  /** Semantic search query — required unless a mode flag is set */
  query?: string;
  output?: string;
  types?: string[];
  /** Max function hits to return (default 10). Keeps output focused. */
  topN?: number;
  /** Storage backend: "file" (default linear scan), "sqlite" (FTS5/BM25), or "auto" (sqlite if guardian.db exists) */
  backend?: "file" | "sqlite" | "auto";
  /** Project root for path relativization (default: process.cwd()) */
  projectRoot?: string;
  /** Use verbose grouped output instead of compact file-first format */
  verbose?: boolean;
  // ── Mode flags (mutually exclusive with query) ──
  /** Return architecture-context.md as compact JSON */
  orient?: boolean;
  /** Return file/endpoint context from codebase-intelligence.json */
  file?: string;
  /** Return model details from codebase-intelligence.json */
  model?: string;
  /** Return impact analysis from codebase-intelligence.json */
  impact?: string;
  /** Output format for --query: "text" (default) or "json" (categorical) */
  format?: "text" | "json";
};

type SearchMatch = {
  type: SearchType;
  name: string;
  score: number;
  markdown: string[];
};

export async function runSearch(options: SearchOptions): Promise<void> {
  const inputDir = await resolveMachineInputDir(options.input || DEFAULT_SPECS_DIR);

  // ── SQLite/FTS5 backend: BM25-ranked search via guardian.db ──────────────
  // SQLite is primary for ALL formats when guardian.db exists.
  // File-based search is only a fallback for backward compatibility.
  if ((options.backend === "sqlite" || options.backend === "auto") && options.query) {
    if (options.format === "json") {
      // For JSON output (used by MCP): merge BM25-ranked files into querySearch output
      const sqliteResult = await getSqliteFileList(options.input || DEFAULT_SPECS_DIR, options.query, options.topN ?? 20, options.backend);
      if (sqliteResult !== null) {
        const base = JSON.parse(await querySearch(inputDir, options.query));
        base.files = sqliteResult.files;
        base.symbols = sqliteResult.symbols;
        base.search_signal = sqliteResult.signal;
        console.log(JSON.stringify(base));
        return;
      }
      // No guardian.db — fall through to file-based querySearch below
    } else {
      const handled = await runSearchSqlite(options.input || DEFAULT_SPECS_DIR, options.query, options.topN ?? 20, options.backend);
      if (handled) return; // false = no guardian.db, fall through to file search
    }
  }

  // ── Mode dispatch: intel-based lookups ──
  if (options.orient) {
    console.log(await queryOrient(inputDir));
    return;
  }
  if (options.file) {
    console.log(await queryFile(inputDir, options.file));
    return;
  }
  if (options.model) {
    console.log(await queryModel(inputDir, options.model));
    return;
  }
  if (options.impact) {
    console.log(await queryImpact(inputDir, options.impact));
    return;
  }

  // ── Semantic search ──
  if (!options.query) {
    console.error("Error: --query is required for semantic search (or use --orient / --file / --model / --impact)");
    process.exit(1);
  }

  if (options.format === "json") {
    // Fallback: file-based categorical search (no guardian.db available)
    console.log(await querySearch(inputDir, options.query));
    return;
  }

  const { architecture, ux } = await loadSnapshots(inputDir);
  const heatmap = await loadHeatmap(inputDir);
  const funcIntel = await loadFunctionIntelligence(inputDir);
  const types = normalizeTypes(options.types);
  const projectRoot = options.projectRoot ?? process.cwd();
  const matches = searchSnapshots({
    architecture,
    ux,
    query: options.query,
    types,
    heatmap,
    funcIntel,
    projectRoot,
    topN: options.topN ?? 10,
  });
  const content = options.verbose
    ? renderSearchMarkdownVerbose(options.query, matches)
    : renderSearchMarkdown(options.query, matches);

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf8");
    console.log(`Wrote ${outputPath}`);
    return;
  }

  console.log(content);
}

// ── SQLite / FTS5 search path ────────────────────────────────────────────────

/**
 * Preprocess a user query before FTS5 matching.
 * Strips commit-message noise (issue numbers, conventional commit prefixes, PR refs)
 * and expands camelCase/snake_case identifiers so BM25 ranks them correctly.
 */
function preprocessSearchQuery(q: string): string {
  return q
    // Remove PR/issue references: (#1234) or #1234
    .replace(/\(#\d+\)/g, "")
    .replace(/#\d+\s*/g, "")
    // Remove conventional commit prefixes: "Fixed #37016 --", "Refs #28455 --"
    .replace(/^(?:Fixed|Refs|Closes|Resolved)\s*(?:#\d+\s*)?--?\s*/i, "")
    // Remove conventional commit types: "feat(deps)!:", "chore:", "docs:", etc.
    .replace(/^(?:feat|fix|chore|docs|test|refactor|style|perf|ci|build)(?:\([^)]+\))?!?:\s*/i, "")
    // Remove double dashes
    .replace(/\s*--\s*/g, " ")
    // Expand camelCase: getUserById → get user by id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Expand snake_case: get_user_by_id → get user by id
    .replace(/_/g, " ")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns false if no guardian.db found and backend is "auto" (caller should fall through to file search).
 * Exits the process if backend is "sqlite" and no db found.
 */
async function runSearchSqlite(specsInput: string, query: string, limit: number, backend: "sqlite" | "auto" = "sqlite"): Promise<boolean> {
  const { openSpecsStore } = await import("../db/index.js");
  const { SqliteSpecsStore } = await import("../db/sqlite-specs-store.js");
  const { getOutputLayout } = await import("../output-layout.js");

  const layout = getOutputLayout(path.resolve(specsInput));
  const store = await openSpecsStore(layout, { backend });

  try {
    if (!(store instanceof SqliteSpecsStore)) {
      if (backend === "auto") return false; // fall through to file search
      console.error("guardian.db not found — run `guardian extract --backend sqlite` first.");
      process.exit(1);
    }

    const cleaned = preprocessSearchQuery(query);
    let results = store.searchWithGraph(cleaned, limit);

    // If preprocessed query returns nothing, try the raw query as a fallback
    if (results.length === 0 && cleaned !== query) {
      results = store.searchWithGraph(query, limit);
    }

    if (results.length === 0) {
      if (backend === "auto") return false; // fall through to file-based search
      console.log(`No FTS results for "${query}"`);
      return true;
    }

    let queryVec: Float32Array | undefined;
    try {
      const { embedQuery } = await import("../db/embeddings.js");
      const vec = await embedQuery(cleaned || query, process.env.OPENAI_API_KEY);
      if (vec) queryVec = vec;
    } catch { /* graceful degradation */ }

    const symbols = store.searchSymbols(cleaned || query, Math.ceil(limit / 2), queryVec);

    const lines: string[] = [`## FTS5 search: "${query}"\n`];
    // Build a map of file → matching symbols for quick lookup
    const symbolsByFile = new Map<string, Array<{ name: string; line: number }>>();
    for (const s of symbols) {
      if (!symbolsByFile.has(s.file_path)) symbolsByFile.set(s.file_path, []);
      symbolsByFile.get(s.file_path)!.push({ name: s.name, line: s.line });
    }

    for (const r of results) {
      const rank = Math.abs(r.rank).toFixed(3);
      lines.push(`### \`${r.file_path}\`  (score: ${rank})`);
      // Matching symbols from this file (snippet equivalent)
      const fileSyms = symbolsByFile.get(r.file_path) ?? [];
      const inlineSyms = r.matching_symbols.filter(s => !fileSyms.some(f => f.name === s));
      if (fileSyms.length) {
        for (const s of fileSyms) lines.push(`  → \`${s.name}\` :${s.line}`);
      }
      if (inlineSyms.length) {
        lines.push(`  symbols: ${inlineSyms.join(", ")}`);
      }
      if (r.imports.length)  lines.push(`  imports: ${r.imports.join(", ")}`);
      if (r.used_by.length)  lines.push(`  used by: ${r.used_by.join(", ")}`);
      lines.push("");
    }
    console.log(lines.join("\n"));
    return true;
  } finally {
    await store.close();
  }
}

/**
 * Returns BM25-ranked file paths from SQLite FTS5 for JSON consumers (e.g. MCP).
 * Returns null when guardian.db doesn't exist OR FTS returns 0 results
 * so the caller falls through to file-based querySearch().
 */
type SqliteFileResult = {
  files: string[];
  symbols: Array<{ file: string; name: string; line: number }>;
  signal: { score: number; confidence: "high" | "medium" | "low"; reason: string };
};

async function getSqliteFileList(specsInput: string, query: string, limit: number, backend: "sqlite" | "auto" = "auto"): Promise<SqliteFileResult | null> {
  const { openSpecsStore } = await import("../db/index.js");
  const { SqliteSpecsStore } = await import("../db/sqlite-specs-store.js");
  const { getOutputLayout } = await import("../output-layout.js");

  const layout = getOutputLayout(path.resolve(specsInput));
  const store = await openSpecsStore(layout, { backend });

  try {
    if (!(store instanceof SqliteSpecsStore)) {
      return null; // no guardian.db — caller uses file-based fallback
    }

    const cleaned = preprocessSearchQuery(query);
    let results = store.searchWithGraph(cleaned, limit);

    // If preprocessed query returns nothing, try raw query
    if (results.length === 0 && cleaned !== query) {
      results = store.searchWithGraph(query, limit);
    }

    // Return null on 0 results so caller can fall back to querySearch()
    if (results.length === 0) return null;

    const signal = store.querySignal(query);

    // Hybrid symbol search: BM25 + call-graph authority + optional vector similarity.
    // embedQuery uses local model (no API key) or OpenAI if OPENAI_API_KEY is set.
    let queryVec: Float32Array | undefined;
    try {
      const { embedQuery } = await import("../db/embeddings.js");
      const vec = await embedQuery(cleaned || query, process.env.OPENAI_API_KEY);
      if (vec) queryVec = vec;
    } catch { /* graceful degradation — vector unavailable */ }

    const symbols = store.searchSymbols(cleaned || query, Math.ceil(limit / 2), queryVec);
    return {
      files: results.map((r) => r.file_path),
      symbols: symbols.map((s) => ({ file: s.file_path, name: s.name, line: s.line })),
      signal,
    };
  } finally {
    await store.close();
  }
}

// ── File-based snapshots loader (original, unchanged) ────────────────────────

async function loadSnapshots(
  inputDir: string
): Promise<{ architecture: ArchitectureSnapshot; ux: UxSnapshot }> {
  const architecturePath = path.join(inputDir, "architecture.snapshot.yaml");
  const uxPath = path.join(inputDir, "ux.snapshot.yaml");
  let architectureRaw: string;
  let uxRaw: string;
  try {
    [architectureRaw, uxRaw] = await Promise.all([
      fs.readFile(architecturePath, "utf8"),
      fs.readFile(uxPath, "utf8")
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Could not find snapshots in ${inputDir}. Run \`guardian extract\` first.`
      );
    }
    throw error;
  }

  return {
    architecture: yaml.load(architectureRaw) as ArchitectureSnapshot,
    ux: yaml.load(uxRaw) as UxSnapshot
  };
}

function normalizeTypes(types?: string[]): Set<SearchType> {
  const ALL_TYPES: SearchType[] = ["models", "endpoints", "components", "modules", "tasks", "files"];

  if (!types || types.length === 0) {
    return new Set(ALL_TYPES);
  }

  const normalized = new Set<SearchType>();
  for (const entry of types) {
    for (const part of entry.split(",").map((value) => value.trim().toLowerCase())) {
      if (ALL_TYPES.includes(part as SearchType) || part === "functions") {
        normalized.add(part as SearchType);
      }
    }
  }

  return normalized.size > 0
    ? normalized
    : new Set([...ALL_TYPES, "functions"]);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/.{}-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreItem(
  queryTokens: string[],
  item: {
    name: string;
    file?: string;
    text: string[];
  }
): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalizedName = item.name.toLowerCase();
  const normalizedFile = (item.file ?? "").toLowerCase();
  const normalizedText = item.text
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
  let total = 0;

  for (const token of queryTokens) {
    if (normalizedName === token) {
      total += 1;
      continue;
    }
    if (normalizedName.includes(token)) {
      total += 0.7;
      continue;
    }
    if (normalizedText.some((entry) => entry.includes(token))) {
      total += 0.4;
      continue;
    }
    if (normalizedFile.includes(token)) {
      total += 0.2;
      continue;
    }
  }

  const phrase = queryTokens.join(" ");
  if (phrase && normalizedName.includes(phrase)) {
    total += 0.15;
  }

  return Math.min(1, total / queryTokens.length);
}

function searchSnapshots(params: {
  architecture: ArchitectureSnapshot;
  ux: UxSnapshot;
  query: string;
  types: Set<SearchType>;
  heatmap: DriftHeatmap | null;
  funcIntel: FunctionIntelligence | null;
  projectRoot: string;
  topN: number;
}): SearchMatch[] {
  const { architecture, ux, query, types, heatmap, funcIntel, projectRoot, topN } = params;
  const queryTokens = tokenize(query);
  const matches: SearchMatch[] = [];
  const pageUsage = buildComponentPageUsage(ux);
  const moduleHeatmap = new Map(
    (heatmap?.levels.find((level) => level.level === "module")?.entries ?? []).map((entry) => [
      entry.id,
      entry.score
    ])
  );
  // PageRank scores per file — prefer file-level heatmap, fall back to module-level
  // (maps absolute or relative file path → pagerank score in [0,1])
  const filePrFromFileLevel = new Map(
    (heatmap?.levels.find((level) => level.level === "file")?.entries ?? []).map((entry) => [
      entry.id,
      entry.components.pagerank ?? 0
    ])
  );
  // Build file→module map so we can use module-level PR when file-level is unavailable
  const fileToModuleId = new Map<string, string>();
  for (const mod of architecture.modules) {
    for (const f of mod.files) {
      fileToModuleId.set(f, mod.id);
      fileToModuleId.set(path.join(projectRoot, f), mod.id);
    }
  }
  const modulePrMap = new Map(
    (heatmap?.levels.find((level) => level.level === "module")?.entries ?? []).map((entry) => [
      entry.id,
      entry.components.pagerank ?? 0
    ])
  );
  const getFilePr = (filePath: string): number => {
    const direct = filePrFromFileLevel.get(filePath);
    if (direct !== undefined) return direct;
    const modId = fileToModuleId.get(filePath) ?? fileToModuleId.get(path.relative(projectRoot, filePath));
    return modulePrMap.get(modId ?? "") ?? 0;
  };

  if (types.has("models")) {
    for (const model of architecture.data_models) {
      const score = scoreItem(queryTokens, {
        name: model.name,
        file: model.file,
        text: [...model.fields, ...model.relationships, model.framework]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "models",
        name: model.name,
        score,
        markdown: [
          `**${model.name}** · ${model.file}`,
          `Fields: ${formatList(model.fields, 8)}`,
          `Relations: ${formatList(model.relationships, 8)}`
        ]
      });
    }
  }

  if (types.has("endpoints")) {
    for (const endpoint of architecture.endpoints) {
      const score = scoreItem(queryTokens, {
        name: `${endpoint.method} ${endpoint.path}`,
        file: endpoint.file,
        text: [
          endpoint.handler,
          endpoint.module,
          endpoint.request_schema ?? "",
          endpoint.response_schema ?? "",
          ...endpoint.service_calls
        ]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "endpoints",
        name: `${endpoint.method} ${endpoint.path}`,
        score,
        markdown: [
          `${endpoint.method.padEnd(4, " ")} ${endpoint.path} → ${endpoint.handler} (${endpoint.file})`,
          `Module: ${endpoint.module} · Request: ${endpoint.request_schema ?? "none"} · Response: ${endpoint.response_schema ?? "none"}`
        ]
      });
    }
  }

  if (types.has("components")) {
    for (const component of ux.components) {
      const score = scoreItem(queryTokens, {
        name: component.name,
        file: component.file,
        text: [
          component.kind,
          component.export_kind,
          ...(component.props ?? []).map((prop) => `${prop.name}:${prop.type}`)
        ]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "components",
        name: component.name,
        score,
        markdown: [
          `**${component.name}** · ${component.file} · import: ${component.export_kind ?? "unknown"}`,
          `Props: ${formatProps(component.props)}`,
          `Used by: ${formatList(pageUsage.get(component.id) ?? [], 4)}`
        ]
      });
    }
  }

  if (types.has("modules")) {
    for (const module of architecture.modules) {
      const score = scoreItem(queryTokens, {
        name: module.id,
        file: module.path,
        text: [...module.files, ...module.endpoints, ...module.imports]
      });
      if (score <= 0) {
        continue;
      }
      const couplingScore = moduleHeatmap.get(module.id);
      matches.push({
        type: "modules",
        name: module.id,
        score,
        markdown: [
          `**${module.id}** · ${module.path} · ${module.files.length} files${
            typeof couplingScore === "number"
              ? ` · coupling score: ${couplingScore.toFixed(2)}`
              : ""
          }`,
          `Contains: ${formatList(module.files, 4)}`
        ]
      });
    }
  }

  if (types.has("tasks")) {
    for (const task of architecture.tasks) {
      const score = scoreItem(queryTokens, {
        name: task.name,
        file: task.file,
        text: [task.kind, task.queue ?? "", task.schedule ?? ""]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "tasks",
        name: task.name,
        score,
        markdown: [
          `**${task.name}** · ${task.file}`,
          `Kind: ${task.kind}${task.queue ? ` · Queue: ${task.queue}` : ""}${
            task.schedule ? ` · Schedule: ${task.schedule}` : ""
          }`
        ]
      });
    }
  }

  if (types.has("files")) {
    // Language-agnostic file search — searches ALL file paths across arch + ux modules.
    // Frontend paths stored as "app/..." (relative to frontend root) are normalized to
    // "frontend/app/..." so results are consistent and directly openable.
    // Ranked by: query token overlap in path + filename + PageRank of the file.

    // Collect all files: arch modules (project-relative) + ux component files (frontend-root-relative)
    type FilEntry = { filePath: string; module: string; pagerank: number };
    const allFiles = new Map<string, FilEntry>(); // keyed by normalized project-relative path

    // Helper: normalize a path to project-relative form
    const normalizePath = (rawPath: string, moduleId: string): string => {
      if (rawPath.startsWith("frontend/") || rawPath.startsWith("backend/")) return rawPath;
      // UX snapshot stores paths relative to frontend root (e.g. "app/parent/login.tsx")
      if (moduleId.startsWith("frontend/")) return `frontend/${rawPath}`;
      return rawPath;
    };

    for (const mod of architecture.modules) {
      for (const f of mod.files) {
        const norm = normalizePath(f, mod.id);
        const pr = getFilePr(f) || getFilePr(norm);
        allFiles.set(norm, { filePath: norm, module: mod.id, pagerank: pr });
      }
    }
    // Also collect ux component files (may not be in arch modules)
    for (const comp of ux.components) {
      if (!comp.file) continue;
      const norm = normalizePath(comp.file, "frontend/app");
      if (!allFiles.has(norm)) {
        allFiles.set(norm, { filePath: norm, module: "frontend/app", pagerank: getFilePr(norm) });
      }
    }

    for (const { filePath, module: modId, pagerank } of allFiles.values()) {
      const filename = path.basename(filePath);
      const stem = filename.replace(/\.[^.]+$/, ""); // without extension
      // Score: query overlap against path segments + filename stem
      const pathSegments = filePath.split("/");
      const queryScore = scoreItem(queryTokens, {
        name: stem,
        file: filePath,
        text: pathSegments
      });
      if (queryScore <= 0) continue;

      // Blend query relevance + PageRank (architecturally important files surface higher)
      const score = 0.7 * queryScore + 0.3 * pagerank;

      matches.push({
        type: "files",
        name: filePath,
        score,
        markdown: [
          `${filePath} [${modId}]${pagerank > 0.5 ? " · high-pagerank" : ""}`
        ]
      });
    }
  }

  if (types.has("functions") && funcIntel) {
    const queryTokens = tokenize(query);
    const fnMatches: SearchMatch[] = [];

    // Build a map: file → model field names (feature 3 — field augmentation)
    const fileToFields = new Map<string, string[]>();
    for (const model of architecture.data_models) {
      if (!model.file) continue;
      const existing = fileToFields.get(model.file) ?? [];
      fileToFields.set(model.file, [...existing, ...model.fields]);
    }

    // Helper: relativize a path if it looks absolute
    const relativize = (filePath: string): string => {
      if (!path.isAbsolute(filePath)) return filePath;
      return path.relative(projectRoot, filePath);
    };

    // Helper: build detail lines for a function hit
    const buildDetail = (fn: (typeof funcIntel.functions)[number], relFile: string): string[] => {
      const detail: string[] = [];
      if (fn.stringLiterals.length > 0) {
        detail.push(`Literals: ${formatList(fn.stringLiterals.slice(0, 3).map((l) => `"${l.slice(0, 60)}"`), 3)}`);
      }
      if (fn.regexPatterns.length > 0) {
        detail.push(`Patterns: ${formatList(fn.regexPatterns.slice(0, 3).map((p) => `/${p.slice(0, 60)}/`), 3)}`);
      }
      if (fn.calls.length > 0) {
        detail.push(`Calls: ${formatList(fn.calls, 5)}`);
      }
      // Feature 3 — append model field names for the file this function lives in
      const fields = fileToFields.get(fn.file) ?? fileToFields.get(relFile);
      if (fields && fields.length > 0) {
        detail.push(`Model fields: ${formatList(fields.slice(0, 8), 8)}`);
      }
      return detail;
    };

    // 1. Name match — function / theorem name contains a query token
    for (const fn of funcIntel.functions) {
      const queryScore = scoreItem(queryTokens, {
        name: fn.name,
        file: fn.file,
        text: [...fn.stringLiterals, ...fn.regexPatterns, ...fn.calls, fn.language],
      });
      if (queryScore <= 0) continue;

      // Blend: 70% query relevance + 30% file PageRank (importance of the file in the graph)
      const pr = getFilePr(fn.file);
      const score = 0.7 * queryScore + 0.3 * pr;

      const relFile = relativize(fn.file);
      const lineRange = `${fn.lines[0]}–${fn.lines[1]}`;
      const detail = buildDetail(fn, relFile);

      fnMatches.push({
        type: "functions",
        name: `${fn.name} (${fn.language})`,
        score,
        markdown: [
          `**${fn.name}** · ${relFile}:${lineRange} · ${fn.language}${fn.isAsync ? " · async" : ""}`,
          ...detail,
        ],
      });
    }

    // 2. Literal index match — query token appears in a function's string/regex literals
    // Uses proper scoreItem() ranking instead of hardcoded 0.6 to prevent noise flooding.
    for (const tok of queryTokens) {
      const hits = funcIntel.literal_index[tok.toLowerCase()];
      if (!hits) continue;
      for (const hit of hits) {
        // Skip if we already emitted this function via name match above
        if (fnMatches.some((m) => m.type === "functions" && m.name.startsWith(hit.function + " ("))) {
          continue;
        }
        const fn = funcIntel.functions.find(
          (f) => f.file === hit.file && f.name === hit.function
        );
        if (!fn) continue;

        const queryScore = scoreItem(queryTokens, {
          name: fn.name,
          file: fn.file,
          text: [...fn.stringLiterals, ...fn.regexPatterns, ...fn.calls, fn.language],
        });
        const pr = getFilePr(fn.file);
        const score = Math.max(0.7 * queryScore + 0.3 * pr, 0.2);

        const relFile = relativize(fn.file);
        const detail = buildDetail(fn, relFile);
        fnMatches.push({
          type: "functions",
          name: `${fn.name} (${fn.language})`,
          score,
          markdown: [
            `**${fn.name}** · ${relFile}:${fn.lines[0]}–${fn.lines[1]} · ${fn.language}`,
            `Matched literal/pattern containing "${tok}"`,
            ...detail,
          ],
        });
      }
    }

    // Feature 2 — rank by score, cap at topN to prevent context flooding
    fnMatches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    matches.push(...fnMatches.slice(0, topN));
  }

  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function buildComponentPageUsage(ux: UxSnapshot): Map<string, string[]> {
  const usage = new Map<string, Set<string>>();

  for (const page of ux.pages) {
    const pageLabel = `${page.component} (${page.path})`;
    const ids = new Set<string>([
      page.component_id,
      ...page.components_direct_ids,
      ...page.components_descendants_ids
    ]);
    for (const id of ids) {
      const entry = usage.get(id) ?? new Set<string>();
      entry.add(pageLabel);
      usage.set(id, entry);
    }
  }

  return new Map(
    Array.from(usage.entries()).map(([id, pages]) => [
      id,
      Array.from(pages).sort((a, b) => a.localeCompare(b))
    ])
  );
}

function formatList(items: string[], limit: number): string {
  if (!items || items.length === 0) {
    return "none";
  }
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
}

function formatProps(
  props: UxSnapshot["components"][number]["props"] | undefined
): string {
  if (!props || props.length === 0) {
    return "none";
  }
  return props
    .slice(0, 6)
    .map((prop) => `${prop.name}${prop.optional ? "?" : ""}: ${prop.type}`)
    .join(", ");
}

/**
 * Compact file-first renderer — the default for agent navigation.
 *
 * Deduplicates by file path and emits one line per file:
 *   backend/service-auth/main.py  [create_child, PersonaCreateRequest, ...]
 *
 * Keeps total output small so LLMs can extract the answer without wading
 * through hundreds of match lines. Capped at 15 files max.
 */
function renderSearchMarkdown(query: string, matches: SearchMatch[]): string {
  if (matches.length === 0) {
    return `# Search: "${query}"\n\n*No matches found.*`;
  }

  // Build a file → {score, symbols} map. Each match contributes its file path
  // and a short symbol label extracted from the first markdown line.
  const fileMap = new Map<string, { score: number; symbols: string[] }>();

  const extractFile = (md: string[], matchType: SearchType): string | null => {
    // Modules are collections — their path isn't a usable file path; skip them.
    if (matchType === "modules") return null;
    const first = md[0] ?? "";
    // Endpoint format: "POST /path → handler (file.py)"
    let m = first.match(/\(([^)]+)\)\s*$/);
    if (m) return m[1].trim();
    // Files type: bare path at start, no bold markdown — check before model format
    // "path/to/file [module]" or "path/to/file [module] · high-pagerank"
    m = first.match(/^([^\s[*]+)\s+\[/);
    if (m) return m[1].trim();
    // Model/component/task/function: "**Name** · file.py ..."
    m = first.match(/·\s+([^\s·:]+)\s*(?:·|$)/);
    if (m) return m[1].trim();
    return null;
  };

  const extractSymbol = (md: string[], matchType: SearchType): string | null => {
    const first = md[0] ?? "";
    if (matchType === "endpoints") {
      // "POST /path → handler (file)" → extract "handler"
      const m = first.match(/→\s+(\S+)\s+\(/);
      return m ? m[1] : null;
    }
    if (matchType === "models" || matchType === "tasks" || matchType === "functions") {
      // "**Name** · file" → extract "Name"
      const m = first.match(/\*\*([^*]+)\*\*/);
      return m ? m[1] : null;
    }
    if (matchType === "components") {
      const m = first.match(/\*\*([^*]+)\*\*/);
      return m ? m[1] : null;
    }
    return null;
  };

  for (const match of matches) {
    const file = extractFile(match.markdown, match.type);
    if (!file) continue;
    const existing = fileMap.get(file);
    const symbol = extractSymbol(match.markdown, match.type);
    if (existing) {
      if (match.score > existing.score) existing.score = match.score;
      if (symbol && !existing.symbols.includes(symbol)) existing.symbols.push(symbol);
    } else {
      fileMap.set(file, { score: match.score, symbols: symbol ? [symbol] : [] });
    }
  }

  // Sort files by best score descending, cap at 15
  const ranked = Array.from(fileMap.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, 15);

  const lines: string[] = [];
  lines.push(`# Search: "${query}" — ${ranked.length} relevant files\n`);
  for (const [file, { symbols }] of ranked) {
    const sym = symbols.slice(0, 6).join(", ");
    lines.push(sym ? `${file}  [${sym}]` : file);
  }

  return lines.join("\n").trimEnd();
}

/**
 * Verbose grouped renderer — kept for human inspection (`--verbose`).
 */
function renderSearchMarkdownVerbose(query: string, matches: SearchMatch[]): string {
  const grouped = new Map<SearchType, SearchMatch[]>();
  for (const match of matches) {
    const entry = grouped.get(match.type) ?? [];
    entry.push(match);
    grouped.set(match.type, entry);
  }

  const labels: Array<[SearchType, string]> = [
    ["models", "Data Models"],
    ["endpoints", "Endpoints"],
    ["components", "Components"],
    ["modules", "Modules"],
    ["tasks", "Tasks"],
    ["files", "Files"],
    ["functions", "Functions"],
  ];

  const lines: string[] = [];
  lines.push(`# Search: "${query}" - ${matches.length} matches`);
  lines.push("");

  if (matches.length === 0) {
    lines.push("*No matches found.*");
    return lines.join("\n");
  }

  for (const [type, label] of labels) {
    const entries = grouped.get(type) ?? [];
    if (entries.length === 0) continue;
    lines.push(`## ${label} (${entries.length})`);
    lines.push("");
    for (const entry of entries.slice(0, 8)) {
      lines.push(...entry.markdown);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Intel-based query functions
// Read from pre-built intelligence files (written by VSCode plugin / guardian extract).
// These are the authoritative implementations — MCP tools call the CLI which calls these.
// ─────────────────────────────────────────────────────────────────────────────

async function loadCodebaseIntel(inputDir: string): Promise<any> {
  const intelPath = path.join(inputDir, "codebase-intelligence.json");
  try {
    const raw = await fs.readFile(intelPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { api_registry: {}, model_registry: {}, service_map: [], frontend_pages: [], enum_registry: {}, background_tasks: [], meta: {} };
  }
}

async function loadFuncIntelRaw(inputDir: string): Promise<any | null> {
  const fnPath = path.join(inputDir, "function-intelligence.json");
  try {
    const raw = await fs.readFile(fnPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Scoring (same algorithm as MCP, kept in sync) ──

const SKIP_SERVICES = new Set(["str", "dict", "int", "len", "float", "max", "join", "getattr", "lower", "open", "params.append", "updates.append"]);

function isGenericCall(s: string): boolean {
  if (SKIP_SERVICES.has(s)) return true;
  const genericPrefixes = ["service.", "self.", "db.", "session.", "response.", "request.", "app.", "router.", "logger.", "config.", "os.", "json.", "re.", "datetime.", "uuid."];
  return genericPrefixes.some(p => s.toLowerCase().startsWith(p));
}

function scoreQueryIntel(query: string, fields: { value: string; weight: number }[]): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let best = 0;
  for (const { value, weight } of fields) {
    if (!value) continue;
    const low = value.toLowerCase();
    if (low === query.toLowerCase()) { best = Math.max(best, weight * 1.0); continue; }
    if (low.includes(query.toLowerCase())) { best = Math.max(best, weight * 0.8); continue; }
    if (tokens.length > 1 && tokens.every(t => low.includes(t))) { best = Math.max(best, weight * 0.6); continue; }
    const matched = tokens.filter(t => t.length >= 3 && low.includes(t)).length;
    if (matched > 0) { best = Math.max(best, weight * (matched >= 2 ? 0.45 : 0.3)); }
  }
  return best;
}

function normalizeFilePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/\//g, "/");
}

function findModuleForFile(data: any, file: string) {
  const f = normalizeFilePath(file);
  return data.service_map?.find((m: any) => {
    const mp = normalizeFilePath(m.path || "");
    return mp && (f.startsWith(mp + "/") || f === mp);
  }) || data.service_map?.find((m: any) => {
    const mid = normalizeFilePath(m.id || "");
    return mid && f.includes(mid);
  });
}

function findEndpointsInFile(data: any, file: string): any[] {
  const f = normalizeFilePath(file);
  const basename = path.basename(f);
  return Object.values(data.api_registry || {}).filter((ep: any) => {
    const ef = normalizeFilePath(ep.file || "");
    return ef && (f.includes(ef) || ef.includes(f) || ef.endsWith(basename));
  });
}

function findModelsInFile(data: any, file: string): any[] {
  const f = normalizeFilePath(file);
  const basename = path.basename(f);
  return Object.values(data.model_registry || {}).filter((m: any) => {
    const mf = normalizeFilePath(m.file || "");
    return mf && (f.includes(mf) || mf.includes(f) || mf.endsWith(basename));
  });
}

// ── orient: architecture-context.md as compact JSON ──

export async function queryOrient(inputDir: string): Promise<string> {
  const contextPath = path.join(inputDir, "architecture-context.md");
  try {
    const raw = await fs.readFile(contextPath, "utf8");
    const match = raw.match(/<!-- guardian:context[^>]*-->([\s\S]*?)<!-- \/guardian:context -->/);
    if (match) {
      const lines = match[1].split("\n").map(l => l.trim()).filter(Boolean);
      const desc = raw.match(/Description: (.+)/)?.[1]?.slice(0, 120) ?? "";
      const map = lines.find(l => l.startsWith("**Backend:**")) ?? "";
      const modules = lines
        .filter(l => /^- \*\*[^*]+\*\*\s*\([^)]+\)/.test(l))
        .map(l => { const m = l.match(/\*\*([^*]+)\*\*\s*\(([^)]+)\)/); return m ? `${m[1]} (${m[2]})` : null; })
        .filter((x): x is string => x !== null);
      const deps = lines.filter(l => l.includes("→")).map(l => l.replace(/^- /, ""));
      const coupling = lines.filter(l => /score \d/.test(l)).map(l => l.replace(/^- /, "")).slice(0, 5);
      const modelEp = lines.filter(l => l.includes("endpoints) ->")).map(l => l.replace(/^- /, ""));
      return JSON.stringify({ desc, map, modules, deps, coupling, modelEp });
    }
  } catch {}
  const d = await loadCodebaseIntel(inputDir);
  const c = d.meta?.counts || {};
  const pages = (d.frontend_pages || []).map((p: any) => p.path);
  return JSON.stringify({ p: d.meta?.project, ep: c.endpoints, models: c.models, pg: c.pages, pages });
}

// ── file: per-file or per-endpoint context ──

export async function queryFile(inputDir: string, target: string): Promise<string> {
  const d = await loadCodebaseIntel(inputDir);
  const epMatch = target.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
  if (epMatch) {
    const ep: any = d.api_registry?.[`${epMatch[1].toUpperCase()} ${epMatch[2]}`]
      || Object.values(d.api_registry || {}).find((e: any) => e.method === epMatch[1].toUpperCase() && e.path === epMatch[2]);
    if (!ep) return JSON.stringify({ err: "not found" });
    const calls = (ep.service_calls || []).filter((s: string) => !SKIP_SERVICES.has(s));
    return JSON.stringify({ ep: `${ep.method} ${ep.path}`, h: ep.handler, f: ep.file, m: ep.module, req: ep.request_schema, res: ep.response_schema, calls, ai: ep.ai_operations?.length || 0 });
  }
  const file = normalizeFilePath(target);
  const mod = findModuleForFile(d, file);
  const eps = findEndpointsInFile(d, file);
  const models = findModelsInFile(d, file);
  const fileName = path.basename(file, path.extname(file));
  const calledBy: string[] = [];
  for (const ep of Object.values(d.api_registry || {}) as any[]) {
    if (ep.service_calls?.some((s: string) => s.toLowerCase().includes(fileName.toLowerCase()))) {
      calledBy.push(`${ep.method} ${ep.path}`);
    }
  }
  const calls = eps.flatMap((ep: any) => (ep.service_calls || []).filter((s: string) => !SKIP_SERVICES.has(s)));
  return JSON.stringify({ f: file, mod: mod ? [mod.id, mod.layer] : null, ep: eps.map((e: any) => `${e.method} ${e.path}`), models: models.map((m: any) => [m.name, m.fields?.length || 0]), calls: [...new Set(calls)], calledBy: calledBy.slice(0, 8) });
}

// ── model: model details + usage ──

export async function queryModel(inputDir: string, name: string): Promise<string> {
  const d = await loadCodebaseIntel(inputDir);
  const m = d.model_registry?.[name];
  if (!m) return JSON.stringify({ err: "not found", name });
  const usedBy = Object.values(d.api_registry || {})
    .filter((ep: any) => ep.request_schema === name || ep.response_schema === name)
    .map((ep: any) => `${ep.method} ${ep.path}`);
  return JSON.stringify({ name: m.name, fw: m.framework, f: m.file, fields: m.fields, rels: m.relationships, usedBy });
}

// ── impact: what breaks if you change this file ──

export async function queryImpact(inputDir: string, target: string): Promise<string> {
  const d = await loadCodebaseIntel(inputDir);
  const file = normalizeFilePath(target);
  const eps = findEndpointsInFile(d, file);
  const models = findModelsInFile(d, file);
  const modelNames = new Set(models.map((m: any) => m.name));
  const affectedEps = Object.values(d.api_registry || {}).filter((ep: any) =>
    (ep.request_schema && modelNames.has(ep.request_schema)) ||
    (ep.response_schema && modelNames.has(ep.response_schema))
  );
  const mod = findModuleForFile(d, file);
  const depMods = mod ? (d.service_map || []).filter((m: any) => m.imports?.includes(mod.id)) : [];
  const affectedPages = (d.frontend_pages || []).filter((p: any) =>
    p.api_calls?.some((call: string) => eps.some((ep: any) => call.includes(ep.path?.split("{")[0])))
  );
  const total = eps.length + affectedEps.length + depMods.length + affectedPages.length;
  return JSON.stringify({ f: file, risk: total > 5 ? "HIGH" : total > 2 ? "MED" : "LOW", ep: eps.map((e: any) => `${e.method} ${e.path}`), models: models.map((m: any) => m.name), affectedEp: affectedEps.map((e: any) => `${e.method} ${e.path}`), depMods: depMods.map((m: any) => m.id), pages: affectedPages.map((p: any) => p.path) });
}

// ── querySearch --format json: categorical search from codebase-intelligence.json ──

export async function querySearch(inputDir: string, query: string): Promise<string> {
  const d = await loadCodebaseIntel(inputDir);
  const q = query;
  type Scored<T> = { item: T; score: number };

  const scoredEps: Scored<any>[] = [];
  for (const ep of Object.values(d.api_registry || {}) as any[]) {
    const score = scoreQueryIntel(q, [
      { value: ep.path, weight: 1.0 }, { value: ep.handler, weight: 0.9 },
      ...(ep.service_calls || []).filter((s: string) => !isGenericCall(s)).map((s: string) => ({ value: s, weight: 0.5 })),
    ]);
    if (score > 0) scoredEps.push({ item: ep, score });
  }
  scoredEps.sort((a, b) => b.score - a.score);
  const eps = scoredEps.slice(0, 8).map(({ item: ep }) => `${ep.method} ${ep.path} [${ep.module}]`);

  const scoredModels: Scored<any>[] = [];
  for (const m of Object.values(d.model_registry || {}) as any[]) {
    const score = scoreQueryIntel(q, [{ value: m.name, weight: 1.0 }, ...(m.fields || []).map((f: string) => ({ value: f, weight: 0.6 }))]);
    if (score > 0) scoredModels.push({ item: m, score });
  }
  scoredModels.sort((a, b) => b.score - a.score);
  const models = scoredModels.slice(0, 8).map(({ item: m }) => `${m.name}:${m.fields?.length}f`);

  const mods = (d.service_map || []).filter((m: any) =>
    scoreQueryIntel(q, [{ value: m.id, weight: 1.0 }, ...(m.imports || []).map((i: string) => ({ value: i, weight: 0.5 }))]) > 0
  ).slice(0, 5).map((m: any) => `${m.id}:${m.file_count}files [${m.layer}]`);

  const scoredExports: Scored<string>[] = [];
  for (const m of d.service_map || []) {
    for (const sym of m.exports || []) {
      const score = scoreQueryIntel(q, [{ value: sym, weight: 1.0 }]);
      if (score > 0) scoredExports.push({ item: `${sym} [${m.id}]`, score });
    }
  }
  scoredExports.sort((a, b) => b.score - a.score);

  const ASSET_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".css", ".scss", ".less", ".lock", ".map"]);
  const isMigration = (f: string) => /alembic\/versions|migrations\/\d/.test(f);
  const scoredFiles: Scored<string>[] = [];
  for (const m of d.service_map || []) {
    for (const f of m.files || []) {
      if (ASSET_EXTS.has(path.extname(f).toLowerCase()) || isMigration(f)) continue;
      const score = scoreQueryIntel(q, [{ value: path.basename(f), weight: 1.0 }, { value: f, weight: 0.5 }]);
      if (score > 0) scoredFiles.push({ item: f, score });
    }
  }
  scoredFiles.sort((a, b) => b.score - a.score);

  const enums = Object.values(d.enum_registry || {}).filter((e: any) =>
    scoreQueryIntel(q, [{ value: e.name, weight: 1.0 }, ...(e.values || []).map((v: string) => ({ value: v, weight: 0.6 }))]) > 0
  ).slice(0, 5).map((e: any) => `${e.name} [${e.file}]`);

  const tasks = (d.background_tasks || []).filter((t: any) =>
    scoreQueryIntel(q, [{ value: t.name, weight: 1.0 }, { value: t.kind, weight: 0.6 }]) > 0
  ).slice(0, 5).map((t: any) => `${t.name} [${t.kind}] ${t.file}`);

  const pages = (d.frontend_pages || []).filter((p: any) =>
    scoreQueryIntel(q, [
      { value: p.path, weight: 1.0 },
      { value: p.component, weight: 0.9 },
      { value: p.file ?? "", weight: 0.8 },
      ...(p.api_calls || []).map((c: string) => ({ value: c, weight: 0.5 })),
      ...(p.components || []).map((c: string) => ({ value: c, weight: 0.4 })),
    ]) > 0
  ).slice(0, 5).map((p: any) => p.file ? `${p.path} [${p.file}]` : `${p.path} → ${p.component}`);

  const fnHits: string[] = [];
  const fi = await loadFuncIntelRaw(inputDir);
  if (fi) {
    type FnScore = { fn: any; score: number };
    const scored: FnScore[] = [];
    const seen = new Set<string>();
    for (const fn of (fi.functions ?? []) as any[]) {
      const nameNorm = (fn.name ?? "").toLowerCase();
      const fileNorm = (fn.file ?? "").toLowerCase();
      const callsNorm = (fn.calls ?? []).map((c: string) => c.toLowerCase());
      const litsNorm = [...(fn.stringLiterals ?? []), ...(fn.regexPatterns ?? [])].map((l: string) => l.toLowerCase());
      let score = 0;
      if (nameNorm === q) score = 1.0;
      else if (nameNorm.includes(q)) score = 0.7;
      else if (callsNorm.some((c: string) => c.includes(q))) score = 0.5;
      else if (litsNorm.some((l: string) => l.includes(q))) score = 0.3;
      else if (fileNorm.includes(q)) score = 0.2;
      if (score > 0) { scored.push({ fn, score }); seen.add(`${fn.file}:${fn.name}`); }
    }
    const litIndex: Record<string, Array<{ file: string; function: string; line: number }>> = fi.literal_index ?? {};
    for (const [key, hits] of Object.entries(litIndex)) {
      if (!key.includes(q)) continue;
      for (const h of hits as any[]) {
        const uid = `${h.file}:${h.function}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        const fn = (fi.functions as any[]).find((f: any) => f.file === h.file && f.name === h.function);
        scored.push({ fn: fn ?? { name: h.function, file: h.file, lines: [h.line, h.line] }, score: 0.25 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { fn } of scored.slice(0, 10)) {
      fnHits.push(`${fn.name} [${fn.file}:${fn.lines?.[0]}]`);
    }
  }

  return JSON.stringify({
    ep: eps, mod: models, m: mods,
    exports: scoredExports.slice(0, 10).map(e => e.item),
    files: scoredFiles.slice(0, 8).map(f => f.item),
    enums, tasks, pages,
    ...(fnHits.length > 0 ? { fns: fnHits } : {}),
  });
}
