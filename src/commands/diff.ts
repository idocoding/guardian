import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { ArchitectureSnapshot } from "../extract/types.js";

export type DiffOptions = {
  baselinePath: string;
  currentPath: string;
  output: string;
};

export async function runDiff(options: DiffOptions): Promise<void> {
  const { baselinePath, currentPath, output } = options;

  let baselineRaw: string;
  let currentRaw: string;

  try {
    baselineRaw = await fs.readFile(baselinePath, "utf8");
  } catch (err) {
    console.error(`Failed to read baseline snapshot at ${baselinePath}`);
    return;
  }

  try {
    currentRaw = await fs.readFile(currentPath, "utf8");
  } catch (err) {
    console.error(`Failed to read current snapshot at ${currentPath}`);
    return;
  }

  const baseline = yaml.load(baselineRaw) as ArchitectureSnapshot;
  const current = yaml.load(currentRaw) as ArchitectureSnapshot;

  const diffResult = computeDiff(baseline, current);

  const markdownRaw = generateDiffMarkdown(diffResult);
  
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, markdownRaw, "utf8");
  console.log(`Wrote diff markdown to ${output}`);
}

type DiffResult = {
  endpoints: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  models: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  components: {
    added: string[];
    removed: string[];
  };
};

function computeDiff(baseline: ArchitectureSnapshot, current: ArchitectureSnapshot): DiffResult {
  const baselineEndpoints = new Map(baseline.endpoints.map(e => [e.id, e]));
  const currentEndpoints = new Map(current.endpoints.map(e => [e.id, e]));

  const endpointAdded = [];
  const endpointRemoved = [];
  const endpointChanged = [];

  for (const [id, e] of currentEndpoints.entries()) {
    if (!baselineEndpoints.has(id)) {
      endpointAdded.push(id);
    } else {
      const bE = baselineEndpoints.get(id)!;
      if (bE.path !== e.path || bE.method !== e.method || bE.handler !== e.handler) {
        endpointChanged.push(id);
      }
    }
  }

  for (const id of baselineEndpoints.keys()) {
    if (!currentEndpoints.has(id)) {
      endpointRemoved.push(id);
    }
  }
  
  const baselineModels = new Map(baseline.data_models?.map(m => [m.name, m]) ?? []);
  const currentModels = new Map(current.data_models?.map(m => [m.name, m]) ?? []);
  
  const modelsAdded = [];
  const modelsRemoved = [];
  const modelsChanged = [];
  
  for (const [name, m] of currentModels.entries()) {
    if (!baselineModels.has(name)) {
      modelsAdded.push(name);
    } else {
      const bM = baselineModels.get(name)!;
      if (bM.fields.length !== m.fields.length || bM.relationships.length !== m.relationships.length) {
         modelsChanged.push(name);
      }
    }
  }
  
  for (const name of baselineModels.keys()) {
    if (!currentModels.has(name)) {
      modelsRemoved.push(name);
    }
  }
  
  // To handle components we need to look at UxSnapshot mostly, but let's see if we can use frontend_files/pages
  const baselinePages = new Set((baseline.frontend?.pages ?? []).map(p => p.path));
  const currentPages = new Set((current.frontend?.pages ?? []).map(p => p.path));
  
  const componentsAdded = [];
  const componentsRemoved = [];
  
  for (const p of currentPages) {
    if (!baselinePages.has(p)) componentsAdded.push(p);
  }
  for (const p of baselinePages) {
    if (!currentPages.has(p)) componentsRemoved.push(p);
  }

  return {
    endpoints: { added: endpointAdded, removed: endpointRemoved, changed: endpointChanged },
    models: { added: modelsAdded, removed: modelsRemoved, changed: modelsChanged },
    components: { added: componentsAdded, removed: componentsRemoved }
  };
}

function generateDiffMarkdown(diff: DiffResult): string {
  const lines: string[] = [];
  
  lines.push("# Architecture Snapshot Changelog");
  lines.push("");
  lines.push(`**${diff.endpoints.added.length}** endpoints added, **${diff.models.changed.length}** models changed, **${diff.components.removed.length}** components/pages removed.`);
  lines.push("");
  
  lines.push("## Endpoints");
  if (diff.endpoints.added.length > 0) {
    lines.push("### Added");
    diff.endpoints.added.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.endpoints.removed.length > 0) {
    lines.push("### Removed");
    diff.endpoints.removed.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.endpoints.changed.length > 0) {
    lines.push("### Changed");
    diff.endpoints.changed.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.endpoints.added.length === 0 && diff.endpoints.removed.length === 0 && diff.endpoints.changed.length === 0) {
     lines.push("*No changes*");
  }
  lines.push("");
  
  lines.push("## Data Models");
  if (diff.models.added.length > 0) {
    lines.push("### Added");
    diff.models.added.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.models.removed.length > 0) {
    lines.push("### Removed");
    diff.models.removed.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.models.changed.length > 0) {
    lines.push("### Changed");
    diff.models.changed.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.models.added.length === 0 && diff.models.removed.length === 0 && diff.models.changed.length === 0) {
     lines.push("*No changes*");
  }
  lines.push("");
  
  lines.push("## Frontend Pages (Components)");
  if (diff.components.added.length > 0) {
    lines.push("### Added");
    diff.components.added.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.components.removed.length > 0) {
    lines.push("### Removed");
    diff.components.removed.forEach(e => lines.push(`- ${e}`));
  }
  if (diff.components.added.length === 0 && diff.components.removed.length === 0) {
     lines.push("*No changes*");
  }
  lines.push("");
  
  return lines.join("\n");
}
