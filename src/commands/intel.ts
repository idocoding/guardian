/**
 * `guardian intel` — build codebase-intelligence.json from existing snapshots.
 *
 * Reads:  specs-out/machine/architecture.snapshot.yaml + ux.snapshot.yaml
 * Writes: specs-out/machine/codebase-intelligence.json
 *
 * Also auto-runs at the end of `guardian extract`.
 */

import path from "node:path";
import { writeCodebaseIntelligence } from "../extract/codebase-intel.js";
import { getOutputLayout } from "../output-layout.js";

export type IntelOptions = {
  specs: string;
  output?: string;
};

export async function runIntel(options: IntelOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const layout = getOutputLayout(specsDir);
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(layout.machineDir, "codebase-intelligence.json");

  await writeCodebaseIntelligence(specsDir, outputPath);
  console.log(`Wrote ${outputPath}`);
}
