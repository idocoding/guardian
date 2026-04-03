/**
 * `guardian doc-html` — generate a self-contained Javadoc-style HTML viewer.
 *
 * Same data pipeline as `doc-generate` but outputs a single index.html with:
 *   - Fixed sidebar navigation (collapsible, searchable)
 *   - Mermaid diagrams rendered in-browser
 *   - Tables, collapsible sections, scroll-spy active states
 *   - No server or build step required — open directly in browser
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { loadCodebaseIntelligence } from "../extract/codebase-intel.js";
import { buildDiscrepancyReport } from "../extract/discrepancies.js";
import { loadExistingDocs } from "../extract/docs-loader.js";
import { renderHtmlDoc } from "../extract/html-doc.js";
import { getOutputLayout } from "../output-layout.js";
import type { UxSnapshot } from "../extract/types.js";

export type DocHtmlOptions = {
  specs: string;
  output?: string;
};

export async function runDocHtml(options: DocHtmlOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);

  // ── Load codebase intelligence ────────────────────────────────────────────
  const intelPath = path.join(layout.machineDir, "codebase-intelligence.json");
  process.stdout.write("Loading codebase intelligence... ");
  const intel = await loadCodebaseIntelligence(intelPath).catch(() => {
    console.log("failed");
    throw new Error(
      `Could not load ${intelPath}. Run \`guardian intel --specs ${options.specs}\` first.`
    );
  });
  console.log(
    `${intel.meta.counts.endpoints} endpoints, ${intel.meta.counts.models} models`
  );

  // ── Feature arcs (optional) ───────────────────────────────────────────────
  const arcsPath = path.join(layout.machineDir, "feature-arcs.json");
  let featureArcs = null;
  try {
    const raw = await fs.readFile(arcsPath, "utf8");
    featureArcs = JSON.parse(raw);
    const arcCount = Object.keys((featureArcs as { arcs: object }).arcs).length;
    console.log(`Feature arcs: ${arcCount} arc(s)`);
  } catch {
    // optional
  }

  // ── Discrepancy report ────────────────────────────────────────────────────
  const baselinePath = path.join(layout.machineDir, "product-document.baseline.json");
  process.stdout.write("Computing discrepancies... ");
  const discrepancies = await buildDiscrepancyReport({
    intel,
    baselinePath,
    featureSpecsDir: null,
  });
  console.log(
    discrepancies.summary.total_issues === 0
      ? "none"
      : `${discrepancies.summary.total_issues} issue(s)`
  );

  // ── Load existing docs ────────────────────────────────────────────────────
  process.stdout.write("Loading existing docs... ");
  const existingDocs = await loadExistingDocs(layout.machineDocsDir);
  const loadedKeys = Object.entries(existingDocs).filter(([, v]) => v != null).map(([k]) => k);
  console.log(loadedKeys.length > 0 ? loadedKeys.join(", ") : "none");

  // ── Load UX snapshot (for component graph) ───────────────────────────────
  process.stdout.write("Loading UX snapshot... ");
  let uxSnapshot: UxSnapshot | null = null;
  try {
    const uxPath = path.join(layout.machineDir, "ux.snapshot.yaml");
    const raw = await fs.readFile(uxPath, "utf8");
    uxSnapshot = yaml.load(raw) as UxSnapshot;
    console.log(`${uxSnapshot.components?.length ?? 0} components, ${uxSnapshot.component_graph?.length ?? 0} edges`);
  } catch {
    console.log("not found");
  }

  // ── Load product context from README ──────────────────────────────────────
  let productContext: string | null = null;
  const readmeCandidates = [
    path.join(path.dirname(specsDir), "README.md"),
    path.join(path.dirname(specsDir), "readme.md"),
  ];
  for (const candidate of readmeCandidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const lines = raw.split("\n");
      const contextLines: string[] = [];
      let sectionCount = 0;
      for (const line of lines) {
        if (line.startsWith("## ") && sectionCount > 0) break;
        if (line.startsWith("## ")) sectionCount++;
        if (line.startsWith("# ")) continue;
        contextLines.push(line);
        if (contextLines.join("\n").length > 1200) break;
      }
      productContext = contextLines.join("\n").trim();
      break;
    } catch {
      // Not found
    }
  }

  // ── Render HTML (multi-page) ──────────────────────────────────────────────
  console.log("Rendering HTML viewer...");
  const files = renderHtmlDoc({ intel, featureArcs, discrepancies, existingDocs, uxSnapshot, productContext });

  // ── Write output files ────────────────────────────────────────────────────
  const outputDir = options.output
    ? path.resolve(options.output)
    : path.join(layout.humanDir, "docs");

  await fs.mkdir(outputDir, { recursive: true });

  let totalBytes = 0;
  for (const [filename, html] of Object.entries(files)) {
    const filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, html, "utf8");
    totalBytes += Buffer.byteLength(html, "utf8");
  }

  const totalKb = Math.round(totalBytes / 1024);
  const fileCount = Object.keys(files).length;
  console.log(`Wrote ${fileCount} files to ${outputDir}/ (${totalKb} KB total)`);
  console.log(`  Open in browser: open "${path.join(outputDir, "index.html")}"`);
  for (const filename of Object.keys(files)) {
    console.log(`    ${filename}`);
  }
}
