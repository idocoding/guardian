export type DirectedGraph = Map<string, Set<string>>;

export function ensureNode(graph: DirectedGraph, node: string): void {
  if (!graph.has(node)) {
    graph.set(node, new Set());
  }
}

export function addEdge(graph: DirectedGraph, from: string, to: string): void {
  ensureNode(graph, from);
  ensureNode(graph, to);
  graph.get(from)?.add(to);
}

export function inboundCounts(graph: DirectedGraph, nodes: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();

  for (const node of nodes) {
    counts.set(node, 0);
  }

  for (const [from, neighbors] of graph) {
    if (!counts.has(from)) {
      counts.set(from, 0);
    }
    for (const neighbor of neighbors) {
      counts.set(neighbor, (counts.get(neighbor) ?? 0) + 1);
    }
  }

  return counts;
}

function normalizeCycle(cycle: string[]): string[] {
  if (cycle.length === 0) {
    return cycle;
  }

  let minIndex = 0;
  for (let i = 1; i < cycle.length; i += 1) {
    if (cycle[i] < cycle[minIndex]) {
      minIndex = i;
    }
  }

  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

function cycleKey(cycle: string[]): string {
  return normalizeCycle(cycle).join("->");
}

export function findCycles(graph: DirectedGraph): string[][] {
  const nodes = Array.from(graph.keys()).sort((a, b) => a.localeCompare(b));
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  function dfs(node: string): void {
    visited.add(node);
    stack.push(node);
    onStack.add(node);

    const neighbors = Array.from(graph.get(node) ?? []).sort((a, b) => a.localeCompare(b));
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (onStack.has(neighbor)) {
        const startIndex = stack.indexOf(neighbor);
        if (startIndex >= 0) {
          const cycle = stack.slice(startIndex);
          const key = cycleKey(cycle);
          if (!cycles.has(key)) {
            cycles.set(key, normalizeCycle(cycle));
          }
        }
      }
    }

    stack.pop();
    onStack.delete(node);
  }

  for (const node of nodes) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return Array.from(cycles.values()).sort((a, b) => a.join("->").localeCompare(b.join("->")));
}
