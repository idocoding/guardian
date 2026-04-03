/**
 * Discrepancy Detection — diffs current codebase intelligence against a committed baseline.
 *
 * Answers: "what changed in the code that isn't reflected in our product docs or feature specs?"
 *
 * Checks:
 *   1. untracked_endpoints   — endpoints in code but not in any feature spec
 *   2. new_endpoints         — endpoints added since the baseline
 *   3. removed_endpoints     — endpoints present in baseline but gone from code
 *   4. drifted_models        — ORM models whose field count changed since baseline
 *   5. new_models            — models added since baseline
 *   6. removed_models        — models removed since baseline
 *   7. new_tasks             — background tasks added since baseline
 *   8. orphan_specs          — feature specs referencing endpoints that no longer exist
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { CodebaseIntelligence } from "./codebase-intel.js";
import type { FeatureSpec } from "../schema/feature-spec.js";
import yaml from "js-yaml";
import { parseFeatureSpec } from "../schema/feature-spec.js";

export type DiscrepancyReport = {
  generated_at: string;
  baseline_at: string | null;
  summary: {
    total_issues: number;
    has_critical: boolean;
  };
  untracked_endpoints: string[];      // in code, not in any feature spec
  new_endpoints: string[];            // added since baseline
  removed_endpoints: string[];        // in baseline, not in code
  drifted_models: Array<{
    name: string;
    baseline_field_count: number;
    current_field_count: number;
    delta: number;
  }>;
  new_models: string[];
  removed_models: string[];
  new_tasks: string[];
  orphan_specs: Array<{
    spec_file: string;
    missing_endpoints: string[];
  }>;
};

/** Minimal baseline shape — written alongside product-document.md */
export type IntelBaseline = {
  generated_at: string;
  endpoints: string[];
  models: Record<string, number>;   // name → field count
  tasks: string[];
};

export function buildBaseline(intel: CodebaseIntelligence): IntelBaseline {
  return {
    generated_at: intel.meta.generated_at,
    endpoints: Object.keys(intel.api_registry).sort(),
    models: Object.fromEntries(
      Object.entries(intel.model_registry).map(([name, m]) => [name, m.fields.length])
    ),
    tasks: intel.background_tasks.map((t) => t.name).sort(),
  };
}

export async function buildDiscrepancyReport(params: {
  intel: CodebaseIntelligence;
  baselinePath: string | null;
  featureSpecsDir: string | null;
}): Promise<DiscrepancyReport> {
  const { intel, baselinePath, featureSpecsDir } = params;

  const currentEndpoints = new Set(Object.keys(intel.api_registry));
  const currentModels = new Map(
    Object.entries(intel.model_registry).map(([name, m]) => [name, m.fields.length])
  );
  const currentTasks = new Set(intel.background_tasks.map((t) => t.name));

  // Load baseline
  let baseline: IntelBaseline | null = null;
  if (baselinePath) {
    try {
      const raw = await fs.readFile(baselinePath, "utf8");
      baseline = JSON.parse(raw) as IntelBaseline;
    } catch {
      // No baseline yet — first run
    }
  }

  const baselineEndpoints = new Set(baseline?.endpoints ?? []);
  const baselineModels = new Map(Object.entries(baseline?.models ?? {}));
  const baselineTasks = new Set(baseline?.tasks ?? []);

  // Load feature specs to find covered endpoints
  const coveredEndpoints = new Set<string>();
  const orphanSpecs: DiscrepancyReport["orphan_specs"] = [];

  if (featureSpecsDir) {
    const specs = await loadFeatureSpecs(featureSpecsDir);
    for (const { spec, file } of specs) {
      const missing: string[] = [];
      for (const ep of spec.affected_endpoints) {
        coveredEndpoints.add(ep);
        if (!currentEndpoints.has(ep)) {
          missing.push(ep);
        }
      }
      if (missing.length > 0) {
        orphanSpecs.push({ spec_file: file, missing_endpoints: missing });
      }
    }
  }

  // 1. Untracked endpoints (in code, not in any spec)
  const untrackedEndpoints = Array.from(currentEndpoints)
    .filter((ep) => !coveredEndpoints.has(ep))
    .sort();

  // 2. New endpoints since baseline
  const newEndpoints = Array.from(currentEndpoints)
    .filter((ep) => !baselineEndpoints.has(ep))
    .sort();

  // 3. Removed endpoints since baseline
  const removedEndpoints = Array.from(baselineEndpoints)
    .filter((ep) => !currentEndpoints.has(ep))
    .sort();

  // 4. Drifted models (field count changed)
  const driftedModels: DiscrepancyReport["drifted_models"] = [];
  for (const [name, currentCount] of currentModels) {
    const baselineCount = baselineModels.get(name);
    if (baselineCount !== undefined && baselineCount !== currentCount) {
      driftedModels.push({
        name,
        baseline_field_count: baselineCount,
        current_field_count: currentCount,
        delta: currentCount - baselineCount,
      });
    }
  }
  driftedModels.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // 5. New models
  const newModels = Array.from(currentModels.keys())
    .filter((name) => !baselineModels.has(name))
    .sort();

  // 6. Removed models
  const removedModels = Array.from(baselineModels.keys())
    .filter((name) => !currentModels.has(name))
    .sort();

  // 7. New tasks
  const newTasks = Array.from(currentTasks)
    .filter((t) => !baselineTasks.has(t))
    .sort();

  const totalIssues =
    newEndpoints.length +
    removedEndpoints.length +
    driftedModels.length +
    newModels.length +
    removedModels.length +
    newTasks.length +
    orphanSpecs.length;

  const hasCritical =
    removedEndpoints.length > 0 ||
    removedModels.length > 0 ||
    orphanSpecs.length > 0;

  return {
    generated_at: new Date().toISOString(),
    baseline_at: baseline?.generated_at ?? null,
    summary: { total_issues: totalIssues, has_critical: hasCritical },
    untracked_endpoints: untrackedEndpoints,
    new_endpoints: newEndpoints,
    removed_endpoints: removedEndpoints,
    drifted_models: driftedModels,
    new_models: newModels,
    removed_models: removedModels,
    new_tasks: newTasks,
    orphan_specs: orphanSpecs,
  };
}

