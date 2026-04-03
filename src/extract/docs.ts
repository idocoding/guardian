import fs from "node:fs/promises";
import path from "node:path";
import type { ArchitectureSnapshot, UxSnapshot } from "./types.js";
import type {
  ArchitectureSummary,
  ArchitectureDiffSummary,
  DriftHeatmap
} from "./compress.js";
import {
  loadArchitectureSummary,
  loadArchitectureDiff,
  loadHeatmap
} from "./compress.js";
import { getOutputLayout } from "../output-layout.js";

export type DocsMode = "lean" | "full";

const LEAN_INDEX_FILES = [
  "summary.md",
  "stakeholder.md",
  "hld.md",
  "integration.md",
  "diff.md",
  "runtime.md",
  "infra.md",
  "ux.md",
  "data.md",
  "tests.md"
];

const FULL_INDEX_FILES = [
  "summary.md",
  "stakeholder.md",
  "architecture.md",
  "ux.md",
  "data.md",
  "data_dictionary.md",
  "integration.md",
  "diff.md",
  "test_coverage.md",
  "runtime.md",
  "infra.md",
  "hld.md",
  "lld.md",
  "tests.md"
];

function section(title: string): string {
  return `# ${title}\n\n`;
}

function bullet(lines: string[]): string {
  if (lines.length === 0) {
    return "*None*\n";
  }
  return lines.map((line) => `- ${line}`).join("\n") + "\n";
}

function renderTests(architecture: ArchitectureSnapshot): string {
  if (!architecture.tests || architecture.tests.length === 0) {
    return [
      section("Behavioral Test Specifications"),
      "No tests extracted in this snapshot.",
      ""
    ].join("\n");
  }

  const testsByFile = new Map<string, typeof architecture.tests>();
  for (const test of architecture.tests) {
    if (!test.file) continue;
    if (!testsByFile.has(test.file)) testsByFile.set(test.file, []);
    testsByFile.get(test.file)!.push(test);
  }

  const rows: string[][] = [];
  for (const [file, tests] of Array.from(testsByFile.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const test of tests) {
      rows.push([
        file,
        test.suite_name || "-",
        test.test_name
      ]);
    }
  }

  return [
    section("Behavioral Test Specifications"),
    `Total extracted tests: **${architecture.tests.length}** across **${testsByFile.size}** files.`,
    "",
    renderTable(["File", "Suite", "Test Name"], rows),
    ""
  ].join("\n");
}

function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return "*None*\n\n";
  }
  const safe = (value: string): string =>
    value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "—";
  const headerLine = `| ${headers.map(safe).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(safe).join(" | ")} |`).join("\n");
  return `${headerLine}\n${separator}\n${body}\n\n`;
}

function mermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidLabel(raw: string): string {
  return raw.replace(/"/g, '\\"');
}

function renderMermaid(lines: string[]): string {
  return ["```mermaid\n", ...lines, "```\n\n"].join("");
}

function summarizeList(items: string[], limit = 5): string {
  if (items.length === 0) {
    return "none";
  }
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
}

function formatComponentProps(
  props?: UxSnapshot["components"][number]["props"]
): string {
  if (!props || props.length === 0) {
    return "none";
  }
  const entries = props.map((prop) => {
    const suffix = prop.optional ? "?" : "";
    return `${prop.name}${suffix}: ${prop.type || "unknown"}`;
  });
  return summarizeList(entries, 6);
}

function splitModelsByFramework(snapshot: ArchitectureSnapshot): {
  orm: ArchitectureSnapshot["data_models"];
  schemas: ArchitectureSnapshot["data_models"];
} {
  return {
    orm: snapshot.data_models.filter((model) => model.framework !== "pydantic"),
    schemas: snapshot.data_models.filter((model) => model.framework === "pydantic")
  };
}

function pickHeatmapLevel(
  heatmap: DriftHeatmap | null | undefined,
  level: "module" | "file" | "function" | "domain"
): DriftHeatmap["levels"][number] | null {
  if (!heatmap || !Array.isArray(heatmap.levels)) {
    return null;
  }
  return heatmap.levels.find((entry) => entry.level === level) ?? heatmap.levels[0] ?? null;
}

function pickHeatmapEntries(
  heatmap: DriftHeatmap | null | undefined,
  level: "module" | "file" | "function" | "domain"
): DriftHeatmap["levels"][number]["entries"] {
  return pickHeatmapLevel(heatmap, level)?.entries ?? [];
}

function renderHeatmapTable(
  label: string,
  entries: DriftHeatmap["levels"][number]["entries"],
  limit: number
): string {
  if (!entries || entries.length === 0) {
    return "*Not available*\n\n";
  }
  return renderTable(
    [label, "Layer", "Score", "Degree", "Cross-Layer", "Cycle"],
    entries.slice(0, limit).map((entry) => [
      entry.id,
      entry.layer,
      entry.score.toFixed(3),
      String(entry.components.degree),
      entry.components.cross_layer_ratio.toFixed(3),
      String(entry.components.cycle)
    ])
  );
}

function formatAiOperations(
  operations: ArchitectureSnapshot["endpoints"][number]["ai_operations"]
): string {
  if (!operations || operations.length === 0) {
    return "none";
  }
  return operations
    .map((op) => {
      const parts: string[] = [];
      if (op.model) {
        parts.push(op.model);
      }
      const tokenBudget = op.token_budget ?? op.max_output_tokens ?? op.max_tokens;
      if (typeof tokenBudget === "number") {
        parts.push(`tokens ${tokenBudget}`);
      }
      return parts.length > 0 ? `${op.operation} (${parts.join(", ")})` : op.operation;
    })
    .join(", ");
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function accessLabel(access: "read" | "write" | "read_write" | "unknown"): string {
  if (access === "read") {
    return "read";
  }
  if (access === "write") {
    return "write";
  }
  if (access === "read_write") {
    return "read/write";
  }
  return "uses";
}

function renderIndex(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  options: {
    docsFiles: string[];
    internalFiles?: string[];
    internalDir?: string;
  }
): string {
  const docsFiles = options.docsFiles;
  const internalFiles = options.internalFiles ?? [];
  const internalDir = options.internalDir ?? "internal";

  return [
    section("SpecGuard Overview"),
    `Project: **${architecture.project.name}**\n\n`,
    renderTable(
      ["Metric", "Count", "Notes"],
      [
        ["Modules", String(architecture.modules.length), "Backend modules"],
        ["Endpoints", String(architecture.endpoints.length), "HTTP surface"],
        ["Models", String(architecture.data_models.length), "ORM entities and schemas"],
        ["Pages", String(ux.pages.length), "UX routes"],
        ["Components", String(ux.components.length), "UI nodes"]
      ]
    ),
    "Files\n\n",
    docsFiles.map((file) => `- \`${file}\``).join("\n") + "\n\n",
    internalFiles.length > 0
      ? `Internal (full reference) files in \`${internalDir}/\`\n\n` +
          internalFiles.map((file) => `- \`${internalDir}/${file}\``).join("\n") +
          "\n\n"
      : "",
    "Generated Artifacts\n\n",
    "- `architecture.summary.json`\n- `architecture.diff.summary.json`\n- `drift.heatmap.json`\n- `constraints.json`\n- `drift.simulation.json`\n\n"
  ].join("");
}

function renderHumanRootReadme(architecture: ArchitectureSnapshot): string {
  return [
    "# SpecGuard Output",
    "",
    `Project: **${architecture.project.name}**`,
    "",
    "This output is split intentionally so humans and tools can read different layers without bloating context.",
    "",
    "## Human-Readable",
    "",
    "- Start in [`human/start-here.md`](./human/start-here.md)",
    "- Narrative onboarding docs for engineers",
    "- Plain-English explanation of system structure, flows, risks, and changes",
    "",
    "## Machine-Readable",
    "",
    "- Start in [`machine/docs/index.md`](./machine/docs/index.md)",
    "- Deterministic snapshots, summaries, heatmaps, constraints, and technical reference docs",
    "- Intended for tooling, IDE context, and AI guardrails",
    ""
  ].join("\n");
}

function renderHumanStartHere(architecture: ArchitectureSnapshot, ux: UxSnapshot): string {
  const { orm, schemas } = splitModelsByFramework(architecture);
  return [
    section("Start Here"),
    `This snapshot describes **${architecture.project.name}** in a human-friendly way. Read these files in order if you are new to the codebase or preparing an AI-assisted work session.`,
    "",
    "## Recommended Path",
    "",
    "- [System Overview](./system-overview.md)",
    "- [Backend Overview](./backend-overview.md)",
    "- [Frontend Overview](./frontend-overview.md)",
    "- [Data and Flows](./data-and-flows.md)",
    "- [Change Guide](./change-guide.md)",
    "",
    "## Snapshot At A Glance",
    "",
    renderTable(
      ["Area", "Count", "What it means"],
      [
        ["Backend modules", String(architecture.modules.length), "Logical backend units and service slices"],
        ["API endpoints", String(architecture.endpoints.length), "HTTP surface area"],
        ["ORM models", String(orm.length), "Persistent data entities"],
        ["Schemas", String(schemas.length), "Request/response and validation models"],
        ["Pages", String(ux.pages.length), "User-facing routes"],
        ["Components", String(ux.components.length), "Reusable UI building blocks"]
      ]
    ),
    "## Separation Of Concerns",
    "",
    "- Human-readable docs live in this `human/` directory.",
    "- Machine-readable snapshots and technical docs live under `../machine/`.",
    "- If you are feeding context to an IDE agent, prefer the `machine/` tree unless you specifically want narrative onboarding context.",
    ""
  ].join("\n");
}

function renderHumanSystemOverview(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  meta?: {
    heatmap?: DriftHeatmap | null;
  }
): string {
  const modules = architecture.modules.map((module) => module.id);
  const topHotspots = pickHeatmapEntries(meta?.heatmap, "file")
    .slice(0, 5)
    .map((entry) => `${entry.id} (${entry.score.toFixed(2)})`);

  return [
    section("System Overview"),
    `**${architecture.project.name}** is represented here as one backend workspace and one frontend workspace. The goal of this document set is to explain how the system is split up, where key responsibilities live, and where changes are likely to have wider impact.`,
    "",
    "## Boundaries",
    "",
    `Backend root: \`${architecture.project.backend_root}\``,
    "",
    `Frontend root: \`${architecture.project.frontend_root}\``,
    "",
    `Workspace root: \`${architecture.project.workspace_root}\``,
    "",
    "## Main Moving Parts",
    "",
    bullet([
      `Backend modules tracked: ${architecture.modules.length} (${summarizeList(modules, 6)})`,
      `Frontend pages tracked: ${ux.pages.length}`,
      `Runtime services tracked: ${architecture.runtime.services.length}`,
      architecture.drift.status === "stable"
        ? "Structural drift is currently stable."
        : architecture.drift.status === "critical"
          ? "Structural drift is currently in a critical state and should be treated carefully."
          : "Structural drift is present, so changes may have more blast radius."
    ]),
    "## Where Changes Are Riskier",
    "",
    topHotspots.length > 0
      ? bullet(
          topHotspots.map(
            (entry) => `${entry} — higher coupling here means changes may affect more neighbors.`
          )
        )
      : "*No major hotspots identified in this snapshot.*\n",
    "Next: [Backend Overview](./backend-overview.md)",
    ""
  ].join("\n");
}

function renderHumanBackendOverview(architecture: ArchitectureSnapshot): string {
  const backendModules = architecture.modules.filter((module) => module.type === "backend");
  const services = groupModulesForHumans(backendModules);
  const lines: string[] = [section("Backend Overview")];
  lines.push(
    "This file groups backend modules into service-like areas so you can quickly see ownership boundaries and where APIs are concentrated.\n"
  );
  for (const service of services) {
    const endpointCount = service.modules.reduce((sum, module) => sum + module.endpoints.length, 0);
    const files = service.modules.flatMap((module) => module.files);
    lines.push(`## ${service.name}\n`);
    lines.push(
      bullet([
        `Modules: ${service.modules.length}`,
        `Files: ${files.length}`,
        `Endpoints: ${endpointCount}`,
        `Layers present: ${summarizeList(Array.from(new Set(service.modules.map((module) => module.layer))), 4)}`
      ])
    );
    lines.push(
      renderTable(
        ["Module", "Layer", "Files", "Endpoints"],
        service.modules.map((module) => [
          module.id,
          module.layer,
          String(module.files.length),
          String(module.endpoints.length)
        ])
      )
    );
  }
  lines.push("Next: [Frontend Overview](./frontend-overview.md)\n");
  return lines.join("\n");
}

function renderHumanFrontendOverview(ux: UxSnapshot): string {
  const lines: string[] = [section("Frontend Overview")];
  lines.push(
    "This file describes the user-facing surface area and the main UI pieces a developer is likely to touch first.\n"
  );
  lines.push(
    renderTable(
      ["Page", "Root Component", "Components", "API Calls"],
      ux.pages.map((page) => [
        page.path,
        page.component,
        String(page.components.length),
        String(page.api_calls.length)
      ])
    )
  );
  const topComponents = ux.components
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 15);
  lines.push("## Representative Components\n");
  lines.push(
    renderTable(
      ["Component", "Kind", "File", "Import Style"],
      topComponents.map((component) => [
        component.name,
        component.kind,
        component.file,
        component.export_kind
      ])
    )
  );
  lines.push("Next: [Data and Flows](./data-and-flows.md)\n");
  return lines.join("\n");
}

function renderHumanDataAndFlows(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot
): string {
  const { orm, schemas } = splitModelsByFramework(architecture);
  const lines: string[] = [section("Data and Flows")];
  lines.push(
    "This file focuses on the data shape of the system and the most important frontend-to-backend paths.\n"
  );
  lines.push(
    renderTable(
      ["Type", "Count", "Meaning"],
      [
        ["ORM models", String(orm.length), "Database-backed persistent entities"],
        ["Schemas", String(schemas.length), "Validation and API payload structures"],
        ["Cross-stack contracts", String(architecture.cross_stack_contracts.length), "Frontend/backend API matches"],
        ["Data flows", String(architecture.data_flows.length), "Page-to-endpoint-to-model traces"]
      ]
    )
  );
  lines.push("## Representative Data Flows\n");
  lines.push(
    renderTable(
      ["Page", "Endpoint", "Models"],
      architecture.data_flows.slice(0, 12).map((flow) => [
        flow.page,
        flow.endpoint_id,
        flow.models.join(", ") || "none"
      ])
    )
  );
  lines.push("## Contract Status\n");
  const verified = architecture.cross_stack_contracts.filter(
    (contract) => contract.status === "ok" || contract.status === "mismatched"
  );
  lines.push(
    renderTable(
      ["Status", "Count", "Meaning"],
      [
        [
          "ok",
          String(verified.filter((contract) => contract.status === "ok").length),
          "Frontend fields line up with backend expectations"
        ],
        [
          "mismatched",
          String(verified.filter((contract) => contract.status === "mismatched").length),
          "A frontend/backend contract likely needs attention"
        ],
        [
          "unverified",
          String(architecture.cross_stack_contracts.length - verified.length),
          "SpecGuard could not confidently infer enough fields yet"
        ]
      ]
    )
  );
  lines.push("Next: [Change Guide](./change-guide.md)\n");
  return lines.join("\n");
}

function renderHumanChangeGuide(
  architecture: ArchitectureSnapshot,
  meta?: {
    diff?: ArchitectureDiffSummary | null;
    heatmap?: DriftHeatmap | null;
  }
): string {
  const lines: string[] = [section("Change Guide")];
  lines.push(
    "Use this file before making code changes. It highlights where the architecture is more fragile and what changed since the previous snapshot.\n"
  );
  lines.push("## Structural Risk\n");
  lines.push(
    bullet([
      `Current drift status: ${architecture.drift.status}`,
      `Current delta: ${architecture.drift.delta.toFixed(4)}`,
      architecture.analysis.circular_dependencies.length > 0
        ? `Circular dependencies detected: ${architecture.analysis.circular_dependencies.length}`
        : "No circular dependencies detected",
      architecture.analysis.unused_endpoints.length > 0
        ? `Unused endpoints: ${architecture.analysis.unused_endpoints.length}`
        : "No unused endpoints detected"
    ])
  );
  lines.push("## High-Coupling Files\n");
  const hotspots = pickHeatmapEntries(meta?.heatmap, "file").slice(0, 10);
  lines.push(
    renderTable(
      ["File", "Coupling Score", "Meaning"],
      hotspots.map((entry) => [
        entry.id,
        entry.score.toFixed(3),
        "Higher scores usually mean broader blast radius when edited"
      ])
    )
  );
  lines.push("## Since The Previous Snapshot\n");
  if (!meta?.diff) {
    lines.push("No previous snapshot was available, so this run cannot summarize structural changes yet.\n");
  } else if (!meta.diff.structural_change) {
    lines.push("No structural changes were detected since the previous snapshot.\n");
  } else {
    const deltas = Object.entries(meta.diff.counts_delta)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => `${key}: ${value > 0 ? `+${value}` : value}`);
    lines.push(bullet(deltas.length > 0 ? deltas : ["Structural changes detected"]));
  }
  lines.push("Return to [Start Here](./start-here.md)\n");
  return lines.join("\n");
}

