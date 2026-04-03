import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  loadArchitectureDiff,
  loadHeatmap
} from "../extract/compress.js";
import { renderContextBlock } from "../extract/context-block.js";
import type { ArchitectureSnapshot, UxSnapshot } from "../extract/types.js";
import { resolveMachineInputDir } from "../output-layout.js";
import { DEFAULT_SPECS_DIR } from "../config.js";

export type ContextOptions = {
  input: string;
  output?: string;
  focus?: string;
  maxLines?: string | number;
};

export async function runContext(options: ContextOptions): Promise<void> {
  const inputDir = await resolveMachineInputDir(options.input || DEFAULT_SPECS_DIR);
  const { architecture, ux } = await loadSnapshots(inputDir);
  const [diff, heatmap] = await Promise.all([
    loadArchitectureDiff(inputDir),
    loadHeatmap(inputDir)
  ]);

  const content = renderContextBlock(architecture, ux, {
    focusQuery: options.focus,
    maxLines: normalizeMaxLines(options.maxLines),
    diff,
    heatmap
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

/**
 * Inject context into a file that has <!-- guardian:auto-context --> markers.
 * Replaces content between the markers instead of appending.
 */
function injectIntoAutoContext(existing: string, contextBlock: string): string {
  const marker = "<!-- guardian:auto-context -->";
  const endMarker = "<!-- /guardian:auto-context -->";

  if (!existing.includes(marker)) {
    // No auto-context markers — fall back to append behavior
    const cleaned = stripExistingSpecGuardBlocks(existing).trim();
    return cleaned.length > 0 ? `${cleaned}\n\n${contextBlock}\n` : `${contextBlock}\n`;
  }

  // Replace content between markers
  const startIdx = existing.indexOf(marker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return existing;
  }

  const before = existing.slice(0, startIdx + marker.length);
  const after = existing.slice(endIdx);
  return `${before}\n${contextBlock}\n${after}`;
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
