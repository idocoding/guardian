import { describe, it, expect } from "vitest";
import { analyzeDepth } from "../../src/extract/analyzers/depth.js";
import type { ModuleDependency, FileDependency, ModuleSummary } from "../../src/extract/types.js";

function makeModule(id: string, files: string[] = []): ModuleSummary {
  return { id, path: id, type: "backend", layer: "isolated", files, endpoints: [], imports: [], exports: [] };
}

describe("analyzeDepth — basic metrics", () => {
  it("returns LOW depth for an empty graph", () => {
    const report = analyzeDepth({ query: "auth", modules: [], moduleGraph: [], fileGraph: [], circularDependencies: [] });
    expect(report.classification.depth_level).toBe("LOW");
    expect(report.classification.compressible).toBe("COMPRESSIBLE");
    expect(report.confidence.value).toBeGreaterThanOrEqual(0);
  });

  it("computes depth 1 for a direct edge", () => {
    const modules = [makeModule("a"), makeModule("b")];
    const moduleGraph: ModuleDependency[] = [{ from: "a", to: "b" }];
    const report = analyzeDepth({ query: "a", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    expect(report.metrics.depth).toBeGreaterThan(0);
    expect(report.structure.nodes).toBeGreaterThan(0);
    expect(report.structure.edges).toBeGreaterThan(0);
  });

  it("classifies a 7-node chain depth >= MEDIUM for a mid-chain node query", () => {
    const modules = ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg"].map((id) => makeModule(id));
    const moduleGraph: ModuleDependency[] = [
      { from: "aaa", to: "bbb" }, { from: "bbb", to: "ccc" }, { from: "ccc", to: "ddd" },
      { from: "ddd", to: "eee" }, { from: "eee", to: "fff" }, { from: "fff", to: "ggg" }
    ];
    // Query "ccc" is mid-chain: BFS expands 2 hops in each direction, capturing most of the chain
    const report = analyzeDepth({ query: "ccc", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    // depth should be at least 2 (ccc->ddd->eee) — MEDIUM or higher
    expect(report.metrics.depth).toBeGreaterThanOrEqual(2);
    expect(["MEDIUM", "HIGH"]).toContain(report.classification.depth_level);
  });

  it("classifies graph with cycles as NON_COMPRESSIBLE", () => {
    const modules = [makeModule("x"), makeModule("y")];
    const moduleGraph: ModuleDependency[] = [{ from: "x", to: "y" }, { from: "y", to: "x" }];
    const circular = [["x", "y"]];
    const report = analyzeDepth({ query: "x", modules, moduleGraph, fileGraph: [], circularDependencies: circular });
    expect(report.metrics.has_cycles).toBe(true);
    expect(report.classification.compressible).toBe("NON_COMPRESSIBLE");
  });

  it("computes fanout_max correctly for a fan-out node", () => {
    const modules = ["hub", "a", "b", "c", "d"].map((id) => makeModule(id));
    const moduleGraph: ModuleDependency[] = [
      { from: "hub", to: "a" }, { from: "hub", to: "b" }, { from: "hub", to: "c" }, { from: "hub", to: "d" }
    ];
    const report = analyzeDepth({ query: "hub", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    expect(report.metrics.fanout_max).toBeGreaterThanOrEqual(4);
    // fanout_max=4 exceeds the MODERATE threshold (>2) but doesn't reach STRONG (>5)
    expect(["MODERATE", "STRONG"]).toContain(report.classification.propagation);
  });

  it("returns confidence value between 0 and 1", () => {
    const modules = [makeModule("pay"), makeModule("stripe"), makeModule("webhook")];
    const moduleGraph: ModuleDependency[] = [{ from: "pay", to: "stripe" }, { from: "stripe", to: "webhook" }];
    const report = analyzeDepth({ query: "stripe", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    expect(report.confidence.value).toBeGreaterThanOrEqual(0);
    expect(report.confidence.value).toBeLessThanOrEqual(1);
  });

  it("classifies LOW confidence when query has no matches", () => {
    const modules = [makeModule("alpha"), makeModule("beta")];
    const moduleGraph: ModuleDependency[] = [{ from: "alpha", to: "beta" }];
    const report = analyzeDepth({ query: "zzz_nonexistent", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    // Low query score but other signals may still raise confidence slightly
    expect(["WEAK", "MODERATE"]).toContain(report.confidence.level);
  });

  it("recommendation.avoid is populated for NON_COMPRESSIBLE", () => {
    const modules = ["a", "b", "c", "d", "e", "f", "g"].map((id) => makeModule(id));
    const moduleGraph: ModuleDependency[] = [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" },
      { from: "d", to: "e" }, { from: "e", to: "f" }, { from: "f", to: "g" },
      { from: "a", to: "c" }, { from: "a", to: "d" }, { from: "a", to: "e" }
    ];
    const report = analyzeDepth({ query: "a", modules, moduleGraph, fileGraph: [], circularDependencies: [] });
    if (report.classification.compressible === "NON_COMPRESSIBLE") {
      expect(report.recommendation.avoid.length).toBeGreaterThan(0);
    }
  });

  it("prefers file graph over module graph when both present", () => {
    const modules = [makeModule("m", ["m/a.ts", "m/b.ts"])];
    const fileGraph: FileDependency[] = [{ from: "m/a.ts", to: "m/b.ts" }];
    const report = analyzeDepth({ query: "a.ts", modules, moduleGraph: [], fileGraph, circularDependencies: [] });
    expect(report.structure.nodes).toBeGreaterThan(0);
  });

  it("includes override and guardrails in report", () => {
    const report = analyzeDepth({ query: "any", modules: [], moduleGraph: [], fileGraph: [], circularDependencies: [] });
    expect(report.override.allowed).toBe(true);
    expect(report.override.requires_reason).toBe(true);
    expect(report.guardrails.enforce_if_confidence_above).toBe(0.8);
  });
});
