import fs from "node:fs/promises";
import path from "node:path";
import { buildSnapshots } from "../extract/index.js";
import { renderContextBlock } from "../extract/context-block.js";
import { getOutputLayout } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";
import { analyzeDepth } from "../extract/analyzers/depth.js";
import type { StructuralIntelligenceReport } from "../extract/types.js";

export type GenerateOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
  output?: string;
  focus?: string;
  maxLines?: string | number;
  aiContext?: boolean;
};

type PythonImportReference = {
  name: string;
  statement: string;
  file: string;
  kind: "schema" | "model";
};

export async function runGenerate(options: GenerateOptions): Promise<void> {
  if (!options.aiContext) {
    throw new Error("`guardian generate` currently supports `--ai-context` only.");
  }

  const outputRoot = path.resolve(options.output ?? DEFAULT_SPECS_DIR);
  const layout = getOutputLayout(outputRoot);
  const { architecture, ux } = await buildSnapshots({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    output: outputRoot,
    includeFileGraph: true,
    configPath: options.configPath
  });

  // Load persisted Structural Intelligence reports emitted by `guardian extract`
  const siReports = await loadStructuralIntelligenceReports(layout.machineDir);

  // If a --focus query is provided, prepend a real-time SI report for that query
  if (options.focus) {
    try {
      const focusReport = analyzeDepth({
        query: options.focus,
        modules: architecture.modules,
        moduleGraph: architecture.dependencies.module_graph,
        fileGraph: architecture.dependencies.file_graph,
        circularDependencies: architecture.analysis.circular_dependencies
      });
      const alreadyPresent = siReports.some((r) => r.feature === focusReport.feature);
      if (!alreadyPresent) siReports.unshift(focusReport);
    } catch {
      // Non-fatal — just skip injection for this query
    }
  }

  // Inject into the architecture object so renderContextBlock can consume it
  (architecture as typeof architecture & { structural_intelligence: StructuralIntelligenceReport[] }).structural_intelligence = siReports;

  const pythonImportReferences = await pickPythonImportReferences(architecture);

  // Load product description from README if available
  let productDescription = "";
  const readmeCandidates = [
    path.join(path.resolve(architecture.project.workspace_root), "README.md"),
    path.join(path.resolve(architecture.project.workspace_root), "readme.md"),
  ];
  for (const candidate of readmeCandidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      // Extract first H1 + first paragraph (concise product description)
      const lines = raw.split("\n");
      const descLines: string[] = [];
      let pastH1 = false;
      for (const line of lines) {
        if (line.startsWith("# ")) { pastH1 = true; descLines.push(line.replace(/^# /, "").trim()); continue; }
        if (!pastH1) continue;
        if (line.startsWith("## ")) break;  // stop at first H2
        if (line.trim()) descLines.push(line.trim());
        if (descLines.length >= 4) break;  // max 4 lines
      }
      productDescription = descLines.join(" ").slice(0, 300);
      break;
    } catch {
      // Not found
    }
  }

  const content = renderAiContextMarkdown(architecture, ux, {
    focusQuery: options.focus,
    maxLines: normalizeMaxLines(options.maxLines),
    pythonImportReferences,
    structuralIntelligence: siReports,
    productDescription
  });

  const outputPath = path.join(layout.machineDir, "architecture-context.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
  console.log(`Wrote ${outputPath}`);
}

async function loadStructuralIntelligenceReports(
  machineDir: string
): Promise<StructuralIntelligenceReport[]> {
  const siPath = path.join(machineDir, "structural-intelligence.json");
  try {
    const raw = await fs.readFile(siPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as StructuralIntelligenceReport[];
    }
  } catch {
    // File doesn't exist yet — run extract first
  }
  return [];
}

function renderAiContextMarkdown(
  architecture: Awaited<ReturnType<typeof buildSnapshots>>["architecture"],
  ux: Awaited<ReturnType<typeof buildSnapshots>>["ux"],
  options?: {
    focusQuery?: string;
    maxLines?: number;
    pythonImportReferences?: PythonImportReference[];
    structuralIntelligence?: StructuralIntelligenceReport[];
    productDescription?: string;
  }
): string {
  const keyModules = pickKeyBackendModules(architecture);
  const coreOrmModels = pickCoreOrmModels(architecture);
  const fallbackSchemas = pickTopSchemas(architecture);
  const lines: string[] = [];
  lines.push("<!-- guardian:ai-context -->");
  lines.push("# Architecture Context");
  lines.push("");
  lines.push(
    "Use this file as compact architectural memory for AI coding tools. It is optimized for machine consumption and omits full docs, charts, and raw snapshots."
  );
  lines.push("");
  lines.push(`Project: **${architecture.project.name}**`);
  if (options?.productDescription) {
    lines.push(`Description: ${options.productDescription}`);
  }
  lines.push(`Workspace: \`${architecture.project.workspace_root}\``);
  lines.push(`Backend: \`${architecture.project.backend_root}\``);
  lines.push(`Frontend: \`${architecture.project.frontend_root}\``);
  lines.push("");
  if (keyModules.length > 0) {
    lines.push(`Key backend modules: ${keyModules.join(", ")}`);
  }
  if (coreOrmModels.length > 0) {
    lines.push(`Core data models: ${coreOrmModels.join(", ")}`);
  } else if (fallbackSchemas.length > 0) {
    lines.push(
      `Core data models: no ORM models detected; top schemas: ${fallbackSchemas.join(", ")}`
    );
  } else {
    lines.push("Core data models: none detected");
  }
  lines.push("");
  if ((options?.pythonImportReferences?.length ?? 0) > 0) {
    lines.push("## Backend Import Reference");
    lines.push("");
    for (const reference of options?.pythonImportReferences ?? []) {
      lines.push(
        `- ${reference.name} -> \`${reference.statement}\` (${reference.kind}, ${reference.file})`
      );
    }
    lines.push("");
  }
  lines.push(renderContextBlock(architecture, ux, {
    focusQuery: options?.focusQuery,
    maxLines: options?.maxLines ?? 200,
    structuralIntelligence: options?.structuralIntelligence
  }));
  lines.push("");
  lines.push("## Usage");
  lines.push("");
  lines.push("- Paste into `CLAUDE.md`, `.cursorrules`, or a coding prompt.");
  lines.push("- Prefer this file over the human-readable docs when minimizing AI context size.");
  lines.push("- For deeper lookup, run `guardian search --query \"<feature>\"`.");
  lines.push("- Regenerate after major structural changes.");
  lines.push("");
  lines.push("<!-- /guardian:ai-context -->");
  return lines.join("\n");
}

function pickKeyBackendModules(
  architecture: Awaited<ReturnType<typeof buildSnapshots>>["architecture"]
): string[] {
  return architecture.modules
    .filter((module) => module.type === "backend")
    .map((module) => ({
      id: module.id,
      score: module.endpoints.length * 3 + module.files.length + module.imports.length
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((module) => module.id);
}

function pickCoreOrmModels(
  architecture: Awaited<ReturnType<typeof buildSnapshots>>["architecture"]
): string[] {
  const usageCounts = new Map<string, number>();
  for (const usage of architecture.endpoint_model_usage) {
    for (const model of usage.models) {
      usageCounts.set(model.name, (usageCounts.get(model.name) ?? 0) + 1);
    }
  }

  return architecture.data_models
    .filter((model) => model.framework !== "pydantic")
    .map((model) => ({
      name: model.name,
      score:
        (usageCounts.get(model.name) ?? 0) * 4 +
        model.relationships.length * 2 +
        Math.min(model.fields.length, 10)
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((model) => model.name);
}

function pickTopSchemas(
  architecture: Awaited<ReturnType<typeof buildSnapshots>>["architecture"]
): string[] {
  const schemaMentions = new Map<string, number>();
  for (const endpoint of architecture.endpoints) {
    if (endpoint.request_schema) {
      schemaMentions.set(
        endpoint.request_schema,
        (schemaMentions.get(endpoint.request_schema) ?? 0) + 1
      );
    }
    if (endpoint.response_schema) {
      schemaMentions.set(
        endpoint.response_schema,
        (schemaMentions.get(endpoint.response_schema) ?? 0) + 1
      );
    }
  }

  return architecture.data_models
    .filter((model) => model.framework === "pydantic")
    .map((model) => ({
      name: model.name,
      score: (schemaMentions.get(model.name) ?? 0) * 3 + Math.min(model.fields.length, 8)
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((model) => model.name);
}

function normalizeMaxLines(value?: string | number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

async function pickPythonImportReferences(
  architecture: Awaited<ReturnType<typeof buildSnapshots>>["architecture"]
): Promise<PythonImportReference[]> {
  const backendRoot = path.resolve(architecture.project.backend_root);
  const workspaceRoot = path.resolve(architecture.project.workspace_root);
  const topSchemas = pickTopSchemas(architecture).slice(0, 3);
  const topOrmModels = pickCoreOrmModels(architecture).slice(0, 2);
  const candidateNames = Array.from(new Set([...topSchemas, ...topOrmModels]));
  if (candidateNames.length === 0) {
    return [];
  }

  const modelByName = new Map(
    architecture.data_models.map((model) => [model.name, model])
  );
  const importSpecifiers = await collectPythonImportSpecifiers(backendRoot, new Set(candidateNames));

  const references: PythonImportReference[] = [];
  for (const name of candidateNames) {
    const model = modelByName.get(name);
    if (!model) {
      continue;
    }
    const specifier = importSpecifiers.get(name);
    const derivedModulePath = derivePythonModulePath(model.file, workspaceRoot, backendRoot);
    const statement = specifier
      ? `from ${specifier} import ${name}`
      : derivedModulePath
        ? `from ${derivedModulePath} import ${name}`
        : "";
    if (!statement) {
      continue;
    }
    references.push({
      name,
      statement,
      file: model.file,
      kind: model.framework === "pydantic" ? "schema" : "model"
    });
  }

  return references;
}

async function collectPythonImportSpecifiers(
  backendRoot: string,
  targetNames: Set<string>
): Promise<Map<string, string>> {
  const counts = new Map<string, Map<string, number>>();
  const files = await listPythonFiles(backendRoot);

  for (const file of files) {
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const usage of extractPythonFromImports(content)) {
      for (const symbol of usage.symbols) {
        if (!targetNames.has(symbol)) {
          continue;
        }
        const specifierCounts = counts.get(symbol) ?? new Map<string, number>();
        specifierCounts.set(usage.specifier, (specifierCounts.get(usage.specifier) ?? 0) + 1);
        counts.set(symbol, specifierCounts);
      }
    }
  }

  const winners = new Map<string, string>();
  for (const [symbol, specifierCounts] of counts.entries()) {
    const best = Array.from(specifierCounts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0]?.[0];
    if (best) {
      winners.set(symbol, best);
    }
  }
  return winners;
}

async function listPythonFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPythonFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".py")) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractPythonFromImports(content: string): Array<{ specifier: string; symbols: string[] }> {
  const imports: Array<{ specifier: string; symbols: string[] }> = [];

  for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm)) {
    let namesPart = match[2].split("#")[0]?.trim() ?? "";
    namesPart = namesPart.replace(/[()]/g, "");
    const symbols = namesPart
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.split(/\s+as\s+/i)[0]?.trim() ?? "")
      .filter((name) => name.length > 0 && name !== "*");
    if (symbols.length > 0) {
      imports.push({ specifier: match[1], symbols });
    }
  }

  return imports;
}

function derivePythonModulePath(
  relativeFile: string,
  workspaceRoot: string,
  backendRoot: string
): string | null {
  const absoluteFile = path.resolve(workspaceRoot, relativeFile);
  const relativeToBackend = path.relative(backendRoot, absoluteFile).replace(/\\/g, "/");
  if (!relativeToBackend || relativeToBackend.startsWith("../") || !relativeToBackend.endsWith(".py")) {
    return null;
  }

  const withoutExt = relativeToBackend.replace(/\.py$/, "");
  const normalized = withoutExt.endsWith("/__init__")
    ? withoutExt.slice(0, -"/__init__".length)
    : withoutExt;
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))
  ) {
    return null;
  }

  return segments.join(".");
}
