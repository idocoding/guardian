/**
 * `guardian intel` — build codebase-intelligence.json from existing snapshots.
 *
 * Reads:  specs-out/machine/architecture.snapshot.yaml + ux.snapshot.yaml
 * Writes: specs-out/machine/codebase-intelligence.json  (file backend, default)
 *         specs-out/guardian.db                          (sqlite backend)
 *
 * Also auto-runs at the end of `guardian extract`.
 */

import path from "node:path";
import { writeCodebaseIntelligence } from "../extract/codebase-intel.js";
import { writeCodebaseIntelligenceViaStore } from "../extract/codebase-intel.js";
import { getOutputLayout } from "../output-layout.js";
import { SqliteSpecsStore } from "../db/sqlite-specs-store.js";
import { populateFTSIndex } from "../db/fts-builder.js";
import { embedFunctions } from "../db/embeddings.js";

export type IntelOptions = {
  specs: string;
  output?: string;
  /** Storage backend: "file" (default) or "sqlite" */
  backend?: "file" | "sqlite";
};

export async function runIntel(options: IntelOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);

  if (options.backend === "sqlite") {
    // ── SQLite path ──
    // extract always writes snapshots as files, so we read those then write
    // intel + FTS into guardian.db. This avoids requiring --backend on extract.
    const store = new SqliteSpecsStore(layout.rootDir);
    await store.init();
    try {
      // Read snapshots from the existing file-based layout
      const machineDir = layout.machineDir;
      const [archRaw, uxRaw] = await Promise.all([
        (await import("node:fs/promises")).readFile(
          (await import("node:path")).join(machineDir, "architecture.snapshot.yaml"), "utf8"
        ),
        (await import("node:fs/promises")).readFile(
          (await import("node:path")).join(machineDir, "ux.snapshot.yaml"), "utf8"
        ),
      ]);

      // Populate snapshots into the store so writeCodebaseIntelligenceViaStore can read them
      await store.writeSpec("architecture.snapshot", archRaw, "yaml");
      await store.writeSpec("ux.snapshot", uxRaw, "yaml");

      // Build intel and write to DB
      await writeCodebaseIntelligenceViaStore(store);

      // Build FTS5 index — enrich with all extract output for best recall
      const intelEntry = await store.readSpec("codebase-intelligence");
      if (intelEntry) {
        const intel = JSON.parse(intelEntry.content);
        const archEntry  = await store.readSpec("architecture.snapshot");
        const arch = archEntry ? (await import("js-yaml")).load(archEntry.content) : undefined;
        // Also load function-intelligence if present in the machine dir
        let funcIntel: any;
        try {
          const fnRaw = await (await import("node:fs/promises")).readFile(
            (await import("node:path")).join(machineDir, "function-intelligence.json"), "utf8"
          );
          funcIntel = JSON.parse(fnRaw);
        } catch { /* not generated yet — skip */ }
        populateFTSIndex(store, intel, arch, funcIntel);
        console.log(`Built FTS5 search index (${Object.keys(intel.api_registry ?? {}).length} endpoints indexed)`);

        // Populate module_metrics from structural-intelligence.json (if present).
        try {
          const siRaw = await (await import("node:fs/promises")).readFile(
            (await import("node:path")).join(machineDir, "structural-intelligence.json"), "utf8"
          );
          const siReports = JSON.parse(siRaw);
          if (Array.isArray(siReports) && siReports.length > 0) {
            store.rebuildModuleMetrics(siReports);
            console.log(`Indexed ${siReports.length} module metrics`);
          }
        } catch { /* structural-intelligence.json not generated yet — skip */ }

        // Embed functions for semantic (vector) search.
        // Uses local on-device model by default (no API key needed).
        // If OPENAI_API_KEY is set, uses OpenAI text-embedding-3-small (better quality).
        if (funcIntel?.functions?.length) {
          console.log(`[guardian embed] embedding ${funcIntel.functions.length} functions…`);
          try {
            await embedFunctions(store, funcIntel.functions, process.env.OPENAI_API_KEY);
          } catch (err) {
            console.warn(`[guardian embed] skipped: ${(err as Error).message}`);
          }
        }
      }

      console.log(`Wrote guardian.db → ${layout.rootDir}`);
    } finally {
      await store.close();
    }
    return;
  }

  // ── File path (default): original behavior, unchanged ──
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(layout.machineDir, "codebase-intelligence.json");

  await writeCodebaseIntelligence(specsDir, outputPath);
  console.log(`Wrote ${outputPath}`);
}
