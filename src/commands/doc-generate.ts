/**
 * `specguard doc-generate` — generate a human-readable, self-updating product document.
 *
 * Reads:
 *   - specs-out/machine/codebase-intelligence.json
 *   - feature-specs/*.yaml (optional)
 *   - specs-out/machine/feature-arcs.json (optional, if exists)
 *   - specs-out/machine/product-document.baseline.json (optional, for discrepancy section)
 *
 * Writes:
 *   - specs-out/human/product-document.md
 *   - specs-out/machine/product-document.baseline.json (if --update-baseline)
 *
 * LLM env vars (optional — all deterministic sections write regardless):
 *   SPECGUARD_LLM_ENDPOINT, SPECGUARD_LLM_API_KEY, SPECGUARD_LLM_MODEL
 *   SPECGUARD_OLLAMA_HOST, SPECGUARD_OLLAMA_MODEL
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadCodebaseIntelligence } from "../extract/codebase-intel.js";
import { buildFeatureArcs } from "../extract/feature-arcs.js";
import {
  buildDiscrepancyReport,
  buildBaseline,
} from "../extract/discrepancies.js";
import { renderProductDocument } from "../extract/product-doc.js";
import { loadExistingDocs } from "../extract/docs-loader.js";
import { loadLlmConfig } from "../extract/llm-client.js";
import { getOutputLayout } from "../output-layout.js";

export type DocGenerateOptions = {
  specs: string;
  featureSpecs?: string;
  output?: string;
  updateBaseline: boolean;
};

export async function runDocGenerate(options: DocGenerateOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);

  // ── Step 1: LLM config resolution ─────────────────────────────────────────
  process.stdout.write("Resolving LLM config... ");
  const llmConfig = await loadLlmConfig();
  if (!llmConfig) {
    console.log("none (deterministic only)");
    console.log("  Tip: set SPECGUARD_LLM_ENDPOINT + SPECGUARD_LLM_API_KEY, or run Ollama locally, to add narrative summaries.");
  } else if (llmConfig.provider === "ollama") {
    console.log(`Ollama (${llmConfig.model} at ${llmConfig.endpoint.replace("/api/chat", "")})`);
  } else {
    console.log(`${llmConfig.provider} (${llmConfig.model})`);
    console.log(
      "  ⚠ Cloud LLM enabled — this will consume API tokens (one call per section: overview, API domains, each model). Use Ollama to avoid costs."
    );
  }

  // ── Step 2: Load codebase intelligence ────────────────────────────────────
  const intelPath = path.join(layout.machineDir, "codebase-intelligence.json");
  process.stdout.write("Loading codebase intelligence... ");
  const intel = await loadCodebaseIntelligence(intelPath).catch(() => {
    console.log("failed");
    throw new Error(
      `Could not load ${intelPath}. Run \`specguard intel --specs ${options.specs}\` first.`
    );
  });
  console.log(
    `${intel.meta.counts.endpoints} endpoints, ${intel.meta.counts.models} models, ` +
    `${intel.meta.counts.enums} enums, ${intel.meta.counts.tasks} tasks`
  );

  // ── Step 3: Feature arcs (optional) ───────────────────────────────────────
  const arcsPath = path.join(layout.machineDir, "feature-arcs.json");
  let featureArcs = null;
  if (options.featureSpecs) {
    const featureSpecsDir = path.resolve(options.featureSpecs);
    process.stdout.write(`Building feature arcs from ${options.featureSpecs}... `);
    featureArcs = await buildFeatureArcs(featureSpecsDir);
    const arcCount = Object.keys(featureArcs.arcs).length;
    console.log(`${arcCount} arc(s)`);
    await fs.writeFile(arcsPath, JSON.stringify(featureArcs, null, 2), "utf8");
    console.log(`  Wrote ${arcsPath}`);
  } else {
    try {
      const raw = await fs.readFile(arcsPath, "utf8");
      featureArcs = JSON.parse(raw);
      const arcCount = Object.keys((featureArcs as { arcs: object }).arcs).length;
      console.log(`Feature arcs: loaded from cache (${arcCount} arc(s))`);
    } catch {
      // No arcs — skip feature timeline section silently
    }
  }

  // ── Step 4: Discrepancy report ─────────────────────────────────────────────
  const baselinePath = path.join(layout.machineDir, "product-document.baseline.json");
  process.stdout.write("Computing discrepancies... ");
  const discrepancies = await buildDiscrepancyReport({
    intel,
    baselinePath,
    featureSpecsDir: options.featureSpecs ? path.resolve(options.featureSpecs) : null,
  });
  if (discrepancies.summary.total_issues === 0) {
    console.log("none (in sync)");
  } else {
    const critical = discrepancies.summary.has_critical ? " ⚠ critical" : "";
    console.log(`${discrepancies.summary.total_issues} issue(s)${critical}`);
  }

  // ── Step 5: Load existing docs (hld.md, summary.md, integration.md, etc.) ─
  process.stdout.write("Loading existing docs... ");
  const existingDocs = await loadExistingDocs(layout.machineDocsDir);
  const loadedKeys = Object.entries(existingDocs).filter(([, v]) => v != null).map(([k]) => k);
  console.log(loadedKeys.length > 0 ? loadedKeys.join(", ") : "none");

  // ── Step 5b: Load product context (from config description or README) ─────
  let productContext: string | null = null;
  {
    // Try config.project.description first
    // Then try README.md auto-detection
    const readmeCandidates = [
      path.join(path.dirname(specsDir), "README.md"),
      path.join(path.dirname(specsDir), "readme.md"),
      path.join(path.dirname(specsDir), "Readme.md"),
    ];
    for (const candidate of readmeCandidates) {
      try {
        const raw = await fs.readFile(candidate, "utf8");
        // Extract first meaningful content (up to first ## or 800 chars)
        const lines = raw.split("\n");
        const contextLines: string[] = [];
        let inHeader = false;
        let sectionCount = 0;
        for (const line of lines) {
          if (line.startsWith("## ") && sectionCount > 0) break;  // stop at second H2
          if (line.startsWith("## ")) sectionCount++;
          if (line.startsWith("# ")) { inHeader = true; continue; }  // skip H1
          if (inHeader && line.trim() === "") { inHeader = false; continue; }
          contextLines.push(line);
          if (contextLines.join("\n").length > 800) break;
        }
        productContext = contextLines.join("\n").trim();
        if (productContext.length > 0) {
          console.log(`Product context: loaded from README.md (${productContext.length} chars)`);
        }
        break;
      } catch {
        // Not found, try next
      }
    }
  }

  // ── Step 6: Render product document ───────────────────────────────────────
  console.log("Rendering product document...");
  const content = await renderProductDocument({ intel, featureArcs, discrepancies, llmConfig, existingDocs, productContext });

  // ── Step 7: Write output ───────────────────────────────────────────────────
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(layout.humanDir, "product-document.md");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
  console.log(`Wrote ${outputPath}`);

  // ── Step 7: Update baseline (optional) ────────────────────────────────────
  if (options.updateBaseline) {
    const baseline = buildBaseline(intel);
    await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
    console.log(`Wrote baseline ${baselinePath}`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (discrepancies.summary.total_issues > 0) {
    const critical = discrepancies.summary.has_critical ? " (critical changes detected)" : "";
    console.log(
      `  ⚠ ${discrepancies.summary.total_issues} discrepancy(s) found${critical}. Run \`specguard discrepancy\` for details.`
    );
  }
}
