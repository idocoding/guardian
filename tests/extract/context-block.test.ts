import { describe, it, expect } from "vitest";
import { renderContextBlock } from "../../src/extract/context-block.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../../src/extract/types.js";

function makeArch(overrides?: Partial<ArchitectureSnapshot>): ArchitectureSnapshot {
  return {
    project_name: "test-project",
    workspace_root: ".",
    backend_root: ".",
    frontend_root: "./frontend",
    modules: overrides?.modules ?? [],
    endpoints: overrides?.endpoints ?? [],
    data_models: overrides?.data_models ?? [],
    endpoint_model_usage: overrides?.endpoint_model_usage ?? [],
    data_flows: overrides?.data_flows ?? [],
    runtime: overrides?.runtime ?? {
      dockerfiles: [],
      services: [],
      config_files: [],
      shell_scripts: [],
      manifests: [],
    },
    tasks: overrides?.tasks ?? [],
    enums: overrides?.enums ?? [],
    constants: overrides?.constants ?? [],
    dependencies: overrides?.dependencies ?? {
      module_graph: [],
      file_graph: [],
      circular: [],
    },
    ...overrides,
  } as ArchitectureSnapshot;
}

function makeUx(overrides?: Partial<UxSnapshot>): UxSnapshot {
  return {
    components: overrides?.components ?? [],
    pages: overrides?.pages ?? [],
    component_graph: overrides?.component_graph ?? [],
    state_stores: overrides?.state_stores ?? [],
    actions: overrides?.actions ?? [],
    ...overrides,
  } as UxSnapshot;
}

describe("renderContextBlock", () => {
  it("renders the specguard:context markers", () => {
    const result = renderContextBlock(makeArch(), makeUx());
    expect(result).toContain("<!-- specguard:context ");
    expect(result).toContain("<!-- /specguard:context -->");
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
        circular: [],
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

  it("truncates output at maxLines", () => {
    const models = Array.from({ length: 20 }, (_, i) => ({
      name: `Model${i}`,
      file: "m.py",
      framework: "sqlalchemy",
      fields: ["id"],
      relationships: [],
      field_details: [],
    })) as any[];
    const endpoints = Array.from({ length: 20 }, (_, i) => ({
      id: `ep${i}`,
      method: "GET",
      path: `/api/item${i}`,
      handler: `handler${i}`,
      file: "r.ts",
      module: "api",
    })) as any[];
    const usages = models.map((m, i) => ({
      endpoint_id: `ep${i}`,
      endpoint: `GET /api/item${i}`,
      models: [{ name: m.name, access: "read" }],
    }));
    const fileEdges = Array.from({ length: 20 }, (_, i) => ({
      from: `a${i}.ts`,
      to: `b${i}.ts`,
    }));
    const arch = makeArch({
      endpoints,
      data_models: models,
      endpoint_model_usage: usages,
      dependencies: { module_graph: [], file_graph: fileEdges, circular: [] },
    });
    const result = renderContextBlock(arch, makeUx(), { maxLines: 10 });
    expect(result).toContain("context truncated for line budget");
  });

  it("Component Import Reference renders export kind", () => {
    const ux = makeUx({
      components: [
        { id: "c1", name: "Button", file: "Button.tsx", export_kind: "default", kind: "component" } as any,
        { id: "c2", name: "Modal", file: "Modal.tsx", export_kind: "named", kind: "component" } as any,
      ],
      pages: [
        { path: "/", component_id: "c1", components_direct_ids: ["c2"], components_descendants_ids: [] } as any,
      ],
    });
    const result = renderContextBlock(makeArch(), ux);
    expect(result).toContain("### Component Import Reference");
    expect(result).toContain("import Button from");
    expect(result).toContain("import { Modal } from");
  });
});
