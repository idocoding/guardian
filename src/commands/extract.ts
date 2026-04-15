import fs from "node:fs/promises";
import path from "node:path";
import { extractProject } from "../extract/index.js";
import { runIntel } from "./intel.js";
import { runGenerate } from "./generate.js";
import { runContext } from "./context.js";

export type ExtractOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  includeFileGraph: boolean;
  configPath?: string;
  docsMode?: "lean" | "full";
  /** Storage backend for guardian.db — "sqlite" builds FTS index after extract */
  backend?: "file" | "sqlite";
};

export async function runExtract(options: ExtractOptions): Promise<void> {
  // Default to sqlite so every extract builds guardian.db automatically.
  // Pass --backend file to opt out (e.g. CI environments that don't need search).
  const backend = options.backend ?? "sqlite";

  const { architecturePath, uxPath } = await extractProject(options);

  console.log(`Wrote ${architecturePath}`);
  console.log(`Wrote ${uxPath}`);

  // Auto-build codebase intelligence after every extract
  const specsDir = path.resolve(options.output);
  try {
    await runIntel({ specs: specsDir, backend });
  } catch {
    // Non-fatal — intel build failure should not break extract
  }

  // Auto-generate AI context + inject into CLAUDE.md
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  try {
    await runGenerate({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: specsDir,
      aiContext: true,
    });

    const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
    try {
      await fs.stat(claudeMdPath);
      await runContext({ input: specsDir, output: claudeMdPath });
    } catch {
      // No CLAUDE.md — skip context injection
    }
  } catch {
    // Non-fatal — context generation failure should not break extract
  }
}
