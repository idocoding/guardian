import type { ArchitectureDiffSummary, DriftHeatmap } from "./compress.js";
import type { ArchitectureSnapshot, UxSnapshot } from "./types.js";

export function renderContextBlock(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  options?: {
    focusQuery?: string;
    maxLines?: number;
    heatmap?: DriftHeatmap | null;
    diff?: ArchitectureDiffSummary | null;
    structuralIntelligence?: ArchitectureSnapshot["structural_intelligence"];
  }
): string {
  const focusTokens = tokenize(options?.focusQuery ?? "");
  const ormModels = architecture.data_models.filter((model) => model.framework !== "pydantic");
  const schemaModels = architecture.data_models.length - ormModels.length;
  const lines: string[] = [];
  lines.push(`<!-- guardian:context generated=${new Date().toISOString()} -->`);
  lines.push("## Codebase Map");
  lines.push("");
  lines.push(
    `**Backend:** ${ormModels.length} ORM models + ${schemaModels} schemas · ${architecture.endpoints.length} endpoints · ${architecture.modules.length} modules`
  );
  lines.push(`**Frontend:** ${ux.components.length} components · ${ux.pages.length} pages`);

  // Show all roots if multi-root project
  const roots = architecture.project.roots;
  if (roots && roots.length > 2) {
    lines.push(`**Roots:** ${roots.join(", ")}`);
  }
  lines.push("");

  // Module map with key exports — the most useful section for AI context
  const modulesWithExports = architecture.modules.filter(m => m.exports.length > 0 || m.files.length > 0);
  if (modulesWithExports.length > 0) {
    lines.push("### Module Map");
    for (const mod of modulesWithExports) {
      const allSymbols = mod.exports.flatMap(e => e.symbols).filter(Boolean);
      const topSymbols = allSymbols.slice(0, 6);
      const symbolStr = topSymbols.length > 0
        ? ` — exports: ${topSymbols.join(", ")}${allSymbols.length > 6 ? ` (+${allSymbols.length - 6} more)` : ""}`
        : ` — ${mod.files.length} files`;
      const epCount = mod.endpoints.length > 0 ? ` · ${mod.endpoints.length} endpoints` : "";
      lines.push(`- **${mod.id}** (${mod.layer})${epCount}${symbolStr}`);
    }
    lines.push("");
  }

  // Cross-module dependencies
  const crossEdges = architecture.dependencies.module_graph.filter(
    e => e.from !== e.to
  );
  if (crossEdges.length > 0) {
    lines.push("### Module Dependencies");
    for (const edge of crossEdges.slice(0, 10)) {
      lines.push(`- ${edge.from} → ${edge.to}`);
    }
    lines.push("");
  }

  const couplingFiles = pickTopCouplingFiles(architecture, options?.heatmap, 5);
  if (couplingFiles.length > 0) {
    lines.push("### High-Coupling Files");
    for (const entry of couplingFiles) {
      lines.push(`- ${entry.id} (score ${entry.score.toFixed(2)})`);
    }
    lines.push("");
  }

  const recentChanges = summarizeDiff(options?.diff);
  if (recentChanges.length > 0) {
    lines.push("### Recent Structural Changes");
    for (const change of recentChanges) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }



  const exportComponents = pickRelevantComponents(ux, focusTokens).slice(0, 8);
  if (exportComponents.length > 0) {
    lines.push("### Component Import Reference");
    for (const component of exportComponents) {
      const importExample =
        component.export_kind === "default"
          ? `import ${component.name} from`
          : `import { ${component.name} } from`;
      lines.push(
        `- ${component.name} -> \`${importExample}\` (${component.export_kind ?? "unknown"})`
      );
    }
    lines.push("");
  }

  if (architecture.tests && architecture.tests.length > 0) {
    const testsByFile = new Map<string, typeof architecture.tests>();
    for (const test of architecture.tests) {
      if (!test.file) continue;
      if (!testsByFile.has(test.file)) testsByFile.set(test.file, []);
      testsByFile.get(test.file)!.push(test);
    }
    
    const testFiles = Array.from(testsByFile.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, 5); 

    if (testFiles.length > 0) {
      lines.push("### Behavioral Test Specifications");
      for (const [file, tests] of testFiles) {
        lines.push(`- \`${file}\` (${tests.length} tests)`);
      }
      lines.push("");
    }
  }

  const siReports = (options?.structuralIntelligence ?? architecture.structural_intelligence ?? []).filter(
    (r) => r.structure.nodes > 0
  ).slice(0, 5);

  if (siReports.length > 0) {
    lines.push("### Structural Intelligence");
    for (const r of siReports) {
      const compressLabel =
        r.classification.compressible === "NON_COMPRESSIBLE"
          ? "compressible=**no**"
          : r.classification.compressible === "PARTIAL"
            ? "compressible=partial"
            : "compressible=yes";
      lines.push(
        `- ${r.feature}: depth=${r.classification.depth_level} · propagation=${r.classification.propagation} · ${compressLabel} · pattern=${r.recommendation.primary.pattern} (confidence ${r.confidence.value.toFixed(2)})`
      );
    }
    lines.push("");

    const highRisk = siReports.filter(
      (r) =>
        r.classification.compressible === "NON_COMPRESSIBLE" &&
        r.confidence.value >= r.guardrails.enforce_if_confidence_above
    );
    if (highRisk.length > 0) {
      lines.push("### AI Reasoning Rules");
      lines.push("> [!WARNING]");
      lines.push("> The following features are HIGH complexity. Do NOT implement as a single function.");
      lines.push("");
      for (const r of highRisk) {
        lines.push(`- **${r.feature}** (confidence ${r.confidence.value.toFixed(2)}): use ${r.recommendation.primary.pattern}`);
        if (r.recommendation.avoid.length > 0) {
          lines.push(`  - Avoid: ${r.recommendation.avoid.join(", ")}`);
        }
      }
      lines.push("");
    }
  }

  const modelMap = buildModelEndpointMap(architecture, focusTokens);
  if (modelMap.length > 0) {
    lines.push("### Key Model -> Endpoint Map");
    for (const entry of modelMap.slice(0, 8)) {
      lines.push(
        `- ${entry.model} (${entry.endpoints.length} endpoints) -> ${formatEndpointPreview(entry.endpoints, 5)}`
      );
    }
    lines.push("");
  }

  if (focusTokens.length > 0) {
    const focusMatches = buildFocusSummary(architecture, ux, focusTokens);
    if (focusMatches.length > 0) {
      lines.push(`### Focus: ${options?.focusQuery}`);
      for (const match of focusMatches.slice(0, 10)) {
        lines.push(`- ${match}`);
      }
      lines.push("");
    }
  }

  // Deep intelligence — directive instructions for AI agents
  lines.push("### How to Use This Context");
  lines.push("");
  lines.push("> **Before reading source files**, run `guardian search --query \"<keyword>\"` to find relevant endpoints, models, components, and modules. This is faster than file exploration.");
  lines.push("");
  lines.push("**Deeper analysis files** (read when you need specifics):");
  lines.push("- `.specs/machine/architecture.snapshot.yaml` — every file, export symbol, and import edge per module");
  lines.push("- `.specs/machine/codebase-intelligence.json` — API registry: handlers, service calls, request/response schemas");
  lines.push("- `.specs/machine/structural-intelligence.json` — depth and complexity classification per module");

  if (architecture.dependencies.file_graph.length > 0) {
    lines.push("- File-level dependency graph available in `architecture.snapshot.yaml → dependencies.file_graph`");
  }
  if (architecture.analysis?.circular_dependencies?.length > 0) {
    lines.push(`- ⚠ ${architecture.analysis.circular_dependencies.length} circular dependency cycle(s) detected — check snapshot before refactoring`);
  }

  lines.push("");
  lines.push("**Commands:**");
  lines.push("- `guardian search --query \"auth\"` — find everything related to a feature");
  lines.push("- `guardian context --focus \"auth\"` — generate AI context focused on one area");
  lines.push("- `guardian drift` — check if architecture has shifted since last baseline");
  lines.push("");

  lines.push("<!-- /guardian:context -->");

  return lines.join("\n");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/.{}-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesFocus(tokens: string[], values: string[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const haystack = values.join(" ").toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function pickTopCouplingFiles(
  architecture: ArchitectureSnapshot,
  heatmap: DriftHeatmap | null | undefined,
  limit: number
): Array<{ id: string; score: number }> {
  const fileEntries = heatmap?.levels.find((level) => level.level === "file")?.entries ?? [];
  if (fileEntries.length > 0) {
    return fileEntries.slice(0, limit).map((entry) => ({
      id: entry.id,
      score: entry.score
    }));
  }

  const degree = new Map<string, number>();
  for (const edge of architecture.dependencies.file_graph) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const maxDegree = Math.max(...degree.values(), 1);

  return Array.from(degree.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, score]) => ({ id, score: score / maxDegree }));
}

function summarizeDiff(diff: ArchitectureDiffSummary | null | undefined): string[] {
  if (!diff) {
    return [];
  }

  const changes: string[] = [];
  for (const [kind, items] of Object.entries(diff.added)) {
    for (const item of items.slice(0, 3)) {
      changes.push(`${kind}: +${item}`);
    }
  }
  for (const [kind, items] of Object.entries(diff.removed)) {
    for (const item of items.slice(0, 2)) {
      changes.push(`${kind}: -${item}`);
    }
  }
  return changes.slice(0, 6);
}

function pickRelevantComponents(ux: UxSnapshot, focusTokens: string[]) {
  const pageContext = buildComponentPageContext(ux);
  const inDegree = buildComponentInDegree(ux);
  return ux.components
    .map((component) => {
      const pages = pageContext.get(component.id) ?? [];
      const values = [
        component.name,
        component.file,
        component.export_kind ?? "unknown",
        ...pages,
        ...(component.props ?? []).map((prop) => `${prop.name}:${prop.type}`)
      ];
      const score =
        focusTokens.length === 0
          ? (inDegree.get(component.id) ?? 0) * 0.5 +
            pages.length * 0.2 +
            (component.kind === "page" ? 0.1 : 0)
          : scoreFocus(focusTokens, component.name, component.file, values);
      return { component, pages, score };
    })
    .filter((entry) => focusTokens.length === 0 || entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      b.pages.length - a.pages.length ||
      a.component.name.localeCompare(b.component.name)
    )
    .map((entry) => entry.component);
}

function buildComponentInDegree(ux: UxSnapshot): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const edge of ux.component_graph) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  return inDegree;
}

