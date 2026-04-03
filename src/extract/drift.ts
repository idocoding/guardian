import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import ts from "typescript";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { analyzeBackend } from "./analyzers/backend.js";
import { analyzeFrontend } from "./analyzers/frontend.js";
import { loadSpecGuardConfig } from "../config.js";
import type { SpecGuardConfig } from "../config.js";
import type {
  DriftReport,
  ModuleDependency,
  ModuleSummary,
  FileDependency,
  DriftScaleReport,
  DriftScaleLevel
} from "./types.js";

const EPSILON = 1e-6;

export type DriftOptions = {
  backendRoot: string;
  frontendRoot: string;
  configPath?: string;
};

export async function computeProjectDrift(options: DriftOptions): Promise<DriftReport> {
  const resolvedBackendRoot = await resolveBackendRoot(options.backendRoot);
  const resolvedFrontendRoot = path.resolve(options.frontendRoot);
  const config = await loadSpecGuardConfig({
    backendRoot: resolvedBackendRoot,
    frontendRoot: resolvedFrontendRoot,
    configPath: options.configPath
  });

  const backend = await analyzeBackend(resolvedBackendRoot, config);
  await analyzeFrontend(resolvedFrontendRoot, config);

  const projectRoot = findCommonRoot([resolvedBackendRoot, resolvedFrontendRoot]);
  return computeDriftReport({
    backendRoot: resolvedBackendRoot,
    modules: backend.modules,
    moduleGraph: backend.moduleGraph,
    fileGraph: backend.fileGraph,
    circularDependencies: backend.circularDependencies,
    config,
    projectRoot
  });
}

export async function computeDriftReport(params: {
  backendRoot: string;
  modules: ModuleSummary[];
  moduleGraph: ModuleDependency[];
  fileGraph: FileDependency[];
  circularDependencies: string[][];
  config: SpecGuardConfig;
  projectRoot: string;
}): Promise<DriftReport> {
  const {
    modules,
    moduleGraph,
    fileGraph,
    circularDependencies,
    config,
    projectRoot,
    backendRoot
  } = params;
  const requestedLevel = config.drift?.graphLevel ?? "module";
  const requestedScales = new Set(config.drift?.scales ?? []);

  const moduleGraphData = buildModuleGraph(modules, moduleGraph);
  const fileGraphData = buildFileGraph(modules, fileGraph);

  const shouldBuildFunction =
    requestedLevel === "function" ||
    requestedLevel === "auto" ||
    requestedScales.has("function");

  const functionGraphData = shouldBuildFunction
    ? await buildFunctionGraph({
        backendRoot,
        modules,
        projectRoot
      })
    : null;

  const domainGraphData = buildDomainGraph(modules, moduleGraph, config);

  const graphs: DriftGraph[] = [];
  if (requestedScales.size === 0 || requestedScales.has("module")) {
    graphs.push(moduleGraphData);
  }
  if ((requestedScales.size === 0 || requestedScales.has("file")) && fileGraphData) {
    graphs.push(fileGraphData);
  }
  if ((requestedScales.size === 0 || requestedScales.has("function")) && functionGraphData) {
    graphs.push(functionGraphData);
  }
  if ((requestedScales.size === 0 || requestedScales.has("domain")) && domainGraphData) {
    graphs.push(domainGraphData);
  }

  if (graphs.length === 0) {
    graphs.push(moduleGraphData);
  }

  const scaleReports = await Promise.all(
    graphs.map((graph) =>
      computeDriftForGraph({
        graph,
        circularDependencies,
        config,
        projectRoot
      })
    )
  );

  const primaryLevel = resolvePrimaryLevel(requestedLevel, scaleReports);
  const primary =
    scaleReports.find((report) => report.level === primaryLevel) ?? scaleReports[0];

  return {
    version: "0.3",
    graph_level: primary.level,
    metrics: primary.metrics,
    D_t: primary.D_t,
    K_t: primary.K_t,
    delta: primary.delta,
    status: primary.status,
    capacity: primary.capacity,
    growth: primary.growth,
    alerts: primary.alerts,
    details: primary.details,
    scales: scaleReports
  };
}

export type DriftGraph = {
  level: DriftScaleLevel;
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  nodeLayers: Map<string, string>;
};

type CapacityStatus = "ok" | "warning" | "critical" | "unbudgeted";

type DriftCapacityReport = {
  thresholds: {
    warning: number;
    critical: number;
  };
  total?: {
    budget?: number;
    used: number;
    ratio?: number;
    remaining?: number;
    status: CapacityStatus;
  };
  layers: Array<{
    layer: string;
    nodes: number;
    edges: number;
    cross_layer_out: number;
    budget?: number;
    ratio?: number;
    remaining?: number;
    status: CapacityStatus;
  }>;
  status: CapacityStatus;
};

type DriftGrowthReport = {
  edges_per_hour: number;
  edges_per_day: number;
  trend: "increasing" | "decreasing" | "stable" | "insufficient_data";
  window: {
    from?: string;
    to?: string;
    hours?: number;
  };
  status: "ok" | "critical" | "insufficient_data";
};

type DriftHistoryEntry = {
  timestamp?: string;
  graph_level?: string;
  details?: {
    edges?: number;
  };
  scales?: Array<{
    level?: string;
    details?: {
      edges?: number;
    };
  }>;
};

function buildModuleGraph(
  modules: ModuleSummary[],
  moduleGraph: ModuleDependency[]
): DriftGraph {
  const isTest = (f: string) => {
    const lower = f.toLowerCase();
    return lower.includes("test") || lower.includes("spec") || lower.includes("mock");
  };

  const filteredModules = modules.filter(m => !isTest(m.id));
  const nodes = filteredModules.map((module) => module.id);
  const nodeLayers = new Map<string, string>();
  for (const module of filteredModules) {
    nodeLayers.set(module.id, module.layer);
  }
  const edgeSet = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const edge of moduleGraph) {
    if (isTest(edge.from) || isTest(edge.to)) {
      continue;
    }
    const key = `${edge.from}::${edge.to}`;
    if (edgeSet.has(key)) {
      continue;
    }
    edgeSet.add(key);
    edges.push({ from: edge.from, to: edge.to });
  }
  return {
    level: "module",
    nodes,
    edges,
    nodeLayers
  };
}