function groupModulesForHumans(modules: ArchitectureSnapshot["modules"]): Array<{
  name: string;
  modules: ArchitectureSnapshot["modules"];
}> {
  const grouped = new Map<string, ArchitectureSnapshot["modules"]>();
  for (const module of modules) {
    const parts = module.path.split("/").filter(Boolean);
    const key =
      parts.find((part) => part.startsWith("service-")) ??
      parts.find((part) => part !== "backend" && part !== "src") ??
      module.id;
    const entry = grouped.get(key) ?? [];
    entry.push(module);
    grouped.set(key, entry);
  }

  return Array.from(grouped.entries())
    .map(([name, groupedModules]) => ({
      name,
      modules: groupedModules.sort((a, b) => a.id.localeCompare(b.id))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renderExecutiveSummary(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  meta?: {
    summary?: ArchitectureSummary | null;
    diff?: ArchitectureDiffSummary | null;
    heatmap?: DriftHeatmap | null;
    docsMode?: DocsMode;
    internalDir?: string;
  }
): string {
  const summary = meta?.summary ?? null;
  const diff = meta?.diff ?? null;
  const heatmap = meta?.heatmap ?? null;
  const docsMode = meta?.docsMode ?? "lean";
  const internalDir = meta?.internalDir ?? "internal";
  const generatedAt = summary?.generated_at ?? new Date().toISOString();
  const modules = architecture.modules.map((module) => module.id);
  const moduleNames = summarizeList(modules, 6);
  const entrypoints = summarizeList(architecture.project.entrypoints ?? [], 4);
  const cycleCount = architecture.analysis.circular_dependencies.length;
  const orphanModules = architecture.analysis.orphan_modules.length;
  const orphanFiles = architecture.analysis.orphan_files.length;
  const unusedEndpoints = architecture.analysis.unused_endpoints.length;
  const unusedCalls = architecture.analysis.frontend_unused_api_calls.length;
  const duplicateGroups = architecture.analysis.duplicate_functions.length;
  const similarGroups = architecture.analysis.similar_functions.length;
  const untestedFiles = architecture.analysis.test_coverage.untested_source_files.length;
  const topFunctions =
    pickHeatmapEntries(heatmap, "function")
      .slice(0, 5)
      .map((entry) => `${entry.id} (${entry.score.toFixed(2)})`);

  const driftStatus =
    architecture.drift.status === "stable"
      ? "Stable"
      : architecture.drift.status === "critical"
      ? "Needs Attention"
      : "Drift Detected";

  const summaryLines: string[] = [];
  summaryLines.push(section("Product Summary"));
  summaryLines.push(`Project: **${architecture.project.name}**\n\n`);
  summaryLines.push(`Snapshot date: **${formatTimestamp(generatedAt)}**\n\n`);
  summaryLines.push(
    "SpecGuard produces living, machine‑verified documentation for your codebase so teams can align on architecture, detect drift, and share an accurate system spec without manual doc maintenance.\n\n"
  );

  summaryLines.push("## Vision\n\n");
  summaryLines.push(
    "Enable teams to treat architecture as a first‑class, continuously verifiable product artifact—" +
      "not a static diagram or an outdated wiki.\n\n"
  );

  summaryLines.push("## Goals\n\n");
  summaryLines.push(
    bullet([
      "Capture the current system structure (modules, APIs, data models, UI routes).",
      "Expose architectural drift signals early (cycles, unused endpoints, duplicates).",
      "Provide fast, shareable documentation for engineers, PMs, and tech writers.",
      "Reduce exploration time for AI‑assisted development sessions."
    ])
  );

  summaryLines.push("## What This Snapshot Covers\n\n");
  summaryLines.push(
    bullet([
      `Backend root: \`${architecture.project.backend_root}\``,
      `Frontend root: \`${architecture.project.frontend_root}\``,
      `Entrypoints: ${entrypoints}`
    ])
  );

  summaryLines.push("## System Scale (Current State)\n\n");
  summaryLines.push(
    renderTable(
      ["Area", "Count", "Notes"],
      [
        ["Backend modules", String(architecture.modules.length), moduleNames],
        ["API endpoints", String(architecture.endpoints.length), "HTTP surface area"],
        ["Data models", String(architecture.data_models.length), "Database entities"],
        ["UI pages", String(ux.pages.length), "User-facing routes"],
        ["UI components", String(ux.components.length), "Reusable UI elements"],
        ["Background tasks", String(architecture.tasks.length), "Async or scheduled jobs"],
        ["Runtime services", String(architecture.runtime.services.length), "Docker/services"]
      ]
    )
  );

  summaryLines.push("## Architecture Overview\n\n");
  summaryLines.push(
    bullet([
      `Primary backend modules: ${moduleNames}`,
      `Module dependencies captured with a directed graph (${architecture.dependencies.module_graph.length} edges).`,
      cycleCount > 0
        ? `Circular dependencies detected: ${cycleCount}`
        : "No circular dependencies detected"
    ])
  );

  summaryLines.push("## API & Service Surface\n\n");
  summaryLines.push(
    bullet([
      `Endpoints cataloged: ${architecture.endpoints.length}`,
      "Request/response schemas tracked per endpoint when available.",
      "Endpoint‑to‑model usage captured for database impact mapping."
    ])
  );

  summaryLines.push("## Data Layer\n\n");
  summaryLines.push(
    bullet([
      `Models detected: ${architecture.data_models.length}`,
      docsMode === "full"
        ? "Field‑level details (types, nullable, PK/FK, defaults) are captured in the data dictionary."
        : "Field‑level details (types, nullable, PK/FK, defaults) are available in the full data dictionary (internal).",
      "Enums and constants are cataloged for shared domain vocabulary."
    ])
  );

  summaryLines.push("## UX Layer\n\n");
  summaryLines.push(
    bullet([
      `Pages detected: ${ux.pages.length}`,
      `Components detected: ${ux.components.length}`,
      "Component graphs include API calls, state, and navigation signals."
    ])
  );

  summaryLines.push("## Quality & Drift Signals\n\n");
  summaryLines.push(
    bullet([
      `Overall structural status: **${driftStatus}**`,
      orphanModules > 0 ? `Orphan modules: ${orphanModules}` : "No orphan modules detected",
      orphanFiles > 0 ? `Orphan files: ${orphanFiles}` : "No orphan files detected",
      unusedEndpoints > 0
        ? `Backend endpoints without a known frontend caller: ${unusedEndpoints}`
        : "Every backend endpoint has a known frontend caller",
      unusedCalls > 0
        ? `Frontend API calls without a known backend endpoint: ${unusedCalls}`
        : "No unmatched frontend API calls detected",
      duplicateGroups > 0
        ? `Exact duplicate function groups detected: ${duplicateGroups}`
        : "No exact duplicate function groups detected",
      similarGroups > 0
        ? `Similar function groups detected: ${similarGroups}`
        : "No similar function groups detected",
      untestedFiles > 0
        ? `Untested source files: ${untestedFiles}`
        : "All source files have at least one mapped test",
      topFunctions.length > 0
        ? `Top drift hotspots (functions): ${summarizeList(topFunctions, 5)}`
        : "No function-level drift hotspots identified"
    ])
  );

  summaryLines.push("## Changes Since Last Snapshot\n\n");
  if (!diff) {
    summaryLines.push("No previous snapshot available for comparison.\n\n");
  } else if (!diff.structural_change) {
    summaryLines.push("No structural changes detected since the previous snapshot.\n\n");
  } else {
    const deltas = Object.entries(diff.counts_delta)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => `${key}: ${value > 0 ? `+${value}` : value}`);
    summaryLines.push(
      bullet([
        diff.shape_equivalent
          ? "Changes are additive (shape‑equivalent)."
          : "Changes include structural refactors.",
        deltas.length > 0 ? `Count changes: ${summarizeList(deltas, 6)}` : "Count changes detected"
      ])
    );
  }

  summaryLines.push("## Roadmap (Suggested)\n\n");
  summaryLines.push(
    bullet([
      "Track drift over time with history charts and alerts.",
      "Enforce architectural capacity budgets for critical layers.",
      "Deepen UI prop & state understanding for richer UX specs.",
      "Add snapshot‑to‑snapshot change narratives for PM updates."
    ])
  );

  summaryLines.push("## Documentation Outputs\n\n");
  summaryLines.push(
    bullet([
      "`summary.md` provides this product‑spec overview.",
      "`stakeholder.md` is the one‑page executive view.",
      "`hld.md` provides the system block diagram, drift summary, and module dependencies.",
      "`integration.md` groups APIs by domain with schemas and service links.",
      "`ux.md` captures UI pages, components, props, API calls, and interaction maps.",
      "`data.md` lists data models and where they live.",
      "`diff.md` summarizes what changed between snapshots.",
      "`runtime.md` captures services, ports, and tasks."
    ])
  );
  if (docsMode === "full") {
    summaryLines.push(
      `Full reference docs (architecture dump, field‑level data dictionary, interaction maps, and tests) are available in \`${internalDir}/\`.\n\n`
    );
  }

  return summaryLines.join("");
}

export function renderStakeholderSummary(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  meta?: {
    summary?: ArchitectureSummary | null;
    diff?: ArchitectureDiffSummary | null;
    docsMode?: DocsMode;
    internalDir?: string;
  }
): string {
  const summary = meta?.summary ?? null;
  const diff = meta?.diff ?? null;
  const docsMode = meta?.docsMode ?? "lean";
  const internalDir = meta?.internalDir ?? "internal";
  const generatedAt = summary?.generated_at ?? new Date().toISOString();

  const cycleCount = architecture.analysis.circular_dependencies.length;
  const unusedEndpoints = architecture.analysis.unused_endpoints.length;
  const untestedFiles = architecture.analysis.test_coverage.untested_source_files.length;
  const driftStatus =
    architecture.drift.status === "stable"
      ? "Stable"
      : architecture.drift.status === "critical"
      ? "Needs Attention"
      : "Drift Detected";

  const lines: string[] = [];
  lines.push(section("Stakeholder Summary"));
  lines.push(`Project: **${architecture.project.name}**\n\n`);
  lines.push(`Snapshot date: **${formatTimestamp(generatedAt)}**\n\n`);
  lines.push(
    "A one‑page overview for non‑technical stakeholders highlighting scale, health, and changes.\n\n"
  );

  lines.push(
    renderTable(
      ["Metric", "Count", "Notes"],
      [
        ["Modules", String(architecture.modules.length), "Backend units"],
        ["Endpoints", String(architecture.endpoints.length), "API surface"],
        ["Models", String(architecture.data_models.length), "Data entities"],
        ["UI Pages", String(ux.pages.length), "User routes"],
        ["UI Components", String(ux.components.length), "Reusable UI parts"]
      ]
    )
  );

  lines.push("## Health Snapshot\n\n");
  lines.push(
    bullet([
      `Architecture status: **${driftStatus}**`,
      cycleCount > 0
        ? `Circular dependencies detected: ${cycleCount}`
        : "No circular dependencies detected",
      unusedEndpoints > 0
        ? `Unused backend endpoints: ${unusedEndpoints}`
        : "All backend endpoints are used",
      untestedFiles > 0
        ? `Untested source files: ${untestedFiles}`
        : "All source files have mapped tests"
    ])
  );

  lines.push("## What Changed Since Last Snapshot\n\n");
  if (!diff) {
    lines.push("No previous snapshot available for comparison.\n\n");
  } else if (!diff.structural_change) {
    lines.push("No structural changes detected since the previous snapshot.\n\n");
  } else {
    const deltas = Object.entries(diff.counts_delta)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => `${key}: ${value > 0 ? `+${value}` : value}`);
    lines.push(
      bullet([
        diff.shape_equivalent
          ? "Changes are additive (shape‑equivalent)."
          : "Changes include structural refactors.",
        deltas.length > 0 ? `Count changes: ${summarizeList(deltas, 6)}` : "Count changes detected"
      ])
    );
  }

  lines.push("## Where To Look Next\n\n");
  lines.push(
    bullet([
      "`summary.md` for the product-level overview",
      "`hld.md` for system overview",
      "`integration.md` for domain-level API summaries",
      "`ux.md` for UI interactions",
      "`data.md` for model inventory"
    ])
  );
  if (docsMode === "full") {
    lines.push(`\nFull reference docs are available in \`${internalDir}/\`.\n\n`);
  }

  return lines.join("");
}

function renderArchitecture(
  snapshot: ArchitectureSnapshot,
  meta?: {
    summary?: ArchitectureSummary | null;
    diff?: ArchitectureDiffSummary | null;
    heatmap?: DriftHeatmap | null;
  }
): string {
  const lines: string[] = [];
  lines.push(section("Architecture Snapshot"));
  lines.push(`Backend: \`${snapshot.project.backend_root}\`\n\n`);
  lines.push(`Frontend: \`${snapshot.project.frontend_root}\`\n\n`);

  lines.push("## Drift Summary\n\n");
  lines.push(
    renderTable(
      ["Status", "Graph", "D_t", "K_t", "Delta"],
      [[
        snapshot.drift.status,
        snapshot.drift.graph_level,
        snapshot.drift.D_t.toFixed(4),
        snapshot.drift.K_t.toFixed(4),
        snapshot.drift.delta.toFixed(4)
      ]]
    )
  );
  lines.push(
    renderTable(
      ["Entropy", "Cross-Layer", "Cycle Density", "Modularity Gap"],
      [[
        snapshot.drift.metrics.entropy.toFixed(4),
        snapshot.drift.metrics.cross_layer_ratio.toFixed(4),
        snapshot.drift.metrics.cycle_density.toFixed(4),
        snapshot.drift.metrics.modularity_gap.toFixed(4)
      ]]
    )
  );

  lines.push("## Multi-Scale Drift\n\n");
  lines.push(
    renderTable(
      ["Level", "Status", "Delta", "D_t", "K_t", "Edges", "Nodes"],
      snapshot.drift.scales.map((scale) => [
        scale.level,
        scale.status,
        scale.delta.toFixed(4),
        scale.D_t.toFixed(4),
        scale.K_t.toFixed(4),
        String(scale.details.edges),
        String(scale.details.nodes)
      ])
    )
  );

  lines.push("## Architecture Fingerprint\n\n");
  if (meta?.summary) {
    lines.push(`Fingerprint: \`${meta.summary.fingerprint}\`\n\n`);
    lines.push(`Shape Fingerprint: \`${meta.summary.shape_fingerprint ?? "n/a"}\`\n\n`);
    lines.push(
      "Legend: shape fingerprint changes indicate structural refactors (dependency pattern shifts), " +
        "while fingerprint changes with the same shape indicate additive changes.\n\n"
    );
    lines.push(
      renderTable(
        ["Modules", "Edges", "Files", "Endpoints", "Models", "Pages", "Components"],
        [[
          String(meta.summary.counts.modules),
          String(meta.summary.counts.module_edges),
          String(meta.summary.counts.files),
          String(meta.summary.counts.endpoints),
          String(meta.summary.counts.models),
          String(meta.summary.counts.pages),
          String(meta.summary.counts.components)
        ]]
      )
    );
  } else {
    lines.push("*Not available*\n\n");
  }

  lines.push("## Compressed Diff Summary\n\n");
  if (meta?.diff) {
    lines.push(
      `Structural change: **${meta.diff.structural_change ? "yes" : "no"}**  \n` +
        `Shape equivalent: **${meta.diff.shape_equivalent ? "yes" : "no"}**\n\n`
    );
    const addedModules = meta.diff.added.modules.slice(0, 10);
    const removedModules = meta.diff.removed.modules.slice(0, 10);
    lines.push(
      renderTable(
        ["Field", "Delta"],
        Object.entries(meta.diff.counts_delta).map(([field, delta]) => [field, String(delta)])
      )
    );
    lines.push("### Added (Top 10)\n\n");
    lines.push(bullet(addedModules.length ? addedModules : ["None"]));
    lines.push("\n### Removed (Top 10)\n\n");
    lines.push(bullet(removedModules.length ? removedModules : ["None"]));
  } else {
    lines.push("*No previous summary available*\n\n");
  }

  lines.push("## Drift Heatmap (Files)\n\n");
  const fileHeatmap = pickHeatmapEntries(meta?.heatmap, "file");
  lines.push(renderHeatmapTable("File", fileHeatmap, 10));

  lines.push("## Drift Heatmap (Functions)\n\n");
  const functionHeatmap = pickHeatmapEntries(meta?.heatmap, "function");
  lines.push(renderHeatmapTable("Function", functionHeatmap, 10));

  lines.push("## Duplication Signals\n\n");
  const duplicates = snapshot.analysis.duplicate_functions ?? [];
  if (duplicates.length === 0) {
    lines.push("*None*\n\n");
  } else {
    lines.push(
      renderTable(
        ["Hash", "Count", "Size", "Examples"],
        duplicates.slice(0, 10).map((group) => [
          group.hash.slice(0, 8),
          String(group.functions.length),
          String(group.size),
          group.functions
            .slice(0, 3)
            .map((fn) => `${path.basename(fn.file)}#${fn.name}`)
            .join(", ") || "n/a"
        ])
      )
    );
  }

  const similar = snapshot.analysis.similar_functions ?? [];
  if (similar.length > 0) {
    lines.push(
      renderTable(
        ["Similarity", "Basis", "Function A", "Function B"],
        similar.slice(0, 10).map((pair) => [
          pair.similarity.toFixed(2),
          pair.basis,
          `${path.basename(pair.functions[0]?.file ?? "")}#${pair.functions[0]?.name ?? ""}`,
          `${path.basename(pair.functions[1]?.file ?? "")}#${pair.functions[1]?.name ?? ""}`
        ])
      )
    );
  }

  const capacityHasBudget =
    snapshot.drift.capacity.layers.some((layer) => layer.status !== "unbudgeted") ||
    (snapshot.drift.capacity.total && snapshot.drift.capacity.total.status !== "unbudgeted");
  lines.push("## Capacity Summary\n\n");
  if (!capacityHasBudget) {
    lines.push("*Capacity budgets not configured*\n\n");
  } else {
    if (snapshot.drift.capacity.layers.length > 0) {
      lines.push(
        renderTable(
          ["Layer", "Budget", "Used", "Ratio", "Status", "Cross-Layer Out"],
          snapshot.drift.capacity.layers.map((layer) => [
            layer.layer,
            layer.budget !== undefined ? String(layer.budget) : "n/a",
            String(layer.edges),
            layer.ratio !== undefined ? layer.ratio.toFixed(2) : "n/a",
            layer.status,
            String(layer.cross_layer_out)
          ])
        )
      );
    }
    if (snapshot.drift.capacity.total && snapshot.drift.capacity.total.budget !== undefined) {
      lines.push(
        renderTable(
          ["Total Budget", "Used", "Ratio", "Status"],
          [[
            String(snapshot.drift.capacity.total.budget),
            String(snapshot.drift.capacity.total.used),
            snapshot.drift.capacity.total.ratio !== undefined
              ? snapshot.drift.capacity.total.ratio.toFixed(2)
              : "n/a",
            snapshot.drift.capacity.total.status
          ]]
        )
      );
    }
  }

  lines.push("## Growth Summary\n\n");
  lines.push(
    renderTable(
      ["Edges/Hour", "Edges/Day", "Trend", "Status", "Window"],
      [[
        snapshot.drift.growth.edges_per_hour.toFixed(2),
        snapshot.drift.growth.edges_per_day.toFixed(2),
        snapshot.drift.growth.trend,
        snapshot.drift.growth.status,
        snapshot.drift.growth.window.from && snapshot.drift.growth.window.to
          ? `${snapshot.drift.growth.window.from} → ${snapshot.drift.growth.window.to}`
          : "n/a"
      ]]
    )
  );

  lines.push("## Modules\n\n");
  lines.push(
    renderTable(
      ["Module", "Layer", "Files", "Imports"],
      snapshot.modules.map((module) => [
        module.id,
        module.layer,
        String(module.files.length),
        module.imports.join(", ") || "none"
      ])
    )
  );

  lines.push("## Endpoints\n\n");
  lines.push(
    renderTable(
      ["Method", "Path", "Handler", "Module", "Request Schema", "Response Schema", "AI Operations"],
      snapshot.endpoints.map((endpoint) => [
        endpoint.method,
        endpoint.path,
        endpoint.handler,
        endpoint.module,
        endpoint.request_schema || "none",
        endpoint.response_schema || "none",
        formatAiOperations(endpoint.ai_operations)
      ])
    )
  );

  const endpointsWithServices = snapshot.endpoints.filter(
    (endpoint) => endpoint.service_calls && endpoint.service_calls.length > 0
  );
  lines.push("## Endpoint Service Dependencies\n\n");
  if (endpointsWithServices.length === 0) {
    lines.push("*None*\n\n");
  } else {
    lines.push(
      renderTable(
        ["Endpoint", "Services"],
        endpointsWithServices.map((endpoint) => [
          `${endpoint.method} ${endpoint.path}`,
          endpoint.service_calls.join(", ")
        ])
      )
    );
  }

  lines.push("## Data Models\n\n");
  lines.push(
    renderTable(
      ["Name", "Framework", "File", "Fields"],
      snapshot.data_models.map((model) => [
        model.name,
        model.framework,
        model.file,
        model.fields.join(", ") || "none"
      ])
    )
  );

  lines.push("## Endpoint → Model Usage\n\n");
  lines.push(
    renderTable(
      ["Endpoint", "Models"],
      snapshot.endpoint_model_usage.map((usage) => [
        usage.endpoint,
        usage.models
          .map((model) => `${model.name} (${model.access})`)
          .join(", ") || "none"
      ])
    )
  );

  lines.push("## Tasks\n\n");
  lines.push(
    renderTable(
      ["Name", "Kind", "File", "Queue"],
      snapshot.tasks.map((task) => [
        task.name,
        task.kind,
        task.file,
        task.queue ?? "n/a"
      ])
    )
  );

  lines.push("## Runtime\n\n");
  lines.push("### Dockerfiles\n\n");
  lines.push(bullet(snapshot.runtime.dockerfiles));
  lines.push("\n### Services\n\n");
  lines.push(
    renderTable(
      ["Service", "Image/Build", "Ports", "Depends On"],
      snapshot.runtime.services.map((service) => [
        service.name,
        service.image ?? service.build ?? "n/a",
        (service.ports ?? []).join(", ") || "n/a",
        (service.depends_on ?? []).join(", ") || "n/a"
      ])
    )
  );

  if (snapshot.analysis.unused_endpoints.length > 0) {
    lines.push("## Unused Endpoints (Dead Code)\n\n");
    lines.push(
      "The following backend endpoints are not called by any known frontend code:\n\n"
    );
    lines.push(bullet(snapshot.analysis.unused_endpoints));
    lines.push("\n");
  }

  if (snapshot.analysis.frontend_unused_api_calls && snapshot.analysis.frontend_unused_api_calls.length > 0) {
    lines.push("## Orphaned Frontend API Calls\n\n");
    lines.push(
      "The following API calls made by the frontend do not have a matching backend endpoint:\n\n"
    );
    lines.push(bullet(snapshot.analysis.frontend_unused_api_calls));
    lines.push("\n");
  }

  lines.push("## Backend Interaction Map\n\n");
  const backendLines: string[] = ["flowchart LR\n"];
  const endpointUsage = new Map(
    snapshot.endpoint_model_usage.map((usage) => [usage.endpoint_id, usage.models])
  );
  const apiNodes: string[] = [];
  const fnNodes: string[] = [];
  const svcNodes: string[] = [];
  const dbNodes: string[] = [];
  const edgeLines: string[] = [];
  const seenApiNodes = new Set<string>();
  const seenFnNodes = new Set<string>();
  const seenSvcNodes = new Set<string>();
  const seenDbNodes = new Set<string>();
  const addApiNode = (id: string, label: string): void => {
    if (seenApiNodes.has(id)) {
      return;
    }
    seenApiNodes.add(id);
    apiNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
  };
  const addFnNode = (id: string, label: string): void => {
    if (seenFnNodes.has(id)) {
      return;
    }
    seenFnNodes.add(id);
    fnNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
  };
  const addDbNode = (id: string, label: string): void => {
    if (seenDbNodes.has(id)) {
      return;
    }
    seenDbNodes.add(id);
    dbNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
  };
  const addSvcNode = (id: string, label: string): void => {
    if (seenSvcNodes.has(id)) {
      return;
    }
    seenSvcNodes.add(id);
    svcNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
  };

  for (const endpoint of snapshot.endpoints) {
    const apiId = `api_${mermaidId(endpoint.id)}`;
    const handlerKey = `${endpoint.file}#${endpoint.handler}`;
    const handlerId = `fn_${mermaidId(handlerKey)}`;
    addApiNode(apiId, `API ${endpoint.method} ${endpoint.path}`);
    addFnNode(handlerId, `Fn ${endpoint.handler}`);
    edgeLines.push(`  ${apiId} --> ${handlerId}\n`);

    const models = endpointUsage.get(endpoint.id) ?? [];
    for (const model of models) {
      const modelId = `db_${mermaidId(model.name)}`;
      addDbNode(modelId, `DB ${model.name}`);
      edgeLines.push(`  ${handlerId} -- ${accessLabel(model.access)} --> ${modelId}\n`);
    }

    if (endpoint.service_calls && endpoint.service_calls.length > 0) {
      for (const svc of endpoint.service_calls) {
        const svcId = `svc_${mermaidId(svc)}`;
        addSvcNode(svcId, `Svc ${svc}`);
        edgeLines.push(`  ${handlerId} --> ${svcId}\n`);
      }
    }
  }

  backendLines.push('  subgraph API["API"]\n', ...apiNodes, "  end\n");
  backendLines.push('  subgraph Functions["Functions"]\n', ...fnNodes, "  end\n");
  backendLines.push('  subgraph Services["Services"]\n', ...svcNodes, "  end\n");
  backendLines.push('  subgraph Data["Data"]\n', ...dbNodes, "  end\n");
  backendLines.push(...edgeLines);
  lines.push(renderMermaid(backendLines));

  lines.push("## Module Interaction Maps\n\n");
  const endpointsByModule = new Map<string, typeof snapshot.endpoints>();
  for (const endpoint of snapshot.endpoints) {
    const list = endpointsByModule.get(endpoint.module) ?? [];
    list.push(endpoint);
    endpointsByModule.set(endpoint.module, list);
  }

  for (const module of snapshot.modules) {
    const moduleEndpoints = endpointsByModule.get(module.id) ?? [];
    lines.push(`### ${module.id}\n\n`);
    if (moduleEndpoints.length === 0) {
      lines.push("*None*\n\n");
      continue;
    }
    const moduleLines: string[] = ["flowchart LR\n"];
    const moduleApiNodes: string[] = [];
    const moduleFnNodes: string[] = [];
    const moduleSvcNodes: string[] = [];
    const moduleDbNodes: string[] = [];
    const moduleEdges: string[] = [];
    const seenModuleApiNodes = new Set<string>();
    const seenModuleFnNodes = new Set<string>();
    const seenModuleSvcNodes = new Set<string>();
    const seenModuleDbNodes = new Set<string>();
    const addModuleApi = (id: string, label: string): void => {
      if (seenModuleApiNodes.has(id)) {
        return;
      }
      seenModuleApiNodes.add(id);
      moduleApiNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    const addModuleFn = (id: string, label: string): void => {
      if (seenModuleFnNodes.has(id)) {
        return;
      }
      seenModuleFnNodes.add(id);
      moduleFnNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    const addModuleDb = (id: string, label: string): void => {
      if (seenModuleDbNodes.has(id)) {
        return;
      }
      seenModuleDbNodes.add(id);
      moduleDbNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    const addModuleSvc = (id: string, label: string): void => {
      if (seenModuleSvcNodes.has(id)) {
        return;
      }
      seenModuleSvcNodes.add(id);
      moduleSvcNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    for (const endpoint of moduleEndpoints) {
      const apiId = `api_${mermaidId(endpoint.id)}`;
      const handlerKey = `${endpoint.file}#${endpoint.handler}`;
      const handlerId = `fn_${mermaidId(handlerKey)}`;
      addModuleApi(apiId, `API ${endpoint.method} ${endpoint.path}`);
      addModuleFn(handlerId, `Fn ${endpoint.handler}`);
      moduleEdges.push(`  ${apiId} --> ${handlerId}\n`);
      const models = endpointUsage.get(endpoint.id) ?? [];
      for (const model of models) {
        const modelId = `db_${mermaidId(model.name)}`;
        addModuleDb(modelId, `DB ${model.name}`);
        moduleEdges.push(`  ${handlerId} -- ${accessLabel(model.access)} --> ${modelId}\n`);
      }
      if (endpoint.service_calls && endpoint.service_calls.length > 0) {
        for (const svc of endpoint.service_calls) {
          const svcId = `svc_${mermaidId(svc)}`;
          addModuleSvc(svcId, `Svc ${svc}`);
          moduleEdges.push(`  ${handlerId} --> ${svcId}\n`);
        }
      }
    }
    moduleLines.push('  subgraph API["API"]\n', ...moduleApiNodes, "  end\n");
    moduleLines.push('  subgraph Functions["Functions"]\n', ...moduleFnNodes, "  end\n");
    moduleLines.push('  subgraph Services["Services"]\n', ...moduleSvcNodes, "  end\n");
    moduleLines.push('  subgraph Data["Data"]\n', ...moduleDbNodes, "  end\n");
    moduleLines.push(...moduleEdges);
    lines.push(renderMermaid(moduleLines));
  }

  return lines.join("");
}

function renderUx(snapshot: UxSnapshot): string {
  const lines: string[] = [];
  lines.push(section("UX Snapshot"));

  lines.push("## Components\n\n");
  lines.push(
    renderTable(
      ["Component", "File", "Props", "Import Style"],
      snapshot.components.map((component) => [
        component.name,
        component.file,
        formatComponentProps(component.props),
        component.export_kind
      ])
    )
  );

  lines.push("## Component Graph\n\n");
  const graphLines: string[] = ["flowchart LR\n"];
  for (const edge of snapshot.component_graph) {
    const from = mermaidId(edge.from);
    const to = mermaidId(edge.to);
    graphLines.push(`  ${from} --> ${to}\n`);
  }
  lines.push(renderMermaid(graphLines));

  lines.push("## Pages\n\n");
  for (const page of snapshot.pages) {
    lines.push(`### ${page.path}\n\n`);
    lines.push(`Component: \`${page.component}\`\n\n`);
    lines.push("Components (Direct)\n\n");
    lines.push(bullet(page.components_direct));
    lines.push("\nComponents (Descendants)\n\n");
    lines.push(bullet(page.components_descendants));
    lines.push("\nLocal State\n\n");
    lines.push(bullet(page.local_state_variables));
    lines.push("\nAPI Calls\n\n");
    lines.push(bullet(page.api_calls));
    lines.push("\nComponent API Calls\n\n");
    lines.push(
      renderTable(
        ["Component", "API Calls"],
        page.component_api_calls.map((entry) => [
          entry.component,
          entry.api_calls.join(", ") || "none"
        ])
      )
    );
    lines.push("\nComponent State\n\n");
    lines.push(
      renderTable(
        ["Component", "State Variables"],
        page.component_state_variables.map((entry) => [
          entry.component,
          entry.local_state_variables.join(", ") || "none"
        ])
      )
    );
    lines.push("\nNavigation\n\n");
    lines.push(bullet(page.possible_navigation));
    lines.push("\n");
  }

  lines.push("## Page Interaction Maps\n\n");
  const componentNames = new Map(snapshot.components.map((component) => [component.id, component.name]));

  for (const page of snapshot.pages) {
    const pageNodes: string[] = [];
    const componentNodes: string[] = [];
    const apiNodes: string[] = [];
    const stateNodes: string[] = [];
    const actionNodes: string[] = [];
    const uiEdges: string[] = [];
    const seenUiNodes = new Set<string>();
    const addUiNode = (
      id: string,
      label: string,
      category: "page" | "component" | "api" | "state" | "action"
    ): void => {
      if (seenUiNodes.has(id)) {
        return;
      }
      seenUiNodes.add(id);
      const entry = `    ${id}["${mermaidLabel(label)}"]\n`;
      if (category === "page") {
        pageNodes.push(entry);
      } else if (category === "api") {
        apiNodes.push(entry);
      } else if (category === "state") {
        stateNodes.push(entry);
      } else if (category === "action") {
        actionNodes.push(entry);
      } else {
        componentNodes.push(entry);
      }
    };

    const pageId = `page_${mermaidId(page.path)}`;
    addUiNode(pageId, `Page ${page.path}`, "page");

    const componentScope = new Set<string>([
      page.component_id,
      ...page.components_direct_ids,
      ...page.components_descendants_ids
    ]);

    for (const componentId of page.components_direct_ids) {
      const componentName = componentNames.get(componentId) ?? componentId;
      const nodeId = `comp_${mermaidId(componentId)}`;
      addUiNode(nodeId, `Component ${componentName}`, "component");
      uiEdges.push(`  ${pageId} --> ${nodeId}\n`);
    }
    for (const entry of page.component_api_calls) {
      const componentId = entry.component_id;
      const componentName = entry.component;
      if (componentId && !componentScope.has(componentId)) {
        componentScope.add(componentId);
      }
      const componentNode = `comp_${mermaidId(componentId)}`;
      addUiNode(componentNode, `Component ${componentName}`, "component");
      for (const call of entry.api_calls) {
        const apiNode = `api_${mermaidId(call)}`;
        addUiNode(apiNode, `API ${call}`, "api");
        uiEdges.push(`  ${componentNode} --> ${apiNode}\n`);
      }
    }
    for (const entry of page.component_state_variables) {
      const componentId = entry.component_id;
      const componentName = entry.component;
      if (componentId && !componentScope.has(componentId)) {
        componentScope.add(componentId);
      }
      const componentNode = `comp_${mermaidId(componentId)}`;
      addUiNode(componentNode, `Component ${componentName}`, "component");
      for (const state of entry.local_state_variables) {
        const stateNode = `state_${mermaidId(componentId)}_${mermaidId(state)}`;
        addUiNode(stateNode, `State ${state}`, "state");
        uiEdges.push(`  ${componentNode} --> ${stateNode}\n`);
      }
    }
    for (const target of page.possible_navigation) {
      const navNode = `nav_${mermaidId(target)}`;
      addUiNode(navNode, `Action ${target}`, "action");
      uiEdges.push(`  ${pageId} --> ${navNode}\n`);
    }

    for (const edge of snapshot.component_graph) {
      if (!componentScope.has(edge.from) && !componentScope.has(edge.to)) {
        continue;
      }
      const fromName = componentNames.get(edge.from) ?? edge.from;
      const toName = componentNames.get(edge.to) ?? edge.to;
      const fromId = `comp_${mermaidId(edge.from)}`;
      const toId = `comp_${mermaidId(edge.to)}`;
      addUiNode(fromId, `Component ${fromName}`, "component");
      addUiNode(toId, `Component ${toName}`, "component");
      uiEdges.push(`  ${fromId} --> ${toId}\n`);
    }

    lines.push(`### ${page.path} Interaction Map\n\n`);
    const mapLines: string[] = ["flowchart LR\n"];
    mapLines.push('  subgraph Page["Page"]\n', ...pageNodes, "  end\n");
    mapLines.push('  subgraph Components["Components"]\n', ...componentNodes, "  end\n");
    mapLines.push('  subgraph API["API"]\n', ...apiNodes, "  end\n");
    mapLines.push('  subgraph State["State"]\n', ...stateNodes, "  end\n");
    mapLines.push('  subgraph Actions["Actions"]\n', ...actionNodes, "  end\n");
    mapLines.push(...uiEdges);
    lines.push(renderMermaid(mapLines));
  }

  return lines.join("");
}

type DriftHistoryEntry = {
  timestamp: string;
  D_t: number;
  K_t: number;
  delta: number;
  status: string;
  graph_level?: string;
};

function renderHld(
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  driftHistory: DriftHistoryEntry[],
  meta?: {
    summary?: ArchitectureSummary | null;
    diff?: ArchitectureDiffSummary | null;
    heatmap?: DriftHeatmap | null;
  }
): string {
  const lines: string[] = [];
  const { orm, schemas } = splitModelsByFramework(architecture);
  lines.push(section("High-Level Design"));
  lines.push("## System Block Diagram\n\n");

  const blockLines: string[] = [
    "flowchart TB\n",
    '  subgraph Frontend["Frontend"]\n',
    `    FE_Pages["Pages: ${ux.pages.length}"]\n`,
    `    FE_Components["Components: ${ux.components.length}"]\n`,
    "  end\n",
    '  subgraph Backend["Backend"]\n',
    `    BE_Modules["Modules: ${architecture.modules.length}"]\n`,
    `    BE_Endpoints["Endpoints: ${architecture.endpoints.length}"]\n`,
    "  end\n",
    '  subgraph Data["Data"]\n',
    `    DATA_Models["Models: ${orm.length} ORM + ${schemas.length} schemas"]\n`,
    "  end\n",
    '  subgraph Runtime["Runtime"]\n',
    `    RT_Services["Services: ${architecture.runtime.services.length}"]\n`,
    `    RT_Tasks["Tasks: ${architecture.tasks.length}"]\n`,
    "  end\n",
    "  FE_Components --> BE_Endpoints\n",
    "  BE_Endpoints --> DATA_Models\n",
    "  BE_Endpoints --> RT_Services\n",
    "  BE_Endpoints --> RT_Tasks\n"
  ];
  lines.push(renderMermaid(blockLines));

  lines.push("## Drift Summary\n\n");
  lines.push(
    renderTable(
      ["Status", "Graph", "D_t", "K_t", "Delta"],
      [[
        architecture.drift.status,
        architecture.drift.graph_level,
        architecture.drift.D_t.toFixed(4),
        architecture.drift.K_t.toFixed(4),
        architecture.drift.delta.toFixed(4)
      ]]
    )
  );
  lines.push(
    renderTable(
      ["Entropy", "Cross-Layer", "Cycle Density", "Modularity Gap"],
      [[
        architecture.drift.metrics.entropy.toFixed(4),
        architecture.drift.metrics.cross_layer_ratio.toFixed(4),
        architecture.drift.metrics.cycle_density.toFixed(4),
        architecture.drift.metrics.modularity_gap.toFixed(4)
      ]]
    )
  );

  lines.push("## Architecture Fingerprint\n\n");
  if (meta?.summary) {
    lines.push(`Fingerprint: \`${meta.summary.fingerprint}\`\n\n`);
    lines.push(`Shape Fingerprint: \`${meta.summary.shape_fingerprint ?? "n/a"}\`\n\n`);
    lines.push(
      "Legend: shape fingerprint changes indicate structural refactors (dependency pattern shifts), " +
        "while fingerprint changes with the same shape indicate additive changes.\n\n"
    );
  } else {
    lines.push("*Not available*\n\n");
  }

  lines.push("## Structural Coupling Heatmap (Top Files)\n\n");
  lines.push(
    "Coupling score reflects structural dependency pressure, not git recency or file churn.\n\n"
  );
  const hldFileHeatmap = pickHeatmapEntries(meta?.heatmap, "file");
  if (hldFileHeatmap.length > 0) {
    lines.push(
      renderTable(
        ["File", "Coupling Score", "Layer"],
        hldFileHeatmap.slice(0, 8).map((entry) => [
          entry.id,
          entry.score.toFixed(3),
          entry.layer
        ])
      )
    );
  } else {
    lines.push("*Not available*\n\n");
  }

  lines.push("## Structural Coupling Heatmap (Top Functions)\n\n");
  const hldFunctionHeatmap = pickHeatmapEntries(meta?.heatmap, "function");
  if (hldFunctionHeatmap.length > 0) {
    lines.push(
      renderTable(
        ["Function", "Coupling Score", "Layer"],
        hldFunctionHeatmap.slice(0, 8).map((entry) => [
          entry.id,
          entry.score.toFixed(3),
          entry.layer
        ])
      )
    );
  } else {
    lines.push("*Not available*\n\n");
  }

  lines.push("## Multi-Scale Drift\n\n");
  lines.push(
    renderTable(
      ["Level", "Status", "Delta", "D_t", "K_t", "Edges", "Nodes"],
      architecture.drift.scales.map((scale) => [
        scale.level,
        scale.status,
        scale.delta.toFixed(4),
        scale.D_t.toFixed(4),
        scale.K_t.toFixed(4),
        String(scale.details.edges),
        String(scale.details.nodes)
      ])
    )
  );

  const capacityHasBudget =
    architecture.drift.capacity.layers.some((layer) => layer.status !== "unbudgeted") ||
    (architecture.drift.capacity.total && architecture.drift.capacity.total.status !== "unbudgeted");
  lines.push("## Capacity Summary\n\n");
  if (!capacityHasBudget) {
    lines.push("*Capacity budgets not configured*\n\n");
  } else {
    if (architecture.drift.capacity.layers.length > 0) {
      lines.push(
        renderTable(
          ["Layer", "Budget", "Used", "Ratio", "Status"],
          architecture.drift.capacity.layers.map((layer) => [
            layer.layer,
            layer.budget !== undefined ? String(layer.budget) : "n/a",
            String(layer.edges),
            layer.ratio !== undefined ? layer.ratio.toFixed(2) : "n/a",
            layer.status
          ])
        )
      );
    }
    if (architecture.drift.capacity.total && architecture.drift.capacity.total.budget !== undefined) {
      lines.push(
        renderTable(
          ["Total Budget", "Used", "Ratio", "Status"],
          [[
            String(architecture.drift.capacity.total.budget),
            String(architecture.drift.capacity.total.used),
            architecture.drift.capacity.total.ratio !== undefined
              ? architecture.drift.capacity.total.ratio.toFixed(2)
              : "n/a",
            architecture.drift.capacity.total.status
          ]]
        )
      );
    }
  }

  lines.push("## Growth Summary\n\n");
  lines.push(
    renderTable(
      ["Edges/Day", "Trend", "Status"],
      [[
        architecture.drift.growth.edges_per_day.toFixed(2),
        architecture.drift.growth.trend,
        architecture.drift.growth.status
      ]]
    )
  );

  lines.push("## Drift Trend\n\n");
  if (driftHistory.length < 2) {
    lines.push("*No drift history available*\n\n");
  } else {
    const recent = driftHistory.slice(-20);
    const labels = recent.map((entry) => `"${formatTimestamp(entry.timestamp)}"`);
    const deltaValues = recent.map((entry) => round(entry.delta, 3));
    const dtValues = recent.map((entry) => round(entry.D_t, 3));
    const allValues = [...deltaValues, ...dtValues];
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const padding = minValue === maxValue ? 1 : Math.max(0.1, Math.abs(maxValue - minValue) * 0.1);
    const yMin = round(minValue - padding, 3);
    const yMax = round(maxValue + padding, 3);

    lines.push(
      renderMermaid([
        "xychart-beta\n",
        "  title \"Drift Trend\"\n",
        `  x-axis [${labels.join(", ")}]\n`,
        `  y-axis \"Value\" ${yMin} --> ${yMax}\n`,
        `  line \"Delta\" [${deltaValues.join(", ")}]\n`,
        `  line \"D_t\" [${dtValues.join(", ")}]\n`
      ])
    );
  }

  lines.push("## Backend Subsystems\n\n");
  const modulesById = new Map(architecture.modules.map((module) => [module.id, module]));

  const findModuleForFile = (file: string): typeof architecture.modules[number] | null => {
    let best: typeof architecture.modules[number] | null = null;
    for (const module of architecture.modules) {
      const prefix = module.path.endsWith("/") ? module.path : `${module.path}/`;
      if (file.startsWith(prefix)) {
        if (!best || module.path.length > best.path.length) {
          best = module;
        }
      }
    }
    return best;
  };

  const groupKeyForFile = (
    module: typeof architecture.modules[number],
    file: string
  ): string => {
    const prefix = module.path.endsWith("/") ? module.path : `${module.path}/`;
    const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) {
      return "root";
    }
    if (segments.length === 1 && segments[0].includes(".")) {
      return "root";
    }
    return segments[0];
  };

  const modelByName = new Map(
    architecture.data_models.map((model) => [model.name, model])
  );

  const endpointById = new Map(
    architecture.endpoints.map((endpoint) => [endpoint.id, endpoint])
  );

  for (const module of architecture.modules) {
    const groupStats = new Map<
      string,
      { files: number; endpoints: number; models: number }
    >();
    const edgeAccess = new Map<string, { read: boolean; write: boolean }>();

    const ensureGroup = (group: string): void => {
      if (!groupStats.has(group)) {
        groupStats.set(group, { files: 0, endpoints: 0, models: 0 });
      }
    };

    for (const file of module.files) {
      const group = groupKeyForFile(module, file);
      ensureGroup(group);
      groupStats.get(group)!.files += 1;
    }

    for (const endpoint of architecture.endpoints) {
      if (endpoint.module !== module.id) {
        continue;
      }
      const group = groupKeyForFile(module, endpoint.file);
      ensureGroup(group);
      groupStats.get(group)!.endpoints += 1;
    }

    for (const model of architecture.data_models) {
      const modelModule = findModuleForFile(model.file);
      if (!modelModule || modelModule.id !== module.id) {
        continue;
      }
      const group = groupKeyForFile(module, model.file);
      ensureGroup(group);
      groupStats.get(group)!.models += 1;
    }

    for (const usage of architecture.endpoint_model_usage) {
      const endpoint = endpointById.get(usage.endpoint_id);
      if (!endpoint || endpoint.module !== module.id) {
        continue;
      }
      const endpointGroup = groupKeyForFile(module, endpoint.file);
      for (const modelUsage of usage.models) {
        const model = modelByName.get(modelUsage.name);
        if (!model) {
          continue;
        }
        const modelModule = findModuleForFile(model.file);
        if (!modelModule || modelModule.id !== module.id) {
          continue;
        }
        const modelGroup = groupKeyForFile(module, model.file);
        if (endpointGroup === modelGroup) {
          continue;
        }
        const key = `${endpointGroup}::${modelGroup}`;
        const entry = edgeAccess.get(key) ?? { read: false, write: false };
        if (modelUsage.access === "read" || modelUsage.access === "read_write") {
          entry.read = true;
        }
        if (modelUsage.access === "write" || modelUsage.access === "read_write") {
          entry.write = true;
        }
        edgeAccess.set(key, entry);
      }
    }

    lines.push(`### ${module.id}\n\n`);
    if (groupStats.size === 0) {
      lines.push("*None*\n\n");
      continue;
    }

    // Collect actual entity names per group
    const groupEndpoints = new Map<string, string[]>();  // group → handler names
    const groupModels = new Map<string, string[]>();     // group → model names
    const groupClasses = new Map<string, string[]>();    // group → exported class/function names

    for (const endpoint of architecture.endpoints) {
      if (endpoint.module !== module.id) continue;
      const group = groupKeyForFile(module, endpoint.file);
      const eps = groupEndpoints.get(group) ?? [];
      eps.push(`${endpoint.method} ${endpoint.path}`);
      groupEndpoints.set(group, eps);
    }

    for (const model of architecture.data_models) {
      const modelModule = findModuleForFile(model.file);
      if (!modelModule || modelModule.id !== module.id) continue;
      const group = groupKeyForFile(module, model.file);
      const models = groupModels.get(group) ?? [];
      models.push(model.name);
      groupModels.set(group, models);
    }

    for (const exportInfo of module.exports) {
      const group = groupKeyForFile(module, exportInfo.file);
      const classes = groupClasses.get(group) ?? [];
      for (const symbol of exportInfo.symbols) {
        // Only include PascalCase names (classes) or significant names
        if (/^[A-Z]/.test(symbol) && !classes.includes(symbol)) {
          classes.push(symbol);
        }
      }
      groupClasses.set(group, classes);
    }

    const moduleLines: string[] = ["flowchart LR\n"];
    const groupNodes: string[] = [];
    for (const [group, stats] of groupStats.entries()) {
      const nodeId = `grp_${mermaidId(`${module.id}_${group}`)}`;
      const entities: string[] = [];

      // Show class/function names instead of just counts
      const classes = groupClasses.get(group) ?? [];
      const models = groupModels.get(group) ?? [];
      const eps = groupEndpoints.get(group) ?? [];

      if (classes.length > 0) {
        entities.push(classes.slice(0, 4).join(", ") + (classes.length > 4 ? ` +${classes.length - 4}` : ""));
      } else if (models.length > 0) {
        entities.push(models.slice(0, 3).join(", ") + (models.length > 3 ? ` +${models.length - 3}` : ""));
      }
      if (eps.length > 0 && entities.length === 0) {
        entities.push(eps.slice(0, 2).join(", ") + (eps.length > 2 ? ` +${eps.length - 2}` : ""));
      }

      const label = entities.length > 0
        ? `${group}\\n${entities.join("\\n")}`
        : `${group} · ${stats.files} files`;
      groupNodes.push(`    ${nodeId}["${mermaidLabel(label)}"]\n`);
    }
    moduleLines.push(`  subgraph ${mermaidId(module.id)}["${mermaidLabel(module.id)}"]\n`);
    moduleLines.push(...groupNodes);
    moduleLines.push("  end\n");

    for (const [key, access] of edgeAccess.entries()) {
      const [from, to] = key.split("::");
      const fromId = `grp_${mermaidId(`${module.id}_${from}`)}`;
      const toId = `grp_${mermaidId(`${module.id}_${to}`)}`;
      const label = access.read && access.write ? "read/write" : access.read ? "read" : "write";
      moduleLines.push(`  ${fromId} -- ${label} --> ${toId}\n`);
    }

    lines.push(renderMermaid(moduleLines));
  }

  lines.push("## Module Dependency Graph\n\n");
  const moduleLines: string[] = ["flowchart LR\n"];
  const layerBuckets = new Map<string, string[]>();
  for (const module of architecture.modules) {
    const nodeId = `mod_${mermaidId(module.id)}`;
    const entry = `    ${nodeId}["${mermaidLabel(module.id)}"]\n`;
    const bucket = layerBuckets.get(module.layer) ?? [];
    bucket.push(entry);
    layerBuckets.set(module.layer, bucket);
  }
  const orderedLayers: Array<"core" | "middle" | "top" | "isolated"> = [
    "core",
    "middle",
    "top",
    "isolated"
  ];
  for (const layer of orderedLayers) {
    const bucket = layerBuckets.get(layer);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    moduleLines.push(`  subgraph ${layer}["${layer.toUpperCase()}"]\n`, ...bucket, "  end\n");
  }
  const edgeSet = new Set<string>();
  for (const edge of architecture.dependencies.module_graph) {
    const key = `${edge.from}-->${edge.to}`;
    if (edgeSet.has(key)) {
      continue;
    }
    edgeSet.add(key);
    const fromId = `mod_${mermaidId(edge.from)}`;
    const toId = `mod_${mermaidId(edge.to)}`;
    moduleLines.push(`  ${fromId} --> ${toId}\n`);
  }
  lines.push(renderMermaid(moduleLines));

  lines.push("## API Domain Map\n\n");
  const domainLines: string[] = ["flowchart LR\n"];
  const domainNodes: string[] = [];
  const pageNodes: string[] = [];
  const domainEdges: string[] = [];
  const seenDomainNodes = new Set<string>();
  const seenPageNodes = new Set<string>();
  const seenDomainEdges = new Set<string>();

  const toDomain = (value: string): string | null => {
    const pathPart = value.includes(" ") ? value.split(" ").slice(1).join(" ") : value;
    const clean = pathPart.split("?")[0];
    const segments = clean.split("/").filter(Boolean);
    if (segments.length === 0) {
      return null;
    }
    const first = segments.find((segment) => !segment.startsWith("{") && !segment.startsWith(":"));
    if (!first) {
      return null;
    }
    if (first === "api" && segments.length > 1) {
      const second = segments.slice(1).find((segment) => !segment.startsWith("{") && !segment.startsWith(":"));
      return second ? `api/${second}` : "api";
    }
    return first;
  };

  for (const page of ux.pages) {
    const pageId = `page_${mermaidId(page.path)}`;
    if (!seenPageNodes.has(pageId)) {
      seenPageNodes.add(pageId);
      pageNodes.push(`    ${pageId}["${mermaidLabel(page.path)}"]\n`);
    }
    const pageDomains = new Set<string>();
    for (const call of page.api_calls) {
      const domain = toDomain(call);
      if (domain) {
        pageDomains.add(domain);
      }
    }
    for (const domain of pageDomains) {
      const domainId = `domain_${mermaidId(domain)}`;
      if (!seenDomainNodes.has(domainId)) {
        seenDomainNodes.add(domainId);
        domainNodes.push(`    ${domainId}["${mermaidLabel(domain)}"]\n`);
      }
      const key = `${pageId}::${domainId}`;
      if (!seenDomainEdges.has(key)) {
        seenDomainEdges.add(key);
        domainEdges.push(`  ${pageId} --> ${domainId}\n`);
      }
    }
  }

  domainLines.push('  subgraph Pages["Pages"]\n', ...pageNodes, "  end\n");
  domainLines.push('  subgraph Domains["API Domains"]\n', ...domainNodes, "  end\n");
  domainLines.push(...domainEdges);
  lines.push(renderMermaid(domainLines));

  lines.push("## Data Domain Summary\n\n");
  const dataRows: string[][] = [];
  const modelGroups = new Map<string, { count: number; files: Set<string> }>();
  for (const model of architecture.data_models) {
    const module = findModuleForFile(model.file);
    const group = module ? `${module.id}/${groupKeyForFile(module, model.file)}` : "unknown";
    const entry = modelGroups.get(group) ?? { count: 0, files: new Set<string>() };
    entry.count += 1;
    entry.files.add(model.file);
    modelGroups.set(group, entry);
  }
  for (const [group, stats] of modelGroups.entries()) {
    dataRows.push([group, String(stats.count), String(stats.files.size)]);
  }
  lines.push(renderTable(["Group", "Models", "Files"], dataRows));

  lines.push("## Runtime Services\n\n");
  const runtimeLines: string[] = ["flowchart LR\n"];
  const serviceNodes: string[] = [];
  const taskNodes: string[] = [];
  const runtimeEdges: string[] = [];
  const runtimeNodeSet = new Set<string>();
  const addRuntimeNode = (bucket: "service" | "task", id: string, label: string): void => {
    if (runtimeNodeSet.has(id)) {
      return;
    }
    runtimeNodeSet.add(id);
    const entry = `    ${id}["${mermaidLabel(label)}"]\n`;
    if (bucket === "task") {
      taskNodes.push(entry);
    } else {
      serviceNodes.push(entry);
    }
  };
  for (const service of architecture.runtime.services) {
    const serviceId = `svc_${mermaidId(service.name)}`;
    addRuntimeNode("service", serviceId, service.name);
    for (const dep of service.depends_on ?? []) {
      const depId = `svc_${mermaidId(dep)}`;
      addRuntimeNode("service", depId, dep);
      runtimeEdges.push(`  ${serviceId} --> ${depId}\n`);
    }
  }
  for (const task of architecture.tasks) {
    const taskId = `task_${mermaidId(`${task.kind}_${task.name}`)}`;
    addRuntimeNode("task", taskId, `${task.kind}: ${task.name}`);
  }
  runtimeLines.push('  subgraph Services["Services"]\n', ...serviceNodes, "  end\n");
  runtimeLines.push('  subgraph Tasks["Tasks"]\n', ...taskNodes, "  end\n");
  runtimeLines.push(...runtimeEdges);
  lines.push(renderMermaid(runtimeLines));

  return lines.join("");
}

function renderLld(architecture: ArchitectureSnapshot, ux: UxSnapshot, mode: DocsMode = "full"): string {
  const lines: string[] = [];
  lines.push(section("Low-Level Design"));
  if (mode === "full") {
    lines.push("## Endpoint Inventory\n\n");
    lines.push(
      renderTable(
        ["Method", "Path", "Handler", "Module", "Request", "Response", "Services", "AI Ops"],
        architecture.endpoints.map((endpoint) => [
          endpoint.method,
          endpoint.path,
          endpoint.handler,
          endpoint.module,
          endpoint.request_schema || "none",
          endpoint.response_schema || "none",
          endpoint.service_calls.join(", ") || "none",
          formatAiOperations(endpoint.ai_operations)
        ])
      )
    );
  }
  lines.push("## Backend Interaction Maps\n\n");

  const endpointUsage = new Map(
    architecture.endpoint_model_usage.map((usage) => [usage.endpoint_id, usage.models])
  );
  const endpointsByModule = new Map<string, typeof architecture.endpoints>();
  for (const endpoint of architecture.endpoints) {
    const list = endpointsByModule.get(endpoint.module) ?? [];
    list.push(endpoint);
    endpointsByModule.set(endpoint.module, list);
  }

  for (const module of architecture.modules) {
    const moduleEndpoints = endpointsByModule.get(module.id) ?? [];
    lines.push(`### ${module.id}\n\n`);
    if (moduleEndpoints.length === 0) {
      lines.push("*None*\n\n");
      continue;
    }
    const moduleLines: string[] = ["flowchart LR\n"];
    const moduleApiNodes: string[] = [];
    const moduleFnNodes: string[] = [];
    const moduleDbNodes: string[] = [];
    const moduleEdges: string[] = [];
    const seenModuleApiNodes = new Set<string>();
    const seenModuleFnNodes = new Set<string>();
    const seenModuleDbNodes = new Set<string>();
    const addModuleApi = (id: string, label: string): void => {
      if (seenModuleApiNodes.has(id)) {
        return;
      }
      seenModuleApiNodes.add(id);
      moduleApiNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    const addModuleFn = (id: string, label: string): void => {
      if (seenModuleFnNodes.has(id)) {
        return;
      }
      seenModuleFnNodes.add(id);
      moduleFnNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    const addModuleDb = (id: string, label: string): void => {
      if (seenModuleDbNodes.has(id)) {
        return;
      }
      seenModuleDbNodes.add(id);
      moduleDbNodes.push(`    ${id}["${mermaidLabel(label)}"]\n`);
    };
    for (const endpoint of moduleEndpoints) {
      const apiId = `api_${mermaidId(endpoint.id)}`;
      const handlerKey = `${endpoint.file}#${endpoint.handler}`;
      const handlerId = `fn_${mermaidId(handlerKey)}`;
      addModuleApi(apiId, `API ${endpoint.method} ${endpoint.path}`);
      addModuleFn(handlerId, `Fn ${endpoint.handler}`);
      moduleEdges.push(`  ${apiId} --> ${handlerId}\n`);
      const models = endpointUsage.get(endpoint.id) ?? [];
      for (const model of models) {
        const modelId = `db_${mermaidId(model.name)}`;
        addModuleDb(modelId, `DB ${model.name}`);
        moduleEdges.push(`  ${handlerId} -- ${accessLabel(model.access)} --> ${modelId}\n`);
      }
    }
    moduleLines.push('  subgraph API["API"]\n', ...moduleApiNodes, "  end\n");
    moduleLines.push('  subgraph Functions["Functions"]\n', ...moduleFnNodes, "  end\n");
    moduleLines.push('  subgraph Data["Data"]\n', ...moduleDbNodes, "  end\n");
    moduleLines.push(...moduleEdges);
    lines.push(renderMermaid(moduleLines));
  }

  lines.push("## UI Interaction Maps\n\n");
  const componentNames = new Map(ux.components.map((component) => [component.id, component.name]));
  for (const page of ux.pages) {
    const pageNodes: string[] = [];
    const componentNodes: string[] = [];
    const apiNodes: string[] = [];
    const stateNodes: string[] = [];
    const actionNodes: string[] = [];
    const uiEdges: string[] = [];
    const seenUiNodes = new Set<string>();
    const addUiNode = (
      id: string,
      label: string,
      category: "page" | "component" | "api" | "state" | "action"
    ): void => {
      if (seenUiNodes.has(id)) {
        return;
      }
      seenUiNodes.add(id);
      const entry = `    ${id}["${mermaidLabel(label)}"]\n`;
      if (category === "page") {
        pageNodes.push(entry);
      } else if (category === "api") {
        apiNodes.push(entry);
      } else if (category === "state") {
        stateNodes.push(entry);
      } else if (category === "action") {
        actionNodes.push(entry);
      } else {
        componentNodes.push(entry);
      }
    };

    const pageId = `page_${mermaidId(page.path)}`;
    addUiNode(pageId, `Page ${page.path}`, "page");
    const componentScope = new Set<string>([
      page.component_id,
      ...page.components_direct_ids,
      ...page.components_descendants_ids
    ]);
    for (const componentId of page.components_direct_ids) {
      const componentName = componentNames.get(componentId) ?? componentId;
      const nodeId = `comp_${mermaidId(componentId)}`;
      addUiNode(nodeId, `Component ${componentName}`, "component");
      uiEdges.push(`  ${pageId} --> ${nodeId}\n`);
    }
    for (const entry of page.component_api_calls) {
      const componentId = entry.component_id;
      const componentName = entry.component;
      const componentNode = `comp_${mermaidId(componentId)}`;
      addUiNode(componentNode, `Component ${componentName}`, "component");
      for (const call of entry.api_calls) {
        const apiNode = `api_${mermaidId(call)}`;
        addUiNode(apiNode, `API ${call}`, "api");
        uiEdges.push(`  ${componentNode} --> ${apiNode}\n`);
      }
    }
    for (const entry of page.component_state_variables) {
      const componentId = entry.component_id;
      const componentName = entry.component;
      const componentNode = `comp_${mermaidId(componentId)}`;
      addUiNode(componentNode, `Component ${componentName}`, "component");
      for (const state of entry.local_state_variables) {
        const stateNode = `state_${mermaidId(componentId)}_${mermaidId(state)}`;
        addUiNode(stateNode, `State ${state}`, "state");
        uiEdges.push(`  ${componentNode} --> ${stateNode}\n`);
      }
    }
    for (const target of page.possible_navigation) {
      const navNode = `nav_${mermaidId(target)}`;
      addUiNode(navNode, `Action ${target}`, "action");
      uiEdges.push(`  ${pageId} --> ${navNode}\n`);
    }
    for (const edge of ux.component_graph) {
      if (!componentScope.has(edge.from) && !componentScope.has(edge.to)) {
        continue;
      }
      const fromName = componentNames.get(edge.from) ?? edge.from;
      const toName = componentNames.get(edge.to) ?? edge.to;
      const fromId = `comp_${mermaidId(edge.from)}`;
      const toId = `comp_${mermaidId(edge.to)}`;
      addUiNode(fromId, `Component ${fromName}`, "component");
      addUiNode(toId, `Component ${toName}`, "component");
      uiEdges.push(`  ${fromId} --> ${toId}\n`);
    }

    lines.push(`### ${page.path}\n\n`);
    const mapLines: string[] = ["flowchart LR\n"];
    mapLines.push('  subgraph Page["Page"]\n', ...pageNodes, "  end\n");
    mapLines.push('  subgraph Components["Components"]\n', ...componentNodes, "  end\n");
    mapLines.push('  subgraph API["API"]\n', ...apiNodes, "  end\n");
    mapLines.push('  subgraph State["State"]\n', ...stateNodes, "  end\n");
    mapLines.push('  subgraph Actions["Actions"]\n', ...actionNodes, "  end\n");
    mapLines.push(...uiEdges);
    lines.push(renderMermaid(mapLines));
  }

  return lines.join("");
}

function renderData(snapshot: ArchitectureSnapshot, mode: DocsMode = "full"): string {
  const lines: string[] = [];
  const { orm, schemas } = splitModelsByFramework(snapshot);
  lines.push(section("Data Flow"));

  lines.push(`Model inventory: ${orm.length} ORM models, ${schemas.length} Pydantic schemas.\n\n`);
  lines.push("## ORM Models\n\n");
  lines.push(
    renderTable(
      ["Name", "Framework", "Fields", "Relationships"],
      orm.map((model) => [
        model.name,
        model.framework,
        model.fields.join(", ") || "none",
        model.relationships.join(", ") || "none"
      ])
    )
  );
  lines.push("## API Schemas\n\n");
  lines.push(
    renderTable(
      ["Name", "Framework", "Fields", "Relationships"],
      schemas.map((model) => [
        model.name,
        model.framework,
        model.fields.join(", ") || "none",
        model.relationships.join(", ") || "none"
      ])
    )
  );

  if (mode === "lean") {
    return lines.join("");
  }

  lines.push("## Model Field Details\n\n");
  if (snapshot.data_models.length === 0) {
    lines.push("*None*\n\n");
  } else {
    for (const model of snapshot.data_models) {
      lines.push(`### ${model.name} [${model.framework}]\n\n`);
      if (!model.field_details || model.field_details.length === 0) {
        lines.push("*Not available*\n\n");
        continue;
      }
      lines.push(
        renderTable(
          ["Field", "Type", "Nullable", "PK", "FK", "Enum", "Default"],
          model.field_details.map((field) => [
            field.name,
            field.type ?? "unknown",
            field.nullable === null || field.nullable === undefined ? "unknown" : field.nullable ? "yes" : "no",
            field.primary_key === null || field.primary_key === undefined
              ? "unknown"
              : field.primary_key
                ? "yes"
                : "no",
            field.foreign_key ?? "none",
            field.enum ?? "none",
            field.default ?? "none"
          ])
        )
      );
    }
  }

  lines.push("## Endpoint Usage\n\n");
  lines.push(
    renderTable(
      ["Endpoint", "Models"],
      snapshot.endpoint_model_usage.map((usage) => [
        usage.endpoint,
        usage.models
          .map((model) => `${model.name} (${model.access})`)
          .join(", ") || "none"
      ])
    )
  );

  lines.push("## Data Flows\n\n");
  lines.push(bullet(snapshot.data_flows.map((flow) => `${flow.page} → ${flow.endpoint_id} → ${flow.models.join(", ") || "none"}`)));

  return lines.join("");
}

function renderRuntime(snapshot: ArchitectureSnapshot): string {
  const lines: string[] = [];
  lines.push(section("Runtime"));
  lines.push("## Dockerfiles\n\n");
  lines.push(bullet(snapshot.runtime.dockerfiles));
  lines.push("\n## Services\n\n");
  lines.push(
    renderTable(
      ["Service", "Source", "Ports", "Env"],
      snapshot.runtime.services.map((service) => [
        service.name,
        service.source,
        (service.ports ?? []).join(", ") || "n/a",
        (service.environment ?? []).join(", ") || "n/a"
      ])
    )
  );
  lines.push("## Tasks\n\n");
  lines.push(
    renderTable(
      ["Name", "Kind", "Queue", "File"],
      snapshot.tasks.map((task) => [
        task.name,
        task.kind,
        task.queue ?? "n/a",
        task.file
      ])
    )
  );
  return lines.join("");
}

function renderInfra(snapshot: ArchitectureSnapshot): string {
  const lines: string[] = [];
  lines.push(section("Infrastructure & Manifests"));
  
  if (snapshot.runtime.manifests && snapshot.runtime.manifests.length > 0) {
    lines.push("## System Manifests\n\n");
    for (const manifest of snapshot.runtime.manifests) {
      lines.push(`### ${manifest.file} [${manifest.kind}]\n\n`);
      if (manifest.description) lines.push(`**Description:** ${manifest.description}\n\n`);
      if (manifest.commands && manifest.commands.length > 0) {
        lines.push(`**Commands:** ${manifest.commands.join(", ")}\n\n`);
      }
      if (manifest.dependencies && manifest.dependencies.length > 0) {
        lines.push(`**Dependencies:** ${manifest.dependencies.length} entries\n\n`);
      }
      if (manifest.dev_dependencies && manifest.dev_dependencies.length > 0) {
        lines.push(`**Dev Dependencies:** ${manifest.dev_dependencies.length} entries\n\n`);
      }
    }
  }

  if (snapshot.runtime.shell_scripts && snapshot.runtime.shell_scripts.length > 0) {
    lines.push("## Shell Scripts\n\n");
    lines.push(bullet(snapshot.runtime.shell_scripts));
  }
  
  if (lines.length === 1) {
    lines.push("*No infrastructure configuration detected.*\n\n");
  }
  
  return lines.join("");
}

function renderDataDictionary(snapshot: ArchitectureSnapshot): string {
  const lines: string[] = [];
  lines.push(section("Data Dictionary"));

  lines.push("## Model Fields\n\n");
  if (snapshot.data_models.length === 0) {
    lines.push("*None*\n\n");
  } else {
    for (const model of snapshot.data_models) {
      lines.push(`### ${model.name}\n\n`);
      if (model.field_details && model.field_details.length > 0) {
        lines.push(
          renderTable(
            ["Field", "Type", "Nullable", "Primary Key", "Foreign Key", "Enum", "Default"],
            model.field_details.map((field) => [
              field.name,
              field.type ?? "n/a",
              field.nullable === null || typeof field.nullable === "undefined"
                ? "n/a"
                : field.nullable
                ? "yes"
                : "no",
              field.primary_key === null || typeof field.primary_key === "undefined"
                ? "n/a"
                : field.primary_key
                ? "yes"
                : "no",
              field.foreign_key ?? "n/a",
              field.enum ?? "n/a",
              field.default ?? "n/a"
            ])
          )
        );
      } else {
        lines.push(
          renderTable(
            ["Field", "Type", "Nullable", "Primary Key", "Foreign Key", "Enum", "Default"],
            model.fields.map((field) => [field, "n/a", "n/a", "n/a", "n/a", "n/a", "n/a"])
          )
        );
      }
    }
  }

  lines.push("## Backend Enums\n\n");
  lines.push(
    renderTable(
      ["Enum Name", "File", "Values"],
      snapshot.enums.map((e) => [
        e.name,
        e.file,
        e.values.join(", ") || "none"
      ])
    )
  );

  const enumUsage: Array<{ enumName: string; usage: string }> = [];
  for (const model of snapshot.data_models) {
    for (const field of model.field_details ?? []) {
      if (field.enum) {
        enumUsage.push({
          enumName: field.enum,
          usage: `${model.name}.${field.name}`
        });
      }
    }
  }
  lines.push("## Enum Usage\n\n");
  if (enumUsage.length === 0) {
    lines.push("*None*\n\n");
  } else {
    lines.push(
      renderTable(
        ["Enum", "Model.Field"],
        enumUsage.map((entry) => [entry.enumName, entry.usage])
      )
    );
  }

  lines.push("## Global Constants\n\n");
  lines.push(
    renderTable(
      ["Constant Name", "File", "Type", "Value"],
      snapshot.constants.map((c) => [
        c.name,
        c.file,
        c.type,
        c.value
      ])
    )
  );

  return lines.join("");
}

function renderTestCoverage(snapshot: ArchitectureSnapshot): string {
  const lines: string[] = [];
  lines.push(section("Test Coverage Map"));

  const coverage = snapshot.analysis.test_coverage;
  if (!coverage) {
    return lines.join("");
  }

  lines.push("## Coverage Map\n\n");
  lines.push(
    renderTable(
      ["Test File", "Source File", "Match Type"],
      coverage.coverage_map.map((c) => [
        c.test_file,
        c.source_file ?? "*Unmapped*",
        c.match_type
      ])
    )
  );

  if (snapshot.analysis.endpoint_test_coverage.length > 0) {
    lines.push("## Endpoint Coverage\n\n");
    lines.push(
      renderTable(
        ["Endpoint", "File", "Covered", "Test Files"],
        snapshot.analysis.endpoint_test_coverage.map((entry) => [
          entry.endpoint,
          entry.file,
          entry.covered ? "yes" : "no",
          entry.test_files.join(", ") || "none"
        ])
      )
    );
  }

  if (snapshot.analysis.function_test_coverage.length > 0) {
    lines.push("## Function Coverage (File-Level)\n\n");
    lines.push(
      renderTable(
        ["Function", "File", "Covered", "Test Files"],
        snapshot.analysis.function_test_coverage.slice(0, 200).map((entry) => [
          entry.function_id,
          entry.file,
          entry.covered ? "yes" : "no",
          entry.test_files.join(", ") || "none"
        ])
      )
    );
    if (snapshot.analysis.function_test_coverage.length > 200) {
      lines.push(
        `*Showing first 200 of ${snapshot.analysis.function_test_coverage.length} functions*\n\n`
      );
    }
  }

  if (coverage.untested_source_files.length > 0) {
    lines.push("## Untested Source Files\n\n");
    lines.push(bullet(coverage.untested_source_files));
    lines.push("\n");
  }

  if (coverage.test_files_missing_source.length > 0) {
    lines.push("## Unmapped Test Files\n\n");
    lines.push(bullet(coverage.test_files_missing_source));
    lines.push("\n");
  }

  return lines.join("");
}

function computeChangedEndpoints(
  previous: ArchitectureSnapshot,
  current: ArchitectureSnapshot
): Array<{ endpoint: string; changes: string[] }> {
  const prevMap = new Map<string, ArchitectureSnapshot["endpoints"][number]>();
  for (const endpoint of previous.endpoints) {
    prevMap.set(endpointKey(endpoint), endpoint);
  }

  const changes: Array<{ endpoint: string; changes: string[] }> = [];
  for (const endpoint of current.endpoints) {
    const key = endpointKey(endpoint);
    const prev = prevMap.get(key);
    if (!prev) {
      continue;
    }

    const entryChanges: string[] = [];
    if (prev.handler !== endpoint.handler) {
      entryChanges.push(`handler: ${prev.handler} → ${endpoint.handler}`);
    }
    if (prev.module !== endpoint.module) {
      entryChanges.push(`module: ${prev.module} → ${endpoint.module}`);
    }
    if ((prev.request_schema || "") !== (endpoint.request_schema || "")) {
      entryChanges.push(
        `request_schema: ${prev.request_schema || "none"} → ${endpoint.request_schema || "none"}`
      );
    }
    if ((prev.response_schema || "") !== (endpoint.response_schema || "")) {
      entryChanges.push(
        `response_schema: ${prev.response_schema || "none"} → ${endpoint.response_schema || "none"}`
      );
    }

    const serviceDiff = diffList(prev.service_calls, endpoint.service_calls);
    if (serviceDiff.added.length > 0 || serviceDiff.removed.length > 0) {
      entryChanges.push(
        `services: +${serviceDiff.added.join(", ") || "none"} -${serviceDiff.removed.join(", ") || "none"}`
      );
    }

    const prevAi = normalizeAiOps(prev.ai_operations);
    const currAi = normalizeAiOps(endpoint.ai_operations);
    if (prevAi.join("|") !== currAi.join("|")) {
      entryChanges.push(`ai_ops: ${prevAi.join(", ") || "none"} → ${currAi.join(", ") || "none"}`);
    }

    if (entryChanges.length > 0) {
      changes.push({ endpoint: key, changes: entryChanges });
    }
  }

  return changes.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

function endpointKey(endpoint: ArchitectureSnapshot["endpoints"][number]): string {
  return `${endpoint.method.toUpperCase()} ${endpoint.path}`;
}

function diffList(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(previous ?? []);
  const currSet = new Set(current ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  for (const entry of currSet) {
    if (!prevSet.has(entry)) {
      added.push(entry);
    }
  }
  for (const entry of prevSet) {
    if (!currSet.has(entry)) {
      removed.push(entry);
    }
  }
  added.sort((a, b) => a.localeCompare(b));
  removed.sort((a, b) => a.localeCompare(b));
  return { added, removed };
}

function normalizeAiOps(
  operations: ArchitectureSnapshot["endpoints"][number]["ai_operations"]
): string[] {
  if (!operations || operations.length === 0) {
    return [];
  }
  return operations
    .map((op) => {
      const tokenBudget = op.token_budget ?? op.max_output_tokens ?? op.max_tokens;
      return [
        op.provider,
        op.operation,
        op.model ?? "none",
        typeof tokenBudget === "number" ? `tokens:${tokenBudget}` : "tokens:na"
      ].join(":");
    })
    .sort();
}

function renderDiff(
  architecture: ArchitectureSnapshot,
  meta?: {
    summary?: ArchitectureSummary | null;
    diff?: ArchitectureDiffSummary | null;
    previous?: ArchitectureSnapshot | null;
  }
): string {
  const lines: string[] = [];
  lines.push(section("Snapshot Changelog"));

  if (!meta?.diff) {
    lines.push("*No previous summary available. Run SpecGuard twice to generate a diff.*\n\n");
    return lines.join("");
  }

  lines.push(
    `Structural change: **${meta.diff.structural_change ? "yes" : "no"}**  \n` +
      `Shape equivalent: **${meta.diff.shape_equivalent ? "yes" : "no"}**\n\n`
  );

  lines.push(
    renderTable(
      ["Field", "Delta"],
      Object.entries(meta.diff.counts_delta).map(([field, delta]) => [field, String(delta)])
    )
  );

  const sections: Array<keyof ArchitectureDiffSummary["added"]> = [
    "modules",
    "endpoints",
    "models",
    "pages",
    "components",
    "tasks",
    "runtime_services"
  ];

  for (const key of sections) {
    const added = meta.diff.added[key] ?? [];
    const removed = meta.diff.removed[key] ?? [];
    lines.push(`## ${key.replace(/_/g, " ")}\n\n`);
    lines.push("### Added\n\n");
    lines.push(bullet(added.length > 0 ? added.slice(0, 20) : ["None"]));
    lines.push("\n### Removed\n\n");
    lines.push(bullet(removed.length > 0 ? removed.slice(0, 20) : ["None"]));
  }

  lines.push("## Changed Endpoints\n\n");
  if (!meta.previous) {
    lines.push("*Previous snapshot not available*\n\n");
  } else {
    const changes = computeChangedEndpoints(meta.previous, architecture);
    if (changes.length === 0) {
      lines.push("*None*\n\n");
    } else {
      lines.push(
        renderTable(
          ["Endpoint", "Changes"],
          changes.map((change) => [change.endpoint, change.changes.join("; ")])
        )
      );
    }
  }

  return lines.join("");
}

function renderIntegrationGuide(snapshot: ArchitectureSnapshot): string {
  const lines: string[] = [];
  lines.push(section("Integration Guide"));

  if (snapshot.endpoints.length === 0) {
    lines.push("*No endpoints detected.*\n\n");
    return lines.join("");
  }

  const usageMap = new Map(
    snapshot.endpoint_model_usage.map((usage) => [usage.endpoint_id, usage.models])
  );

  const byDomain = new Map<string, typeof snapshot.endpoints>();
  for (const endpoint of snapshot.endpoints) {
    const domain = integrationDomainForPath(endpoint.path);
    const list = byDomain.get(domain) ?? [];
    list.push(endpoint);
    byDomain.set(domain, list);
  }

  const sortedDomains = Array.from(byDomain.keys()).sort((a, b) => a.localeCompare(b));
  for (const domain of sortedDomains) {
    lines.push(`## ${domain}\n\n`);
    const endpoints = byDomain.get(domain) ?? [];
    lines.push(
      renderTable(
        ["Method", "Path", "Request", "Response", "Models", "Services", "AI Ops"],
        endpoints.map((endpoint) => [
          endpoint.method,
          endpoint.path,
          endpoint.request_schema || "none",
          endpoint.response_schema || "none",
          (usageMap.get(endpoint.id) ?? [])
            .map((model) => `${model.name} (${model.access})`)
            .join(", ") || "none",
          endpoint.service_calls.join(", ") || "none",
          formatAiOperations(endpoint.ai_operations)
        ])
      )
    );
  }

  lines.push("## Cross-Stack Contracts\n\n");
  if (snapshot.cross_stack_contracts.length === 0) {
    lines.push("*No matched frontend/backend contracts detected.*\n\n");
  } else {
    const verifiedContracts = snapshot.cross_stack_contracts.filter(
      (contract) => contract.status === "ok" || contract.status === "mismatched"
    );
    const mismatchedCount = verifiedContracts.filter((contract) => contract.status === "mismatched").length;
    const unverifiedCount = snapshot.cross_stack_contracts.length - verifiedContracts.length;
    lines.push(
      `Verified: ${verifiedContracts.length} contracts (${mismatchedCount} mismatched). Unverified: ${unverifiedCount}.`
    );
    lines.push(" Run `specguard extract --include-file-graph` for richer caller inference.\n\n");

    if (verifiedContracts.length === 0) {
      lines.push("*No verified frontend/backend contracts detected yet.*\n\n");
    } else {
      lines.push(
        renderTable(
          ["Endpoint", "Status", "Backend Schema", "Frontend Fields", "Callers", "Issues"],
          verifiedContracts.map((contract) => [
            `${contract.method} ${contract.path}`,
            contract.status,
            contract.backend_request_schema || contract.backend_response_schema || "none",
            contract.frontend_request_fields.join(", ") || "none",
            contract.frontend_callers
              .map((caller) => `${caller.component} (${caller.file})`)
              .join(", ") || "none",
            contract.issues.join(", ") || "—"
          ])
        )
      );
    }
  }

  return lines.join("");
}

function integrationDomainForPath(endpointPath: string): string {
  const segments = endpointPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "/";
  }
  if ((segments[0] === "api" || segments[0] === "v1") && segments[1]) {
    return `/${segments[0]}/${segments[1]}`;
  }
  return `/${segments[0]}`;
}

export async function writeDocs(
  outputRoot: string,
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot,
  options?: {
    projectRoot?: string;
    driftHistoryPath?: string;
    previous?: {
      architecture?: ArchitectureSnapshot;
      ux?: UxSnapshot;
    };
    docsMode?: DocsMode;
    internalDir?: string;
  }
): Promise<string[]> {
  const docsMode: DocsMode = options?.docsMode ?? "lean";
  const internalDirName = options?.internalDir ?? "internal";
  const layout = getOutputLayout(outputRoot, internalDirName);
  await fs.mkdir(layout.machineDocsDir, { recursive: true });
  await fs.mkdir(layout.humanDir, { recursive: true });
  const driftHistory = await loadDriftHistory(layout.machineDir, options);
  const summary = await loadArchitectureSummary(layout.machineDir);
  const diff = await loadArchitectureDiff(layout.machineDir);
  const heatmap = await loadHeatmap(layout.machineDir);

  const leanFiles = [
    {
      name: "index.md",
      content: renderIndex(architecture, ux, {
        docsFiles: LEAN_INDEX_FILES,
        internalFiles:
          docsMode === "full"
            ? FULL_INDEX_FILES.filter((file) => !LEAN_INDEX_FILES.includes(file))
            : [],
        internalDir: internalDirName
      })
    },
    {
      name: "summary.md",
      content: renderExecutiveSummary(architecture, ux, {
        summary,
        diff,
        heatmap,
        docsMode,
        internalDir: internalDirName
      })
    },
    {
      name: "stakeholder.md",
      content: renderStakeholderSummary(architecture, ux, {
        summary,
        diff,
        docsMode,
        internalDir: internalDirName
      })
    },
    { name: "hld.md", content: renderHld(architecture, ux, driftHistory, { summary, diff, heatmap }) },
    { name: "integration.md", content: renderIntegrationGuide(architecture) },
    {
      name: "diff.md",
      content: renderDiff(architecture, {
        summary,
        diff,
        previous: options?.previous?.architecture ?? null
      })
    },
    { name: "runtime.md", content: renderRuntime(architecture) },
    { name: "infra.md", content: renderInfra(architecture) },
    { name: "ux.md", content: renderUx(ux) },
    { name: "data.md", content: renderData(architecture, "lean") },
    { name: "tests.md", content: renderTests(architecture) }
  ];

  const fullFiles = [
    { name: "index.md", content: renderIndex(architecture, ux, { docsFiles: FULL_INDEX_FILES }) },
    {
      name: "summary.md",
      content: renderExecutiveSummary(architecture, ux, {
        summary,
        diff,
        heatmap,
        docsMode: "full",
        internalDir: internalDirName
      })
    },
    {
      name: "stakeholder.md",
      content: renderStakeholderSummary(architecture, ux, {
        summary,
        diff,
        docsMode: "full",
        internalDir: internalDirName
      })
    },
    { name: "architecture.md", content: renderArchitecture(architecture, { summary, diff, heatmap }) },
    { name: "ux.md", content: renderUx(ux) },
    { name: "data.md", content: renderData(architecture, "full") },
    { name: "data_dictionary.md", content: renderDataDictionary(architecture) },
    { name: "integration.md", content: renderIntegrationGuide(architecture) },
    {
      name: "diff.md",
      content: renderDiff(architecture, {
        summary,
        diff,
        previous: options?.previous?.architecture ?? null
      })
    },
    { name: "test_coverage.md", content: renderTestCoverage(architecture) },
    { name: "runtime.md", content: renderRuntime(architecture) },
    { name: "infra.md", content: renderInfra(architecture) },
    {
      name: "hld.md",
      content: renderHld(architecture, ux, driftHistory, { summary, diff, heatmap })
    },
    { name: "lld.md", content: renderLld(architecture, ux, "full") },
    { name: "tests.md", content: renderTests(architecture) }
  ];

  const written: string[] = [];
  await fs.writeFile(path.join(layout.rootDir, "README.md"), renderHumanRootReadme(architecture));
  written.push(path.join(layout.rootDir, "README.md"));
  for (const file of leanFiles) {
    const target = path.join(layout.machineDocsDir, file.name);
    await fs.writeFile(target, file.content);
    written.push(target);
  }

  if (docsMode === "full") {
    const internalDir = layout.machineInternalDir;
    await fs.mkdir(internalDir, { recursive: true });
    for (const file of fullFiles) {
      const target = path.join(internalDir, file.name);
      await fs.writeFile(target, file.content);
      written.push(target);
    }
  }

  const humanFiles = [
    { name: "start-here.md", content: renderHumanStartHere(architecture, ux) },
    {
      name: "system-overview.md",
      content: renderHumanSystemOverview(architecture, ux, { heatmap })
    },
    { name: "backend-overview.md", content: renderHumanBackendOverview(architecture) },
    { name: "frontend-overview.md", content: renderHumanFrontendOverview(ux) },
    { name: "data-and-flows.md", content: renderHumanDataAndFlows(architecture, ux) },
    {
      name: "change-guide.md",
      content: renderHumanChangeGuide(architecture, { diff, heatmap })
    }
  ];
  for (const file of humanFiles) {
    const target = path.join(layout.humanDir, file.name);
    await fs.writeFile(target, file.content);
    written.push(target);
  }

  return written;
}

async function loadDriftHistory(
  machineDir: string,
  options?: {
    projectRoot?: string;
    driftHistoryPath?: string;
  }
): Promise<DriftHistoryEntry[]> {
  const candidates: string[] = [];
  if (options?.driftHistoryPath) {
    const resolved = path.isAbsolute(options.driftHistoryPath)
      ? options.driftHistoryPath
      : path.resolve(options.projectRoot ?? machineDir, options.driftHistoryPath);
    candidates.push(resolved);
  }
  if (options?.projectRoot) {
    candidates.push(path.resolve(options.projectRoot, "specs-out/machine/drift.history.jsonl"));
    candidates.push(path.resolve(options.projectRoot, "specs-out/drift.history.jsonl"));
  }
  candidates.push(path.join(machineDir, "drift.history.jsonl"));

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const entries: DriftHistoryEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as DriftHistoryEntry;
          if (
            typeof parsed.timestamp === "string" &&
            typeof parsed.D_t === "number" &&
            typeof parsed.delta === "number"
          ) {
            entries.push(parsed);
          }
        } catch {
          continue;
        }
      }
      if (entries.length > 0) {
        entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return entries;
      }
    } catch {
      continue;
    }
  }

  return [];
}
