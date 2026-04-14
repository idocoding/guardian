/**
 * Context Coverage Metric
 *
 * Measures how well guardian_context covers the modules and files
 * relevant to a benchmark task.
 *
 * Method:
 *   1. Read architecture-context.md from the specs dir
 *   2. For each ground-truth file, check if its basename or containing module
 *      is mentioned anywhere in the context block
 *   3. For modules: check if the module ID appears (e.g. "src/auth", "auth")
 *
 * A coverage of 1.0 means every ground-truth file/module appears in the context.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { ContextCoverageResult } from "../types.js";

export async function measureContextCoverage(params: {
  specsDir: string;
  groundTruthFiles: string[];
  groundTruthSymbols?: string[];
}): Promise<ContextCoverageResult> {
  const { specsDir, groundTruthFiles } = params;

  // Read architecture-context.md
  const contextPath = path.join(specsDir, "machine", "architecture-context.md");
  let contextText = "";
  try {
    const raw = await fs.readFile(contextPath, "utf8");
    // Extract the guardian:context block for fair comparison
    const match = raw.match(/<!-- guardian:context[^>]*-->([\s\S]*?)<!-- \/guardian:context -->/);
    contextText = (match ? match[1] : raw).toLowerCase();
  } catch {
    // No context file — zero coverage
    return {
      coverage: 0,
      modules_mentioned: [],
      modules_missing: groundTruthFiles.map(moduleIdFor),
      files_mentioned: 0,
      files_total: groundTruthFiles.length,
    };
  }

  // ── Check file coverage ──────────────────────────────────────────────────
  let filesMentioned = 0;
  for (const f of groundTruthFiles) {
    const basename = path.basename(f).toLowerCase();
    const noExt = basename.replace(/\.[^.]+$/, "");
    if (contextText.includes(basename) || contextText.includes(noExt)) {
      filesMentioned++;
    }
  }

  // ── Check module coverage ────────────────────────────────────────────────
  // Derive module IDs from ground-truth file paths (e.g. "src/auth/service.ts" → "src/auth")
  const allModuleIds = [...new Set(groundTruthFiles.map(moduleIdFor))];
  const modulesMentioned: string[] = [];
  const modulesMissing: string[] = [];

  for (const modId of allModuleIds) {
    // Check if the module ID (or any segment) appears in context
    const segments = modId.split("/").filter(Boolean);
    const mentioned = segments.some(seg => contextText.includes(seg.toLowerCase())) ||
      contextText.includes(modId.toLowerCase());
    if (mentioned) {
      modulesMentioned.push(modId);
    } else {
      modulesMissing.push(modId);
    }
  }

  const coverage = allModuleIds.length > 0
    ? round(modulesMentioned.length / allModuleIds.length)
    : 0;

  return {
    coverage,
    modules_mentioned: modulesMentioned,
    modules_missing: modulesMissing,
    files_mentioned: filesMentioned,
    files_total: groundTruthFiles.length,
  };
}

/** Derive a module-level ID from a file path (parent directory) */
function moduleIdFor(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return path.dirname(normalized);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
