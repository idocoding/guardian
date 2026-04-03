import type { ModuleDependency, FileDependency, ModuleSummary } from "../types.js";

// ─── Public Types ────────────────────────────────────────────────────────────

export type DepthLevel = "LOW" | "MEDIUM" | "HIGH";
export type PropagationLevel = "LOCAL" | "MODERATE" | "STRONG";
export type CompressibilityLevel = "COMPRESSIBLE" | "PARTIAL" | "NON_COMPRESSIBLE";
export type ConfidenceLevel = "WEAK" | "MODERATE" | "STRONG";
export type AmbiguityLevel = "LOW" | "MEDIUM" | "HIGH";

export type StructuralIntelligenceReport = {
  feature: string;
  structure: {
    nodes: number;
    edges: number;
  };
  metrics: {
    depth: number;
    fanout_avg: number;
    fanout_max: number;
    density: number;
    has_cycles: boolean;
  };
  scores: {
    depth_score: number;
    fanout_score: number;
    density_score: number;
    cycle_score: number;
    query_score: number;
  };
  confidence: {
    value: number;
    level: ConfidenceLevel;
  };
  ambiguity: {
    level: AmbiguityLevel;
  };
  classification: {
    depth_level: DepthLevel;
    propagation: PropagationLevel;
    compressible: CompressibilityLevel;
  };
  recommendation: {
    primary: { pattern: string; confidence: number };
    fallback: { pattern: string; condition: string };
    avoid: string[];
  };
  guardrails: {
    enforce_if_confidence_above: number;
  };
  override: { allowed: true; requires_reason: true };
};

// ─── Graph Building ───────────────────────────────────────────────────────────

type SimpleGraph = {
  nodes: Set<string>;
  /** adjacency: from → Set<to> */
  adj: Map<string, Set<string>>;
  edges: number;
};

function buildGraph(
  fileGraph: FileDependency[],
  moduleGraph: ModuleDependency[],
  modules: ModuleSummary[]
): SimpleGraph {
  const nodes = new Set<string>();
  const adj = new Map<string, Set<string>>();
  let edges = 0;

  const ensure = (id: string) => {
    if (!nodes.has(id)) {
      nodes.add(id);
      adj.set(id, new Set());
    }
  };

  const addEdge = (from: string, to: string) => {
    ensure(from);
    ensure(to);
    const set = adj.get(from)!;
    if (!set.has(to)) {
      set.add(to);
      edges++;
    }
  };

  // Prefer file-level graph for precision; fall back to module-level
  const hasFG = fileGraph.length > 0;
  if (hasFG) {
    for (const edge of fileGraph) {
      addEdge(edge.from, edge.to);
    }
    // Also make sure all module files are nodes
    for (const mod of modules) {
      for (const f of mod.files) {
        ensure(f);
      }
    }
  } else {
    for (const edge of moduleGraph) {
      addEdge(edge.from, edge.to);
    }
    for (const mod of modules) {
      ensure(mod.id);
    }
  }

  return { nodes, adj, edges };
}

// ─── Subgraph Extraction ──────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function matchesQuery(id: string, tokens: string[]): boolean {
  const lower = id.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

function extractSubgraph(
  graph: SimpleGraph,
  queryTokens: string[],
  hops = 2
): { subgraph: SimpleGraph; seedNodes: Set<string>; totalMatchedNodes: number } {
  const seedNodes = new Set<string>();
  for (const node of graph.nodes) {
    if (matchesQuery(node, queryTokens)) {
      seedNodes.add(node);
    }
  }

  // BFS expansion
  const visited = new Set<string>(seedNodes);
  let frontier = [...seedNodes];
  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of graph.adj.get(node) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.push(neighbour);
        }
      }
      // Also expand reverse edges (who imports this node?)
      for (const [from, tos] of graph.adj) {
        if (tos.has(node) && !visited.has(from)) {
          visited.add(from);
          next.push(from);
        }
      }
    }
    frontier = next;
  }

  // Build subgraph
  const subAdj = new Map<string, Set<string>>();
  let subEdges = 0;
  for (const node of visited) {
    subAdj.set(node, new Set());
  }
  for (const [from, tos] of graph.adj) {
    if (!visited.has(from)) continue;
    for (const to of tos) {
      if (visited.has(to)) {
        subAdj.get(from)!.add(to);
        subEdges++;
      }
    }
  }

  const subgraph: SimpleGraph = {
    nodes: visited,
    adj: subAdj,
    edges: subEdges
  };

  return { subgraph, seedNodes, totalMatchedNodes: seedNodes.size };
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Longest path via DFS with memoization. Caps at 20. */
function longestPath(adj: Map<string, Set<string>>, nodes: Set<string>): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function dfs(node: string): number {
    if (memo.has(node)) return memo.get(node)!;
    if (visiting.has(node)) return 0; // cycle — skip
    visiting.add(node);
    let best = 0;
    for (const neighbour of adj.get(node) ?? []) {
      best = Math.min(Math.max(best, 1 + dfs(neighbour)), 20);
    }
    visiting.delete(node);
    memo.set(node, best);
    return best;
  }

  let max = 0;
  for (const node of nodes) {
    max = Math.max(max, dfs(node));
  }
  return max;
}

