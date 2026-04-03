import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { ArchitectureSnapshot, UxSnapshot } from "./types.js";

export async function writeSnapshots(
  outputDir: string,
  architecture: ArchitectureSnapshot,
  ux: UxSnapshot
): Promise<{ architecturePath: string; uxPath: string }> {
  await fs.mkdir(outputDir, { recursive: true });

  const architecturePath = path.join(outputDir, "architecture.snapshot.yaml");
  const uxPath = path.join(outputDir, "ux.snapshot.yaml");

  await fs.writeFile(
    architecturePath,
    yaml.dump(architecture, { noRefs: true, lineWidth: 120 })
  );
  await fs.writeFile(uxPath, yaml.dump(ux, { noRefs: true, lineWidth: 120 }));

  return { architecturePath, uxPath };
}