async function loadFeatureSpecs(
  dir: string
): Promise<Array<{ spec: FeatureSpec; file: string }>> {
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(dir);
    entries = dirEntries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }

  const results: Array<{ spec: FeatureSpec; file: string }> = [];
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(entry, "utf8");
      const parsed = yaml.load(raw);
      results.push({ spec: parseFeatureSpec(parsed), file: path.basename(entry) });
    } catch {
      // Skip malformed specs
    }
  }
  return results;
}

/**
 * Render a discrepancy report as human-readable Markdown.
 */
export function renderDiscrepancyMarkdown(report: DiscrepancyReport): string {
  const lines: string[] = [];
  const since = report.baseline_at
    ? `since baseline (${report.baseline_at.slice(0, 10)})`
    : "(no baseline — first run)";

  lines.push(`# Discrepancy Report`);
  lines.push(`_Generated: ${report.generated_at.slice(0, 19).replace("T", " ")} UTC_`);
  lines.push(`_Baseline: ${report.baseline_at ? report.baseline_at.slice(0, 10) : "none"}_`);
  lines.push("");
  lines.push(
    `**${report.summary.total_issues} issue(s) found**${report.summary.has_critical ? " — ⚠ critical changes detected" : ""}`
  );
  lines.push("");

  if (report.new_endpoints.length > 0) {
    lines.push(`## New Endpoints ${since} (${report.new_endpoints.length})`);
    lines.push("");
    for (const ep of report.new_endpoints) lines.push(`- \`${ep}\``);
    lines.push("");
  }

  if (report.removed_endpoints.length > 0) {
    lines.push(`## ⚠ Removed Endpoints ${since} (${report.removed_endpoints.length})`);
    lines.push("");
    for (const ep of report.removed_endpoints) lines.push(`- \`${ep}\``);
    lines.push("");
  }

  if (report.untracked_endpoints.length > 0) {
    lines.push(`## Untracked Endpoints — not in any feature spec (${report.untracked_endpoints.length})`);
    lines.push("");
    for (const ep of report.untracked_endpoints.slice(0, 20)) lines.push(`- \`${ep}\``);
    if (report.untracked_endpoints.length > 20) {
      lines.push(`- _...and ${report.untracked_endpoints.length - 20} more_`);
    }
    lines.push("");
  }

  if (report.drifted_models.length > 0) {
    lines.push(`## Drifted Models — field count changed (${report.drifted_models.length})`);
    lines.push("");
    lines.push("| Model | Baseline fields | Current fields | Delta |");
    lines.push("|---|---|---|---|");
    for (const m of report.drifted_models) {
      const sign = m.delta > 0 ? "+" : "";
      lines.push(`| ${m.name} | ${m.baseline_field_count} | ${m.current_field_count} | ${sign}${m.delta} |`);
    }
    lines.push("");
  }

  if (report.new_models.length > 0) {
    lines.push(`## New Models ${since} (${report.new_models.length})`);
    lines.push("");
    for (const m of report.new_models) lines.push(`- \`${m}\``);
    lines.push("");
  }

  if (report.removed_models.length > 0) {
    lines.push(`## ⚠ Removed Models ${since} (${report.removed_models.length})`);
    lines.push("");
    for (const m of report.removed_models) lines.push(`- \`${m}\``);
    lines.push("");
  }

  if (report.new_tasks.length > 0) {
    lines.push(`## New Background Tasks ${since} (${report.new_tasks.length})`);
    lines.push("");
    for (const t of report.new_tasks) lines.push(`- \`${t}\``);
    lines.push("");
  }

  if (report.orphan_specs.length > 0) {
    lines.push(`## ⚠ Orphan Feature Specs — reference endpoints that no longer exist (${report.orphan_specs.length})`);
    lines.push("");
    for (const s of report.orphan_specs) {
      lines.push(`**${s.spec_file}**: ${s.missing_endpoints.map((e) => `\`${e}\``).join(", ")}`);
    }
    lines.push("");
  }

  if (report.summary.total_issues === 0) {
    lines.push("No discrepancies found. Code and specs are in sync.");
  }

  return lines.join("\n");
}
