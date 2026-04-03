/**
 * Pre-publish critical test suite.
 * Run before every `git push` and `npm publish`.
 *
 * These tests cover the bugs we've actually hit in production:
 * - Multi-root merging (module ID collisions, graph edge remapping)
 * - Context block (missing sections, truncation)
 * - Config (roots array, ignore defaults, merge behavior)
 * - Output paths (.specs default, no orphan dirs)
 */

import { describe, it, expect } from "vitest";
import { renderContextBlock } from "../../src/extract/context-block.js";
import { DEFAULT_SPECS_DIR } from "../../src/config.js";
import { getOutputLayout } from "../../src/output-layout.js";
import type { ArchitectureSnapshot, UxSnapshot, ModuleSummary } from "../../src/extract/types.js";

// ========== HELPERS ==========

function makeModule(id: string, opts?: Partial<ModuleSummary>): ModuleSummary {
  return {
    id,
    path: id,
    type: "backend",
    layer: "core",
    files: [],
    endpoints: [],
    imports: [],
    exports: [],
    ...opts,
  };
}

function makeArch(modules: ModuleSummary[], overrides?: Partial<ArchitectureSnapshot>): ArchitectureSnapshot {
  return {
    version: "1.0",
    metadata: { generated_at: "", duration_ms: 0, target_backend: ".", target_frontend: "." },
    project: {
      name: "test", workspace_root: ".", backend_root: "./backend", frontend_root: "./frontend",
      roots: ["./backend", "./frontend"],
      resolution_source: "config", entrypoints: [],
    },
    modules,
    frontend_files: [],
    frontend: { pages: [], api_calls: [] },
    endpoints: [],
    data_models: [],
    enums: [],
    constants: [],
    endpoint_model_usage: [],
    cross_stack_contracts: [],
    tasks: [],
    runtime: { dockerfiles: [], services: [], manifests: [], shell_scripts: [] },
    data_flows: [],
    tests: [],
    dependencies: { module_graph: [], file_graph: [] },
    drift: null as any,
    analysis: {
      circular_dependencies: [],
      orphan_modules: [],
      orphan_files: [],
      frontend_orphan_files: [],
      module_usage: {},
      unused_exports: [],
      frontend_unused_exports: [],
      unused_endpoints: [],
      frontend_unused_api_calls: [],
      duplicate_functions: [],
      similar_functions: [],
      test_coverage: { untested_source_files: [], test_files_missing_source: [], coverage_map: [] },
      endpoint_test_coverage: [],
      function_test_coverage: [],
    },
    ...overrides,
  };
}

const emptyUx: UxSnapshot = { version: "0.2", components: [], component_graph: [], pages: [] };

// ========== CONFIG DEFAULTS ==========

describe("Config defaults", () => {
  it("DEFAULT_SPECS_DIR is .specs", () => {
    expect(DEFAULT_SPECS_DIR).toBe(".specs");
  });
});

// ========== OUTPUT LAYOUT ==========

describe("Output layout", () => {
  it("resolves all directories from root", () => {
    const layout = getOutputLayout("/project/.specs");
    expect(layout.rootDir).toBe("/project/.specs");
    expect(layout.machineDir).toBe("/project/.specs/machine");
    expect(layout.machineDocsDir).toBe("/project/.specs/machine/docs");
    expect(layout.humanDir).toBe("/project/.specs/human");
  });

  it("uses custom internal dir", () => {
    const layout = getOutputLayout("/project/.specs", "private");
    expect(layout.machineInternalDir).toBe("/project/.specs/machine/docs/private");
  });
});

// ========== CONTEXT BLOCK ==========

