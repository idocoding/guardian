import path from "node:path";
import { extractProject } from "../extract/index.js";
import { runIntel } from "./intel.js";

export type ExtractOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output: string;
  includeFileGraph: boolean;
  configPath?: string;
  docsMode?: "lean" | "full";
};

export async function runExtract(options: ExtractOptions): Promise<void> {
  const { architecturePath, uxPath } = await extractProject(options);

  console.log(`Wrote ${architecturePath}`);
  console.log(`Wrote ${uxPath}`);

  // Auto-build codebase intelligence after every extract
  const specsDir = path.resolve(options.output);
  try {
    await runIntel({ specs: specsDir });
  } catch {
    // Non-fatal — intel build failure should not break extract
  }
}
