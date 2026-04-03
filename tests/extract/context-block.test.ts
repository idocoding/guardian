import { describe, it, expect } from "vitest";
import { renderContextBlock } from "../../src/extract/context-block.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../../src/extract/types.js";

function makeArch(overrides?: Partial<ArchitectureSnapshot>): ArchitectureSnapshot {
  return {
    version: "1.0",
    metadata: { generated_at: "", duration_ms: 0, target_backend: ".", target_frontend: "." },
    project: {
      name: "test-project", workspace_root: ".", backend_root: ".", frontend_root: "./frontend",
      resolution_source: "auto", entrypoints: [],
    },
    modules: [],
    frontend_files: [],
    frontend: { pages: [], api_calls: [] },
    endpoints: [],
    data_models: [],
    enums: [],
    constants: [],
    endpoint_model_usage: [],
    cross_stack_contracts: [],
    tasks: [],
    runtime: { docker: null, configs: [], ci: [] },
    data_flows: [],
    tests: [],
    dependencies: { module_graph: [], file_graph: [] },
    drift: null as any,
    analysis: {
      circular_dependencies: [], orphan_modules: [], orphan_files: [], frontend_orphan_files: [],
      module_usage: {}, unused_exports: [], frontend_unused_exports: [],
      unused_endpoints: [], frontend_unused_api_calls: [],
      duplicate_functions: [], similar_functions: [],
      test_coverage: { untested_source_files: [], test_files_missing_source: [], coverage_map: [] },
      endpoint_test_coverage: [], function_test_coverage: [],
    },
    ...overrides,
  } as ArchitectureSnapshot;
}

function makeUx(overrides?: Partial<UxSnapshot>): UxSnapshot {
  return {
    version: "0.2",
    components: [],
    component_graph: [],
    pages: [],
    ...overrides,
  } as UxSnapshot;
}

describe("renderContextBlock", () => {
  it("renders the guardian:context markers", () => {
    const result = renderContextBlock(makeArch(), makeUx());
    expect(result).toContain("<!-- guardian:context ");
    expect(result).toContain("<!-- /guardian:context -->");
  });

  it("renders Codebase Map header", () => {
    const result = renderContextBlock(makeArch(), makeUx());
    expect(result).toContain("## Codebase Map");
  });

  it("renders backend and frontend stats", () => {
    const arch = makeArch({
      endpoints: [
        { id: "ep1", method: "GET", path: "/api/users", handler: "getUsers", file: "r.ts", module: "api" } as any,
      ],
    });
    const result = renderContextBlock(arch, makeUx());
    expect(result).toContain("1 endpoints");
    expect(result).toContain("0 components");
  });

  it("renders High-Coupling Files when file_graph has edges", () => {
    const arch = makeArch({
      dependencies: {
        module_graph: [],
        file_graph: [
          { from: "a.ts", to: "b.ts" },
          { from: "b.ts", to: "c.ts" },
          { from: "c.ts", to: "a.ts" },
        ],
      },
    });
    const result = renderContextBlock(arch, makeUx());
    expect(result).toContain("### High-Coupling Files");
  });

  it("renders Key Model -> Endpoint Map when usage exists", () => {
    const arch = makeArch({
      endpoints: [
        { id: "ep1", method: "GET", path: "/api/users", handler: "get", file: "r.ts", module: "api" } as any,
      ],
      data_models: [
        { name: "User", file: "m.py", framework: "sqlalchemy", fields: ["id"], relationships: [], field_details: [] } as any,
      ],
      endpoint_model_usage: [
        { endpoint_id: "ep1", endpoint: "GET /api/users", models: [{ name: "User", access: "read" }] },
      ],
    });
    const result = renderContextBlock(arch, makeUx());
    expect(result).toContain("### Key Model -> Endpoint Map");
    expect(result).toContain("User");
  });

  it("renders Focus section when focusQuery is provided", () => {
    const arch = makeArch({
      endpoints: [
        { id: "ep1", method: "GET", path: "/api/stripe/charges", handler: "getCharges", file: "stripe.ts", module: "billing" } as any,
      ],
    });
    const result = renderContextBlock(arch, makeUx(), { focusQuery: "stripe" });
    expect(result).toContain("### Focus: stripe");
  });

  it("does not truncate — all sections always present", () => {
    // We removed global truncation. Per-section limits handle large projects.
    const arch = makeArch({
      endpoints: Array.from({ length: 20 }, (_, i) => ({
        id: `ep${i}`, method: "GET", path: `/api/item${i}`, handler: `h${i}`, file: "r.ts", module: "api",
      })) as any[],
    });
    const result = renderContextBlock(arch, makeUx());
    expect(result).not.toContain("truncated");
    expect(result).toContain("<!-- /guardian:context -->");
  });

  it("Component Import Reference renders export kind", () => {
    const ux = makeUx({
      components: [
        { id: "c1", name: "Button", file: "Button.tsx", export_kind: "default", props: [], children: [] } as any,
        { id: "c2", name: "Modal", file: "Modal.tsx", export_kind: "named", props: [], children: [] } as any,
      ],
    });
    const result = renderContextBlock(makeArch(), ux);
    expect(result).toContain("### Component Import Reference");
    expect(result).toContain("import Button from");
    expect(result).toContain("import { Modal } from");
  });
});
