/**
 * Codebase Intelligence — assembles a frozen cross-feature packet from architecture snapshots.
 *
 * Analogous to series-intelligence.json in the book workflow:
 * a single self-contained JSON file that any downstream command can read without
 * touching source code. Contains:
 *
 *   api_registry      — every endpoint keyed by "METHOD /path"
 *   model_registry    — every ORM model with fields and relationships
 *   enum_registry     — every enum with its values
 *   pattern_registry  — detected implementation patterns (P1–P8)
 *   background_tasks  — all background/celery tasks
 *   service_map       — modules with their endpoint counts and dependencies
 *   frontend_pages    — pages with their component trees and API calls
 *   meta              — project name, counts, generated_at
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { ArchitectureSnapshot, UxSnapshot } from "./types.js";
import { buildPatternRegistry, type PatternRegistry } from "./pattern-registry.js";
import { resolveMachineInputDir } from "../output-layout.js";

export type ApiRegistryEntry = {
  method: string;
  path: string;
  handler: string;
  file: string;
  module: string;
  request_schema: string | null;
  response_schema: string | null;
  service_calls: string[];
  ai_operations: ArchitectureSnapshot["endpoints"][number]["ai_operations"];
  patterns: string[];  // pattern IDs that apply, e.g. ["P1", "P2"]
};

export type ModelFieldDetail = {
  name: string;
  type?: string | null;
  nullable?: boolean | null;
  primary_key?: boolean | null;
  foreign_key?: string | null;
  enum?: string | null;
  default?: string | null;
};

export type ModelRegistryEntry = {
  name: string;
  file: string;
  framework: string;
  fields: string[];
  relationships: string[];
  field_details: ModelFieldDetail[];
};

export type EnumRegistryEntry = {
  name: string;
  file: string;
  values: string[];
};

export type ServiceMapEntry = {
  id: string;
  path: string;
  type: "backend" | "frontend";
  layer: string;
  file_count: number;
  endpoint_count: number;
  imports: string[];
};

export type FrontendPageEntry = {
  path: string;
  component: string;
  api_calls: string[];
  direct_components: string[];
};

export type CodebaseIntelligence = {
  meta: {
    project: string;
    generated_at: string;
    counts: {
      endpoints: number;
      models: number;
      enums: number;
      tasks: number;
      modules: number;
      pages: number;
      patterns_detected: number;
    };
  };
  api_registry: Record<string, ApiRegistryEntry>;
  model_registry: Record<string, ModelRegistryEntry>;
  enum_registry: Record<string, EnumRegistryEntry>;
  pattern_registry: PatternRegistry;
  background_tasks: ArchitectureSnapshot["tasks"];
  service_map: ServiceMapEntry[];
  frontend_pages: FrontendPageEntry[];
};

export function buildCodebaseIntelligence(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot
): CodebaseIntelligence {
  const patternRegistry = buildPatternRegistry(architecture);

  // Build a per-endpoint pattern index
  const endpointPatterns = new Map<string, string[]>();
  for (const pattern of patternRegistry.patterns) {
    for (const epStr of pattern.example_endpoints) {
      // example_endpoints are "METHOD /path" — match by id
    }
  }
  // More precise: recompute per-endpoint patterns from the architecture
  const epPatternMap = buildEndpointPatternMap(architecture);

  // api_registry
  const apiRegistry: Record<string, ApiRegistryEntry> = {};
  for (const ep of architecture.endpoints) {
    const key = `${ep.method} ${ep.path}`;
    apiRegistry[key] = {
      method: ep.method,
      path: ep.path,
      handler: ep.handler,
      file: ep.file,
      module: ep.module,
      request_schema: ep.request_schema ?? null,
      response_schema: ep.response_schema ?? null,
      service_calls: ep.service_calls,
      ai_operations: ep.ai_operations,
      patterns: epPatternMap.get(ep.id) ?? [],
    };
  }

  // model_registry
  const modelRegistry: Record<string, ModelRegistryEntry> = {};
  for (const model of architecture.data_models) {
    modelRegistry[model.name] = {
      name: model.name,
      file: model.file,
      framework: model.framework,
      fields: model.fields,
      relationships: model.relationships,
      field_details: model.field_details ?? [],
    };
  }

  // enum_registry
  const enumRegistry: Record<string, EnumRegistryEntry> = {};
  for (const en of architecture.enums) {
    enumRegistry[en.name] = {
      name: en.name,
      file: en.file,
      values: en.values,
    };
  }

  // service_map
  const serviceMap: ServiceMapEntry[] = architecture.modules.map((m) => ({
    id: m.id,
    path: m.path,
    type: m.type,
    layer: m.layer,
    file_count: m.files.length,
    endpoint_count: m.endpoints.length,
    imports: m.imports,
  }));

  // frontend_pages
  const frontendPages: FrontendPageEntry[] = ux.pages.map((p) => ({
    path: p.path,
    component: p.component,
    api_calls: p.api_calls,
    direct_components: p.components_direct,
  }));

  return {
    meta: {
      project: architecture.project.name,
      generated_at: new Date().toISOString(),
      counts: {
        endpoints: architecture.endpoints.length,
        models: architecture.data_models.length,
        enums: architecture.enums.length,
        tasks: architecture.tasks.length,
        modules: architecture.modules.length,
        pages: ux.pages.length,
        patterns_detected: patternRegistry.patterns.filter((p) => p.occurrences > 0).length,
      },
    },
    api_registry: apiRegistry,
    model_registry: modelRegistry,
    enum_registry: enumRegistry,
    pattern_registry: patternRegistry,
    background_tasks: architecture.tasks,
    service_map: serviceMap,
    frontend_pages: frontendPages,
  };
}

/**
 * Build a map from endpoint id → list of pattern IDs that apply.
 * This mirrors the pattern detection logic in pattern-registry.ts but keyed by id.
 */
