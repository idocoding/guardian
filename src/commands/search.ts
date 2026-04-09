import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { loadHeatmap, type DriftHeatmap } from "../extract/compress.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../extract/types.js";
import {
  loadFunctionIntelligence,
  type FunctionIntelligence,
} from "../extract/function-intel.js";
import { resolveMachineInputDir } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";

type SearchType = "models" | "endpoints" | "components" | "modules" | "tasks" | "functions";

export type SearchOptions = {
  input: string;
  query: string;
  output?: string;
  types?: string[];
};

type SearchMatch = {
  type: SearchType;
  name: string;
  score: number;
  markdown: string[];
};

export async function runSearch(options: SearchOptions): Promise<void> {
  const inputDir = await resolveMachineInputDir(options.input || DEFAULT_SPECS_DIR);
  const { architecture, ux } = await loadSnapshots(inputDir);
  const heatmap = await loadHeatmap(inputDir);
  const funcIntel = await loadFunctionIntelligence(inputDir);
  const types = normalizeTypes(options.types);
  const matches = searchSnapshots({
    architecture,
    ux,
    query: options.query,
    types,
    heatmap,
    funcIntel,
  });
  const content = renderSearchMarkdown(options.query, matches);

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf8");
    console.log(`Wrote ${outputPath}`);
    return;
  }

  console.log(content);
}

async function loadSnapshots(
  inputDir: string
): Promise<{ architecture: ArchitectureSnapshot; ux: UxSnapshot }> {
  const architecturePath = path.join(inputDir, "architecture.snapshot.yaml");
  const uxPath = path.join(inputDir, "ux.snapshot.yaml");
  let architectureRaw: string;
  let uxRaw: string;
  try {
    [architectureRaw, uxRaw] = await Promise.all([
      fs.readFile(architecturePath, "utf8"),
      fs.readFile(uxPath, "utf8")
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Could not find snapshots in ${inputDir}. Run \`guardian extract\` first.`
      );
    }
    throw error;
  }

  return {
    architecture: yaml.load(architectureRaw) as ArchitectureSnapshot,
    ux: yaml.load(uxRaw) as UxSnapshot
  };
}

function normalizeTypes(types?: string[]): Set<SearchType> {
  if (!types || types.length === 0) {
    return new Set(["models", "endpoints", "components", "modules", "tasks"]);
  }

  const normalized = new Set<SearchType>();
  for (const entry of types) {
    for (const part of entry.split(",").map((value) => value.trim().toLowerCase())) {
      if (
        part === "models" ||
        part === "endpoints" ||
        part === "components" ||
        part === "modules" ||
        part === "tasks"
      ) {
        normalized.add(part);
      }
    }
  }

  return normalized.size > 0
    ? normalized
    : new Set(["models", "endpoints", "components", "modules", "tasks", "functions"]);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/.{}-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreItem(
  queryTokens: string[],
  item: {
    name: string;
    file?: string;
    text: string[];
  }
): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalizedName = item.name.toLowerCase();
  const normalizedFile = (item.file ?? "").toLowerCase();
  const normalizedText = item.text
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
  let total = 0;

  for (const token of queryTokens) {
    if (normalizedName === token) {
      total += 1;
      continue;
    }
    if (normalizedName.includes(token)) {
      total += 0.7;
      continue;
    }
    if (normalizedText.some((entry) => entry.includes(token))) {
      total += 0.4;
      continue;
    }
    if (normalizedFile.includes(token)) {
      total += 0.2;
      continue;
    }
  }

  const phrase = queryTokens.join(" ");
  if (phrase && normalizedName.includes(phrase)) {
    total += 0.15;
  }

  return Math.min(1, total / queryTokens.length);
}