function buildFileGraph(
  modules: ModuleSummary[],
  fileGraph: FileDependency[]
): DriftGraph {
  const nodes = new Set<string>();
  const nodeLayers = new Map<string, string>();
  const fileToLayer = new Map<string, string>();

  const isTest = (f: string) => {
    const lower = f.toLowerCase();
    return lower.includes("test") || lower.includes("spec") || lower.includes("mock");
  };

  for (const module of modules) {
    for (const file of module.files) {
      if (isTest(file)) continue;
      nodes.add(file);
      fileToLayer.set(file, module.layer);
      nodeLayers.set(file, module.layer);
    }
  }

  const edgeSet = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const edge of fileGraph) {
    if (isTest(edge.from) || isTest(edge.to)) continue;
    
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (fileToLayer.has(edge.from) && !nodeLayers.has(edge.from)) {
      nodeLayers.set(edge.from, fileToLayer.get(edge.from) as string);
    }
    if (fileToLayer.has(edge.to) && !nodeLayers.has(edge.to)) {
      nodeLayers.set(edge.to, fileToLayer.get(edge.to) as string);
    }
    const key = `${edge.from}::${edge.to}`;
    if (edgeSet.has(key)) {
      continue;
    }
    edgeSet.add(key);
    edges.push({ from: edge.from, to: edge.to });
  }

  return {
    level: "file",
    nodes: Array.from(nodes),
    edges,
    nodeLayers
  };
}

function buildDomainGraph(
  modules: ModuleSummary[],
  moduleGraph: ModuleDependency[],
  config: SpecGuardConfig
): DriftGraph | null {
  const domainMap = config.drift?.domains ?? {};
  const domainKeys = Object.keys(domainMap);
  if (domainKeys.length === 0) {
    return null;
  }

  const moduleToDomain = new Map<string, string>();
  for (const module of modules) {
    const domain = resolveDomainForModule(module.id, domainMap);
    if (domain) {
      moduleToDomain.set(module.id, domain);
    }
  }

  if (moduleToDomain.size === 0) {
    return null;
  }

  const nodes = new Set<string>();
  const nodeLayers = new Map<string, string>();
  const edgeSet = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  for (const domain of moduleToDomain.values()) {
    nodes.add(domain);
    nodeLayers.set(domain, domain);
  }

  for (const edge of moduleGraph) {
    const fromDomain = moduleToDomain.get(edge.from) ?? "unassigned";
    const toDomain = moduleToDomain.get(edge.to) ?? "unassigned";
    nodes.add(fromDomain);
    nodes.add(toDomain);
    nodeLayers.set(fromDomain, fromDomain);
    nodeLayers.set(toDomain, toDomain);
    const key = `${fromDomain}::${toDomain}`;
    if (edgeSet.has(key)) {
      continue;
    }
    edgeSet.add(key);
    edges.push({ from: fromDomain, to: toDomain });
  }

  return {
    level: "domain",
    nodes: Array.from(nodes),
    edges,
    nodeLayers
  };
}

function resolveDomainForModule(
  moduleId: string,
  domainMap: Record<string, string[]>
): string | null {
  for (const [domain, patterns] of Object.entries(domainMap)) {
    for (const pattern of patterns) {
      if (pattern === moduleId) {
        return domain;
      }
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        if (moduleId.startsWith(prefix)) {
          return domain;
        }
      }
    }
  }
  return null;
}

async function computeDriftForGraph(params: {
  graph: DriftGraph;
  circularDependencies: string[][];
  config: SpecGuardConfig;
  projectRoot: string;
}): Promise<DriftScaleReport> {
  const { graph, circularDependencies, config, projectRoot } = params;
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;

  const layerRules = config.drift?.layers ?? {};
  const layers = Object.keys(layerRules);
  const useLayerRules = layers.length > 0;

  let crossLayerEdges = 0;
  if (useLayerRules) {
    for (const edge of graph.edges) {
      const fromLayer = graph.nodeLayers.get(edge.from);
      const toLayer = graph.nodeLayers.get(edge.to);
      const allowed = fromLayer ? layerRules[fromLayer] ?? [] : [];
      if (!fromLayer || !toLayer || !allowed.includes(toLayer)) {
        crossLayerEdges += 1;
      }
    }
  }

  const crossLayerRatio = edgeCount === 0 ? 0 : crossLayerEdges / edgeCount;

  const degreeMap = new Map<string, number>();
  for (const node of graph.nodes) {
    degreeMap.set(node, 0);
  }
  for (const edge of graph.edges) {
    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
  }
  const totalDegree = Array.from(degreeMap.values()).reduce((sum, value) => sum + value, 0);
  let entropy = 0;
  if (totalDegree > 0) {
    for (const value of degreeMap.values()) {
      const p = value / totalDegree;
      if (p > 0) {
        entropy -= p * Math.log(p);
      }
    }
  }

  const cycles =
    graph.level === "module"
      ? circularDependencies.length
      : countCyclesInGraph(graph.edges, graph.nodes);
  const cycleDensity = nodeCount === 0 ? 0 : cycles / nodeCount;

  const modularityGap = computeModularityGap(graph.edges, graph.nodes);

  const weights = {
    entropy: config.drift?.weights?.entropy ?? 0.4,
    crossLayer: config.drift?.weights?.crossLayer ?? 0.3,
    cycles: config.drift?.weights?.cycles ?? 0.2,
    modularity: config.drift?.weights?.modularity ?? 0.1
  };

  const D_t =
    weights.entropy * entropy +
    weights.crossLayer * crossLayerRatio +
    weights.cycles * cycleDensity +
    weights.modularity * modularityGap;

  const capacity = await resolveCapacity({
    config,
    projectRoot,
    nodeCount,
    layersCount: layers.length
  });

  const delta = capacity - Math.log(D_t + EPSILON);
  const criticalThreshold = config.drift?.criticalDelta ?? 0.25;
  const baseStatus = delta < 0 ? "drift" : delta < criticalThreshold ? "critical" : "stable";
  const capacityReport = computeCapacityReport(graph, config);
  const growthReport = await computeGrowthReport({
    projectRoot,
    config,
    graphLevel: graph.level
  });
  const alerts = buildAlerts({
    baseStatus,
    capacity: capacityReport,
    growth: growthReport
  });
  const fingerprints = computeGraphFingerprints(graph);
  let status: DriftScaleReport["status"] = baseStatus;
  if (status !== "drift") {
    if (capacityReport.status === "critical" || growthReport.status === "critical") {
      status = "critical";
    }
  }

  return {
    level: graph.level,
    metrics: {
      entropy,
      cross_layer_ratio: crossLayerRatio,
      cycle_density: cycleDensity,
      modularity_gap: modularityGap
    },
    D_t,
    K_t: capacity,
    delta,
    status,
    capacity: capacityReport,
    growth: growthReport,
    alerts,
    details: {
      nodes: nodeCount,
      edges: edgeCount,
      cycles,
      cross_layer_edges: crossLayerEdges,
      layers,
      fingerprint: fingerprints.fingerprint,
      shape_fingerprint: fingerprints.shape_fingerprint
    }
  };
}

