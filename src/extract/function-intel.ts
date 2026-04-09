/**
 * Function-level intelligence extraction and persistence.
 *
 * Produces `function-intelligence.json` in the guardian machine output dir.
 * Contains:
 *  - Full FunctionRecord list (all languages)
 *  - Call graph: name → { calls, called_by }
 *  - Literal index: token → [{ file, function, line }]  ← drives `guardian search --types functions`
 *
 * This is a second-pass scan that runs after the main extraction.
 * It re-uses the adapter pipeline on the same files; results are not fed
 * back into the architecture snapshot (additive, non-breaking).
 *
 * Language-specific domain concepts (e.g. Lean4 `sorry`, Python re.* patterns)
 * are surfaced entirely by each adapter — this module has zero language knowledge.
 * Adapters encode domain specifics into `stringLiterals`, making them searchable
 * through the generic literal_index.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getAdapterForFile, runAdapter } from "../adapters/index.js";
import type { FunctionRecord } from "../adapters/types.js";
import type { SpecGuardConfig } from "../config.js";

// ── Public types ──────────────────────────────────────────────────────────

export interface LiteralHit {
  file: string;
  /** Name of the function / theorem / method that contains the literal */
  function: string;
  line: number;
}

export interface CallGraphEntry {
  calls: string[];
  called_by: string[];
}

export interface FunctionIntelligence {
  version: "0.1";
  generated_at: string;
  total_functions: number;
  functions: FunctionRecord[];
  /**
   * call_graph["foo"] = { calls: ["bar", "baz"], called_by: ["main"] }
   * Built from the `calls` field of every FunctionRecord.
   */
  call_graph: Record<string, CallGraphEntry>;
  /**
   * literal_index["thought"] = [{file, function, line}, …]
   *
   * Indexed by token (lowercased word extracted from string/regex literals).
   * Adapters are responsible for populating `stringLiterals` and
   * `regexPatterns` on each FunctionRecord with whatever is meaningful in
   * their language domain.  This index is the search surface — no language
   * knowledge lives here.
   *
   * Example queries:
   *   guardian search --types functions --query "thought"   → regex tag locations
   *   guardian search --types functions --query "sorry"     → Lean4 incomplete proofs
   *   guardian search --types functions --query "re.sub"    → Python regex call sites
   */
  literal_index: Record<string, LiteralHit[]>;
}

// ── Token helpers ─────────────────────────────────────────────────────────

/** Split text into lowercase alphanumeric tokens (min 3 chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
}

// ── Core build ────────────────────────────────────────────────────────────

/**
 * Given a flat list of FunctionRecord entries (from all files / all adapters),
 * build the call graph and literal index.
 */
export function buildFunctionIntelligence(
  allFunctions: FunctionRecord[]
): FunctionIntelligence {
  // ── Call graph ──
  const callGraph: Record<string, CallGraphEntry> = Object.create(null);

  for (const fn of allFunctions) {
    if (!Object.prototype.hasOwnProperty.call(callGraph, fn.name)) callGraph[fn.name] = { calls: [], called_by: [] };
    callGraph[fn.name].calls = [...new Set(fn.calls)];
  }

  // Invert: for each callee name, record who calls it
  for (const fn of allFunctions) {
    for (const callee of fn.calls) {
      if (!Object.prototype.hasOwnProperty.call(callGraph, callee)) callGraph[callee] = { calls: [], called_by: [] };
      const entry = callGraph[callee];
      if (!entry.called_by.includes(fn.name)) {
        entry.called_by.push(fn.name);
      }
    }
  }

  // ── Literal index ──
  // Object.create(null) avoids prototype property collisions (e.g. "constructor",
  // "toString") that would cause `existing.some is not a function` errors when
  // source tokens match built-in Object property names.
  const literalIndex: Record<string, LiteralHit[]> = Object.create(null);

  function addHit(token: string, fn: FunctionRecord): void {
    const key = token.toLowerCase().trim();
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(literalIndex, key)) literalIndex[key] = [];
    const existing = literalIndex[key];
    // One hit per function per token — no duplicates
    if (!existing.some((h) => h.file === fn.file && h.function === fn.name)) {
      existing.push({ file: fn.file, function: fn.name, line: fn.lines[0] });
    }
  }

  for (const fn of allFunctions) {
    for (const lit of fn.stringLiterals) {
      const full = lit.slice(0, 100);
      if (full.length >= 3) addHit(full, fn);
      for (const tok of tokenize(lit)) addHit(tok, fn);
    }
    for (const pat of fn.regexPatterns) {
      const full = pat.slice(0, 100);
      if (full.length >= 3) addHit(full, fn);
      for (const tok of tokenize(pat)) addHit(tok, fn);
    }
  }

  return {
    version: "0.1",
    generated_at: new Date().toISOString(),
    total_functions: allFunctions.length,
    functions: allFunctions,
    call_graph: callGraph,
    literal_index: literalIndex,
  };
}

