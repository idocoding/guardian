import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArchitectureSnapshot, UxSnapshot } from "./types.js";
import type { SpecGuardConfig } from "../config.js";
import { buildFunctionGraph } from "./drift.js";

export type ArchitectureSummary = {
  version: "0.1";
  generated_at: string;
  fingerprint: string;
  shape_fingerprint: string;
  normalized: {
    modules: string[];
    module_edges: string[];
    endpoints: string[];
    models: string[];
    pages: string[];
    components: string[];
    tasks: string[];
    runtime_services: string[];
  };
  counts: {
    modules: number;
    module_edges: number;
    file_edges: number;
    files: number;
    endpoints: number;
    models: number;
    pages: number;
    components: number;
    tasks: number;
    services: number;
  };
  top_modules: Array<{
    id: string;
    inbound: number;
    outbound: number;
    total: number;
    layer: string;
  }>;
};

export type ArchitectureDiffSummary = {
  version: "0.1";
  generated_at: string;
  from_fingerprint: string;
  to_fingerprint: string;
  structural_change: boolean;
  shape_equivalent: boolean;
  added: Record<string, string[]>;
  removed: Record<string, string[]>;
  counts_delta: Record<string, number>;
};

export type DriftHeatmapEntry = {
  id: string;
  layer: string;
  score: number;
  components: {
    degree: number;
    cross_layer_ratio: number;
    cycle: number;
  };
};

export type DriftHeatmapLevel = {
  level: "module" | "file" | "function" | "domain";
  entries: DriftHeatmapEntry[];
};

export type DriftHeatmap = {
  version: "0.2";
  generated_at: string;
  levels: DriftHeatmapLevel[];
};

export async function writeCompressionOutputs(params: {
  outputDir: string;
  architecture: ArchitectureSnapshot;
  ux: UxSnapshot;
  context?: {
    projectRoot?: string;
    backendRoot?: string;
    config?: SpecGuardConfig;
  };
}): Promise<{
  summary: ArchitectureSummary;
  diff: ArchitectureDiffSummary | null;
  heatmap: DriftHeatmap;
}> {
  const { outputDir, architecture, ux, context } = params;
  await fs.mkdir(outputDir, { recursive: true });

  const previous = await loadArchitectureSummary(outputDir);
  const summary = buildArchitectureSummary(architecture, ux);
  const diff = previous ? buildArchitectureDiff(previous, summary) : null;
  const heatmap = await buildHeatmapBundle(architecture, context);

  await fs.writeFile(
    path.join(outputDir, "architecture.summary.json"),
    JSON.stringify(summary, null, 2)
  );
  if (diff) {
    await fs.writeFile(
      path.join(outputDir, "architecture.diff.summary.json"),
      JSON.stringify(diff, null, 2)
    );
  }
  await fs.writeFile(
    path.join(outputDir, "drift.heatmap.json"),
    JSON.stringify(heatmap, null, 2)
  );

  return { summary, diff, heatmap };
}

export async function loadArchitectureSummary(
  outputDir: string
): Promise<ArchitectureSummary | null> {
  try {
    const raw = await fs.readFile(path.join(outputDir, "architecture.summary.json"), "utf8");
    return JSON.parse(raw) as ArchitectureSummary;
  } catch {
    return null;
  }
}

export async function loadArchitectureDiff(
  outputDir: string
): Promise<ArchitectureDiffSummary | null> {
  try {
    const raw = await fs.readFile(
      path.join(outputDir, "architecture.diff.summary.json"),
      "utf8"
    );
    return JSON.parse(raw) as ArchitectureDiffSummary;
  } catch {
    return null;
  }
}

