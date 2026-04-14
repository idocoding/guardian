/**
 * `guardian discrepancy` — diff current codebase intelligence against a baseline.
 *
 * Reads:
 *   - specs-out/machine/codebase-intelligence.json
 *   - specs-out/machine/product-document.baseline.json (optional)
 *   - feature-specs/*.yaml (optional)
 *
 * Writes:
 *   - specs-out/machine/discrepancies.json  (--format json, default)
 *   - specs-out/human/discrepancies.md      (--format md)
 *   Both if format is omitted.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  buildDiscrepancyReport,
  renderDiscrepancyMarkdown,
} from "../extract/discrepancies.js";
import { loadCodebaseIntelligence } from "../extract/codebase-intel.js";
import { getOutputLayout } from "../output-layout.js";

export type DiscrepancyOptions = {
  specs: string;
  featureSpecs?: string;
  output?: string;
  format: "json" | "md" | "both";
};

export async function runDiscrepancy(options: DiscrepancyOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);

  // Load codebase intelligence
  const intelPath = path.join(layout.machineDir, "codebase-intelligence.json");
  const intel = await loadCodebaseIntelligence(intelPath).catch(() => {
    throw new Error(
      `Could not load codebase-intelligence.json from ${intelPath}. Run \`guardian extract --output ${options.specs}\` first.`
    );
  });

  const baselinePath = path.join(layout.machineDir, "product-document.baseline.json");
  const featureSpecsDir = options.featureSpecs ? path.resolve(options.featureSpecs) : null;

  const report = await buildDiscrepancyReport({
    intel,
    baselinePath,
    featureSpecsDir,
  });

  const format = options.format ?? "json";
  const writeJson = format === "json" || format === "both";
  const writeMd = format === "md" || format === "both";

  if (writeJson) {
    const jsonPath = options.output
      ? path.resolve(options.output)
      : path.join(layout.machineDir, "discrepancies.json");
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`Wrote ${jsonPath}`);
  }

  if (writeMd) {
    const mdPath = options.output && format === "md"
      ? path.resolve(options.output)
      : path.join(layout.humanDir, "discrepancies.md");
    const md = renderDiscrepancyMarkdown(report);
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
    await fs.writeFile(mdPath, md, "utf8");
    console.log(`Wrote ${mdPath}`);
  }

  // Exit summary
  const { total_issues, has_critical } = report.summary;
  if (total_issues === 0) {
    console.log("✓ No discrepancies found.");
  } else {
    console.log(
      `${has_critical ? "⚠ " : ""}${total_issues} discrepancy(s): ` +
      [
        report.new_endpoints.length > 0 && `${report.new_endpoints.length} new endpoint(s)`,
        report.removed_endpoints.length > 0 && `${report.removed_endpoints.length} removed endpoint(s)`,
        report.drifted_models.length > 0 && `${report.drifted_models.length} drifted model(s)`,
        report.orphan_specs.length > 0 && `${report.orphan_specs.length} orphan spec(s)`,
        report.untracked_endpoints.length > 0 && `${report.untracked_endpoints.length} untracked endpoint(s)`,
      ]
        .filter(Boolean)
        .join(", ")
    );
  }
}
