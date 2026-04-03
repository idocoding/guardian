import path from "node:path";
import fs from "node:fs/promises";

export type OutputLayout = {
  rootDir: string;
  machineDir: string;
  machineDocsDir: string;
  machineInternalDir: string;
  humanDir: string;
};

export function getOutputLayout(outputRoot: string, internalDir = "internal"): OutputLayout {
  const rootDir = path.resolve(outputRoot);
  const machineDir = path.join(rootDir, "machine");
  return {
    rootDir,
    machineDir,
    machineDocsDir: path.join(machineDir, "docs"),
    machineInternalDir: path.join(machineDir, "docs", internalDir),
    humanDir: path.join(rootDir, "human")
  };
}

export async function resolveMachineInputDir(input: string): Promise<string> {
  const resolved = path.resolve(input || "specs-out");
  const directSnapshot = await hasMachineSnapshots(resolved);
  if (directSnapshot) {
    return resolved;
  }

  const machineDir = path.join(resolved, "machine");
  if (await hasMachineSnapshots(machineDir)) {
    return machineDir;
  }

  return machineDir;
}

async function hasMachineSnapshots(dir: string): Promise<boolean> {
  try {
    await Promise.all([
      fs.stat(path.join(dir, "architecture.snapshot.yaml")),
      fs.stat(path.join(dir, "ux.snapshot.yaml"))
    ]);
    return true;
  } catch {
    return false;
  }
}