function resolvePrimaryLevel(
  requestedLevel: "module" | "function" | "auto",
  scales: DriftScaleReport[]
): DriftScaleLevel {
  if (requestedLevel !== "auto") {
    const found = scales.find((scale) => scale.level === requestedLevel);
    if (found) {
      return found.level;
    }
  }

  const preferred: DriftScaleLevel[] = ["function", "module", "file", "domain"];
  for (const level of preferred) {
    if (scales.some((scale) => scale.level === level)) {
      return level;
    }
  }

  return scales[0]?.level ?? "module";
}

function computeCapacityReport(graph: DriftGraph, config: SpecGuardConfig): DriftCapacityReport {
  const thresholds = {
    warning: config.drift?.capacity?.warningRatio ?? 0.85,
    critical: config.drift?.capacity?.criticalRatio ?? 1.0
  };
  const layerBudgets = config.drift?.capacity?.layers ?? {};

  const usage = new Map<
    string,
    {
      nodes: number;
      edges: number;
      crossLayerOut: number;
    }
  >();

  for (const node of graph.nodes) {
    const layer = graph.nodeLayers.get(node) ?? "unassigned";
    const entry = usage.get(layer) ?? { nodes: 0, edges: 0, crossLayerOut: 0 };
    entry.nodes += 1;
    usage.set(layer, entry);
  }

  for (const edge of graph.edges) {
    const fromLayer = graph.nodeLayers.get(edge.from) ?? "unassigned";
    const toLayer = graph.nodeLayers.get(edge.to) ?? "unassigned";
    const entry = usage.get(fromLayer) ?? { nodes: 0, edges: 0, crossLayerOut: 0 };
    entry.edges += 1;
    if (fromLayer !== toLayer) {
      entry.crossLayerOut += 1;
    }
    usage.set(fromLayer, entry);
  }

  const layers = new Set<string>([...usage.keys(), ...Object.keys(layerBudgets)]);
  const layerReports: DriftCapacityReport["layers"] = [];
  let hasBudget = false;
  let anyMeasured = false;
  let overallStatus: CapacityStatus = "unbudgeted";

  const severity = (status: CapacityStatus): number => {
    if (status === "critical") return 3;
    if (status === "warning") return 2;
    if (status === "ok") return 1;
    return 0;
  };

  for (const layer of layers) {
    const stats = usage.get(layer) ?? { nodes: 0, edges: 0, crossLayerOut: 0 };
    const budget = layerBudgets[layer];
    const report = computeCapacityStatus(stats.edges, budget, thresholds);
    const entry = {
      layer,
      nodes: stats.nodes,
      edges: stats.edges,
      cross_layer_out: stats.crossLayerOut,
      budget: report.budget,
      ratio: report.ratio,
      remaining: report.remaining,
      status: report.status
    };
    layerReports.push(entry);
    anyMeasured = true;
    if (typeof budget === "number" && budget > 0) {
      hasBudget = true;
    }
    if (severity(entry.status) > severity(overallStatus)) {
      overallStatus = entry.status;
    } else if (overallStatus === "unbudgeted" && entry.status !== "unbudgeted") {
      overallStatus = entry.status;
    }
  }

  let totalReport: DriftCapacityReport["total"];
  const totalUsed = graph.edges.length;
  const configuredTotal = config.drift?.capacity?.total ?? 0;
  const computedTotal =
    configuredTotal > 0
      ? configuredTotal
      : hasBudget
      ? Object.values(layerBudgets).reduce((sum, value) => sum + (value || 0), 0)
      : 0;
  if (computedTotal > 0 || anyMeasured) {
    const report = computeCapacityStatus(totalUsed, computedTotal || undefined, thresholds);
    totalReport = {
      budget: report.budget,
      used: totalUsed,
      ratio: report.ratio,
      remaining: report.remaining,
      status: report.status
    };
    if (severity(report.status) > severity(overallStatus)) {
      overallStatus = report.status;
    } else if (overallStatus === "unbudgeted" && report.status !== "unbudgeted") {
      overallStatus = report.status;
    }
  }

  return {
    thresholds,
    total: totalReport,
    layers: layerReports.sort((a, b) => a.layer.localeCompare(b.layer)),
    status: overallStatus
  };
}

function computeCapacityStatus(
  used: number,
  budget: number | undefined,
  thresholds: { warning: number; critical: number }
): {
  budget?: number;
  ratio?: number;
  remaining?: number;
  status: CapacityStatus;
} {
  if (typeof budget !== "number" || budget <= 0) {
    return {
      status: "unbudgeted"
    };
  }

  const ratio = budget === 0 ? 0 : used / budget;
  const remaining = Math.max(0, budget - used);
  let status: CapacityStatus = "ok";
  if (ratio >= thresholds.critical) {
    status = "critical";
  } else if (ratio >= thresholds.warning) {
    status = "warning";
  }
  return {
    budget,
    ratio,
    remaining,
    status
  };
}

async function computeGrowthReport(params: {
  projectRoot: string;
  config: SpecGuardConfig;
  graphLevel: DriftScaleLevel;
}): Promise<DriftGrowthReport> {
  const { projectRoot, config, graphLevel } = params;
  const entries = await loadDriftHistory(projectRoot, config);
  const filtered = entries
    .map((entry) => ({
      timestamp: entry.timestamp,
      edges: extractEdgesForLevel(entry, graphLevel)
    }))
    .filter((entry) => typeof entry.edges === "number")
    .filter((entry) => typeof entry.timestamp === "string");

  if (filtered.length < 2) {
    return {
      edges_per_hour: 0,
      edges_per_day: 0,
      trend: "insufficient_data",
      window: {},
      status: "insufficient_data"
    };
  }

  const sorted = filtered.sort((a, b) => {
    const timeA = new Date(a.timestamp ?? "").getTime();
    const timeB = new Date(b.timestamp ?? "").getTime();
    return timeA - timeB;
  });
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const lastTime = new Date(last.timestamp ?? "").getTime();
  const prevTime = new Date(prev.timestamp ?? "").getTime();
  const deltaMs = lastTime - prevTime;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return {
      edges_per_hour: 0,
      edges_per_day: 0,
      trend: "insufficient_data",
      window: {
        from: prev.timestamp,
        to: last.timestamp
      },
      status: "insufficient_data"
    };
  }

  const edgesDelta = (last.edges ?? 0) - (prev.edges ?? 0);
  const hours = deltaMs / (1000 * 60 * 60);
  const edgesPerHour = edgesDelta / hours;
  const edgesPerDay = edgesPerHour * 24;
  const trend = edgesDelta > 0 ? "increasing" : edgesDelta < 0 ? "decreasing" : "stable";
  const maxPerHour = config.drift?.growth?.maxEdgesPerHour ?? 0;
  const maxPerDay = config.drift?.growth?.maxEdgesPerDay ?? 0;
  const shouldAlert =
    (maxPerHour > 0 && edgesPerHour > maxPerHour) || (maxPerDay > 0 && edgesPerDay > maxPerDay);

  return {
    edges_per_hour: edgesPerHour,
    edges_per_day: edgesPerDay,
    trend,
    window: {
      from: prev.timestamp,
      to: last.timestamp,
      hours
    },
    status: shouldAlert ? "critical" : "ok"
  };
}