function computeFanout(adj: Map<string, Set<string>>, nodes: Set<string>): { avg: number; max: number } {
  if (nodes.size === 0) return { avg: 0, max: 0 };
  let total = 0;
  let max = 0;
  for (const node of nodes) {
    const degree = adj.get(node)?.size ?? 0;
    total += degree;
    if (degree > max) max = degree;
  }
  return { avg: total / nodes.size, max };
}

// ─── Classify & Score ────────────────────────────────────────────────────────

function classifyDepth(depth: number): DepthLevel {
  if (depth <= 2) return "LOW";
  if (depth <= 5) return "MEDIUM";
  return "HIGH";
}

function classifyPropagation(fanoutAvg: number, fanoutMax: number): PropagationLevel {
  if (fanoutAvg > 2 || fanoutMax > 5) return "STRONG";
  if (fanoutAvg > 1.2 || fanoutMax > 2) return "MODERATE";
  return "LOCAL";
}

function classifyCompressibility(
  depth: DepthLevel,
  propagation: PropagationLevel,
  hasCycles: boolean
): CompressibilityLevel {
  if (hasCycles || (depth === "HIGH" && propagation === "STRONG")) return "NON_COMPRESSIBLE";
  if (depth === "LOW" && propagation === "LOCAL") return "COMPRESSIBLE";
  return "PARTIAL";
}

function classifyConfidence(value: number): ConfidenceLevel {
  if (value >= 0.8) return "STRONG";
  if (value >= 0.6) return "MODERATE";
  return "WEAK";
}

function classifyAmbiguity(seedNodes: number, totalNodes: number): AmbiguityLevel {
  if (totalNodes === 0) return "HIGH";
  const ratio = seedNodes / totalNodes;
  if (ratio < 0.1) return "HIGH";
  if (ratio < 0.3) return "MEDIUM";
  return "LOW";
}

function patternFor(compressible: CompressibilityLevel): string {
  if (compressible === "NON_COMPRESSIBLE") return "multi-step workflow / stateful / pipeline";
  if (compressible === "PARTIAL") return "layered / service-oriented";
  return "direct / single-pass";
}

function avoidFor(compressible: CompressibilityLevel): string[] {
  if (compressible === "NON_COMPRESSIBLE") {
    return ["single function implementation", "local-only logic", "greedy shortcut logic"];
  }
  if (compressible === "PARTIAL") {
    return ["monolithic handler logic"];
  }
  return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type AnalyzeDepthInput = {
  query: string;
  modules: ModuleSummary[];
  moduleGraph: ModuleDependency[];
  fileGraph: FileDependency[];
  circularDependencies: string[][];
};

export function analyzeDepth(input: AnalyzeDepthInput): StructuralIntelligenceReport {
  const { query, modules, moduleGraph, fileGraph, circularDependencies } = input;
  const queryTokens = tokenize(query);

  const graph = buildGraph(fileGraph, moduleGraph, modules);
  const { subgraph, seedNodes, totalMatchedNodes } = extractSubgraph(graph, queryTokens, 2);

  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges;

  const depth = longestPath(subgraph.adj, subgraph.nodes);
  const { avg: fanoutAvg, max: fanoutMax } = computeFanout(subgraph.adj, subgraph.nodes);
  const density = nodeCount > 0 ? edgeCount / nodeCount : 0;
  const hasCycles = circularDependencies.some((cycle) =>
    cycle.some((node) => subgraph.nodes.has(node))
  );

  // Scores
  const depthScore = Math.min(depth / 10, 1);
  const fanoutScore = Math.min(fanoutAvg / 3, 1);
  const densityScore = Math.min(density / 3, 1);
  const cycleScore = hasCycles ? 1 : 0;
  const queryScore = graph.nodes.size > 0 ? totalMatchedNodes / graph.nodes.size : 0;

  const confidenceValue =
    0.35 * depthScore +
    0.20 * fanoutScore +
    0.15 * densityScore +
    0.15 * cycleScore +
    0.15 * queryScore;

  const depthLevel = classifyDepth(depth);
  const propagation = classifyPropagation(fanoutAvg, fanoutMax);
  const compressible = classifyCompressibility(depthLevel, propagation, hasCycles);
  const primaryPattern = patternFor(compressible);

  return {
    feature: query,
    structure: { nodes: nodeCount, edges: edgeCount },
    metrics: {
      depth,
      fanout_avg: Math.round(fanoutAvg * 100) / 100,
      fanout_max: fanoutMax,
      density: Math.round(density * 100) / 100,
      has_cycles: hasCycles
    },
    scores: {
      depth_score: Math.round(depthScore * 1000) / 1000,
      fanout_score: Math.round(fanoutScore * 1000) / 1000,
      density_score: Math.round(densityScore * 1000) / 1000,
      cycle_score: cycleScore,
      query_score: Math.round(queryScore * 1000) / 1000
    },
    confidence: {
      value: Math.round(confidenceValue * 1000) / 1000,
      level: classifyConfidence(confidenceValue)
    },
    ambiguity: {
      level: classifyAmbiguity(seedNodes.size, nodeCount)
    },
    classification: {
      depth_level: depthLevel,
      propagation,
      compressible
    },
    recommendation: {
      primary: { pattern: primaryPattern, confidence: Math.round(confidenceValue * 1000) / 1000 },
      fallback: {
        pattern: "direct / single-pass",
        condition: "if implementation remains isolated with no cross-module propagation"
      },
      avoid: avoidFor(compressible)
    },
    guardrails: {
      enforce_if_confidence_above: 0.8
    },
    override: { allowed: true, requires_reason: true }
  };
}
