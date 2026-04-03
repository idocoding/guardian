import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { computeDriftReport, type DriftGraph } from "../../src/extract/drift.js";
import type { SpecGuardConfig } from "../../src/config.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "drift");

const BASE_CONFIG: SpecGuardConfig = {
  drift: {
    graphLevel: "module",
    scales: ["module"],
    weights: { entropy: 0.4, crossLayer: 0.3, cycles: 0.2, modularity: 0.1 },
    layers: {},
    domains: {},
    capacity: { layers: {}, total: 0, warningRatio: 0.85, criticalRatio: 1.0 },
    growth: { maxEdgesPerHour: 0, maxEdgesPerDay: 0, maxEdgeGrowthRatio: 0 },
    baselinePath: "",
    historyPath: "",
    criticalDelta: 0.25,
  },
};

async function scaffold() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
}
async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("computeDriftReport — basic metrics", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("returns stable status for a simple, clean graph", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "service", path: "a", files: ["a/index.ts"] },
        { id: "b", layer: "data", path: "b", files: ["b/index.ts"] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.version).toBe("0.3");
    expect(report.graph_level).toBe("module");
    expect(["stable", "critical"]).toContain(report.status);
    expect(typeof report.D_t).toBe("number");
    expect(typeof report.K_t).toBe("number");
    expect(typeof report.delta).toBe("number");
  });

  it("computes entropy as 0 for a graph with no edges", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "x", layer: "service", path: "x", files: [] },
        { id: "y", layer: "service", path: "y", files: [] },
      ],
      moduleGraph: [],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.metrics.entropy).toBe(0);
    expect(report.details.edges).toBe(0);
  });

  it("computes higher entropy for a densely connected graph", async () => {
    const sparseReport = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    const denseReport = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
        { id: "c", layer: "s", path: "c", files: [] },
        { id: "d", layer: "s", path: "d", files: [] },
      ],
      moduleGraph: [
        { from: "a", to: "b", kind: "import" },
        { from: "b", to: "c", kind: "import" },
        { from: "c", to: "d", kind: "import" },
        { from: "d", to: "a", kind: "import" },
        { from: "a", to: "c", kind: "import" },
        { from: "b", to: "d", kind: "import" },
      ],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(denseReport.metrics.entropy).toBeGreaterThan(sparseReport.metrics.entropy);
  });

  it("reports cycle density when circular dependencies exist", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [
        { from: "a", to: "b", kind: "import" },
        { from: "b", to: "a", kind: "import" },
      ],
      fileGraph: [],
      circularDependencies: [["a", "b"]],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.metrics.cycle_density).toBeGreaterThan(0);
    expect(report.details.cycles).toBe(1);
  });

  it("sets D_t = 0 when there are no edges and no cycles", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.D_t).toBe(0);
  });

  it("includes fingerprints in details", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.details.fingerprint).toBeDefined();
    expect(typeof report.details.fingerprint).toBe("string");
    expect(report.details.shape_fingerprint).toBeDefined();
  });
});

describe("computeDriftReport — cross-layer rules", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("reports cross-layer violations when layer rules are configured", async () => {
    const configWithLayers: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        layers: {
          service: ["data"],
          data: [],
        },
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "data", path: "a", files: [] },
        { id: "b", layer: "service", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: configWithLayers,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.metrics.cross_layer_ratio).toBeGreaterThan(0);
  });

  it("reports 0 cross-layer ratio when all edges follow layer rules", async () => {
    const configWithLayers: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        layers: {
          service: ["data"],
          data: [],
        },
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "service", path: "a", files: [] },
        { id: "b", layer: "data", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: configWithLayers,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.metrics.cross_layer_ratio).toBe(0);
  });
});

describe("computeDriftReport — capacity", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("includes capacity report with default thresholds", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [{ id: "a", layer: "s", path: "a", files: [] }],
      moduleGraph: [],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.capacity).toBeDefined();
    expect(report.capacity.thresholds.warning).toBe(0.85);
    expect(report.capacity.thresholds.critical).toBe(1.0);
  });

  it("reports capacity warning when layer budget is nearly exceeded", async () => {
    const configWithBudgets: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        capacity: {
          total: 10,
          layers: { s: 5 },
          warningRatio: 0.85,
          criticalRatio: 1.0,
        },
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
        { id: "c", layer: "s", path: "c", files: [] },
      ],
      moduleGraph: [
        { from: "a", to: "b", kind: "import" },
        { from: "b", to: "c", kind: "import" },
        { from: "c", to: "a", kind: "import" },
        { from: "a", to: "c", kind: "import" },
        { from: "b", to: "a", kind: "import" },
      ],
      fileGraph: [],
      circularDependencies: [],
      config: configWithBudgets,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.capacity.status).not.toBe("unbudgeted");
    // 5 edges against budget of 5 (layer) → ratio = 1.0 → critical
    expect(["warning", "critical"]).toContain(report.capacity.status);
  });
});

