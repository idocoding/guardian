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
import { randomUUID } from "node:crypto";
import { DEFAULT_SPECS_DIR } from "../config.js";

export type InitOptions = {
  projectRoot?: string;
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

/**
 * Hook script written to .claude/hooks/mcp-first.sh
 *
 * Blocks Read/Glob/Grep until a guardian MCP tool has been called in the
 * current session. Session state lives in /tmp/guardian-used-<SESSION_ID>
 * and is set by the PostToolUse hook (guardian-used.sh) below.
 */
const CLAUDE_CODE_HOOK_SCRIPT = `#!/bin/bash
# Guardian MCP-first hook — blocks Read/Glob/Grep until guardian tools are used.
# Installed by: guardian init  (v3 — session-scoped flag, no time drift)

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"')
FLAG="/tmp/guardian-used-\${SESSION_ID}"

# If guardian was called in this session, allow all file operations.
if [ -f "$FLAG" ]; then
  exit 0
fi

cat >&2 <<'BLOCK'
BLOCKED: Use Guardian MCP tools before exploring source files.

Call one of these first:
  guardian_search("your query")  — find files/symbols/endpoints by keyword
  guardian_grep("pattern")       — semantic grep (replaces Grep tool)
  guardian_glob("src/auth/**")   — semantic file discovery (replaces Glob tool)
  guardian_orient()              — get codebase overview

File reads are unblocked automatically for the rest of this session.
BLOCK

exit 2
`;

/**
 * Hook script written to .claude/hooks/guardian-used.sh
 *
 * Called by PostToolUse after any guardian_* tool. Sets the session flag
 * that mcp-first.sh checks, unblocking subsequent Read/Glob/Grep calls.
 */
const GUARDIAN_USED_SCRIPT = `#!/bin/bash
# Guardian PostToolUse hook — marks guardian as used for this session.
# Installed by: guardian init

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"')
touch "/tmp/guardian-used-\${SESSION_ID}"
exit 0
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

  // 2b. Ensure project_id is present in guardian.config.json
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    if (!cfg.project_id) {
      cfg.project_id = randomUUID();
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("  ✓ Added project_id to guardian.config.json");
    } else {
      console.log("  · guardian.config.json already has project_id");
    }
  } catch {
    // Non-fatal — config may not be valid JSON yet
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
      output: specsDir,
      includeFileGraph: true,
      backend: options.backend,
    });

    const { runGenerate } = await import("./generate.js");
    await runGenerate({
      projectRoot: root,
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
      } catch { /* corrupted — overwrite */ }
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    const servers = mcpConfig.mcpServers as Record<string, unknown>;
    if (!servers.guardian) {
      servers.guardian = { command: "guardian", args: ["mcp-serve", "--specs", specsDir] };
      await fs.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      console.log("  ✓ Created .mcp.json (MCP server config)");
    } else {
      console.log("  · .mcp.json already has guardian MCP config");
    }
  } catch (err) {
    console.warn(`  ⚠ Could not create .mcp.json: ${(err as Error).message}`);
  }

  const claudeDir   = path.join(root, ".claude");
  const hooksDir    = path.join(claudeDir, "hooks");
  const settingsPath    = path.join(claudeDir, "settings.json");
  const mcpFirstPath    = path.join(hooksDir, "mcp-first.sh");
  const guardianUsedPath = path.join(hooksDir, "guardian-used.sh");

  await fs.mkdir(hooksDir, { recursive: true });

  // Always overwrite hook scripts so they stay in sync with this version of guardian.
  await fs.writeFile(mcpFirstPath, CLAUDE_CODE_HOOK_SCRIPT, "utf8");
  await fs.chmod(mcpFirstPath, 0o755);
  console.log("  ✓ Wrote .claude/hooks/mcp-first.sh (PreToolUse — blocks until guardian called)");

  await fs.writeFile(guardianUsedPath, GUARDIAN_USED_SCRIPT, "utf8");
  await fs.chmod(guardianUsedPath, 0o755);
  console.log("  ✓ Wrote .claude/hooks/guardian-used.sh (PostToolUse — sets session flag)");

  // Write or merge .claude/settings.json
  let settings: Record<string, unknown> = {};
  if (await fileExists(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    } catch { /* corrupted — overwrite */ }
  }

  // MCP server registration
  if (!settings.mcpServers) settings.mcpServers = {};
  (settings.mcpServers as Record<string, unknown>).guardian = {
    command: "guardian",
    args: ["mcp-serve", "--specs", specsDir],
  };

  // Hooks — always overwrite to keep in sync with installed scripts.
  settings.hooks = {
    // PreToolUse: block Read/Glob/Grep until a guardian tool has been called.
    // The script itself handles the session-flag check — no "if" filter needed here.
    PreToolUse: [
      {
        matcher: "Read|Glob|Grep",
        hooks: [{ type: "command", command: ".claude/hooks/mcp-first.sh" }],
      },
    ],
    // PostToolUse: set the session flag after any guardian MCP tool call.
    PostToolUse: [
      {
        matcher: "mcp__guardian__guardian_search|mcp__guardian__guardian_orient|mcp__guardian__guardian_context|mcp__guardian__guardian_impact|mcp__guardian__guardian_grep|mcp__guardian__guardian_glob",
        hooks: [{ type: "command", command: ".claude/hooks/guardian-used.sh" }],
      },
    ],
  };

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log("  ✓ Updated .claude/settings.json (MCP server + PreToolUse + PostToolUse hooks)");
}
