/**
 * `guardian init` — initialize guardian for a project.
 *
 * Creates:
 *   1. guardian.config.json (if missing)
 *   2. .specs/ directory
 *   3. Pre-commit hook that auto-runs extract + context injection
 *   4. Injects guardian context block into CLAUDE.md
 *   5. Claude Code hooks (.claude/settings.json + MCP-first enforcement)
 *   6. Adds .specs/ to .gitignore exclusion (tracked by default)
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
  /** Storage backend — "sqlite" builds guardian.db + FTS index during init */
  backend?: "file" | "sqlite";
};

const DEFAULT_CONFIG = {
  docs: {
    mode: "full",
  },
};

const CLAUDE_CODE_HOOK_SCRIPT = `#!/bin/bash
# Guardian MCP-first hook — ensures AI tools use Guardian MCP before reading source files.
# Installed by: guardian init

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

cat >&2 <<BLOCK
BLOCKED: Use Guardian MCP tools before reading source files.

Use these MCP tools first:
  - guardian_orient  — get codebase overview
  - guardian_search  — find features by keyword
  - guardian_context — deep dive into a specific area

Then you can read individual files as needed.
BLOCK

exit 2
`;

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
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    console.log("  ✓ Created guardian.config.json");
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
      "## Guardian Architecture Context",
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

  // 5. Set up Claude Code hooks (.claude/settings.json + hook script)
  await setupClaudeCodeHooks(root, specsDir);

  // 6. Run initial extract + context injection
  console.log("\n  Running initial extraction...");
  try {
    const { runExtract } = await import("./extract.js");
    await runExtract({
      projectRoot: root,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: specsDir,
      includeFileGraph: true,
      backend: options.backend,
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

    console.log("\n✓ Guardian initialized. Architecture context is in CLAUDE.md and .specs/");
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

async function setupClaudeCodeHooks(root: string, specsDir: string): Promise<void> {
  // Create .mcp.json at project root (MCP standard — works with Claude Code, Cursor, etc.)
  const mcpJsonPath = path.join(root, ".mcp.json");
  try {
    let mcpConfig: Record<string, unknown> = {};
    if (await fileExists(mcpJsonPath)) {
      try {
        mcpConfig = JSON.parse(await fs.readFile(mcpJsonPath, "utf8"));
      } catch {
        // Corrupted — overwrite
      }
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    const servers = mcpConfig.mcpServers as Record<string, unknown>;
    if (!servers.guardian) {
      servers.guardian = {
        command: "guardian",
        args: ["mcp-serve", "--specs", specsDir],
      };
      await fs.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      console.log("  ✓ Created .mcp.json (MCP server config)");
    } else {
      console.log("  · .mcp.json already has guardian MCP config");
    }
  } catch (err) {
    console.warn(`  ⚠ Could not create .mcp.json: ${(err as Error).message}`);
  }

  const claudeDir = path.join(root, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  const settingsPath = path.join(claudeDir, "settings.json");
  const hookScriptPath = path.join(hooksDir, "mcp-first.sh");

  await fs.mkdir(hooksDir, { recursive: true });

  // Write the hook script
  if (!(await fileExists(hookScriptPath))) {
    await fs.writeFile(hookScriptPath, CLAUDE_CODE_HOOK_SCRIPT, "utf8");
    await fs.chmod(hookScriptPath, 0o755);
    console.log("  ✓ Created Claude Code MCP-first hook (.claude/hooks/mcp-first.sh)");
  } else {
    console.log("  · Claude Code hook already exists");
  }

  // Write or merge .claude/settings.json
  let settings: Record<string, unknown> = {};
  if (await fileExists(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    } catch {
      // Corrupted file — overwrite
    }
  }

  // Add MCP server config
  if (!settings.mcpServers) settings.mcpServers = {};
  const mcpServers = settings.mcpServers as Record<string, unknown>;
  if (!mcpServers.guardian) {
    mcpServers.guardian = {
      command: "guardian",
      args: ["mcp-serve", "--specs", specsDir],
    };
  }

  // Add PreToolUse hook
  const hookEntry = {
    matcher: "Read|Glob|Grep",
    hooks: [
      {
        type: "command",
        if: "Read(//*/src/*)|Glob(*src*)|Grep(*src*)",
        command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/mcp-first.sh',
      },
    ],
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown>;
  if (!hooks.PreToolUse) {
    hooks.PreToolUse = [hookEntry];
    console.log("  ✓ Configured Claude Code PreToolUse hook in .claude/settings.json");
  } else {
    console.log("  · Claude Code PreToolUse hook already configured");
  }

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log("  ✓ Updated .claude/settings.json (MCP server + hooks)");
}