function extractEdgesForLevel(entry: DriftHistoryEntry, level: DriftScaleLevel): number | null {
  if (Array.isArray(entry.scales)) {
    const scale = entry.scales.find((item) => item.level === level);
    if (scale && typeof scale.details?.edges === "number") {
      return scale.details.edges;
    }
  }
  if (entry.graph_level && entry.graph_level !== level) {
    return null;
  }
  if (typeof entry.details?.edges === "number") {
    return entry.details.edges;
  }
  return null;
}

async function loadDriftHistory(
  projectRoot: string,
  config: SpecGuardConfig
): Promise<DriftHistoryEntry[]> {
  const historyPath =
    config.drift?.historyPath && config.drift.historyPath.length > 0
      ? config.drift.historyPath
      : "specs-out/drift.history.jsonl";
  const resolved = path.isAbsolute(historyPath)
    ? historyPath
    : path.resolve(projectRoot, historyPath);

  let raw = "";
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch {
    return [];
  }

  const entries: DriftHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as DriftHistoryEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

function buildAlerts(params: {
  baseStatus: "stable" | "critical" | "drift";
  capacity: DriftCapacityReport;
  growth: DriftGrowthReport;
}): string[] {
  const alerts: string[] = [];
  if (params.baseStatus === "drift") {
    alerts.push("delta:drift");
  } else if (params.baseStatus === "critical") {
    alerts.push("delta:critical");
  }

  for (const layer of params.capacity.layers) {
    if (layer.status === "warning" || layer.status === "critical") {
      alerts.push(`capacity:${layer.layer}:${layer.status}`);
    }
  }
  if (params.capacity.total && params.capacity.total.status !== "unbudgeted") {
    if (params.capacity.total.status === "warning" || params.capacity.total.status === "critical") {
      alerts.push(`capacity:total:${params.capacity.total.status}`);
    }
  }

  if (params.growth.status === "critical") {
    alerts.push("growth:edges");
  }
  return alerts;
}

export async function buildFunctionGraph(params: {
  backendRoot: string;
  modules: ModuleSummary[];
  projectRoot: string;
}): Promise<DriftGraph | null> {
  const { backendRoot, modules, projectRoot } = params;
  const fileToModule = new Map<string, string>();
  const moduleLayers = new Map<string, string>();
  for (const module of modules) {
    moduleLayers.set(module.id, module.layer);
    for (const file of module.files) {
      fileToModule.set(toPosix(file), module.id);
    }
  }

  const tsFiles: string[] = [];
  const pyFiles: string[] = [];
  for (const file of fileToModule.keys()) {
    if (file.endsWith(".d.ts")) {
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const absolute = path.resolve(projectRoot, file);
    if (ext === ".py") {
      pyFiles.push(absolute);
    } else if (isTsFile(ext)) {
      tsFiles.push(absolute);
    }
  }

  const nodes = new Set<string>();
  const edges = new Set<string>();
  const nodeLayers = new Map<string, string>();

  if (tsFiles.length > 0) {
    const tsResult = buildTsFunctionGraph({
      backendRoot,
      projectRoot,
      fileToModule,
      moduleLayers,
      filePaths: tsFiles
    });
    for (const node of tsResult.nodes) {
      nodes.add(node);
    }
    for (const edge of tsResult.edges) {
      edges.add(edge);
    }
    for (const [key, value] of tsResult.nodeLayers) {
      nodeLayers.set(key, value);
    }
  }

  if (pyFiles.length > 0) {
    const pyResult = await buildPythonFunctionGraph({
      backendRoot,
      projectRoot,
      fileToModule,
      moduleLayers,
      filePaths: pyFiles
    });
    for (const node of pyResult.nodes) {
      nodes.add(node);
    }
    for (const edge of pyResult.edges) {
      edges.add(edge);
    }
    for (const [key, value] of pyResult.nodeLayers) {
      nodeLayers.set(key, value);
    }
  }

  if (nodes.size === 0) {
    return null;
  }

  const edgeList = Array.from(edges).map((entry) => {
    const [from, to] = entry.split("::");
    return { from, to };
  });

  return {
    level: "function",
    nodes: Array.from(nodes),
    edges: edgeList,
    nodeLayers
  };
}

function buildTsFunctionGraph(params: {
  backendRoot: string;
  projectRoot: string;
  fileToModule: Map<string, string>;
  moduleLayers: Map<string, string>;
  filePaths: string[];
}): {
  nodes: Set<string>;
  edges: Set<string>;
  nodeLayers: Map<string, string>;
} {
  const { backendRoot, projectRoot, fileToModule, moduleLayers, filePaths } = params;
  const program = createTsProgram(filePaths, backendRoot);
  const checker = program.getTypeChecker();
  const nodeLayers = new Map<string, string>();
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const declarationToId = new Map<ts.Node, string>();
  const functionNodeToId = new Map<ts.Node, string>();

  const registerFunction = (
    id: string,
    declaration: ts.Node,
    functionNode: ts.Node,
    moduleId: string
  ): void => {
    nodes.add(id);
    declarationToId.set(declaration, id);
    functionNodeToId.set(functionNode, id);
    const layer = moduleLayers.get(moduleId);
    if (layer) {
      nodeLayers.set(id, layer);
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!filePaths.includes(sourceFile.fileName)) {
      continue;
    }
    const relative = toPosix(path.relative(projectRoot, sourceFile.fileName));
    const moduleId = fileToModule.get(relative);
    if (!moduleId) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const id = `${relative}#${node.name.text}`;
        registerFunction(id, node, node, moduleId);
      }

      if (ts.isMethodDeclaration(node) && node.name) {
        const name =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
            ? node.name.text
            : "method";
        const className =
          ts.isClassDeclaration(node.parent) && node.parent.name
            ? node.parent.name.text
            : "Class";
        const id = `${relative}#${className}.${name}`;
        registerFunction(id, node, node, moduleId);
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const initializer = node.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          const id = `${relative}#${node.name.text}`;
          registerFunction(id, node, initializer, moduleId);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!filePaths.includes(sourceFile.fileName)) {
      continue;
    }
    const relative = toPosix(path.relative(projectRoot, sourceFile.fileName));
    const moduleId = fileToModule.get(relative);
    if (!moduleId) {
      continue;
    }

    const visit = (node: ts.Node, currentFunctionId?: string): void => {
      const localFunctionId = functionNodeToId.get(node) ?? currentFunctionId;

      if (localFunctionId && ts.isCallExpression(node)) {
        const calleeId = resolveCallTarget(node.expression, checker, declarationToId);
        if (calleeId) {
          edges.add(`${localFunctionId}::${calleeId}`);
        }
      }

      ts.forEachChild(node, (child) => visit(child, localFunctionId));
    };

    visit(sourceFile);
  }

  return { nodes, edges, nodeLayers };
}

function resolveCallTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  declarationToId: Map<ts.Node, string>
): string | null {
  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return null;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    const id = declarationToId.get(declaration);
    if (id) {
      return id;
    }
  }
  return null;
}

