import path from "node:path";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { buildSnapshots } from "../extract/index.js";
import { analyzeDepth } from "../extract/analyzers/depth.js";
import type { StructuralIntelligenceReport } from "../extract/types.js";

export type AnalyzeDepthOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
  output?: string;
  format?: "yaml" | "json";
  ci?: boolean;
  query: string;
};

export async function runAnalyzeDepth(options: AnalyzeDepthOptions): Promise<void> {
  const { architecture } = await buildSnapshots({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    output: options.output ?? "specs-out",
    includeFileGraph: true,
    configPath: options.configPath
  });

  const report: StructuralIntelligenceReport = analyzeDepth({
    query: options.query,
    modules: architecture.modules,
    moduleGraph: architecture.dependencies.module_graph,
    fileGraph: architecture.dependencies.file_graph,
    circularDependencies: architecture.analysis.circular_dependencies
  });

  const formatted =
    options.format === "json"
      ? JSON.stringify(report, null, 2)
      : (yaml.dump(report, { lineWidth: 100 }));

  if (options.output) {
    const target = path.resolve(options.output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, formatted, "utf8");
    console.log(`Wrote ${target}`);
  } else {
    console.log(formatted);
  }

  // CI enforcement: exit 1 when confident and non-compressible
  if (
    options.ci &&
    report.classification.compressible === "NON_COMPRESSIBLE" &&
    report.confidence.value >= report.guardrails.enforce_if_confidence_above
  ) {
    console.error(
      `\n[SpecGuard] CI FAIL: "${options.query}" classified as HIGH complexity (confidence ${report.confidence.value.toFixed(2)}).\n` +
        `Recommended pattern: ${report.recommendation.primary.pattern}\n` +
        `Avoid: ${report.recommendation.avoid.join(", ")}`
    );
    process.exit(1);
  }
}