function buildComponentPageContext(ux: UxSnapshot): Map<string, string[]> {
  const pageContext = new Map<string, Set<string>>();

  for (const page of ux.pages) {
    const targets = new Set([
      page.component_id,
      ...(page.components_direct_ids ?? []),
      ...(page.components_descendants_ids ?? [])
    ]);
    for (const target of targets) {
      if (!target) {
        continue;
      }
      const pages = pageContext.get(target) ?? new Set<string>();
      pages.add(page.path);
      pageContext.set(target, pages);
    }
  }

  return new Map(
    Array.from(pageContext.entries()).map(([key, value]) => [
      key,
      Array.from(value).sort((a, b) => a.localeCompare(b))
    ])
  );
}

function scoreFocus(tokens: string[], name: string, file: string, values: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const normalizedName = name.toLowerCase();
  const normalizedFile = file.toLowerCase();
  const haystack = values.map((value) => value.toLowerCase());
  let score = 0;

  for (const token of tokens) {
    if (normalizedName === token) {
      score += 1;
      continue;
    }
    if (normalizedName.includes(token)) {
      score += 0.8;
      continue;
    }
    if (normalizedFile.includes(token)) {
      score += 0.55;
      continue;
    }
    if (haystack.some((value) => value.includes(token))) {
      score += 0.4;
    }
  }

  return score / tokens.length;
}