async function buildPythonFunctionGraph(params: {
  backendRoot: string;
  projectRoot: string;
  fileToModule: Map<string, string>;
  moduleLayers: Map<string, string>;
  filePaths: string[];
}): Promise<{
  nodes: Set<string>;
  edges: Set<string>;
  nodeLayers: Map<string, string>;
}> {
  const { backendRoot, projectRoot, fileToModule, moduleLayers, filePaths } = params;
  const parser = new Parser();
  parser.setLanguage(Python);

  const nodes = new Set<string>();
  const edges = new Set<string>();
  const nodeLayers = new Map<string, string>();

  const parsedFiles: Array<{
    filePath: string;
    source: string;
    root: Parser.SyntaxNode;
    moduleName: string | null;
    relative: string;
  }> = [];

  for (const filePath of filePaths) {
    let source = "";
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (!source) {
      continue;
    }
    let tree: Parser.Tree;
    try {
      tree = parser.parse(source);
    } catch {
      continue;
    }
    const root = tree.rootNode;
    const moduleName = pythonModuleName(filePath, backendRoot);
    const relative = toPosix(path.relative(projectRoot, filePath));
    parsedFiles.push({ filePath, source, root, moduleName, relative });
  }

  const moduleIndex = new Map<string, string>();
  const moduleFunctionIds = new Map<string, Map<string, string>>();
  const fileFunctionIds = new Map<string, Map<string, string>>();
  const fileClassMethodIds = new Map<string, Map<string, Map<string, string>>>();

  for (const parsed of parsedFiles) {
    if (!parsed.moduleName) {
      continue;
    }
    const moduleName = parsed.moduleName;
    moduleIndex.set(moduleName, parsed.filePath);
    const moduleId = fileToModule.get(parsed.relative);
    const layer = moduleId ? moduleLayers.get(moduleId) : undefined;
    const functionIds = new Map<string, string>();
    const classMethods = new Map<string, Map<string, string>>();

    walk(parsed.root, (node) => {
      if (node.type !== "function_definition") {
        return;
      }
      if (!isTopLevel(node)) {
        return;
      }
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        return;
      }
      const name = nodeText(nameNode, parsed.source);
      const id = `${parsed.relative}#${name}`;
      functionIds.set(name, id);
      nodes.add(id);
      if (layer) {
        nodeLayers.set(id, layer);
      }
      const moduleMap = moduleFunctionIds.get(moduleName);
      if (moduleMap) {
        if (!moduleMap.has(name)) {
          moduleMap.set(name, id);
        }
      } else {
        moduleFunctionIds.set(moduleName, new Map([[name, id]]));
      }
    });

    walk(parsed.root, (node) => {
      if (node.type !== "class_definition") {
        return;
      }
      if (!isTopLevel(node)) {
        return;
      }
      const nameNode = node.childForFieldName("name");
      const bodyNode = node.childForFieldName("body");
      if (!nameNode || !bodyNode) {
        return;
      }
      const className = nodeText(nameNode, parsed.source);
      const methods = new Map<string, string>();
      for (const child of bodyNode.namedChildren) {
        if (child.type !== "function_definition") {
          continue;
        }
        const methodNameNode = child.childForFieldName("name");
        if (!methodNameNode) {
          continue;
        }
        const methodName = nodeText(methodNameNode, parsed.source);
        const id = `${parsed.relative}#${className}.${methodName}`;
        methods.set(methodName, id);
        nodes.add(id);
        if (layer) {
          nodeLayers.set(id, layer);
        }
        const moduleMap = moduleFunctionIds.get(moduleName);
        const methodKey = `${className}.${methodName}`;
        if (moduleMap) {
          if (!moduleMap.has(methodKey)) {
            moduleMap.set(methodKey, id);
          }
        } else {
          moduleFunctionIds.set(moduleName, new Map([[methodKey, id]]));
        }
      }
      if (methods.size > 0) {
        classMethods.set(className, methods);
      }
    });

    fileFunctionIds.set(parsed.filePath, functionIds);
    if (classMethods.size > 0) {
      fileClassMethodIds.set(parsed.filePath, classMethods);
    }
  }

  for (const parsed of parsedFiles) {
    if (!parsed.moduleName) {
      continue;
    }
    const functionIds = fileFunctionIds.get(parsed.filePath) ?? new Map();
    const classMethods = fileClassMethodIds.get(parsed.filePath) ?? new Map();
    if (functionIds.size === 0 && classMethods.size === 0) {
      continue;
    }

    const currentPackage = pythonPackageParts(parsed.filePath, backendRoot);
    const imports = collectPythonImports({
      root: parsed.root,
      source: parsed.source,
      moduleIndex,
      moduleFunctionIds,
      currentPackage
    });

    walk(parsed.root, (node) => {
      if (node.type !== "function_definition") {
        return;
      }
      if (!isTopLevel(node)) {
        return;
      }
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        return;
      }
      const functionName = nodeText(nameNode, parsed.source);
      const fromId = functionIds.get(functionName);
      if (!fromId) {
        return;
      }
      const body = node.childForFieldName("body");
      if (!body) {
        return;
      }
      walk(body, (child) => {
        if (child.type !== "call") {
          return;
        }
        const callee = child.childForFieldName("function");
        if (!callee) {
          return;
        }
        const toId = resolvePythonCall({
          callee,
          source: parsed.source,
          localFunctions: functionIds,
          imports,
          moduleFunctionIds,
          classContext: null,
          classMethods
        });
        if (toId) {
          edges.add(`${fromId}::${toId}`);
        }
      });
    });

    walk(parsed.root, (node) => {
      if (node.type !== "class_definition") {
        return;
      }
      if (!isTopLevel(node)) {
        return;
      }
      const nameNode = node.childForFieldName("name");
      const bodyNode = node.childForFieldName("body");
      if (!nameNode || !bodyNode) {
        return;
      }
      const className = nodeText(nameNode, parsed.source);
      const methodMap = classMethods.get(className);
      if (!methodMap || methodMap.size === 0) {
        return;
      }
      for (const child of bodyNode.namedChildren) {
        if (child.type !== "function_definition") {
          continue;
        }
        const methodNameNode = child.childForFieldName("name");
        const methodBody = child.childForFieldName("body");
        if (!methodNameNode || !methodBody) {
          continue;
        }
        const methodName = nodeText(methodNameNode, parsed.source);
        const fromId = methodMap.get(methodName);
        if (!fromId) {
          continue;
        }
        walk(methodBody, (callNode) => {
          if (callNode.type !== "call") {
            return;
          }
          const callee = callNode.childForFieldName("function");
          if (!callee) {
            return;
          }
          const toId = resolvePythonCall({
            callee,
            source: parsed.source,
            localFunctions: functionIds,
            imports,
            moduleFunctionIds,
            classContext: className,
            classMethods
          });
          if (toId) {
            edges.add(`${fromId}::${toId}`);
          }
        });
      }
    });
  }

  return { nodes, edges, nodeLayers };
}