// ── File scanning ─────────────────────────────────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  // Version control
  ".git",
  // Lean4 / Lake package manager (contains Mathlib — thousands of .lean files)
  ".lake",
  // JS/TS
  "node_modules",
  "dist",
  ".next",
  ".nuxt",
  "coverage",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  // Java/Kotlin (Maven + Gradle build output + generated sources)
  "target",
  ".gradle",
  "generated",
  "generated-sources",
  // Go
  "vendor",
  // .NET
  "obj",
  "bin",
  // Generic
  "build",
  ".specs",
  ".cache",
]);

async function listSourceFiles(
  dir: string,
  config: SpecGuardConfig,
  results: string[] = []
): Promise<string[]> {
  const ignoreDirs = new Set([
    ...DEFAULT_IGNORE_DIRS,
    ...(config.ignore?.directories ?? []),
  ]);
  const ignorePaths = config.ignore?.paths ?? [];

  let entries: import("node:fs").Dirent[];
  try {
    // encoding: "utf8" ensures entry.name is always string, not Buffer
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const name = entry.name as string;
    const fullPath = path.join(dir, name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(name) && !ignorePaths.some((p) => fullPath.includes(p))) {
        await listSourceFiles(fullPath, config, results);
      }
    } else if (entry.isFile()) {
      if (getAdapterForFile(name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Scan one or more project roots, run adapters on every source file, and
 * return the aggregated FunctionIntelligence index.
 */
export async function buildFunctionIntelligenceFromRoots(
  roots: string[],
  config: SpecGuardConfig
): Promise<FunctionIntelligence> {
  const allFunctions: FunctionRecord[] = [];

  for (const root of roots) {
    const files = await listSourceFiles(root, config);

    await Promise.all(
      files.map(async (filePath) => {
        const adapter = getAdapterForFile(path.basename(filePath));
        if (!adapter) return;

        let source: string;
        try {
          source = await fs.readFile(filePath, "utf8");
        } catch {
          return;
        }

        try {
          const result = runAdapter(adapter, filePath, source);
          allFunctions.push(...result.functions);
        } catch {
          // Skip files that fail to parse (malformed source, encoding issues)
        }
      })
    );
  }

  return buildFunctionIntelligence(allFunctions);
}

// ── Write ─────────────────────────────────────────────────────────────────

/** Persist function-intelligence.json to the guardian machine output dir. */
export async function writeFunctionIntelligence(
  outputDir: string,
  intel: FunctionIntelligence
): Promise<string> {
  const filePath = path.join(outputDir, "function-intelligence.json");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(intel, null, 2), "utf8");
  console.log(`Wrote ${filePath}`);
  return filePath;
}

// ── Load ──────────────────────────────────────────────────────────────────

/** Load function-intelligence.json if it exists; returns null if absent. */
export async function loadFunctionIntelligence(
  machineDir: string
): Promise<FunctionIntelligence | null> {
  const filePath = path.join(machineDir, "function-intelligence.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as FunctionIntelligence;
  } catch {
    return null;
  }
}
