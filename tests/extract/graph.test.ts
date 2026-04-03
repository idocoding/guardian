import { describe, it, expect } from "vitest";
import {
  ensureNode,
  addEdge,
  inboundCounts,
  findCycles,
  type DirectedGraph,
} from "../../src/extract/graph.js";

function makeGraph(): DirectedGraph {
  return new Map();
}

describe("ensureNode", () => {
  it("creates a new entry for an unknown node", () => {
    const g = makeGraph();
    ensureNode(g, "a");
    expect(g.has("a")).toBe(true);
    expect(g.get("a")!.size).toBe(0);
  });

  it("does not overwrite an existing node", () => {
    const g = makeGraph();
    g.set("a", new Set(["b"]));
    ensureNode(g, "a");
    expect(g.get("a")!.has("b")).toBe(true);
  });
});

describe("addEdge", () => {
  it("adds a directed edge from → to", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    expect(g.get("a")!.has("b")).toBe(true);
  });

  it("creates both nodes if absent", () => {
    const g = makeGraph();
    addEdge(g, "x", "y");
    expect(g.has("x")).toBe(true);
    expect(g.has("y")).toBe(true);
  });

  it("does not duplicate edges", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "a", "b");
    expect(g.get("a")!.size).toBe(1);
  });
});

describe("inboundCounts", () => {
  it("counts inbound edges per node", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "c", "b");
    addEdge(g, "a", "c");
    const counts = inboundCounts(g, ["a", "b", "c"]);
    expect(counts.get("a")).toBe(0);
    expect(counts.get("b")).toBe(2);
    expect(counts.get("c")).toBe(1);
  });

  it("returns 0 for isolated nodes", () => {
    const g = makeGraph();
    ensureNode(g, "x");
    ensureNode(g, "y");
    const counts = inboundCounts(g, ["x", "y"]);
    expect(counts.get("x")).toBe(0);
    expect(counts.get("y")).toBe(0);
  });

  it("handles nodes not in initial set but in graph", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    const counts = inboundCounts(g, ["b"]);
    expect(counts.get("b")).toBe(1);
    // "a" is not in the initial set but is in the graph
    expect(counts.get("a")).toBe(0);
  });
});

describe("findCycles", () => {
  it("returns empty array for acyclic graph", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "c");
    const cycles = findCycles(g);
    expect(cycles).toEqual([]);
  });

  it("detects a simple A→B→A cycle", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "a");
    const cycles = findCycles(g);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain("a");
    expect(cycles[0]).toContain("b");
  });

  it("detects a triangle cycle A→B→C→A", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "c");
    addEdge(g, "c", "a");
    const cycles = findCycles(g);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toHaveLength(3);
  });

  it("normalizes cycle order deterministically", () => {
    const g1 = makeGraph();
    addEdge(g1, "c", "a");
    addEdge(g1, "a", "b");
    addEdge(g1, "b", "c");

    const g2 = makeGraph();
    addEdge(g2, "a", "b");
    addEdge(g2, "b", "c");
    addEdge(g2, "c", "a");

    const c1 = findCycles(g1);
    const c2 = findCycles(g2);
    expect(c1).toEqual(c2);
  });

  it("returns empty for empty graph", () => {
    const g = makeGraph();
    expect(findCycles(g)).toEqual([]);
  });

  it("handles multiple separate cycles", () => {
    const g = makeGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "a");
    addEdge(g, "x", "y");
    addEdge(g, "y", "x");
    const cycles = findCycles(g);
    expect(cycles.length).toBe(2);
  });
});