function createTsProgram(filePaths: string[], searchRoot: string): ts.Program {
  const configPath =
    ts.findConfigFile(searchRoot, ts.sys.fileExists, "tsconfig.json") ||
    ts.findConfigFile(searchRoot, ts.sys.fileExists, "jsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config ?? {},
      ts.sys,
      path.dirname(configPath)
    );
    const options = parsed.options;
    return ts.createProgram(filePaths, options);
  }
  return ts.createProgram(filePaths, {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    resolveJsonModule: true
  });
}

function isTsFile(ext: string): boolean {
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts"
  ].includes(ext);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function nodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function isTopLevel(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "module";
}

function pythonModuleParts(filePath: string, backendRoot: string): string[] {
  const relative = toPosix(path.relative(backendRoot, filePath));
  if (!relative || relative.startsWith("..")) {
    return [];
  }
  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    return [];
  }
  const base = fileName.replace(/\.py$/i, "");
  if (base && base !== "__init__") {
    parts.push(base);
  }
  return parts;
}

function pythonModuleName(filePath: string, backendRoot: string): string | null {
  const parts = pythonModuleParts(filePath, backendRoot);
  return parts.length > 0 ? parts.join(".") : null;
}

function pythonPackageParts(filePath: string, backendRoot: string): string[] {
  const parts = pythonModuleParts(filePath, backendRoot);
  const base = path.basename(filePath, ".py");
  if (base === "__init__") {
    return parts;
  }
  return parts.slice(0, -1);
}

type PythonImportInfo = {
  moduleAliases: Map<string, string>;
  functionAliases: Map<string, { moduleName: string; functionName: string }>;
};

function collectPythonImports(params: {
  root: Parser.SyntaxNode;
  source: string;
  moduleIndex: Map<string, string>;
  moduleFunctionIds: Map<string, Map<string, string>>;
  currentPackage: string[];
}): PythonImportInfo {
  const { root, source, moduleIndex, moduleFunctionIds, currentPackage } = params;
  const moduleAliases = new Map<string, string>();
  const functionAliases = new Map<string, { moduleName: string; functionName: string }>();

  const registerFunctionAlias = (alias: string, moduleName: string, functionName: string): void => {
    if (!moduleName || !functionName) {
      return;
    }
    functionAliases.set(alias, { moduleName, functionName });
  };

  const registerModuleAlias = (alias: string, moduleName: string): void => {
    if (!moduleName) {
      return;
    }
    moduleAliases.set(alias, moduleName);
  };

  walk(root, (node) => {
    if (node.type === "import_statement") {
      const entries = collectImportEntries(node, source);
      for (const entry of entries) {
        if (entry.name === "*") {
          continue;
        }
        const alias = entry.alias ?? entry.name.split(".").pop() ?? entry.name;
        registerModuleAlias(alias, entry.name);
      }
    }

    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      const moduleText = moduleNode ? nodeText(moduleNode, source) : "";
      const baseModule = resolveImportModuleName(moduleText, currentPackage);
      if (!baseModule) {
        return;
      }
      const entries = collectImportEntries(node, source);
      for (const entry of entries) {
        if (entry.name === "*" || entry.name === "") {
          continue;
        }
        const alias = entry.alias ?? entry.name.split(".").pop() ?? entry.name;
        const candidateModule = `${baseModule}.${entry.name}`;
        if (moduleIndex.has(candidateModule)) {
          registerModuleAlias(alias, candidateModule);
          continue;
        }

        if (entry.name.includes(".")) {
          const parts = entry.name.split(".").filter(Boolean);
          const functionName = parts[parts.length - 1];
          const moduleCandidate = `${baseModule}.${parts.slice(0, -1).join(".")}`;
          if (moduleFunctionIds.get(moduleCandidate)?.has(functionName)) {
            registerFunctionAlias(alias, moduleCandidate, functionName);
            continue;
          }
          if (moduleIndex.has(moduleCandidate)) {
            registerModuleAlias(alias, moduleCandidate);
            continue;
          }
          registerFunctionAlias(alias, baseModule, functionName);
          continue;
        }

        if (moduleFunctionIds.get(baseModule)?.has(entry.name)) {
          registerFunctionAlias(alias, baseModule, entry.name);
          continue;
        }

        const nestedModule = `${baseModule}.${entry.name}`;
        if (moduleIndex.has(nestedModule)) {
          registerModuleAlias(alias, nestedModule);
          continue;
        }

        registerFunctionAlias(alias, baseModule, entry.name);
      }
    }
  });

  return { moduleAliases, functionAliases };
}

type ImportEntry = { name: string; alias?: string };

function collectImportEntries(node: Parser.SyntaxNode, source: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
      if (!nameNode) {
        continue;
      }
      entries.push({
        name: nodeText(nameNode, source),
        alias: aliasNode ? nodeText(aliasNode, source) : undefined
      });
    } else if (child.type === "dotted_name" || child.type === "identifier") {
      entries.push({ name: nodeText(child, source) });
    } else if (child.type === "wildcard_import") {
      entries.push({ name: "*" });
    }
  }
  return entries;
}