export async function loadHeatmap(outputDir: string): Promise<DriftHeatmap | null> {
  try {
    const raw = await fs.readFile(path.join(outputDir, "drift.heatmap.json"), "utf8");
    const parsed = JSON.parse(raw) as DriftHeatmap | { entries: DriftHeatmapEntry[] };
    if ("levels" in parsed) {
      return parsed as DriftHeatmap;
    }
    if ("entries" in parsed) {
      return {
        version: "0.2",
        generated_at: new Date().toISOString(),
        levels: [
          {
            level: "module",
            entries: (parsed as { entries: DriftHeatmapEntry[] }).entries
          }
        ]
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildArchitectureSummary(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot
): ArchitectureSummary {
  const modules = architecture.modules.map((module) => module.id).sort();
  const moduleEdges = architecture.dependencies.module_graph
    .map((edge) => `${edge.from}→${edge.to}`)
    .sort();
  const endpoints = architecture.endpoints
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .sort();
  const models = architecture.data_models.map((model) => model.name).sort();
  const pages = ux.pages.map((page) => page.path).sort();
  const components = ux.components.map((component) => component.id).sort();
  const tasks = architecture.tasks.map((task) => task.name).sort();
  const services = architecture.runtime.services.map((service) => service.name).sort();
  const fileEdges = architecture.dependencies.file_graph ?? [];

  const normalized = {
    modules,
    module_edges: moduleEdges,
    endpoints,
    models,
    pages,
    components,
    tasks,
    runtime_services: services
  };

  const fingerprint = hashObject(normalized);
  const shapeFingerprint = computeShapeFingerprint(architecture);

  const moduleCounts = new Map<string, { inbound: number; outbound: number; layer: string }>();
  for (const module of architecture.modules) {
    moduleCounts.set(module.id, { inbound: 0, outbound: 0, layer: module.layer });
  }
  for (const edge of architecture.dependencies.module_graph) {
    const from = moduleCounts.get(edge.from);
    if (from) {
      from.outbound += 1;
    }
    const to = moduleCounts.get(edge.to);
    if (to) {
      to.inbound += 1;
    }
  }

  const topModules = Array.from(moduleCounts.entries())
    .map(([id, stats]) => ({
      id,
      inbound: stats.inbound,
      outbound: stats.outbound,
      total: stats.inbound + stats.outbound,
      layer: stats.layer
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return {
    version: "0.1",
    generated_at: new Date().toISOString(),
    fingerprint,
    shape_fingerprint: shapeFingerprint,
    normalized,
    counts: {
      modules: modules.length,
      module_edges: moduleEdges.length,
      file_edges: fileEdges.length,
      files: countUniqueFiles(architecture),
      endpoints: endpoints.length,
      models: models.length,
      pages: pages.length,
      components: components.length,
      tasks: tasks.length,
      services: services.length
    },
    top_modules: topModules
  };
}

export function buildArchitectureDiff(
  previous: ArchitectureSummary,
  next: ArchitectureSummary
): ArchitectureDiffSummary {
  const diff = {
    version: "0.1" as const,
    generated_at: new Date().toISOString(),
    from_fingerprint: previous.fingerprint,
    to_fingerprint: next.fingerprint,
    structural_change: previous.fingerprint !== next.fingerprint,
    shape_equivalent: previous.shape_fingerprint === next.shape_fingerprint,
    added: {} as Record<string, string[]>,
    removed: {} as Record<string, string[]>,
    counts_delta: {} as Record<string, number>
  };

  const keys: Array<keyof ArchitectureSummary["normalized"]> = [
    "modules",
    "module_edges",
    "endpoints",
    "models",
    "pages",
    "components",
    "tasks",
    "runtime_services"
  ];

  for (const key of keys) {
    const prev = new Set(previous.normalized[key]);
    const nextSet = new Set(next.normalized[key]);
    diff.added[key] = Array.from(nextSet).filter((value) => !prev.has(value)).sort();
    diff.removed[key] = Array.from(prev).filter((value) => !nextSet.has(value)).sort();
  }

  const countKeys = Object.keys(next.counts) as Array<keyof ArchitectureSummary["counts"]>;
  for (const key of countKeys) {
    diff.counts_delta[key] = (next.counts[key] ?? 0) - (previous.counts[key] ?? 0);
  }

  return diff;
}

function computeShapeFingerprint(architecture: ArchitectureSnapshot): string {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const module of architecture.modules) {
    inbound.set(module.id, 0);
    outbound.set(module.id, 0);
  }
  for (const edge of architecture.dependencies.module_graph) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const degrees = architecture.modules
    .map((module) => ({
      in: inbound.get(module.id) ?? 0,
      out: outbound.get(module.id) ?? 0
    }))
    .sort((a, b) => (a.in + a.out) - (b.in + b.out));

  const degreeSignature = degrees.map((entry) => `${entry.in}:${entry.out}`).join("|");
  const edgeSignature = architecture.dependencies.module_graph
    .map((edge) => {
      const from = `${inbound.get(edge.from) ?? 0}:${outbound.get(edge.from) ?? 0}`;
      const to = `${inbound.get(edge.to) ?? 0}:${outbound.get(edge.to) ?? 0}`;
      return `${from}->${to}`;
    })
    .sort()
    .join("|");

  return hashObject({
    degreeSignature,
    edgeSignature
  });
}

async function buildHeatmapBundle(
  architecture: ArchitectureSnapshot,
  context?: {
    projectRoot?: string;
    backendRoot?: string;
    config?: SpecGuardConfig;
  }
): Promise<DriftHeatmap> {
  const levels: DriftHeatmapLevel[] = [];

  const moduleNodes = architecture.modules.map((module) => module.id);
  const moduleLayers = new Map(architecture.modules.map((module) => [module.id, module.layer]));
  const moduleEdges = architecture.dependencies.module_graph.map((edge) => ({
    from: edge.from,
    to: edge.to
  }));
  levels.push(
    buildHeatmapFromGraph("module", moduleNodes, moduleEdges, moduleLayers)
  );

  if (architecture.dependencies.file_graph && architecture.dependencies.file_graph.length > 0) {
    const fileNodes = new Set<string>();
    const fileLayers = new Map<string, string>();
    for (const module of architecture.modules) {
      for (const file of module.files) {
        fileNodes.add(file);
        fileLayers.set(file, module.layer);
      }
    }
    for (const edge of architecture.dependencies.file_graph) {
      fileNodes.add(edge.from);
      fileNodes.add(edge.to);
    }
    const fileEdges = architecture.dependencies.file_graph.map((edge) => ({
      from: edge.from,
      to: edge.to
    }));
    levels.push(
      buildHeatmapFromGraph("file", Array.from(fileNodes), fileEdges, fileLayers)
    );
  }

  const domainMap = context?.config?.drift?.domains ?? {};
  if (Object.keys(domainMap).length > 0) {
    const moduleToDomain = new Map<string, string>();
    for (const module of architecture.modules) {
      const domain = resolveDomainForModule(module.id, domainMap);
      if (domain) {
        moduleToDomain.set(module.id, domain);
      }
    }
    const domainNodes = new Set<string>();
    const domainLayers = new Map<string, string>();
    for (const domain of moduleToDomain.values()) {
      domainNodes.add(domain);
      domainLayers.set(domain, domain);
    }
    const domainEdges: Array<{ from: string; to: string }> = [];
    const seen = new Set<string>();
    for (const edge of architecture.dependencies.module_graph) {
      const fromDomain = moduleToDomain.get(edge.from) ?? "unassigned";
      const toDomain = moduleToDomain.get(edge.to) ?? "unassigned";
      const key = `${fromDomain}::${toDomain}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      domainNodes.add(fromDomain);
      domainNodes.add(toDomain);
      domainLayers.set(fromDomain, fromDomain);
      domainLayers.set(toDomain, toDomain);
      domainEdges.push({ from: fromDomain, to: toDomain });
    }
    levels.push(
      buildHeatmapFromGraph("domain", Array.from(domainNodes), domainEdges, domainLayers)
    );
  }

  if (context?.backendRoot && context?.projectRoot) {
    const hasFunctionScale = context.config?.drift?.scales?.includes("function") ?? false;
    const shouldFunction =
      hasFunctionScale ||
      context.config?.drift?.graphLevel === "function" ||
      context.config?.drift?.graphLevel === "auto";
    if (shouldFunction) {
      const fnGraph = await buildFunctionGraph({
        backendRoot: context.backendRoot,
        modules: architecture.modules,
        projectRoot: context.projectRoot
      });
      if (fnGraph) {
        levels.push(
          buildHeatmapFromGraph("function", fnGraph.nodes, fnGraph.edges, fnGraph.nodeLayers)
        );
      }
    }
  }

  return {
    version: "0.2",
    generated_at: new Date().toISOString(),
    levels
  };
}

function buildHeatmapFromGraph(
  level: DriftHeatmapLevel["level"],
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
  nodeLayers: Map<string, string>
): DriftHeatmapLevel {
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const outbound = new Map<string, number>();
  const inbound = new Map<string, number>();
  const crossLayerOut = new Map<string, number>();

  for (const node of nodes) {
    adjacency.set(node, []);
    reverse.set(node, []);
    outbound.set(node, 0);
    inbound.set(node, 0);
    crossLayerOut.set(node, 0);
  }

  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
      reverse.set(edge.from, []);
      outbound.set(edge.from, 0);
      inbound.set(edge.from, 0);
      crossLayerOut.set(edge.from, 0);
      nodes.push(edge.from);
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
      reverse.set(edge.to, []);
      outbound.set(edge.to, 0);
      inbound.set(edge.to, 0);
      crossLayerOut.set(edge.to, 0);
      nodes.push(edge.to);
    }
    adjacency.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
    const fromLayer = nodeLayers.get(edge.from);
    const toLayer = nodeLayers.get(edge.to);
    if (fromLayer && toLayer && fromLayer !== toLayer) {
      crossLayerOut.set(edge.from, (crossLayerOut.get(edge.from) ?? 0) + 1);
    }
  }

  const cycleNodes = findCycleNodes(nodes, adjacency, reverse);
  const degreeValues = nodes.map(
    (node) => (outbound.get(node) ?? 0) + (inbound.get(node) ?? 0)
  );
  const maxDegree = Math.max(1, ...degreeValues);
  const maxCrossRatio = Math.max(
    1,
    ...nodes.map((node) => {
      const out = outbound.get(node) ?? 0;
      const cross = crossLayerOut.get(node) ?? 0;
      return out === 0 ? 0 : cross / out;
    })
  );

  const entries = nodes.map((node) => {
    const degree = (outbound.get(node) ?? 0) + (inbound.get(node) ?? 0);
    const crossOut = crossLayerOut.get(node) ?? 0;
    const out = outbound.get(node) ?? 0;
    const crossRatio = out === 0 ? 0 : crossOut / out;
    const cycleFlag = cycleNodes.has(node) ? 1 : 0;
    const score =
      0.5 * (degree / maxDegree) +
      0.3 * (crossRatio / maxCrossRatio) +
      0.2 * cycleFlag;
    return {
      id: node,
      layer: nodeLayers.get(node) ?? "unknown",
      score: round(score, 4),
      components: {
        degree,
        cross_layer_ratio: round(crossRatio, 4),
        cycle: cycleFlag
      }
    };
  });

  entries.sort((a, b) => b.score - a.score);

  return {
    level,
    entries
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

function findCycleNodes(
  nodes: string[],
  adjacency: Map<string, string[]>,
  reverse: Map<string, string[]>
): Set<string> {
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
  const cycleNodes = new Set<string>();

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
      for (const entry of component) {
        cycleNodes.add(entry);
      }
    } else {
      const neighbors = adjacency.get(node) ?? [];
      if (neighbors.includes(node)) {
        cycleNodes.add(node);
      }
    }
  }

  return cycleNodes;
}

function countUniqueFiles(snapshot: ArchitectureSnapshot): number {
  const files = new Set<string>();
  for (const module of snapshot.modules) {
    for (const file of module.files) {
      files.add(file);
    }
  }
  for (const file of snapshot.frontend_files) {
    files.add(file);
  }
  return files.size;
}

function hashObject(value: unknown): string {
  const payload = stableStringify(value);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
