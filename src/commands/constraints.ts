import fs from "node:fs/promises";
import path from "node:path";
import { analyzeBackend } from "../extract/analyzers/backend.js";
import { analyzeFrontend } from "../extract/analyzers/frontend.js";
import { analyzeRuntime } from "../extract/runtime.js";
import { computeDriftReport } from "../extract/drift.js";
import { buildArchitectureSummary } from "../extract/compress.js";
import type { DriftReport, DriftCapacityReport } from "../extract/types.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";

export type ConstraintOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  configPath?: string;
};

export async function runConstraints(options: ConstraintOptions): Promise<void> {
  const resolved = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  const resolvedBackendRoot = resolved.backendRoot;
  const resolvedFrontendRoot = resolved.frontendRoot;
  const config = resolved.config;
  logResolvedProjectPaths(resolved);

  const backend = await analyzeBackend(resolvedBackendRoot, config);
  const frontend = await analyzeFrontend(resolvedFrontendRoot, config);
  const projectRoot = resolved.workspaceRoot;
  const runtime = await analyzeRuntime(projectRoot, config);

  const drift = await computeDriftReport({
    backendRoot: resolvedBackendRoot,
    modules: backend.modules,
    moduleGraph: backend.moduleGraph,
    fileGraph: backend.fileGraph,
    circularDependencies: backend.circularDependencies,
    config,
    projectRoot
  });

  const architectureSummary = buildArchitectureSummary(
    {
      version: "1.0",
      metadata: {
        generated_at: new Date().toISOString(),
        duration_ms: 0,
        target_backend: resolvedBackendRoot,
        target_frontend: resolvedFrontendRoot
      },
      project: {
        name: deriveProjectName(resolvedBackendRoot),
        workspace_root: resolved.workspaceRoot,
        backend_root: resolvedBackendRoot,
        frontend_root: resolvedFrontendRoot,
        resolution_source: resolved.resolutionSource,
        entrypoints: backend.entrypoints
      },
      modules: backend.modules,
      frontend_files: frontend.files,
      frontend: {
        pages: frontend.pages,
        api_calls: frontend.apiCalls
      },
      endpoints: backend.endpoints,
      data_models: backend.dataModels,
      enums: backend.enums,
      constants: backend.constants,
      endpoint_model_usage: backend.endpointModelUsage,
      cross_stack_contracts: [],
      tasks: backend.tasks,
      runtime,
      data_flows: [],
      tests: [...backend.tests, ...frontend.tests],
      dependencies: {
        module_graph: backend.moduleGraph,
        file_graph: []
      },
      drift,
      analysis: {
        circular_dependencies: backend.circularDependencies,
        orphan_modules: backend.orphanModules,
        orphan_files: backend.orphanFiles,
        frontend_orphan_files: frontend.orphanFiles,
        module_usage: backend.moduleUsage,
        unused_exports: backend.unusedExports,
        frontend_unused_exports: frontend.unusedExports,
        unused_endpoints: [],
        frontend_unused_api_calls: [],
        duplicate_functions: backend.duplicateFunctions,
        similar_functions: backend.similarFunctions,
        test_coverage: {
          untested_source_files: [],
          test_files_missing_source: [],
          coverage_map: []
        },
        endpoint_test_coverage: [],
        function_test_coverage: []
      }
    },
    {
      version: "0.2",
      components: frontend.components,
      component_graph: frontend.componentGraph,
      pages: frontend.uxPages
    }
  );

  const cycleModules = Array.from(
    new Set(backend.circularDependencies.flatMap((cycle) => cycle))
  );

  const constraints = {
    version: "0.1",
    generated_at: new Date().toISOString(),
    project: {
      name: deriveProjectName(resolvedBackendRoot)
    },
    drift: {
      delta: drift.delta,
      D_t: drift.D_t,
      K_t: drift.K_t,
      status: drift.status,
      graph_level: drift.graph_level,
      alerts: drift.alerts
    },
    capacity: drift.capacity,
    growth: drift.growth,
    cross_layer_edges: drift.details.cross_layer_edges,
    allowed_dependencies: config.drift?.layers ?? {},
    capacity_budgets: config.drift?.capacity ?? {},
    cycle_risk_modules: cycleModules,
    duplicate_functions: backend.duplicateFunctions.slice(0, 20),
    similar_functions: backend.similarFunctions.slice(0, 20),
    related_endpoints: findRelatedEndpoints(
      backend.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    ),
    modules: backend.modules.map((module) => module.id),
    endpoints: backend.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    models: backend.dataModels.map((model) => model.name),
    architecture_fingerprint: architectureSummary.fingerprint,
    shape_fingerprint: architectureSummary.shape_fingerprint,
    prompt: renderPrompt({
      drift,
      cycleModules,
      allowed: config.drift?.layers ?? {},
      capacity: drift.capacity
    })
  };

  const outputPath = path.resolve(options.output ?? "specs-out/constraints.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(constraints, null, 2));
  console.log(`Wrote ${outputPath}`);
}

function renderPrompt(params: {
  drift: DriftReport;
  cycleModules: string[];
  allowed: Record<string, string[]>;
  capacity: DriftCapacityReport;
}): string {
  const lines: string[] = [];
  lines.push("SYSTEM:");
  lines.push("You are operating inside a bounded architectural system.");
  lines.push("");
  lines.push("Constraints:");
  lines.push(`- Current delta: ${params.drift.delta.toFixed(4)} (${params.drift.status})`);
  if (params.capacity.total?.budget) {
    lines.push(
      `- Total capacity: ${params.capacity.total.used}/${params.capacity.total.budget}`
    );
  }
  if (params.cycleModules.length > 0) {
    lines.push(`- Avoid cycle-risk modules: ${params.cycleModules.join(", ")}`);
  }
  if (Object.keys(params.allowed).length > 0) {
    lines.push("- Allowed dependency flow:");
    for (const [layer, allowed] of Object.entries(params.allowed)) {
      lines.push(`  - ${layer} -> ${allowed.join(", ") || "none"}`);
    }
  }
  lines.push("");
  lines.push("Your task:");
  lines.push("- Implement the requested change without increasing cross-layer coupling.");
  lines.push("- Prefer refactoring or reuse over new module creation.");
  lines.push("- Do not introduce new cycles.");
  lines.push("- Return a patch only.");
  return lines.join("\n");
}

function findRelatedEndpoints(endpoints: string[]): Array<{
  similarity: number;
  endpoints: [string, string];
}> {
  const pairs: Array<{ similarity: number; endpoints: [string, string] }> = [];
  const tokenized = endpoints.map((endpoint) => ({
    endpoint,
    tokens: tokenizeEndpoint(endpoint)
  }));
  const threshold = 0.8;
  const maxPairs = 20;

  for (let i = 0; i < tokenized.length; i += 1) {
    for (let j = i + 1; j < tokenized.length; j += 1) {
      const sim = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (sim >= threshold) {
        pairs.push({
          similarity: round(sim, 2),
          endpoints: [tokenized[i].endpoint, tokenized[j].endpoint]
        });
        if (pairs.length >= maxPairs) {
          return pairs;
        }
      }
    }
  }
  return pairs;
}

function tokenizeEndpoint(endpoint: string): string[] {
  return endpoint
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .split(/[\\/\\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const entry of setA) {
    if (setB.has(entry)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function deriveProjectName(backendRoot: string): string {
  const base = path.basename(path.resolve(backendRoot));
  if (base.toLowerCase() === "backend" || base.toLowerCase() === "src") {
    return path.basename(path.dirname(path.resolve(backendRoot)));
  }
  return base || "unknown";
}