function resolveImportModuleName(moduleText: string, currentPackage: string[]): string | null {
  if (!moduleText) {
    return null;
  }
  let level = 0;
  while (level < moduleText.length && moduleText[level] === ".") {
    level += 1;
  }
  if (level === 0) {
    return moduleText;
  }
  const remainder = moduleText.slice(level);
  const remove = Math.max(0, level - 1);
  const baseParts = currentPackage.slice(0, Math.max(0, currentPackage.length - remove));
  const combined = remainder
    ? [...baseParts, ...remainder.split(".").filter(Boolean)]
    : baseParts;
  return combined.length > 0 ? combined.join(".") : null;
}

function resolvePythonCall(params: {
  callee: Parser.SyntaxNode;
  source: string;
  localFunctions: Map<string, string>;
  imports: PythonImportInfo;
  moduleFunctionIds: Map<string, Map<string, string>>;
  classContext: string | null;
  classMethods: Map<string, Map<string, string>>;
}): string | null {
  const { callee, source, localFunctions, imports, moduleFunctionIds, classContext, classMethods } = params;
  if (callee.type === "identifier") {
    const name = nodeText(callee, source);
    const local = localFunctions.get(name);
    if (local) {
      return local;
    }
    const alias = imports.functionAliases.get(name);
    if (alias) {
      return moduleFunctionIds.get(alias.moduleName)?.get(alias.functionName) ?? null;
    }
    return null;
  }

  if (callee.type === "attribute") {
    const objectNode = callee.childForFieldName("object");
    const attrNode = callee.childForFieldName("attribute");
    const attrName = attrNode ? nodeText(attrNode, source) : null;
    const objectName = objectNode ? exprName(objectNode, source) : null;

    if (attrName) {
      if (classContext && (objectName === "self" || objectName === "cls")) {
        return classMethods.get(classContext)?.get(attrName) ?? null;
      }
      if (objectName && classMethods.has(objectName)) {
        return classMethods.get(objectName)?.get(attrName) ?? null;
      }
    }

    const dotted = exprName(callee, source);
    if (!dotted) {
      return null;
    }
    const parts = dotted.split(".").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const base = parts[0];
    const rest = parts.slice(1);
    const moduleAlias = imports.moduleAliases.get(base);
    if (moduleAlias) {
      return resolveModuleFunction(moduleAlias, rest, moduleFunctionIds);
    }
    const moduleName = parts.slice(0, -1).join(".");
    const functionName = parts[parts.length - 1];
    return moduleFunctionIds.get(moduleName)?.get(functionName) ?? null;
  }

  return null;
}

function resolveModuleFunction(
  moduleBase: string,
  parts: string[],
  moduleFunctionIds: Map<string, Map<string, string>>
): string | null {
  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return moduleFunctionIds.get(moduleBase)?.get(parts[0]) ?? null;
  }
  const functionName = parts[parts.length - 1];
  const moduleName = `${moduleBase}.${parts.slice(0, -1).join(".")}`;
  const qualifiedName = parts.join(".");
  return (
    moduleFunctionIds.get(moduleName)?.get(functionName) ??
    moduleFunctionIds.get(moduleBase)?.get(qualifiedName) ??
    moduleFunctionIds.get(moduleBase)?.get(functionName) ??
    null
  );
}

function exprName(node: Parser.SyntaxNode, source: string): string | null {
  if (node.type === "identifier") {
    return nodeText(node, source);
  }
  if (node.type === "attribute") {
    const objectNode = node.childForFieldName("object");
    const attrNode = node.childForFieldName("attribute");
    const base = objectNode ? exprName(objectNode, source) : null;
    const attr = attrNode ? nodeText(attrNode, source) : null;
    if (base && attr) {
      return `${base}.${attr}`;
    }
    return attr ?? base;
  }
  return null;
}

function countCyclesInGraph(
  edges: Array<{ from: string; to: string }>,
  nodes: string[]
): number {
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
    reverse.set(node, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }

  const visited = new Set<string>();
  const order: string[] = [];

  const dfs1 = (node: string): void => {
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        dfs1(next);
      }
    }
    order.push(node);
  };

  for (const node of nodes) {
    if (!visited.has(node)) {
      dfs1(node);
    }
  }

  const visited2 = new Set<string>();
  let cycleCount = 0;

  const dfs2 = (node: string, component: string[]): void => {
    visited2.add(node);
    component.push(node);
    for (const next of reverse.get(node) ?? []) {
      if (!visited2.has(next)) {
        dfs2(next, component);
      }
    }
  };

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i];
    if (visited2.has(node)) {
      continue;
    }
    const component: string[] = [];
    dfs2(node, component);
    if (component.length > 1) {
      cycleCount += 1;
    } else {
      const neighbors = adjacency.get(node) ?? [];
      if (neighbors.includes(node)) {
        cycleCount += 1;
      }
    }
  }

  return cycleCount;
}

function computeModularityGap(
  edges: Array<{ from: string; to: string }>,
  nodes: string[]
): number {
  if (nodes.length === 0) {
    return 0;
  }
  const graph = buildUndirectedGraph(edges, nodes);
  if (graph.totalWeight === 0) {
    return 0;
  }
  const modularity = louvainModularity(graph);
  const clamped = Math.max(0, Math.min(1, modularity));
  return 1 - clamped;
}

type UndirectedGraph = {
  nodes: string[];
  adjacency: Map<string, Map<string, number>>;
  degrees: Map<string, number>;
  totalWeight: number;
};

function buildUndirectedGraph(
  edges: Array<{ from: string; to: string }>,
  nodes: string[]
): UndirectedGraph {
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    adjacency.set(node, new Map());
  }
  for (const edge of edges) {
    if (edge.from === edge.to) {
      continue;
    }
    const fromMap = adjacency.get(edge.from);
    const toMap = adjacency.get(edge.to);
    if (!fromMap || !toMap) {
      continue;
    }
    fromMap.set(edge.to, (fromMap.get(edge.to) ?? 0) + 1);
    toMap.set(edge.from, (toMap.get(edge.from) ?? 0) + 1);
  }

  const degrees = new Map<string, number>();
  let totalWeight = 0;
  for (const [node, neighbors] of adjacency.entries()) {
    const degree = Array.from(neighbors.values()).reduce((sum, value) => sum + value, 0);
    degrees.set(node, degree);
    totalWeight += degree;
  }

  return {
    nodes,
    adjacency,
    degrees,
    totalWeight: totalWeight / 2
  };
}

