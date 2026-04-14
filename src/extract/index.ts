import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { analyzeBackend } from "./analyzers/backend.js";
import { analyzeFrontend } from "./analyzers/frontend.js";
import { writeSnapshots } from "./writer.js";
import { writeDocs } from "./docs.js";
import { analyzeRuntime } from "./runtime.js";
import { computeDriftReport, buildFunctionGraph } from "./drift.js";
import { writeCompressionOutputs } from "./compress.js";
import { buildCrossStackContracts } from "./contracts.js";
import { validateArchitectureSnapshot, validateUxSnapshot } from "../schema/index.js";
import type { SpecGuardConfig } from "../config.js";
import { getOutputLayout } from "../output-layout.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";
import type { ArchitectureSnapshot, BackendAnalysis, FrontendAnalysis, UxSnapshot } from "./types.js";
import { analyzeDepth } from "./analyzers/depth.js";
import type { StructuralIntelligenceReport } from "./types.js";
import {
  buildFunctionIntelligenceFromRoots,
  writeFunctionIntelligence,
} from "./function-intel.js";

export type ExtractProjectOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  includeFileGraph: boolean;
  configPath?: string;
  docsMode?: "lean" | "full";
};

export async function buildSnapshots(
  options: ExtractProjectOptions
): Promise<{
  architecture: ArchitectureSnapshot;
  ux: UxSnapshot;
  projectRoot: string;
  config: SpecGuardConfig;
  frontendRoot: string;
  backendRoot: string;
}> {
  const startedAt = Date.now();
  const includeFileGraph = options.includeFileGraph ?? false;
  const resolvedProject = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  const { workspaceRoot, backendRoot: resolvedBackendRoot, frontendRoot: resolvedFrontendRoot } =
    resolvedProject;
  logResolvedProjectPaths(resolvedProject);
  const reportedBackendRoot = formatOutputPath(resolvedBackendRoot);
  const reportedFrontendRoot = formatOutputPath(resolvedFrontendRoot);
  const reportedWorkspaceRoot = formatOutputPath(workspaceRoot);
  const config = resolvedProject.config;

  // Analyze all roots — run both analyzers on each root, then merge
  const allRoots = resolvedProject.roots;
  const backendResults: BackendAnalysis[] = [];
  const frontendResults: FrontendAnalysis[] = [];

  for (const root of allRoots) {
    const [be, fe] = await Promise.all([
      analyzeBackend(root, config, workspaceRoot),
      analyzeFrontend(root, config)
    ]);
    backendResults.push(be);
    frontendResults.push(fe);
  }

  const backend = mergeBackendAnalyses(backendResults, allRoots, workspaceRoot);
  const frontend = mergeFrontendAnalyses(frontendResults, allRoots, workspaceRoot);
  const projectRoot = workspaceRoot;
  const runtime = await analyzeRuntime(workspaceRoot, config);

  const projectName = deriveProjectName(resolvedBackendRoot);

  const normalizedFrontendCalls = buildFrontendCallIndex(frontend.apiCalls);
  const unusedEndpoints = backend.endpoints
    .filter((endpoint) => !isEndpointUsed(endpoint, normalizedFrontendCalls))
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .sort((a, b) => a.localeCompare(b));

  const dataFlows = buildDataFlows(frontend.uxPages, backend.endpoints, backend.endpointModelUsage);
  const crossStackContracts = buildCrossStackContracts({
    endpoints: backend.endpoints,
    apiCalls: frontend.apiCalls,
    ux: {
      version: "0.2",
      components: frontend.components,
      component_graph: frontend.componentGraph,
      pages: frontend.uxPages
    },
    dataModels: backend.dataModels
  });
  const endpointTestCoverage = buildEndpointTestCoverage(backend.endpoints, backend.testCoverage);
  const functionTestCoverage = await buildFunctionTestCoverage({
    backendRoot: resolvedBackendRoot,
    modules: backend.modules,
    projectRoot,
    config,
    testCoverage: backend.testCoverage
  });

  const drift = await computeDriftReport({
    backendRoot: resolvedBackendRoot,
    modules: backend.modules,
    moduleGraph: backend.moduleGraph,
    fileGraph: backend.fileGraph,
    circularDependencies: backend.circularDependencies,
    config,
    projectRoot
  });
  const generatedAt = new Date().toISOString();
  const extractedTests = [...backend.tests, ...frontend.tests];

  const architecture: ArchitectureSnapshot = {
    version: "1.0",
    metadata: {
      generated_at: generatedAt,
      duration_ms: Date.now() - startedAt,
      target_backend: reportedBackendRoot,
      target_frontend: reportedFrontendRoot
    },
    project: {
      name: projectName,
      workspace_root: reportedWorkspaceRoot,
      backend_root: reportedBackendRoot,
      frontend_root: reportedFrontendRoot,
      roots: resolvedProject.roots.map(formatOutputPath),
      resolution_source: resolvedProject.resolutionSource,
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
    cross_stack_contracts: crossStackContracts,
    tasks: backend.tasks,
    runtime,
    data_flows: dataFlows,
    tests: extractedTests,
    dependencies: {
      module_graph: backend.moduleGraph,
      file_graph: includeFileGraph ? dedupeFileGraph([...backend.fileGraph, ...frontend.fileGraph]) : []
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
      unused_endpoints: unusedEndpoints,
      frontend_unused_api_calls: frontend.apiCalls
        .filter((call) => !backend.endpoints.some(
          (ep) =>
            (ep.method.toUpperCase() === "ANY" || ep.method.toUpperCase() === call.method.toUpperCase()) &&
            normalizePathPattern(ep.path) === normalizePathPattern(call.path)
        ))
        .map((call) => `${call.method} ${call.path}`),
      duplicate_functions: backend.duplicateFunctions,
      similar_functions: backend.similarFunctions,
      test_coverage: backend.testCoverage,
      endpoint_test_coverage: endpointTestCoverage,
      function_test_coverage: functionTestCoverage
    }
  };

  const ux: UxSnapshot = {
    version: "0.2",
    components: frontend.components,
    component_graph: frontend.componentGraph,
    pages: frontend.uxPages
  };

  validateArchitectureSnapshot(architecture);
  validateUxSnapshot(ux);

  return {
    architecture,
    ux,
    projectRoot,
    config,
    frontendRoot: resolvedFrontendRoot,
    backendRoot: resolvedBackendRoot
  };
}

export async function extractProject(
  options: ExtractProjectOptions
): Promise<{ architecturePath: string; uxPath: string }> {
  const layout = getOutputLayout(options.output);
  const previous = await loadPreviousSnapshots(layout.machineDir, layout.rootDir);
  const { architecture, ux, projectRoot, config, backendRoot } = await buildSnapshots(options);
  const docsMode = options.docsMode ?? config.docs?.mode ?? "lean";
  const internalDir = config.docs?.internalDir ?? "internal";

  const result = await writeSnapshots(layout.machineDir, architecture, ux);
  await writeCompressionOutputs({
    outputDir: layout.machineDir,
    architecture,
    ux,
    context: {
      projectRoot,
      backendRoot,
      config
    }
  });
  await writeDocs(layout.rootDir, architecture, ux, {
    projectRoot,
    driftHistoryPath: config.drift?.historyPath,
    previous,
    docsMode,
    internalDir
  });

  // Generate Structural Intelligence reports for the top backend modules
  const siReports = await generateStructuralIntelligenceReports(architecture);
  if (siReports.length > 0) {
    const siPath = path.join(layout.machineDir, "structural-intelligence.json");
    await fs.writeFile(siPath, JSON.stringify(siReports, null, 2), "utf8");
    console.log(`Wrote ${siPath}`);
  }

  // Generate Function Intelligence — call graph, literal index across all languages.
  // Runs as an additive second pass; never modifies the architecture snapshot.
  try {
    const funcIntel = await buildFunctionIntelligenceFromRoots([projectRoot], config, projectRoot);
    await writeFunctionIntelligence(layout.machineDir, funcIntel);
  } catch (err) {
    // Non-fatal — function intel is additive; don't block the main extract
    console.warn(`Function intelligence skipped: ${(err as Error).message}`);
  }

  return result;
}

async function generateStructuralIntelligenceReports(
  architecture: ArchitectureSnapshot
): Promise<StructuralIntelligenceReport[]> {
  // Pick top modules by any measure of size: endpoints, files, or imports
  const topModules = architecture.modules
    .filter((m) => m.files.length > 0 || m.imports.length > 0)
    .map((m) => ({
      id: m.id,
      score: m.endpoints.length * 3 + m.files.length + m.imports.length
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((m) => m.id);

  const reports: StructuralIntelligenceReport[] = [];
  for (const query of topModules) {
    try {
      const report = analyzeDepth({
        query,
        modules: architecture.modules,
        moduleGraph: architecture.dependencies.module_graph,
        fileGraph: architecture.dependencies.file_graph,
        circularDependencies: architecture.analysis.circular_dependencies
      });
      // Persist any report with a non-trivial subgraph (at least 1 node matched)
      if (report.structure.nodes > 0) {
        reports.push(report);
      }
    } catch {
      // Skip modules that error during analysis
    }
  }
  return reports;
}

function deriveProjectName(backendRoot: string): string {
  const base = path.basename(path.resolve(backendRoot));
  if (base.toLowerCase() === "backend" || base.toLowerCase() === "src") {
    return path.basename(path.dirname(path.resolve(backendRoot)));
  }
  return base || "unknown";
}

function formatOutputPath(targetPath: string): string {
  const relative = path.relative(process.cwd(), targetPath);
  if (!relative) {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return targetPath;
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function dedupeFileGraph(edges: { from: string; to: string }[]): { from: string; to: string }[] {
  const seen = new Set<string>();
  const result: { from: string; to: string }[] = [];

  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edge);
  }

  result.sort((a, b) => {
    const from = a.from.localeCompare(b.from);
    if (from !== 0) return from;
    return a.to.localeCompare(b.to);
  });

  return result;
}

function buildEndpointTestCoverage(
  endpoints: ArchitectureSnapshot["endpoints"],
  coverage: ArchitectureSnapshot["analysis"]["test_coverage"]
): ArchitectureSnapshot["analysis"]["endpoint_test_coverage"] {
  const coverageMap = new Map<string, string[]>();
  for (const entry of coverage.coverage_map) {
    if (!entry.source_file) {
      continue;
    }
    const current = coverageMap.get(entry.source_file) ?? [];
    current.push(entry.test_file);
    coverageMap.set(entry.source_file, current);
  }

  return endpoints.map((endpoint) => {
    const tests = coverageMap.get(endpoint.file) ?? [];
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      method: endpoint.method,
      path: endpoint.path,
      file: endpoint.file,
      covered: tests.length > 0,
      coverage_type: tests.length > 0 ? "file" : "none",
      test_files: tests
    };
  });
}

async function buildFunctionTestCoverage(params: {
  backendRoot: string;
  modules: ArchitectureSnapshot["modules"];
  projectRoot: string;
  config: SpecGuardConfig;
  testCoverage: ArchitectureSnapshot["analysis"]["test_coverage"];
}): Promise<ArchitectureSnapshot["analysis"]["function_test_coverage"]> {
  const { backendRoot, modules, projectRoot, config, testCoverage } = params;
  const requestedScales = config.drift?.scales ?? [];
  const shouldBuild =
    requestedScales.includes("function") ||
    config.drift?.graphLevel === "function" ||
    config.drift?.graphLevel === "auto";
  if (!shouldBuild) {
    return [];
  }

  const fnGraph = await buildFunctionGraph({
    backendRoot,
    modules,
    projectRoot
  });
  if (!fnGraph) {
    return [];
  }

  const coverageMap = new Map<string, string[]>();
  for (const entry of testCoverage.coverage_map) {
    if (!entry.source_file) {
      continue;
    }
    const current = coverageMap.get(entry.source_file) ?? [];
    current.push(entry.test_file);
    coverageMap.set(entry.source_file, current);
  }

  return fnGraph.nodes.map((node) => {
    const file = node.split("#")[0] ?? node;
    const tests = coverageMap.get(file) ?? [];
    return {
      function_id: node,
      file,
      covered: tests.length > 0,
      coverage_type: tests.length > 0 ? "file" : "none",
      test_files: tests
    };
  });
}

function mergeBackendAnalyses(results: BackendAnalysis[], roots: string[], workspaceRoot: string): BackendAnalysis {
  if (results.length === 1) return results[0];

  // Prefix module IDs with root-relative path so they're globally unique
  for (let i = 0; i < results.length; i++) {
    const rootLabel = path.relative(workspaceRoot, roots[i]).replace(/\\/g, "/");
    const idMap = new Map<string, string>();
    for (const mod of results[i].modules) {
      const newId = `${rootLabel}/${mod.id}`;
      idMap.set(mod.id, newId);
      mod.id = newId;
      mod.path = `${rootLabel}/${mod.path}`;
    }
    // Remap references in graph edges, endpoints, etc.
    for (const edge of results[i].moduleGraph) {
      edge.from = idMap.get(edge.from) ?? edge.from;
      edge.to = idMap.get(edge.to) ?? edge.to;
    }
    for (const ep of results[i].endpoints) {
      if (ep.module && idMap.has(ep.module)) {
        ep.module = idMap.get(ep.module)!;
      }
    }
    for (const cycle of results[i].circularDependencies) {
      for (let j = 0; j < cycle.length; j++) {
        cycle[j] = idMap.get(cycle[j]) ?? cycle[j];
      }
    }
    results[i].orphanModules = results[i].orphanModules.map(m => idMap.get(m) ?? m);
    const newUsage: Record<string, number> = {};
    for (const [key, value] of Object.entries(results[i].moduleUsage)) {
      newUsage[idMap.get(key) ?? key] = value;
    }
    results[i].moduleUsage = newUsage;
  }

  const moduleUsage: Record<string, number> = {};
  for (const r of results) {
    for (const [key, value] of Object.entries(r.moduleUsage)) {
      moduleUsage[key] = (moduleUsage[key] ?? 0) + value;
    }
  }

  // Merge testCoverage: combine arrays across all roots
  const mergedCoverage = { ...results[0].testCoverage };
  mergedCoverage.untested_source_files = [...mergedCoverage.untested_source_files];
  mergedCoverage.test_files_missing_source = [...mergedCoverage.test_files_missing_source];
  mergedCoverage.coverage_map = [...mergedCoverage.coverage_map];
  for (let i = 1; i < results.length; i++) {
    const tc = results[i].testCoverage;
    mergedCoverage.untested_source_files.push(...tc.untested_source_files);
    mergedCoverage.test_files_missing_source.push(...tc.test_files_missing_source);
    mergedCoverage.coverage_map.push(...tc.coverage_map);
  }

  return {
    modules: results.flatMap(r => r.modules),
    moduleGraph: results.flatMap(r => r.moduleGraph),
    fileGraph: results.flatMap(r => r.fileGraph),
    endpoints: results.flatMap(r => r.endpoints),
    dataModels: results.flatMap(r => r.dataModels),
    enums: results.flatMap(r => r.enums),
    constants: results.flatMap(r => r.constants),
    endpointModelUsage: results.flatMap(r => r.endpointModelUsage),
    tasks: results.flatMap(r => r.tasks),
    circularDependencies: results.flatMap(r => r.circularDependencies),
    orphanModules: results.flatMap(r => r.orphanModules),
    orphanFiles: results.flatMap(r => r.orphanFiles),
    moduleUsage,
    unusedExports: results.flatMap(r => r.unusedExports),
    unusedEndpoints: results.flatMap(r => r.unusedEndpoints),
    entrypoints: results.flatMap(r => r.entrypoints),
    duplicateFunctions: results.flatMap(r => r.duplicateFunctions),
    similarFunctions: results.flatMap(r => r.similarFunctions),
    testCoverage: mergedCoverage,
    tests: results.flatMap(r => r.tests)
  };
}

function mergeFrontendAnalyses(results: FrontendAnalysis[], _roots: string[], _workspaceRoot: string): FrontendAnalysis {
  if (results.length === 1) return results[0];

  return {
    files: results.flatMap(r => r.files),
    pages: results.flatMap(r => r.pages),
    apiCalls: results.flatMap(r => r.apiCalls),
    uxPages: results.flatMap(r => r.uxPages),
    components: results.flatMap(r => r.components),
    componentGraph: results.flatMap(r => r.componentGraph),
    fileGraph: results.flatMap(r => r.fileGraph),
    orphanFiles: results.flatMap(r => r.orphanFiles),
    unusedExports: results.flatMap(r => r.unusedExports),
    tests: results.flatMap(r => r.tests)
  };
}


async function loadPreviousSnapshots(machineDir: string, rootDir?: string): Promise<{
  architecture?: ArchitectureSnapshot;
  ux?: UxSnapshot;
}> {
  const result: { architecture?: ArchitectureSnapshot; ux?: UxSnapshot } = {};
  const candidates = [
    {
      archPath: path.join(machineDir, "architecture.snapshot.yaml"),
      uxPath: path.join(machineDir, "ux.snapshot.yaml")
    }
  ];
  if (rootDir) {
    candidates.push({
      archPath: path.join(rootDir, "architecture.snapshot.yaml"),
      uxPath: path.join(rootDir, "ux.snapshot.yaml")
    });
  }

  for (const candidate of candidates) {
    if (!result.architecture) {
      try {
        const raw = await fs.readFile(candidate.archPath, "utf8");
        const parsed = yaml.load(raw) as ArchitectureSnapshot | undefined;
        if (parsed && typeof parsed === "object") {
          result.architecture = parsed;
        }
      } catch {
        // ignore
      }
    }
    if (!result.ux) {
      try {
        const raw = await fs.readFile(candidate.uxPath, "utf8");
        const parsed = yaml.load(raw) as UxSnapshot | undefined;
        if (parsed && typeof parsed === "object") {
          result.ux = parsed;
        }
      } catch {
        // ignore
      }
    }
  }

  return result;
}

function normalizePathPattern(value: string): string {
  if (!value) {
    return "/";
  }
  const withoutQuery = value.split("?")[0] ?? value;
  return withoutQuery
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/<[^>]+>/g, ":param")
    .replace(/:\w+/g, ":param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function normalizeMethod(method: string): string {
  return method ? method.toUpperCase() : "GET";
}

function buildFrontendCallIndex(
  calls: Array<{ method: string; path: string }>
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const call of calls) {
    const pathKey = normalizePathPattern(call.path);
    const method = normalizeMethod(call.method);
    const entry = index.get(pathKey) ?? new Set<string>();
    entry.add(method);
    index.set(pathKey, entry);
  }
  return index;
}

function isEndpointUsed(
  endpoint: { method: string; path: string },
  index: Map<string, Set<string>>
): boolean {
  const pathKey = normalizePathPattern(endpoint.path);
  const methods = index.get(pathKey);
  if (!methods || methods.size === 0) {
    return false;
  }
  if (endpoint.method.toUpperCase() === "ANY") {
    return true;
  }
  return methods.has(endpoint.method.toUpperCase());
}

function buildDataFlows(
  pages: UxSnapshot["pages"],
  endpoints: ArchitectureSnapshot["endpoints"],
  endpointUsage: ArchitectureSnapshot["endpoint_model_usage"]
): ArchitectureSnapshot["data_flows"] {
  const endpointByKey = new Map<string, typeof endpoints>();
  for (const endpoint of endpoints) {
    const key = `${normalizeMethod(endpoint.method)} ${normalizePathPattern(endpoint.path)}`;
    const current = endpointByKey.get(key) ?? [];
    current.push(endpoint);
    endpointByKey.set(key, current);
  }

  const modelsByEndpoint = new Map<string, string[]>();
  for (const usage of endpointUsage) {
    modelsByEndpoint.set(
      usage.endpoint_id,
      usage.models.map((model) => model.name)
    );
  }

  const flows: Array<{ page: string; endpoint_id: string; models: string[] }> = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const call of page.api_calls) {
      const parts = call.split(" ");
      if (parts.length < 2) {
        continue;
      }
      const method = normalizeMethod(parts[0]);
      const pathValue = normalizePathPattern(parts.slice(1).join(" "));
      const key = `${method} ${pathValue}`;
      const candidates =
        endpointByKey.get(key) ?? endpointByKey.get(`ANY ${pathValue}`) ?? [];

      for (const endpoint of candidates) {
        const models = modelsByEndpoint.get(endpoint.id) ?? [];
        const flowKey = `${page.path}|${endpoint.id}|${models.join(",")}`;
        if (seen.has(flowKey)) {
          continue;
        }
        seen.add(flowKey);
        flows.push({
          page: page.path,
          endpoint_id: endpoint.id,
          models
        });
      }
    }
  }

  flows.sort((a, b) => {
    const pageCmp = a.page.localeCompare(b.page);
    if (pageCmp !== 0) return pageCmp;
    return a.endpoint_id.localeCompare(b.endpoint_id);
  });

  return flows;
}
