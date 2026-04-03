/**
 * Feature Arcs — builds a timeline of how feature areas evolve across sprints.
 *
 * Analogous to thread evolution in the book workflow (T8 evolving across 7 books):
 * tracks which endpoints, models, and service calls each feature area added per sprint.
 *
 * Input:  directory of feature spec YAML files
 * Output: feature-arcs.json
 *
 * Structure:
 *   {
 *     "auth": {
 *       "sprint_1": { endpoints: [...], models: [...], maps_to: [...] },
 *       "sprint_4": { ... },
 *     },
 *     "billing": { ... }
 *   }
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { parseFeatureSpec, type FeatureSpec } from "../schema/feature-spec.js";

export type SprintSnapshot = {
  endpoints: string[];
  models: string[];
  maps_to: string[];
  features: string[];   // feature names added in this sprint
};

export type FeatureArc = {
  tag: string;
  sprints: Record<string, SprintSnapshot>;  // "sprint_1", "sprint_2", ...
  total_endpoints: number;
  total_models: number;
};

export type FeatureArcs = {
  generated_at: string;
  arcs: Record<string, FeatureArc>;   // keyed by tag
  untagged: {
    features: string[];
    endpoints: string[];
    models: string[];
  };
};

/**
 * Load all feature spec YAML files from a directory and build the arc timeline.
 */
export async function buildFeatureArcs(featureSpecsDir: string): Promise<FeatureArcs> {
  const specs = await loadAllFeatureSpecs(featureSpecsDir);

  const arcMap = new Map<string, FeatureArc>();
  const untaggedFeatures: string[] = [];
  const untaggedEndpoints = new Set<string>();
  const untaggedModels = new Set<string>();

  for (const spec of specs) {
    const sprintKey = spec.sprint != null ? `sprint_${spec.sprint}` : "unsprinted";
    const tags = spec.tags.length > 0 ? spec.tags : null;

    if (!tags) {
      untaggedFeatures.push(spec.feature);
      spec.affected_endpoints.forEach((e) => untaggedEndpoints.add(e));
      spec.affected_models.forEach((m) => untaggedModels.add(m));
      continue;
    }

    for (const tag of tags) {
      if (!arcMap.has(tag)) {
        arcMap.set(tag, { tag, sprints: {}, total_endpoints: 0, total_models: 0 });
      }
      const arc = arcMap.get(tag)!;

      if (!arc.sprints[sprintKey]) {
        arc.sprints[sprintKey] = { endpoints: [], models: [], maps_to: [], features: [] };
      }
      const sprint = arc.sprints[sprintKey];

      sprint.features.push(spec.feature);
      spec.affected_endpoints.forEach((e) => {
        if (!sprint.endpoints.includes(e)) sprint.endpoints.push(e);
      });
      spec.affected_models.forEach((m) => {
        if (!sprint.models.includes(m)) sprint.models.push(m);
      });
      if (spec.maps_to && !sprint.maps_to.includes(spec.maps_to)) {
        sprint.maps_to.push(spec.maps_to);
      }
    }
  }

  // Compute totals per arc (deduplicated across sprints)
  for (const arc of arcMap.values()) {
    const allEndpoints = new Set<string>();
    const allModels = new Set<string>();
    for (const sprint of Object.values(arc.sprints)) {
      sprint.endpoints.forEach((e) => allEndpoints.add(e));
      sprint.models.forEach((m) => allModels.add(m));
    }
    arc.total_endpoints = allEndpoints.size;
    arc.total_models = allModels.size;
  }

  // Sort arcs alphabetically; sort sprint keys numerically
  const arcs: Record<string, FeatureArc> = {};
  for (const [tag, arc] of Array.from(arcMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    arcs[tag] = {
      ...arc,
      sprints: sortSprintKeys(arc.sprints),
    };
  }

  return {
    generated_at: new Date().toISOString(),
    arcs,
    untagged: {
      features: untaggedFeatures,
      endpoints: Array.from(untaggedEndpoints),
      models: Array.from(untaggedModels),
    },
  };
}

function sortSprintKeys(sprints: Record<string, SprintSnapshot>): Record<string, SprintSnapshot> {
  const sorted: Record<string, SprintSnapshot> = {};
  const keys = Object.keys(sprints).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10);
    const nb = parseInt(b.replace(/\D/g, ""), 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  for (const k of keys) sorted[k] = sprints[k];
  return sorted;
}

async function loadAllFeatureSpecs(dir: string): Promise<FeatureSpec[]> {
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(dir);
    entries = dirEntries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }

  const specs: FeatureSpec[] = [];
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(entry, "utf8");
      const parsed = yaml.load(raw);
      const spec = parseFeatureSpec(parsed);
      specs.push(spec);
    } catch {
      // Skip malformed specs silently
    }
  }
  return specs;
}

/**
 * Write feature arcs to disk.
 */
export async function writeFeatureArcs(
  featureSpecsDir: string,
  outputPath: string
): Promise<void> {
  const arcs = await buildFeatureArcs(featureSpecsDir);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(arcs, null, 2), "utf8");
}