function louvainModularity(graph: UndirectedGraph): number {
  const { nodes, adjacency, degrees, totalWeight } = graph;
  if (totalWeight === 0) {
    return 0;
  }
  const community = new Map<string, string>();
  const stats = new Map<string, { sumTot: number; sumIn: number }>();

  for (const node of nodes) {
    const degree = degrees.get(node) ?? 0;
    community.set(node, node);
    stats.set(node, { sumTot: degree, sumIn: 0 });
  }

  let moved = true;
  let passes = 0;
  const maxPasses = 10;

  while (moved && passes < maxPasses) {
    moved = false;
    passes += 1;
    for (const node of nodes) {
      const nodeComm = community.get(node)!;
      const nodeDegree = degrees.get(node) ?? 0;
      const neighbors = adjacency.get(node) ?? new Map();

      const currentKIn = sumWeightsToCommunity(node, nodeComm, community, neighbors);
      const currentStats = stats.get(nodeComm);
      if (currentStats) {
        currentStats.sumTot -= nodeDegree;
        currentStats.sumIn -= 2 * currentKIn;
      }

      let bestComm = nodeComm;
      let bestGain = 0;
      const candidateComms = new Set<string>();
      candidateComms.add(nodeComm);
      for (const neighbor of neighbors.keys()) {
        candidateComms.add(community.get(neighbor) ?? neighbor);
      }

      for (const candidate of candidateComms) {
        const candidateStats = stats.get(candidate);
        if (!candidateStats) {
          continue;
        }
        const kIn = sumWeightsToCommunity(node, candidate, community, neighbors);
        const gain = deltaModularity(
          candidateStats.sumIn,
          candidateStats.sumTot,
          nodeDegree,
          kIn,
          totalWeight
        );
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = candidate;
        }
      }

      const bestStats = stats.get(bestComm);
      if (bestStats) {
        const kInBest = sumWeightsToCommunity(node, bestComm, community, neighbors);
        bestStats.sumTot += nodeDegree;
        bestStats.sumIn += 2 * kInBest;
      }

      if (bestComm !== nodeComm) {
        community.set(node, bestComm);
        moved = true;
      }
    }
  }

  return computeModularityFromStats(stats, totalWeight);
}

function sumWeightsToCommunity(
  node: string,
  communityId: string,
  community: Map<string, string>,
  neighbors: Map<string, number>
): number {
  let sum = 0;
  for (const [neighbor, weight] of neighbors.entries()) {
    if ((community.get(neighbor) ?? neighbor) === communityId) {
      sum += weight;
    }
  }
  return sum;
}

function deltaModularity(
  sumIn: number,
  sumTot: number,
  nodeDegree: number,
  kIn: number,
  totalWeight: number
): number {
  const m2 = 2 * totalWeight;
  const term1 = (sumIn + 2 * kIn) / m2 - Math.pow((sumTot + nodeDegree) / m2, 2);
  const term2 =
    sumIn / m2 - Math.pow(sumTot / m2, 2) - Math.pow(nodeDegree / m2, 2);
  return term1 - term2;
}

function computeModularityFromStats(
  stats: Map<string, { sumTot: number; sumIn: number }>,
  totalWeight: number
): number {
  const m2 = 2 * totalWeight;
  let modularity = 0;
  for (const entry of stats.values()) {
    if (entry.sumTot === 0) {
      continue;
    }
    modularity += entry.sumIn / m2 - Math.pow(entry.sumTot / m2, 2);
  }
  return modularity;
}

async function resolveCapacity(params: {
  config: SpecGuardConfig;
  projectRoot: string;
  nodeCount: number;
  layersCount: number;
}): Promise<number> {
  const { config, projectRoot, nodeCount, layersCount } = params;
  const baselinePath = config.drift?.baselinePath ?? "";

  if (baselinePath) {
    const resolved = path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(projectRoot, baselinePath);
    const parsed = await loadBaseline(resolved);
    if (typeof parsed === "number") {
      return parsed;
    }
  }

  if (layersCount > 0) {
    return Math.log(Math.max(2, layersCount));
  }

  return Math.log(Math.max(2, nodeCount));
}

async function loadBaseline(filePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();
    const data =
      ext === ".yaml" || ext === ".yml"
        ? (yaml.load(raw) as Record<string, unknown> | null)
        : (JSON.parse(raw) as Record<string, unknown>);
    if (!data) {
      return null;
    }
    const drift = data["drift"] as Record<string, unknown> | undefined;
    const direct = data["K_t"];
    const nested = drift ? drift["K_t"] : undefined;
    if (typeof nested === "number") {
      return nested;
    }
    if (typeof direct === "number") {
      return direct;
    }
  } catch {
    return null;
  }
  return null;
}

function computeGraphFingerprints(graph: DriftGraph): {
  fingerprint: string;
  shape_fingerprint: string;
} {
  const nodes = [...graph.nodes].sort();
  const edges = graph.edges.map((edge) => `${edge.from}→${edge.to}`).sort();
  const fingerprint = hashObject({ nodes, edges });

  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const node of nodes) {
    inbound.set(node, 0);
    outbound.set(node, 0);
  }
  for (const edge of graph.edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const degrees = nodes
    .map((node) => ({
      in: inbound.get(node) ?? 0,
      out: outbound.get(node) ?? 0
    }))
    .sort((a, b) => (a.in + a.out) - (b.in + b.out));

  const degreeSignature = degrees.map((entry) => `${entry.in}:${entry.out}`).join("|");
  const edgeSignature = graph.edges
    .map((edge) => {
      const from = `${inbound.get(edge.from) ?? 0}:${outbound.get(edge.from) ?? 0}`;
      const to = `${inbound.get(edge.to) ?? 0}:${outbound.get(edge.to) ?? 0}`;
      return `${from}->${to}`;
    })
    .sort()
    .join("|");

  return {
    fingerprint,
    shape_fingerprint: hashObject({ degreeSignature, edgeSignature })
  };
}

function hashObject(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

async function resolveBackendRoot(backendRoot: string): Promise<string> {
  const resolved = path.resolve(backendRoot);
  const base = path.basename(resolved).toLowerCase();
  if (base === "backend" || base === "src") {
    return resolved;
  }

  const backendCandidate = path.join(resolved, "backend");
  const srcCandidate = path.join(resolved, "src");

  if (await dirExists(backendCandidate)) {
    return backendCandidate;
  }
  if (await dirExists(srcCandidate)) {
    return srcCandidate;
  }

  return resolved;
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function findCommonRoot(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd();
  }

  const splitPaths = paths.map((p) => path.resolve(p).split(path.sep));
  const minLength = Math.min(...splitPaths.map((parts) => parts.length));
  const shared: string[] = [];

  for (let i = 0; i < minLength; i += 1) {
    const segment = splitPaths[0][i];
    if (splitPaths.every((parts) => parts[i] === segment)) {
      shared.push(segment);
    } else {
      break;
    }
  }

  if (shared.length === 0) {
    return path.parse(paths[0]).root;
  }

  return shared.join(path.sep);
}