function buildModelEndpointMap(
  architecture: ArchitectureSnapshot,
  focusTokens: string[]
): Array<{ model: string; endpoints: string[] }> {
  const endpointLabel = new Map(
    architecture.endpoints.map((endpoint) => [endpoint.id, `${endpoint.method} ${endpoint.path}`])
  );
  const modelMap = new Map<string, Set<string>>();

  for (const usage of architecture.endpoint_model_usage) {
    const endpoint = endpointLabel.get(usage.endpoint_id) ?? usage.endpoint;
    for (const model of usage.models) {
      const entry = modelMap.get(model.name) ?? new Set<string>();
      entry.add(endpoint);
      modelMap.set(model.name, entry);
    }
  }

  const rows = Array.from(modelMap.entries()).map(([model, endpoints]) => ({
    model,
    endpoints: Array.from(endpoints).sort((a, b) => a.localeCompare(b))
  }));

  const filtered = rows.filter((row) =>
    matchesFocus(focusTokens, [row.model, ...row.endpoints])
  );
  return (filtered.length > 0 ? filtered : rows).sort(
    (a, b) => b.endpoints.length - a.endpoints.length || a.model.localeCompare(b.model)
  );
}

function formatEndpointPreview(endpoints: string[], limit: number): string {
  if (endpoints.length <= limit) {
    return endpoints.join(", ");
  }
  const remaining = endpoints.length - limit;
  return `${endpoints.slice(0, limit).join(", ")} +${remaining} more`;
}

