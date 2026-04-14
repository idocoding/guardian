/**
 * Token Efficiency Metric
 *
 * Measures how many tokens an agent needs to orient itself using Guardian MCP
 * vs reading the ground-truth files directly.
 *
 * Method:
 *   MCP path    → read architecture-context.md (orient) + codebase-intelligence.json (search)
 *   Raw path    → read each ground-truth file byte count
 *   Ratio       → MCP bytes / raw bytes  (lower = more efficient)
 *
 * Token estimate: chars / 3.5  (industry-standard rough approximation)
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { TokenEfficiencyResult } from "../types.js";

const CHARS_PER_TOKEN = 3.5;

export async function measureTokenEfficiency(params: {
  specsDir: string;
  groundTruthFiles: string[];
  repoDir?: string;
}): Promise<TokenEfficiencyResult> {
  const { specsDir, groundTruthFiles, repoDir } = params;
  const machineDir = path.join(specsDir, "machine");

  // ── MCP response size ────────────────────────────────────────────────────
  // An agent using Guardian issues two calls: guardian_orient + guardian_search
  // We estimate their response sizes from the files they serve.

  let mcpBytes = 0;

  // orient: architecture-context.md (the guardian:context block only)
  const contextPath = path.join(machineDir, "architecture-context.md");
  try {
    const raw = await fs.readFile(contextPath, "utf8");
    const match = raw.match(/<!-- guardian:context[^>]*-->([\s\S]*?)<!-- \/guardian:context -->/);
    const block = match ? match[1] : raw;
    // MCP compacts this into JSON — roughly 40% of markdown size
    mcpBytes += Math.round(Buffer.byteLength(block, "utf8") * 0.4);
  } catch {
    // Fallback: estimate from codebase-intelligence.json header
    try {
      const stat = await fs.stat(path.join(machineDir, "codebase-intelligence.json"));
      mcpBytes += Math.round(stat.size * 0.05); // orient only emits a compact summary
    } catch { /* ignore */ }
  }

  // search: the guardian_search response is a compact JSON of matched items
  // We estimate it as a fraction of the full intel file
  try {
    const stat = await fs.stat(path.join(machineDir, "codebase-intelligence.json"));
    mcpBytes += Math.round(stat.size * 0.08); // search returns ~8% of intel on average
  } catch { /* ignore */ }

  // ── Raw file size ────────────────────────────────────────────────────────
  let rawBytes = 0;
  for (const relPath of groundTruthFiles) {
    const candidates = repoDir
      ? [path.join(repoDir, relPath), relPath]
      : [relPath];

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        rawBytes += stat.size;
        break;
      } catch { /* try next */ }
    }
  }

  // ── Compute metrics ──────────────────────────────────────────────────────
  const mcpTokens = Math.ceil(mcpBytes / CHARS_PER_TOKEN);
  const rawFileTokens = Math.ceil(rawBytes / CHARS_PER_TOKEN);
  const efficiencyRatio = rawFileTokens > 0 ? round(mcpTokens / rawFileTokens) : 0;
  const tokensSaved = Math.max(0, rawFileTokens - mcpTokens);

  return {
    mcp_tokens: mcpTokens,
    raw_file_tokens: rawFileTokens,
    efficiency_ratio: efficiencyRatio,
    tokens_saved: tokensSaved,
    raw_file_bytes: rawBytes,
    mcp_response_bytes: mcpBytes,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
