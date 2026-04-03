import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import yaml from "js-yaml";
import { buildSnapshots } from "../extract/index.js";
import {
  buildArchitectureSummary,
  loadArchitectureSummary
} from "../extract/compress.js";
import { DEFAULT_SPECS_DIR, type SpecGuardConfig } from "../config.js";
import { createIgnoreMatcher } from "../extract/ignore.js";
import type { DriftReport } from "../extract/types.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";

export type SimulateOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  configPath?: string;
  baseline?: string;
  baselineSummary?: string;
  patch?: string;
  mode?: "soft" | "hard";
};

export async function runSimulate(options: SimulateOptions): Promise<void> {
  const resolved = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  const resolvedBackendRoot = resolved.backendRoot;
  const resolvedFrontendRoot = resolved.frontendRoot;
  const originalRoot = resolved.workspaceRoot;
  const config = resolved.config;
  logResolvedProjectPaths(resolved);

  let simulationRoot = originalRoot;
  let simBackendRoot = resolvedBackendRoot;
  let simFrontendRoot = resolvedFrontendRoot;
  let cleanupTemp = false;

  try {
    if (options.patch) {
      const tempRoot = await createTempCopy(originalRoot, config);
      await applyPatch(tempRoot, options.patch);
      simulationRoot = tempRoot;
      simBackendRoot = remapPath(resolvedBackendRoot, originalRoot, tempRoot);
      simFrontendRoot = remapPath(resolvedFrontendRoot, originalRoot, tempRoot);
      cleanupTemp = true;
    }

    const { architecture, ux } = await buildSnapshots({
      projectRoot: simulationRoot,
      backendRoot: simBackendRoot,
      frontendRoot: simFrontendRoot,
      output: options.output,
      includeFileGraph: true,
      configPath: options.configPath
    });

    const candidate = architecture.drift;
    const candidateSummary = buildArchitectureSummary(architecture, ux);

    const baselinePath = await resolveBaselinePath({
      projectRoot: originalRoot,
      config,
      override: options.baseline
    });
    const baseline = baselinePath ? await loadDriftFromFile(baselinePath) : null;

    const baselineSummaryPath = await resolveBaselineSummaryPath({
      projectRoot: originalRoot,
      override: options.baselineSummary
    });
    const baselineSummary = baselineSummaryPath
      ? await loadSummaryFromPath(baselineSummaryPath)
      : null;

    const evaluation = evaluateCandidate({
      candidate,
      baseline,
      config,
      baselineSummary,
      candidateSummary,
      mode: options.mode ?? config.guard?.mode ?? "soft"
    });

    const outputPath = path.resolve(options.output ?? "specs-out/drift.simulation.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(evaluation, null, 2));

    console.log(`Simulation decision: ${evaluation.decision}`);
    if (evaluation.reasons.length > 0) {
      console.log(`Reasons: ${evaluation.reasons.join(", ")}`);
    }
    console.log(`Wrote ${outputPath}`);
  } finally {
    if (cleanupTemp) {
      await fs.rm(simulationRoot, { recursive: true, force: true });
    }
  }
}

async function resolveBaselinePath(params: {
  projectRoot: string;
  config: SpecGuardConfig;
  override?: string;
}): Promise<string | null> {
  const { projectRoot, config, override } = params;
  const candidates: string[] = [];
  if (override) {
    candidates.push(override);
  }
  if (config.drift?.baselinePath) {
    candidates.push(config.drift.baselinePath);
  }
  candidates.push("specs-out/machine/baseline.json");
  candidates.push("specs-out/machine/drift.report.json");
  candidates.push("specs-out/machine/architecture.snapshot.yaml");

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    if (await fileExists(resolved)) {
      return resolved;
    }
  }
  return null;
}

async function resolveBaselineSummaryPath(params: {
  projectRoot: string;
  override?: string;
}): Promise<string | null> {
  const candidates: string[] = [];
  if (params.override) {
    candidates.push(params.override);
  }
  candidates.push(path.join(params.projectRoot, DEFAULT_SPECS_DIR, "machine", "architecture.summary.json"));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(params.projectRoot, candidate);
    if (await fileExists(resolved)) {
      return resolved;
    }
  }
  return null;
}

async function loadSummaryFromPath(filePath: string) {
  const dir = path.dirname(filePath);
  if (path.basename(filePath) === "architecture.summary.json") {
    return loadArchitectureSummary(dir);
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadDriftFromFile(filePath: string): Promise<DriftReport | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();
    const parsed =
      ext === ".yaml" || ext === ".yml"
        ? (yaml.load(raw) as Record<string, unknown>)
        : (JSON.parse(raw) as Record<string, unknown>);
    if (!parsed) {
      return null;
    }
    const drift = parsed["drift"] as DriftReport | undefined;
    if (drift && typeof drift.delta === "number") {
      return drift;
    }
    if (typeof (parsed as DriftReport).delta === "number") {
      return parsed as DriftReport;
    }
    return null;
  } catch {
    return null;
  }
}

