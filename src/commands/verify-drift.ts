import fs from "node:fs/promises";
import path from "node:path";
import { computeProjectDrift } from "../extract/drift.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";

export type VerifyDriftOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
  baseline?: string;
  strictThreshold?: string;
};

export async function runVerifyDrift(options: VerifyDriftOptions): Promise<void> {
  const resolved = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  logResolvedProjectPaths(resolved);

  const drift = await computeProjectDrift({
    backendRoot: resolved.backendRoot,
    frontendRoot: resolved.frontendRoot,
    configPath: options.configPath
  });

  const config = resolved.config;
  const projectRoot = resolved.workspaceRoot;
  const baselinePath =
    options.baseline || config.drift?.baselinePath || "specs-out/baseline.json";
  const resolvedBaseline = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(projectRoot, baselinePath);

  let baselinePayload: any = null;
  try {
    const raw = await fs.readFile(resolvedBaseline, "utf8");
    baselinePayload = JSON.parse(raw);
  } catch (error) {
    console.log(`[Warning] Could not load baseline at ${resolvedBaseline}`);
  }

  const threshold = options.strictThreshold ? parseFloat(options.strictThreshold) : 0.15;

  console.log("=========================================");
  console.log("Guardian Drift Verification");
  console.log("=========================================\n");
  console.log(`Current Status: ${drift.status}`);
  console.log(`Current Delta:  ${drift.delta.toFixed(4)}`);
  console.log(`Current K_t:    ${drift.K_t.toFixed(4)}`);

  let failed = false;

  if (drift.status === "critical") {
    console.error(`\n[ERROR] Drift status is "critical". Reached critical capacity limits.`);
    failed = true;
  }

  if (baselinePayload && baselinePayload.drift) {
    const baselineDelta = baselinePayload.drift.delta ?? 0;
    const shift = Math.abs(drift.delta - baselineDelta);
    console.log(`\nBaseline Delta: ${baselineDelta.toFixed(4)}`);
    console.log(`Coupling Shift: ${shift.toFixed(4)} (Threshold: ${threshold})`);

    if (shift > threshold) {
      console.error(`\n[ERROR] Architectural coupling shift (${shift.toFixed(4)}) exceeded strict threshold (${threshold}).`);
      failed = true;
    }
  }

  console.log("=========================================");
  if (failed) {
    console.error("Verification FAILED. Architectural drift guardrails breached.");
    process.exit(1);
  } else {
    console.log("Verification PASSED. Architecture remains within acceptable limits.");
  }
}