function buildFocusSummary(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  focusTokens: string[]
): string[] {
  const summary: string[] = [];
  const matchedModels = new Set<string>();
  const matchedEndpoints = new Set<string>();
  const matchedComponents = new Set<string>();
  const matchedModules = new Set<string>();

  // Pass 1: Direct Matching
  for (const model of architecture.data_models) {
    if (matchesFocus(focusTokens, [model.name, model.file, ...model.fields, ...model.relationships])) {
      matchedModels.add(model.name);
    }
  }
  for (const endpoint of architecture.endpoints) {
    if (
      matchesFocus(focusTokens, [
        endpoint.path,
        endpoint.handler,
        endpoint.file,
        endpoint.module,
        endpoint.request_schema ?? "",
        endpoint.response_schema ?? ""
      ])
    ) {
      matchedEndpoints.add(endpoint.id);
    }
  }
  for (const component of ux.components) {
    if (
      matchesFocus(focusTokens, [
        component.name,
        component.file,
        component.export_kind ?? "unknown",
        ...(component.props ?? []).map((prop) => `${prop.name}:${prop.type}`)
      ])
    ) {
      matchedComponents.add(component.id);
    }
  }
  for (const module of architecture.modules) {
    if (matchesFocus(focusTokens, [module.id, module.path, ...module.files])) {
      matchedModules.add(module.id);
    }
  }

  // Pass 2: 1-Degree Graph Expansion
  for (const usage of architecture.endpoint_model_usage) {
    const usesMatchedModel = usage.models.some((m) => matchedModels.has(m.name));
    if (usesMatchedModel) {
      matchedEndpoints.add(usage.endpoint_id);
    }
    if (matchedEndpoints.has(usage.endpoint_id)) {
      usage.models.forEach((m) => matchedModels.add(m.name));
    }
  }

  for (const edge of ux.component_graph) {
    if (matchedComponents.has(edge.from)) {
      matchedComponents.add(edge.to);
    }
    if (matchedComponents.has(edge.to)) {
      matchedComponents.add(edge.from);
    }
  }

  for (const edge of architecture.dependencies.module_graph) {
    if (matchedModules.has(edge.from)) {
      matchedModules.add(edge.to);
    }
    if (matchedModules.has(edge.to)) {
      matchedModules.add(edge.from);
    }
  }

  // Format Output
  for (const model of architecture.data_models) {
    if (matchedModels.has(model.name)) {
      summary.push(`model: ${model.name} (${model.file})`);
    }
  }
  for (const endpoint of architecture.endpoints) {
    if (matchedEndpoints.has(endpoint.id)) {
      summary.push(`endpoint: ${endpoint.method} ${endpoint.path} -> ${endpoint.handler}`);
    }
  }
  for (const component of ux.components) {
    if (matchedComponents.has(component.id)) {
      summary.push(`component: ${component.name} (${component.file})`);
    }
  }
  for (const module of architecture.modules) {
    if (matchedModules.has(module.id)) {
      summary.push(`module: ${module.id} (${module.path})`);
    }
  }

  return summary;
}
