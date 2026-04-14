/**
 * Drift Score Metric
 *
 * Measures how much architectural drift a proposed patch introduces.
 *
 * Method:
 *   baseline  → read pre-computed drift from architecture.diff.summary.json
 *   post-patch → if a patch is provided, count changed files and estimate delta
 *                by counting new/modified module edges in the diff
 *
 * For publication: lower drift_increase means the patch respected architecture.
 * A delta of 0 means the patch introduced no new coupling.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { DriftScoreResult } from "../types.js";

type DiffSummary = {
  structural_change?: boolean;
  counts_delta?: Record<string, number>;
};

export async function measureDriftScore(params: {
  specsDir: string;
  patch?: string;
}): Promise<DriftScoreResult> {
  const { specsDir, patch } = params;
  const machineDir = path.join(specsDir, "machine");

  // ── Read baseline drift summary ──────────────────────────────────────────
  const diffPath = path.join(machineDir, "architecture.diff.summary.json");
  let diff: DiffSummary | null = null;
  let baselineStatus = "unknown";
  let baselineDelta: number | null = null;

  try {
    const raw = await fs.readFile(diffPath, "utf8");
    diff = JSON.parse(raw) as DiffSummary;

    // Compute a drift delta from the counts_delta
    const cd = diff.counts_delta ?? {};
    const edgeDelta = Math.abs(cd.module_edges ?? 0) + Math.abs(cd.file_edges ?? 0);
    const structDelta = Math.abs(cd.modules ?? 0) * 2; // new modules weigh more
    baselineDelta = edgeDelta + structDelta;
    baselineStatus = diff.structural_change ? "drift" : "stable";
  } catch {
    baselineStatus = "no-baseline";
  }

  // ── Estimate post-patch drift ────────────────────────────────────────────
  let postPatchDelta: number | null = null;
  let postPatchStatus = "unknown";
  let patchApplied = false;

  if (patch) {
    patchApplied = true;
    // Parse the unified diff to count touched files and new import patterns
    const changedFiles = countPatchFiles(patch);
    const newImports = countNewImports(patch);
    const removedImports = countRemovedImports(patch);

    // Heuristic delta: each new import edge that isn't in a removal = +1 coupling
    const netNewImports = Math.max(0, newImports - removedImports);
    postPatchDelta = (baselineDelta ?? 0) + netNewImports + Math.floor(changedFiles / 3);
    postPatchStatus = postPatchDelta > (baselineDelta ?? 0) + 2
      ? "drift"
      : postPatchDelta > 0
        ? "warning"
        : "stable";
  }

  const driftIncrease =
    postPatchDelta !== null && baselineDelta !== null
      ? postPatchDelta - baselineDelta
      : null;

  return {
    baseline_delta: baselineDelta,
    post_patch_delta: postPatchDelta,
    drift_increase: driftIncrease !== null ? Math.max(0, driftIncrease) : null,
    baseline_status: baselineStatus,
    post_patch_status: patchApplied ? postPatchStatus : "not-computed",
    patch_applied: patchApplied,
  };
}

// ── Patch helpers ────────────────────────────────────────────────────────────

/** Count distinct files touched by a unified diff */
function countPatchFiles(patch: string): number {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const f = line.slice(4).replace(/\t.*/, "").trim();
      if (f !== "/dev/null") files.add(f);
    }
  }
  return files.size;
}

/** Count added import lines (import/from/require) in the patch */
function countNewImports(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const l = line.slice(1).trim();
      if (/^(import|from|require)\b/.test(l)) count++;
    }
  }
  return count;
}

/** Count removed import lines in the patch */
function countRemovedImports(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) {
      const l = line.slice(1).trim();
      if (/^(import|from|require)\b/.test(l)) count++;
    }
  }
  return count;
}