function evaluateCandidate(params: {
  candidate: DriftReport;
  baseline: DriftReport | null;
  config: SpecGuardConfig;
  baselineSummary: Awaited<ReturnType<typeof loadArchitectureSummary>> | null;
  candidateSummary: ReturnType<typeof buildArchitectureSummary>;
  mode: "soft" | "hard";
}): {
  decision: "accept" | "warn" | "reject";
  reasons: string[];
  feedback: {
    previous_delta?: number;
    candidate_delta: number;
    reasons: string[];
    suggestions: string[];
  };
  mode: "soft" | "hard";
  baseline_delta?: number;
  candidate_delta: number;
  edge_growth_ratio?: number;
  shape_equivalent?: boolean;
} {
  const { candidate, baseline, config, baselineSummary, candidateSummary, mode } = params;
  const reasons: string[] = [];

  if (!baseline) {
    reasons.push("baseline_missing");
  } else {
    if (candidate.delta < baseline.delta) {
      reasons.push("delta_regressed");
    }
    const baselineEdges = baseline.details?.edges ?? 0;
    const candidateEdges = candidate.details?.edges ?? 0;
    if (baselineEdges > 0) {
      const ratio = (candidateEdges - baselineEdges) / baselineEdges;
      const maxRatio = config.drift?.growth?.maxEdgeGrowthRatio ?? 0;
      if (maxRatio > 0 && ratio > maxRatio) {
        reasons.push("edge_growth_ratio_exceeded");
      }
    }
  }

  if (candidate.status === "drift") {
    reasons.push("candidate_in_drift");
  }
  if (candidate.capacity.status === "critical") {
    reasons.push("capacity_critical");
  }
  if (candidate.growth.status === "critical") {
    reasons.push("growth_critical");
  }

  let shapeEquivalent: boolean | undefined;
  if (baselineSummary) {
    shapeEquivalent = baselineSummary.shape_fingerprint === candidateSummary.shape_fingerprint;
    if (!shapeEquivalent) {
      reasons.push("shape_changed");
    }
  }

  let decision: "accept" | "warn" | "reject" = "accept";
  if (reasons.length > 0) {
    decision = mode === "hard" ? "reject" : "warn";
  }

  return {
    decision,
    reasons,
    feedback: {
      previous_delta: baseline?.delta,
      candidate_delta: candidate.delta,
      reasons,
      suggestions: buildSuggestions(reasons)
    },
    mode,
    baseline_delta: baseline?.delta,
    candidate_delta: candidate.delta,
    edge_growth_ratio:
      baseline && (baseline.details?.edges ?? 0) > 0
        ? ((candidate.details?.edges ?? 0) - (baseline.details?.edges ?? 0)) /
          (baseline.details?.edges ?? 1)
        : undefined,
    shape_equivalent: shapeEquivalent
  };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

function buildSuggestions(reasons: string[]): string[] {
  const suggestions = new Set<string>();
  const mapping: Record<string, string> = {
    delta_regressed: "Reduce cross-layer coupling and refactor to lower drift.",
    edge_growth_ratio_exceeded: "Limit new dependencies; split the change into smaller steps.",
    candidate_in_drift: "Refactor to remove cycles or reduce coupling before applying.",
    capacity_critical: "Reduce edges in saturated layers or consolidate modules.",
    growth_critical: "Avoid adding new dependencies in this patch.",
    shape_changed: "Preserve the existing architecture shape; avoid new structural coupling.",
    baseline_missing: "Capture a baseline before enforcing drift gates."
  };
  for (const reason of reasons) {
    const suggestion = mapping[reason];
    if (suggestion) {
      suggestions.add(suggestion);
    }
  }
  return Array.from(suggestions);
}

async function createTempCopy(
  sourceRoot: string,
  config: SpecGuardConfig
): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-sim-"));
  const ignore = createIgnoreMatcher(config, sourceRoot);

  await fs.cp(sourceRoot, tempRoot, {
    recursive: true,
    filter: (src) => filterCopy(src, sourceRoot, ignore)
  });

  return tempRoot;
}

function filterCopy(src: string, baseRoot: string, ignore: ReturnType<typeof createIgnoreMatcher>): boolean {
  if (src === baseRoot) {
    return true;
  }
  const relative = path.relative(baseRoot, src);
  if (!relative) {
    return true;
  }
  const name = path.basename(src);
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(src);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    return !ignore.isIgnoredDir(name, src);
  }
  return !ignore.isIgnoredPath(relative);
}

async function applyPatch(workspaceRoot: string, patchPath: string): Promise<void> {
  const resolvedPatch = path.resolve(patchPath);
  const result = await runCommand("git", ["apply", "--whitespace=nowarn", resolvedPatch], workspaceRoot);
  if (result.code !== 0) {
    throw new Error(`Failed to apply patch: ${result.stderr || result.stdout}`);
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

function remapPath(original: string, sourceRoot: string, targetRoot: string): string {
  const relative = path.relative(sourceRoot, original);
  return path.join(targetRoot, relative);
}
