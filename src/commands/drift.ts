import fs from "node:fs/promises";
import path from "node:path";
import { computeProjectDrift } from "../extract/drift.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";

export type DriftOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  configPath?: string;
  baseline?: string | boolean;
  history?: string | boolean;
};

export async function runDrift(options: DriftOptions): Promise<void> {
  const resolved = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  logResolvedProjectPaths(resolved);
  const drift = await computeProjectDrift({
    backendRoot: resolved.backendRoot,
    frontendRoot: resolved.frontendRoot,
    configPath: options.configPath
  });

  const outputPath = path.resolve(options.output ?? "specs-out/drift.report.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(drift, null, 2));

  if (options.baseline) {
    const config = resolved.config;
    const projectRoot = resolved.workspaceRoot;
    const baselinePath =
      typeof options.baseline === "string"
        ? options.baseline
        : config.drift?.baselinePath || "specs-out/baseline.json";
    const resolvedBaseline = path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(projectRoot, baselinePath);
    const baselinePayload = {
      created_at: new Date().toISOString(),
      K_t: drift.K_t,
      drift
    };
    await fs.mkdir(path.dirname(resolvedBaseline), { recursive: true });
    await fs.writeFile(resolvedBaseline, JSON.stringify(baselinePayload, null, 2));
    console.log(`Wrote baseline ${resolvedBaseline}`);
  }

  if (options.history) {
    const config = resolved.config;
    const projectRoot = resolved.workspaceRoot;
    const historyPath =
      typeof options.history === "string"
        ? options.history
        : config.drift?.historyPath || "specs-out/drift.history.jsonl";
    const resolvedHistory = path.isAbsolute(historyPath)
      ? historyPath
      : path.resolve(projectRoot, historyPath);
    const entry = {
      timestamp: new Date().toISOString(),
      graph_level: drift.graph_level,
      D_t: drift.D_t,
      K_t: drift.K_t,
      delta: drift.delta,
      status: drift.status,
      metrics: drift.metrics,
      details: drift.details,
      capacity: drift.capacity,
      growth: drift.growth,
      scales: drift.scales
    };
    await fs.mkdir(path.dirname(resolvedHistory), { recursive: true });
    await fs.appendFile(resolvedHistory, `${JSON.stringify(entry)}\n`);
    console.log(`Appended history ${resolvedHistory}`);
  }

  console.log("SpecGuard Drift Report");
  console.log(`Status: ${drift.status}`);
  console.log(`D_t: ${drift.D_t.toFixed(4)}`);
  console.log(`K_t: ${drift.K_t.toFixed(4)}`);
  console.log(`Delta: ${drift.delta.toFixed(4)}`);
  console.log(
    `Entropy: ${drift.metrics.entropy.toFixed(4)} | Cross-Layer: ${drift.metrics.cross_layer_ratio.toFixed(4)} | Cycle Density: ${drift.metrics.cycle_density.toFixed(4)} | Modularity Gap: ${drift.metrics.modularity_gap.toFixed(4)}`
  );
  if (drift.scales.length > 1) {
    console.log("Scale Summary:");
    for (const scale of drift.scales) {
      console.log(
        `- ${scale.level}: ${scale.status} | Delta ${scale.delta.toFixed(4)} | Edges ${scale.details.edges}`
      );
    }
  }
  const totalCapacity = drift.capacity.total;
  if (totalCapacity) {
    const ratio = totalCapacity.ratio !== undefined ? totalCapacity.ratio.toFixed(2) : "n/a";
    const budget = totalCapacity.budget ?? 0;
    console.log(
      `Capacity: ${drift.capacity.status} | Used ${totalCapacity.used} / ${budget || "n/a"} | Ratio ${ratio}`
    );
  } else {
    console.log(`Capacity: ${drift.capacity.status}`);
  }
  console.log(
    `Growth: ${drift.growth.status} | ${drift.growth.edges_per_day.toFixed(2)} edges/day (${drift.growth.trend})`
  );
  console.log(`Wrote ${outputPath}`);
}