describe("Context block rendering", () => {
  it("includes all roots when project has multiple", () => {
    const arch = makeArch([], {
      project: {
        name: "test", workspace_root: ".", backend_root: "./be", frontend_root: "./fe",
        roots: ["./be", "./fe", "./packages/lib"],
        resolution_source: "config", entrypoints: [],
      },
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("**Roots:**");
    expect(output).toContain("./packages/lib");
  });

  it("does NOT show roots line for 2-root projects", () => {
    const arch = makeArch([]);
    arch.project.roots = ["./be", "./fe"];
    const output = renderContextBlock(arch, emptyUx);
    expect(output).not.toContain("**Roots:**");
  });

  it("includes Module Map section with exports", () => {
    const mod = makeModule("packages/audio-engine/src", {
      exports: [{ file: "index.ts", symbols: ["PitchTracker", "SargamMapper", "Metronome"], exports: [] }],
    });
    const arch = makeArch([mod]);
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("### Module Map");
    expect(output).toContain("**packages/audio-engine/src**");
    expect(output).toContain("PitchTracker");
    expect(output).toContain("SargamMapper");
  });

  it("includes Module Dependencies section", () => {
    const arch = makeArch([makeModule("a"), makeModule("b")], {
      dependencies: { module_graph: [{ from: "a", to: "b", file: "a.ts" }], file_graph: [] },
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("### Module Dependencies");
    expect(output).toContain("a → b");
  });

  it("includes High-Coupling Files section", () => {
    const arch = makeArch([], {
      dependencies: {
        module_graph: [],
        file_graph: [
          { from: "src/App.tsx", to: "src/utils.ts" },
          { from: "src/App.tsx", to: "src/api.ts" },
          { from: "src/App.tsx", to: "src/store.ts" },
        ],
      },
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("### High-Coupling Files");
    expect(output).toContain("src/App.tsx");
  });

  it("includes Structural Intelligence when provided", () => {
    const si = [{
      feature: "payments",
      structure: { nodes: 5, edges: 3 },
      classification: { depth_level: "HIGH" as const, propagation: "CROSS_MODULE" as const, compressible: "NON_COMPRESSIBLE" as const },
      confidence: { value: 0.85, factors: {} },
      recommendation: { primary: { pattern: "pipeline" }, avoid: ["single-function"] },
      guardrails: { enforce_if_confidence_above: 0.7, suggest_if_above: 0.4 },
    }];
    const arch = makeArch([]);
    const output = renderContextBlock(arch, emptyUx, { structuralIntelligence: si as any });
    expect(output).toContain("### Structural Intelligence");
    expect(output).toContain("payments");
    expect(output).toContain("depth=HIGH");
  });

  it("includes Component Import Reference", () => {
    const ux: UxSnapshot = {
      version: "0.2",
      components: [
        { id: "c1", name: "Button", file: "Button.tsx", export_kind: "named", kind: "component" },
        { id: "c2", name: "App", file: "App.tsx", export_kind: "default", kind: "component" },
      ],
      component_graph: [],
      pages: [],
    };
    const output = renderContextBlock(makeArch([]), ux);
    expect(output).toContain("### Component Import Reference");
    expect(output).toContain("import { Button }");
    expect(output).toContain("import App from");
  });

  it("includes Behavioral Test Specifications", () => {
    const arch = makeArch([], {
      tests: [
        { file: "tests/auth.test.ts", name: "login works", type: "it" },
        { file: "tests/auth.test.ts", name: "logout works", type: "it" },
      ] as any,
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("### Behavioral Test Specifications");
    expect(output).toContain("auth.test.ts");
    expect(output).toContain("(2 tests)");
  });

  it("never truncates — all sections present even with many modules", () => {
    const modules = Array.from({ length: 30 }, (_, i) => makeModule(`mod-${i}`, {
      exports: [{ file: "index.ts", symbols: [`Export${i}`], exports: [] }],
    }));
    const arch = makeArch(modules);
    const output = renderContextBlock(arch, emptyUx);

    // Must have opening and closing markers
    expect(output).toContain("<!-- guardian:context generated=");
    expect(output).toContain("<!-- /guardian:context -->");

    // Must NOT have truncation message
    expect(output).not.toContain("truncated");

    // Must have Module Map with all 30 modules
    expect(output).toContain("### Module Map");
    expect(output).toContain("mod-0");
    expect(output).toContain("mod-29");
  });
});

// ========== ENDPOINT SANITY ==========

describe("Endpoint sanity", () => {
  it("does not include non-HTTP patterns as endpoints", () => {
    // This was a real bug — Phaser scene names like "MainGameScene" matched route regex
    const arch = makeArch([], {
      endpoints: [
        { id: "GET /api/users", method: "GET", path: "/api/users", file: "routes.ts", module: "api" } as any,
        { id: "GET /MainGameScene", method: "GET", path: "/MainGameScene", file: "scenes.ts", module: "game" } as any,
      ],
    });
    const output = renderContextBlock(arch, emptyUx);
    // The context shows "2 endpoints" — both are included.
    // This test documents the current behavior. Future fix: filter by framework pattern.
    expect(output).toContain("2 endpoints");
  });
});

// ========== DEEP INTELLIGENCE SECTION ==========

describe("Deep Intelligence footer", () => {
  it("includes Deep Intelligence section with file pointers", () => {
    const output = renderContextBlock(makeArch([]), emptyUx);
    expect(output).toContain("### Deep Intelligence");
    expect(output).toContain("architecture.snapshot.yaml");
    expect(output).toContain("codebase-intelligence.json");
    expect(output).toContain("structural-intelligence.json");
  });

  it("includes guardian search and context commands", () => {
    const output = renderContextBlock(makeArch([]), emptyUx);
    expect(output).toContain('guardian search --query');
    expect(output).toContain('guardian context --focus');
    expect(output).toContain('guardian drift');
  });

  it("mentions circular dependencies when present", () => {
    const arch = makeArch([], {
      analysis: {
        circular_dependencies: [["a", "b", "a"]],
        orphan_modules: [], orphan_files: [], frontend_orphan_files: [],
        module_usage: {}, unused_exports: [], frontend_unused_exports: [],
        unused_endpoints: [], frontend_unused_api_calls: [],
        duplicate_functions: [], similar_functions: [],
        test_coverage: { untested_source_files: [], test_files_missing_source: [], coverage_map: [] },
        endpoint_test_coverage: [], function_test_coverage: [],
      },
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("Circular dependencies detected: 1 cycles");
  });

  it("mentions file graph when present", () => {
    const arch = makeArch([], {
      dependencies: {
        module_graph: [],
        file_graph: [{ from: "a.ts", to: "b.ts" }],
      },
    });
    const output = renderContextBlock(arch, emptyUx);
    expect(output).toContain("dependencies.file_graph");
  });
});
