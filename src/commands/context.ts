import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  loadArchitectureDiff,
  loadHeatmap
} from "../extract/compress.js";
import { renderContextBlock } from "../extract/context-block.js";
import type { ArchitectureSnapshot, UxSnapshot, StructuralIntelligenceReport } from "../extract/types.js";
import { resolveMachineInputDir } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";
import { SqliteSpecsStore, DB_FILENAME } from "../db/sqlite-specs-store.js";

export type ContextOptions = {
  input: string;
  output?: string;
  focus?: string;
  maxLines?: string | number;
};

/** Open a SqliteSpecsStore if guardian.db exists, return null otherwise. */
async function tryOpenStore(specsDir: string): Promise<SqliteSpecsStore | null> {
  const dbPath = path.join(specsDir, DB_FILENAME);
  try {
    await fs.stat(dbPath);
    const store = new SqliteSpecsStore(specsDir);
    await store.init();
    return store;
  } catch {
    return null;
  }
}

/** Reconstruct the SI report shape renderContextBlock needs from module_metrics rows. */
function siFromMetrics(rows: ReturnType<SqliteSpecsStore["readModuleMetrics"]>): StructuralIntelligenceReport[] {
  return rows.map(r => ({
    feature: r.module,
    structure: { nodes: r.nodes, edges: r.edges },
    metrics: { depth: 0, fanout_avg: 0, fanout_max: 0, density: 0, has_cycles: false },
    scores: { depth_score: 0, fanout_score: 0, density_score: 0, cycle_score: 0, query_score: 0 },
    confidence: { value: r.confidence, level: r.confidence_level as "WEAK" | "MODERATE" | "STRONG" },
    ambiguity: { level: "LOW" as const },
    classification: {
      depth_level: r.depth_level as "LOW" | "MEDIUM" | "HIGH",
      propagation: r.propagation as "LOCAL" | "MODERATE" | "STRONG",
      compressible: r.compressible as "COMPRESSIBLE" | "PARTIAL" | "NON_COMPRESSIBLE",
    },
    recommendation: {
      primary: { pattern: r.pattern, confidence: r.confidence },
      fallback: { pattern: "", condition: "" },
      avoid: [],
    },
    guardrails: { enforce_if_confidence_above: 0.7 },
    override: { allowed: true as const, requires_reason: true as const },
  }));
}

export async function runContext(options: ContextOptions): Promise<void> {
  const inputDir = await resolveMachineInputDir(options.input || DEFAULT_SPECS_DIR);
  // inputDir resolves to .specs/machine/; DB lives one level up at .specs/guardian.db
  const specsDir = path.dirname(inputDir);
  const store = await tryOpenStore(specsDir);

  let architecture: ArchitectureSnapshot;
  let ux: UxSnapshot;
  let si: StructuralIntelligenceReport[] | undefined;

  try {
    // ── Load snapshots: DB first, file fallback ─────────────────────────────
    if (store) {
      const archEntry = await store.readSpec("architecture.snapshot");
      const uxEntry   = await store.readSpec("ux.snapshot");
      if (archEntry && uxEntry) {
        architecture = yaml.load(archEntry.content) as ArchitectureSnapshot;
        ux           = yaml.load(uxEntry.content)   as UxSnapshot;
      } else {
        ({ architecture, ux } = await loadSnapshotsFromFiles(inputDir));
      }
    } else {
      ({ architecture, ux } = await loadSnapshotsFromFiles(inputDir));
    }

    // ── Load SI reports: module_metrics table first, file fallback ──────────
    if (store) {
      const rows = store.readModuleMetrics();
      if (rows.length > 0) {
        si = siFromMetrics(rows);
      }
    }
    if (!si) {
      try {
        const siRaw = await fs.readFile(path.join(inputDir, "structural-intelligence.json"), "utf8");
        si = JSON.parse(siRaw);
      } catch { /* not available */ }
    }
  } finally {
    if (store) await store.close();
  }

  const [diff, heatmap] = await Promise.all([
    loadArchitectureDiff(inputDir),
    loadHeatmap(inputDir)
  ]);

  const content = renderContextBlock(architecture!, ux!, {
    focusQuery: options.focus,
    maxLines: normalizeMaxLines(options.maxLines),
    diff,
    heatmap,
    structuralIntelligence: si
  });

  if (!options.output) {
    console.log(content);
    return;
  }

  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const existing = await readIfExists(outputPath);
  const next = injectIntoAutoContext(existing, content);
  await fs.writeFile(outputPath, next, "utf8");
  console.log(`Wrote ${outputPath}`);
}

async function loadSnapshotsFromFiles(
  inputDir: string
): Promise<{ architecture: ArchitectureSnapshot; ux: UxSnapshot }> {
  const architecturePath = path.join(inputDir, "architecture.snapshot.yaml");
  const uxPath = path.join(inputDir, "ux.snapshot.yaml");
  try {
    const [architectureRaw, uxRaw] = await Promise.all([
      fs.readFile(architecturePath, "utf8"),
      fs.readFile(uxPath, "utf8")
    ]);
    return {
      architecture: yaml.load(architectureRaw) as ArchitectureSnapshot,
      ux: yaml.load(uxRaw) as UxSnapshot
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Could not find snapshots in ${inputDir}. Run \`guardian extract\` first.`
      );
    }
    throw error;
  }
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function stripExistingSpecGuardBlocks(content: string): string {
  return content
    .replace(
      /\n?<!-- guardian:ai-context -->[\s\S]*?<!-- \/guardian:ai-context -->\n?/g,
      "\n"
    )
    .replace(
      /\n?<!-- guardian:context generated=.*?-->[\s\S]*?<!-- \/guardian:context -->\n?/g,
      "\n"
    )
    .replace(
      /<!-- guardian:auto-context -->[\s\S]*?<!-- \/guardian:auto-context -->/g,
      "<!-- guardian:auto-context -->\n<!-- /guardian:auto-context -->"
    )
    .replace(/\n{3,}/g, "\n\n");
}

function injectIntoAutoContext(existing: string, contextBlock: string): string {
  const marker = "<!-- guardian:auto-context -->";
  const endMarker = "<!-- /guardian:auto-context -->";

  if (!existing.includes(marker)) {
    const cleaned = stripExistingSpecGuardBlocks(existing).trim();
    return cleaned.length > 0 ? `${cleaned}\n\n${contextBlock}\n` : `${contextBlock}\n`;
  }

  const startIdx = existing.indexOf(marker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return existing;

  const before = existing.slice(0, startIdx + marker.length);
  const after = existing.slice(endIdx);
  return `${before}\n${contextBlock}\n${after}`;
}

function normalizeMaxLines(value?: string | number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
