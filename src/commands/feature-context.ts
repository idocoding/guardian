/**
 * `guardian feature-context` — generate a filtered, self-contained context packet
 * for implementing a single feature.
 *
 * Analogous to `chapter-context` in the book workflow: given a feature spec YAML,
 * outputs only the endpoints, models, enums, and patterns relevant to that feature —
 * plus one-hop neighbours (endpoints that share a model with the declared ones).
 *
 * Reads:  feature spec YAML + codebase-intelligence.json
 * Writes: specs-out/machine/feature-context/<spec-name>.json (or --output)
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { parseFeatureSpec } from "../schema/feature-spec.js";
import { loadCodebaseIntelligence, type ApiRegistryEntry, type CodebaseIntelligence } from "../extract/codebase-intel.js";
import { getOutputLayout } from "../output-layout.js";

export type FeatureContextOptions = {
  spec: string;           // path to feature spec YAML
  specs: string;          // specs-out dir (default: specs-out)
  output?: string;
};

export type FeatureContext = {
  meta: {
    feature: string;
    description: string;
    patterns: string[];
    tradeoff: string;
    failure_risk: string;
    maps_to: string;
    generated_at: string;
  };
  declared_endpoints: Record<string, ApiRegistryEntry>;
  neighbour_endpoints: Record<string, ApiRegistryEntry>;  // one-hop: share a model
  affected_models: Record<string, CodebaseIntelligence["model_registry"][string]>;
  affected_enums: Record<string, CodebaseIntelligence["enum_registry"][string]>;
  pattern_definitions: CodebaseIntelligence["pattern_registry"]["patterns"];
  write_guide: {
    rule: string;
    endpoint_lookup: string;
    model_lookup: string;
    pattern_lookup: string;
  };
};

export async function runFeatureContext(options: FeatureContextOptions): Promise<void> {
  const specPath = path.resolve(options.spec);
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);

  // Load and validate feature spec
  const raw = await fs.readFile(specPath, "utf8");
  const parsed = yaml.load(raw);
  const spec = parseFeatureSpec(parsed);

  // Load codebase intelligence
  const intelPath = path.join(layout.machineDir, "codebase-intelligence.json");
  const intel = await loadCodebaseIntelligence(intelPath).catch(() => {
    throw new Error(
      `Could not load codebase-intelligence.json from ${intelPath}. Run \`guardian extract --output ${options.specs}\` first.`
    );
  });

  // Build filtered context
  const context = buildFeatureContext(spec, intel);

  // Determine output path
  const specName = path.basename(specPath).replace(/\.ya?ml$/, "");
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(layout.machineDir, "feature-context", `${specName}.json`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(context, null, 2), "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(
    `  ${Object.keys(context.declared_endpoints).length} declared endpoints, ` +
    `${Object.keys(context.neighbour_endpoints).length} neighbours, ` +
    `${Object.keys(context.affected_models).length} models, ` +
    `${Object.keys(context.affected_enums).length} enums`
  );
}

function buildFeatureContext(
  spec: ReturnType<typeof parseFeatureSpec>,
  intel: CodebaseIntelligence
): FeatureContext {
  // Declared endpoints
  const declaredEndpoints: Record<string, ApiRegistryEntry> = {};
  for (const epKey of spec.affected_endpoints) {
    if (intel.api_registry[epKey]) {
      declaredEndpoints[epKey] = intel.api_registry[epKey];
    }
  }

  // Affected models (declared + inferred from endpoint model usage)
  const modelNames = new Set<string>(spec.affected_models);

  // Enrich: collect models used by declared endpoints via service_calls heuristic
  // (we don't have full endpoint→model map in intel — use request/response schema names)
  for (const ep of Object.values(declaredEndpoints)) {
    if (ep.request_schema) modelNames.add(ep.request_schema);
    if (ep.response_schema) modelNames.add(ep.response_schema);
  }

  const affectedModels: Record<string, CodebaseIntelligence["model_registry"][string]> = {};
  for (const name of modelNames) {
    if (intel.model_registry[name]) {
      affectedModels[name] = intel.model_registry[name];
    }
  }

  // One-hop neighbours: other endpoints that share any affected model
  const neighbourEndpoints: Record<string, ApiRegistryEntry> = {};
  for (const [key, ep] of Object.entries(intel.api_registry)) {
    if (declaredEndpoints[key]) continue;  // already declared
    const requestMatch = ep.request_schema && modelNames.has(ep.request_schema);
    const responseMatch = ep.response_schema && modelNames.has(ep.response_schema);
    if (requestMatch || responseMatch) {
      neighbourEndpoints[key] = ep;
    }
  }

  // Affected enums: those whose names appear in model field lists
  const affectedEnums: Record<string, CodebaseIntelligence["enum_registry"][string]> = {};
  for (const model of Object.values(affectedModels)) {
    for (const field of model.fields) {
      for (const [enumName, enumEntry] of Object.entries(intel.enum_registry)) {
        if (field.toLowerCase().includes(enumName.toLowerCase())) {
          affectedEnums[enumName] = enumEntry;
        }
      }
    }
  }

  // Pattern definitions for declared patterns
  const patternDefs = intel.pattern_registry.patterns.filter((p) =>
    spec.pattern.includes(p.id)
  );

  return {
    meta: {
      feature: spec.feature,
      description: spec.description,
      patterns: spec.pattern,
      tradeoff: spec.tradeoff,
      failure_risk: spec.failure_risk,
      maps_to: spec.maps_to,
      generated_at: new Date().toISOString(),
    },
    declared_endpoints: declaredEndpoints,
    neighbour_endpoints: neighbourEndpoints,
    affected_models: affectedModels,
    affected_enums: affectedEnums,
    pattern_definitions: patternDefs,
    write_guide: {
      rule: "Only use endpoints, models, and patterns listed in this file. Do not invent endpoints or models not listed here.",
      endpoint_lookup: "declared_endpoints contains the exact endpoints this feature adds or modifies.",
      model_lookup: "affected_models contains all ORM models this feature reads or writes.",
      pattern_lookup: "pattern_definitions describes the implementation pattern(s) to follow.",
    },
  };
}