function buildEndpointPatternMap(
  architecture: ArchitectureSnapshot
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  const modelWriteMap = new Map<string, number>();
  for (const usage of architecture.endpoint_model_usage) {
    const writes = usage.models.filter(
      (m) => m.access === "write" || m.access === "read_write"
    ).length;
    modelWriteMap.set(usage.endpoint_id, writes);
  }

  const crossStackVerified = new Set(
    (architecture.cross_stack_contracts ?? [])
      .filter((c) => c.status === "ok")
      .map((c) => c.endpoint_id)
  );

  const resourceMethods = new Map<string, Set<string>>();
  for (const ep of architecture.endpoints) {
    const resource = ep.path.replace(/\/\{[^}]+\}$/, "").replace(/\/:[^/]+$/, "");
    const entry = resourceMethods.get(resource) ?? new Set<string>();
    entry.add(ep.method.toUpperCase());
    resourceMethods.set(resource, entry);
  }
  const crudResources = new Set<string>();
  for (const [resource, methods] of resourceMethods) {
    if (methods.has("GET") && methods.has("POST") && (methods.has("PATCH") || methods.has("PUT"))) {
      crudResources.add(resource);
    }
  }

  for (const ep of architecture.endpoints) {
    const patterns: string[] = [];
    const lower = (ep.file + ep.handler).toLowerCase();

    if (ep.service_calls.length > 0) patterns.push("P1");
    if (
      lower.includes("auth") ||
      lower.includes("permission") ||
      lower.includes("require_") ||
      lower.includes("depends(get_current")
    ) patterns.push("P2");
    if (ep.ai_operations && ep.ai_operations.length > 0) patterns.push("P3");
    if (
      ep.service_calls.some((s) => {
        const sl = s.toLowerCase();
        return sl.includes("task") || sl.includes(".delay(") || sl.includes("background");
      })
    ) patterns.push("P4");
    const resource = ep.path.replace(/\/\{[^}]+\}$/, "").replace(/\/:[^/]+$/, "");
    if (crudResources.has(resource)) patterns.push("P5");
    if ((modelWriteMap.get(ep.id) ?? 0) >= 3) patterns.push("P6");
    if (crossStackVerified.has(ep.id)) patterns.push("P7");
    if (
      ep.method.toUpperCase() === "GET" &&
      (ep.path + ep.handler).toLowerCase().match(/list|page|paginate/)
    ) patterns.push("P8");

    result.set(ep.id, patterns);
  }

  return result;
}

/**
 * Load snapshots and build CodebaseIntelligence, then write to disk.
 */
export async function writeCodebaseIntelligence(
  specsDir: string,
  outputPath: string
): Promise<void> {
  const machineDir = await resolveMachineInputDir(specsDir);

  const [archRaw, uxRaw] = await Promise.all([
    fs.readFile(path.join(machineDir, "architecture.snapshot.yaml"), "utf8"),
    fs.readFile(path.join(machineDir, "ux.snapshot.yaml"), "utf8"),
  ]);

  const architecture = yaml.load(archRaw) as ArchitectureSnapshot;
  const ux = yaml.load(uxRaw) as UxSnapshot;

  const intel = buildCodebaseIntelligence(architecture, ux);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(intel, null, 2), "utf8");
}

/**
 * Load an existing codebase-intelligence.json from disk.
 */
export async function loadCodebaseIntelligence(
  intelPath: string
): Promise<CodebaseIntelligence> {
  const raw = await fs.readFile(intelPath, "utf8");
  return JSON.parse(raw) as CodebaseIntelligence;
}