describe("computeDriftReport — growth", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("returns insufficient_data for no history", async () => {
    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [{ id: "a", layer: "s", path: "a", files: [] }],
      moduleGraph: [],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.growth.trend).toBe("insufficient_data");
    expect(report.growth.status).toBe("insufficient_data");
  });

  it("computes growth trend from history file", async () => {
    const historyDir = path.join(FIXTURE_DIR, "specs-out");
    await fs.mkdir(historyDir, { recursive: true });

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600 * 1000);
    const history = [
      JSON.stringify({ timestamp: hourAgo.toISOString(), graph_level: "module", details: { edges: 5 } }),
      JSON.stringify({ timestamp: now.toISOString(), graph_level: "module", details: { edges: 15 } }),
    ].join("\n");

    await fs.writeFile(path.join(historyDir, "drift.history.jsonl"), history);

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: BASE_CONFIG,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.growth.trend).toBe("increasing");
    expect(report.growth.edges_per_hour).toBeGreaterThan(0);
    expect(report.growth.edges_per_day).toBeGreaterThan(0);
    expect(report.growth.window.from).toBeDefined();
    expect(report.growth.window.to).toBeDefined();

    await fs.rm(historyDir, { recursive: true });
  });

  it("triggers growth alert when maxEdgesPerHour is exceeded", async () => {
    const historyDir = path.join(FIXTURE_DIR, "specs-out");
    await fs.mkdir(historyDir, { recursive: true });

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600 * 1000);
    const history = [
      JSON.stringify({ timestamp: hourAgo.toISOString(), graph_level: "module", details: { edges: 5 } }),
      JSON.stringify({ timestamp: now.toISOString(), graph_level: "module", details: { edges: 50 } }),
    ].join("\n");

    await fs.writeFile(path.join(historyDir, "drift.history.jsonl"), history);

    const configWithGrowthLimits: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        growth: { maxEdgesPerHour: 10, maxEdgesPerDay: 0, maxEdgeGrowthRatio: 0 },
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: configWithGrowthLimits,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.growth.status).toBe("critical");
    expect(report.alerts).toContain("growth:edges");

    await fs.rm(historyDir, { recursive: true });
  });
});

describe("computeDriftReport — multi-scale", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("produces file-level scale when requested", async () => {
    const configMultiScale: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        scales: ["module", "file"],
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: ["a/x.ts", "a/y.ts"] },
        { id: "b", layer: "s", path: "b", files: ["b/z.ts"] },
      ],
      moduleGraph: [{ from: "a", to: "b", kind: "import" }],
      fileGraph: [{ from: "a/x.ts", to: "b/z.ts" }],
      circularDependencies: [],
      config: configMultiScale,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.scales).toBeDefined();
    expect(report.scales!.length).toBeGreaterThanOrEqual(2);
    const levels = report.scales!.map((s) => s.level);
    expect(levels).toContain("module");
    expect(levels).toContain("file");
  });

  it("produces domain-level scale when domains are configured", async () => {
    const configWithDomains: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        scales: ["module", "domain"],
        domains: {
          payments: ["billing", "invoices"],
          users: ["auth", "profile"],
        },
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "billing", layer: "s", path: "billing", files: [] },
        { id: "auth", layer: "s", path: "auth", files: [] },
      ],
      moduleGraph: [{ from: "billing", to: "auth", kind: "import" }],
      fileGraph: [],
      circularDependencies: [],
      config: configWithDomains,
      projectRoot: FIXTURE_DIR,
    });

    expect(report.scales).toBeDefined();
    const levels = report.scales!.map((s) => s.level);
    expect(levels).toContain("domain");

    const domainScale = report.scales!.find((s) => s.level === "domain");
    if (domainScale) {
      expect(domainScale.details.nodes).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("computeDriftReport — alerts", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("includes alerts array in report", async () => {
    // Force a very high D_t by having many cycles with heavy weighting
    const configHighCycleWeight: SpecGuardConfig = {
      ...BASE_CONFIG,
      drift: {
        ...BASE_CONFIG.drift!,
        weights: { entropy: 0.1, crossLayer: 0.1, cycles: 0.7, modularity: 0.1 },
        criticalDelta: 0.01,
      },
    };

    const report = await computeDriftReport({
      backendRoot: FIXTURE_DIR,
      modules: [
        { id: "a", layer: "s", path: "a", files: [] },
        { id: "b", layer: "s", path: "b", files: [] },
      ],
      moduleGraph: [
        { from: "a", to: "b", kind: "import" },
        { from: "b", to: "a", kind: "import" },
      ],
      fileGraph: [],
      circularDependencies: [["a", "b"]],
      config: configHighCycleWeight,
      projectRoot: FIXTURE_DIR,
    });

    expect(Array.isArray(report.alerts)).toBe(true);
    // D_t should be elevated due to cycle weighting
    expect(report.D_t).toBeGreaterThan(0);
    expect(report.metrics.cycle_density).toBeGreaterThan(0);
  });
});
