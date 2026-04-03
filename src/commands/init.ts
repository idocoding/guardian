/**
 * `guardian init` — initialize guardian for a project.
 *
 * Creates:
 *   1. guardian.config.json (if missing)
 *   2. .specs/ directory
 *   3. Pre-commit hook that auto-runs extract + context injection
 *   4. Injects guardian context block into CLAUDE.md
 *   5. Adds .specs/ to .gitignore exclusion (tracked by default)
 *
 * Safe to run multiple times — only creates what's missing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SPECS_DIR } from "../config.js";

export type InitOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  output?: string;
  skipHook?: boolean;
};

const DEFAULT_CONFIG = {
  project: {
    backendRoot: "./backend",
    frontendRoot: "./frontend",
  },
  docs: {
    mode: "full",
  },
};

const HOOK_SCRIPT = `#!/bin/sh
# guardian pre-commit hook — keeps architecture context fresh
# Installed by: guardian init

# Only run if guardian is available
if ! command -v guardian >/dev/null 2>&1; then
  exit 0
fi

# Run extract + ai-context generation (fast, ~2-5s)
guardian extract --output .specs 2>/dev/null
guardian generate --ai-context --output .specs 2>/dev/null

# Inject context into CLAUDE.md if it exists
if [ -f CLAUDE.md ]; then
  guardian context --input .specs --output CLAUDE.md 2>/dev/null
fi

# Auto-stage the updated files
git add .specs/machine/architecture-context.md 2>/dev/null
git add CLAUDE.md 2>/dev/null

exit 0
`;

export async function runInit(options: InitOptions): Promise<void> {
  const root = path.resolve(options.projectRoot || process.cwd());
  const specsDir = path.join(root, options.output || DEFAULT_SPECS_DIR);

  console.log(`Initializing Guardian in ${root}\n`);

  // 1. Create .specs/ directory
  await fs.mkdir(path.join(specsDir, "machine", "docs"), { recursive: true });
  await fs.mkdir(path.join(specsDir, "human", "docs"), { recursive: true });
  console.log("  ✓ Created .specs/ directory");

  // 2. Create guardian.config.json if missing
  const configPath = path.join(root, "guardian.config.json");
  if (!(await fileExists(configPath))) {
    const config = { ...DEFAULT_CONFIG };
    // Auto-detect roots
    if (options.backendRoot) {
      config.project.backendRoot = options.backendRoot;
    } else {
      for (const candidate of ["./backend", "./server", "./api", "./src"]) {
        if (await dirExists(path.join(root, candidate))) {
          config.project.backendRoot = candidate;
          break;
        }
      }
    }
    if (options.frontendRoot) {
      config.project.frontendRoot = options.frontendRoot;
    } else {
      for (const candidate of ["./frontend", "./client", "./web", "./app"]) {
        if (await dirExists(path.join(root, candidate))) {
          config.project.frontendRoot = candidate;
          break;
        }
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    console.log(`  ✓ Created guardian.config.json (backend: ${config.project.backendRoot}, frontend: ${config.project.frontendRoot})`);
  } else {
    console.log("  · guardian.config.json already exists");
  }

  // 3. Install pre-commit hook
  if (!options.skipHook) {
    const gitDir = path.join(root, ".git");
    if (await dirExists(gitDir)) {
      const hooksDir = path.join(gitDir, "hooks");
      await fs.mkdir(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, "pre-commit");

      let shouldInstall = true;
      if (await fileExists(hookPath)) {
        const existing = await fs.readFile(hookPath, "utf8");
        if (existing.includes("guardian")) {
          console.log("  · Pre-commit hook already has guardian");
          shouldInstall = false;
        } else {
          // Append to existing hook
          const appended = existing.trimEnd() + "\n\n" + HOOK_SCRIPT.split("\n").slice(1).join("\n");
          await fs.writeFile(hookPath, appended, "utf8");
          await fs.chmod(hookPath, 0o755);
          console.log("  ✓ Appended guardian to existing pre-commit hook");
          shouldInstall = false;
        }
      }

      if (shouldInstall) {
        await fs.writeFile(hookPath, HOOK_SCRIPT, "utf8");
        await fs.chmod(hookPath, 0o755);
        console.log("  ✓ Installed pre-commit hook (.git/hooks/pre-commit)");
      }
    } else {
      console.log("  · No .git directory found — skipping hook installation");
    }
  }

  // 4. Inject context block into CLAUDE.md
  const claudeMdPath = path.join(root, "CLAUDE.md");
  if (await fileExists(claudeMdPath)) {
    const existing = await fs.readFile(claudeMdPath, "utf8");
    if (!existing.includes("guardian:auto-context")) {
      const block = [
        "",
        "<!-- guardian:auto-context -->",
        "<!-- This block is auto-updated by guardian. Do not edit manually. -->",
        `<!-- Run: guardian extract --output .specs && guardian context --input .specs --output CLAUDE.md -->`,
        "<!-- /guardian:auto-context -->",
        "",
      ].join("\n");
      await fs.writeFile(claudeMdPath, existing.trimEnd() + "\n" + block, "utf8");
      console.log("  ✓ Added guardian placeholder to CLAUDE.md");
    } else {
      console.log("  · CLAUDE.md already has guardian context block");
    }
  } else {
    // Create minimal CLAUDE.md
    const projectName = path.basename(root);
    const content = [
      `# ${projectName}`,
      "",
      "## SpecGuard Architecture Context",
      "",
      "<!-- guardian:auto-context -->",
      "<!-- This block is auto-updated by guardian. Do not edit manually. -->",
      `<!-- Run: guardian extract --output .specs && guardian context --input .specs --output CLAUDE.md -->`,
      "<!-- /guardian:auto-context -->",
      "",
    ].join("\n");
    await fs.writeFile(claudeMdPath, content, "utf8");
    console.log("  ✓ Created CLAUDE.md with guardian context block");
  }

  // 5. Run initial extract + context injection
  console.log("\n  Running initial extraction...");
  try {
    const { runExtract } = await import("./extract.js");
    await runExtract({
      projectRoot: root,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: specsDir,
      includeFileGraph: true,
    });

    const { runGenerate } = await import("./generate.js");
    await runGenerate({
      projectRoot: root,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: specsDir,
      aiContext: true,
    });

    // Inject context into CLAUDE.md
    const { runContext } = await import("./context.js");
    await runContext({
      input: specsDir,
      output: claudeMdPath,
    });

    console.log("\n✓ SpecGuard initialized. Architecture context is in CLAUDE.md and .specs/");
    console.log("  Pre-commit hook will keep it fresh on every commit.");
  } catch (err) {
    console.error(`\n  ⚠ Initial extraction failed: ${(err as Error).message}`);
    console.log("  Run manually: guardian extract --output .specs");
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