function searchSnapshots(params: {
  architecture: ArchitectureSnapshot;
  ux: UxSnapshot;
  query: string;
  types: Set<SearchType>;
  heatmap: DriftHeatmap | null;
  funcIntel: FunctionIntelligence | null;
}): SearchMatch[] {
  const { architecture, ux, query, types, heatmap, funcIntel } = params;
  const queryTokens = tokenize(query);
  const matches: SearchMatch[] = [];
  const pageUsage = buildComponentPageUsage(ux);
  const moduleHeatmap = new Map(
    (heatmap?.levels.find((level) => level.level === "module")?.entries ?? []).map((entry) => [
      entry.id,
      entry.score
    ])
  );

  if (types.has("models")) {
    for (const model of architecture.data_models) {
      const score = scoreItem(queryTokens, {
        name: model.name,
        file: model.file,
        text: [...model.fields, ...model.relationships, model.framework]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "models",
        name: model.name,
        score,
        markdown: [
          `**${model.name}** · ${model.file}`,
          `Fields: ${formatList(model.fields, 8)}`,
          `Relations: ${formatList(model.relationships, 8)}`
        ]
      });
    }
  }

  if (types.has("endpoints")) {
    for (const endpoint of architecture.endpoints) {
      const score = scoreItem(queryTokens, {
        name: `${endpoint.method} ${endpoint.path}`,
        file: endpoint.file,
        text: [
          endpoint.handler,
          endpoint.module,
          endpoint.request_schema ?? "",
          endpoint.response_schema ?? "",
          ...endpoint.service_calls
        ]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "endpoints",
        name: `${endpoint.method} ${endpoint.path}`,
        score,
        markdown: [
          `${endpoint.method.padEnd(4, " ")} ${endpoint.path} → ${endpoint.handler} (${endpoint.file})`,
          `Module: ${endpoint.module} · Request: ${endpoint.request_schema ?? "none"} · Response: ${endpoint.response_schema ?? "none"}`
        ]
      });
    }
  }

  if (types.has("components")) {
    for (const component of ux.components) {
      const score = scoreItem(queryTokens, {
        name: component.name,
        file: component.file,
        text: [
          component.kind,
          component.export_kind,
          ...(component.props ?? []).map((prop) => `${prop.name}:${prop.type}`)
        ]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "components",
        name: component.name,
        score,
        markdown: [
          `**${component.name}** · ${component.file} · import: ${component.export_kind ?? "unknown"}`,
          `Props: ${formatProps(component.props)}`,
          `Used by: ${formatList(pageUsage.get(component.id) ?? [], 4)}`
        ]
      });
    }
  }

  if (types.has("modules")) {
    for (const module of architecture.modules) {
      const score = scoreItem(queryTokens, {
        name: module.id,
        file: module.path,
        text: [...module.files, ...module.endpoints, ...module.imports]
      });
      if (score <= 0) {
        continue;
      }
      const couplingScore = moduleHeatmap.get(module.id);
      matches.push({
        type: "modules",
        name: module.id,
        score,
        markdown: [
          `**${module.id}** · ${module.path} · ${module.files.length} files${
            typeof couplingScore === "number"
              ? ` · coupling score: ${couplingScore.toFixed(2)}`
              : ""
          }`,
          `Contains: ${formatList(module.files, 4)}`
        ]
      });
    }
  }

  if (types.has("tasks")) {
    for (const task of architecture.tasks) {
      const score = scoreItem(queryTokens, {
        name: task.name,
        file: task.file,
        text: [task.kind, task.queue ?? "", task.schedule ?? ""]
      });
      if (score <= 0) {
        continue;
      }
      matches.push({
        type: "tasks",
        name: task.name,
        score,
        markdown: [
          `**${task.name}** · ${task.file}`,
          `Kind: ${task.kind}${task.queue ? ` · Queue: ${task.queue}` : ""}${
            task.schedule ? ` · Schedule: ${task.schedule}` : ""
          }`
        ]
      });
    }
  }

  if (types.has("functions") && funcIntel) {
    const queryTokens = tokenize(query);

    // 1. Name match — function / theorem name contains a query token
    for (const fn of funcIntel.functions) {
      const score = scoreItem(queryTokens, {
        name: fn.name,
        file: fn.file,
        text: [...fn.stringLiterals, ...fn.regexPatterns, ...fn.calls, fn.language],
      });
      if (score <= 0) continue;

      const lineRange = `${fn.lines[0]}–${fn.lines[1]}`;
      const detail: string[] = [];
      if (fn.stringLiterals.length > 0) {
        detail.push(`Literals: ${formatList(fn.stringLiterals.slice(0, 3).map((l) => `"${l.slice(0, 60)}"`), 3)}`);
      }
      if (fn.regexPatterns.length > 0) {
        detail.push(`Patterns: ${formatList(fn.regexPatterns.slice(0, 3).map((p) => `/${p.slice(0, 60)}/`), 3)}`);
      }
      if (fn.calls.length > 0) {
        detail.push(`Calls: ${formatList(fn.calls, 5)}`);
      }

      matches.push({
        type: "functions",
        name: `${fn.name} (${fn.language})`,
        score,
        markdown: [
          `**${fn.name}** · ${fn.file}:${lineRange} · ${fn.language}${fn.isAsync ? " · async" : ""}`,
          ...detail,
        ],
      });
    }

    // 2. Literal index match — query token appears in a function's string/regex literals
    // (additive: surfaces functions whose body contains the queried literal even if
    // the function name itself doesn't match)
    for (const tok of queryTokens) {
      const hits = funcIntel.literal_index[tok.toLowerCase()];
      if (!hits) continue;
      for (const hit of hits) {
        // Skip if we already emitted this function via name match above
        if (matches.some((m) => m.type === "functions" && m.name.startsWith(hit.function + " ("))) {
          continue;
        }
        const fn = funcIntel.functions.find(
          (f) => f.file === hit.file && f.name === hit.function
        );
        if (!fn) continue;
        matches.push({
          type: "functions",
          name: `${fn.name} (${fn.language})`,
          score: 0.6,
          markdown: [
            `**${fn.name}** · ${fn.file}:${fn.lines[0]}–${fn.lines[1]} · ${fn.language}`,
            `Matched literal/pattern containing "${tok}"`,
          ],
        });
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function buildComponentPageUsage(ux: UxSnapshot): Map<string, string[]> {
  const usage = new Map<string, Set<string>>();

  for (const page of ux.pages) {
    const pageLabel = `${page.component} (${page.path})`;
    const ids = new Set<string>([
      page.component_id,
      ...page.components_direct_ids,
      ...page.components_descendants_ids
    ]);
    for (const id of ids) {
      const entry = usage.get(id) ?? new Set<string>();
      entry.add(pageLabel);
      usage.set(id, entry);
    }
  }

  return new Map(
    Array.from(usage.entries()).map(([id, pages]) => [
      id,
      Array.from(pages).sort((a, b) => a.localeCompare(b))
    ])
  );
}

function formatList(items: string[], limit: number): string {
  if (!items || items.length === 0) {
    return "none";
  }
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
}

function formatProps(
  props: UxSnapshot["components"][number]["props"] | undefined
): string {
  if (!props || props.length === 0) {
    return "none";
  }
  return props
    .slice(0, 6)
    .map((prop) => `${prop.name}${prop.optional ? "?" : ""}: ${prop.type}`)
    .join(", ");
}

function renderSearchMarkdown(query: string, matches: SearchMatch[]): string {
  const grouped = new Map<SearchType, SearchMatch[]>();
  for (const match of matches) {
    const entry = grouped.get(match.type) ?? [];
    entry.push(match);
    grouped.set(match.type, entry);
  }

  const labels: Array<[SearchType, string]> = [
    ["models", "Data Models"],
    ["endpoints", "Endpoints"],
    ["components", "Components"],
    ["modules", "Modules"],
    ["tasks", "Tasks"],
    ["functions", "Functions"],
  ];

  const lines: string[] = [];
  lines.push(`# Search: "${query}" - ${matches.length} matches`);
  lines.push("");

  if (matches.length === 0) {
    lines.push("*No matches found.*");
    return lines.join("\n");
  }

  for (const [type, label] of labels) {
    const entries = grouped.get(type) ?? [];
    if (entries.length === 0) {
      continue;
    }
    lines.push(`## ${label} (${entries.length})`);
    lines.push("");
    for (const entry of entries.slice(0, 8)) {
      lines.push(...entry.markdown);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}
