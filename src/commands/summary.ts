import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { renderExecutiveSummary } from "../extract/docs.js";
import { loadArchitectureSummary, loadArchitectureDiff, loadHeatmap } from "../extract/compress.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../extract/types.js";
import { resolveMachineInputDir } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";

export type SummaryOptions = {
  input: string;
  output?: string;
};

export async function runSummary(options: SummaryOptions): Promise<void> {
  const inputDir = await resolveMachineInputDir(options.input || DEFAULT_SPECS_DIR);
  const architecturePath = path.join(inputDir, "architecture.snapshot.yaml");
  const uxPath = path.join(inputDir, "ux.snapshot.yaml");

  const [architectureRaw, uxRaw] = await Promise.all([
    fs.readFile(architecturePath, "utf8"),
    fs.readFile(uxPath, "utf8")
  ]);

  const architecture = yaml.load(architectureRaw) as ArchitectureSnapshot;
  const ux = yaml.load(uxRaw) as UxSnapshot;

  const summary = await loadArchitectureSummary(inputDir);
  const diff = await loadArchitectureDiff(inputDir);
  const heatmap = await loadHeatmap(inputDir);

  const content = renderExecutiveSummary(architecture, ux, { summary, diff, heatmap });

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(inputDir, "docs", "summary.md");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content);

  console.log(`Wrote ${outputPath}`);
}
