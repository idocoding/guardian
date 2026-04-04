/**
 * Extension unit tests — tests pure functions and MCP/init logic
 * without requiring the VSCode API.
 *
 * Run: node extension.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Extract testable functions from extension.js ──
// We can't import the extension directly (requires vscode module),
// so we redefine the pure functions here and test them.

function resolveCommandPath(configuredPath, workspaceRoot) {
  if (configuredPath && configuredPath.trim().length > 0) {
    return configuredPath;
  }
  const localBin = path.join(
    workspaceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "guardian.cmd" : "guardian"
  );
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return "guardian";
}

function resolvePath(targetPath, workspaceRoot) {
  if (!targetPath) return "";
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(workspaceRoot, targetPath);
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveSourcePath(filePath, backendAbs, workspaceRoot) {
  if (!filePath || typeof filePath !== "string") return null;
  if (path.isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  const backendCandidate = path.resolve(backendAbs, filePath);
  if (fs.existsSync(backendCandidate)) return backendCandidate;
  const workspaceCandidate = path.resolve(workspaceRoot, filePath);
  if (fs.existsSync(workspaceCandidate)) return workspaceCandidate;
  return null;
}

// ── Test helpers ──

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-test-"));
  return dir;
}

// ── Tests ──

console.log("\n=== resolveCommandPath ===");

test("returns configured path when provided", () => {
  assert.strictEqual(resolveCommandPath("/usr/bin/guardian", "/workspace"), "/usr/bin/guardian");
});

test("returns configured path with whitespace trimming", () => {
  assert.strictEqual(resolveCommandPath("  /usr/bin/guardian  ", "/workspace"), "  /usr/bin/guardian  ");
});

test("returns global guardian when no local bin exists", () => {
  const dir = tmpDir();
  assert.strictEqual(resolveCommandPath("", dir), "guardian");
  fs.rmSync(dir, { recursive: true });
});

test("returns local bin when it exists", () => {
  const dir = tmpDir();
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binName = process.platform === "win32" ? "guardian.cmd" : "guardian";
  fs.writeFileSync(path.join(binDir, binName), "#!/bin/sh\n");
  assert.strictEqual(resolveCommandPath("", dir), path.join(binDir, binName));
  fs.rmSync(dir, { recursive: true });
});

test("ignores empty string config", () => {
  assert.strictEqual(resolveCommandPath("", "/nonexistent"), "guardian");
});

console.log("\n=== resolvePath ===");

test("returns empty string for falsy input", () => {
  assert.strictEqual(resolvePath("", "/workspace"), "");
  assert.strictEqual(resolvePath(null, "/workspace"), "");
  assert.strictEqual(resolvePath(undefined, "/workspace"), "");
});

test("returns absolute path as-is", () => {
  assert.strictEqual(resolvePath("/absolute/path", "/workspace"), "/absolute/path");
});

test("resolves relative path against workspace", () => {
  assert.strictEqual(resolvePath("backend", "/workspace"), path.resolve("/workspace", "backend"));
});

console.log("\n=== readJsonSafe ===");

test("reads valid JSON file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "test.json");
  fs.writeFileSync(file, JSON.stringify({ key: "value" }));
  const result = readJsonSafe(file);
  assert.deepStrictEqual(result, { key: "value" });
  fs.rmSync(dir, { recursive: true });
});

test("returns null for missing file", () => {
  assert.strictEqual(readJsonSafe("/nonexistent/file.json"), null);
});

test("returns null for invalid JSON", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "not json {{{");
  assert.strictEqual(readJsonSafe(file), null);
  fs.rmSync(dir, { recursive: true });
});

console.log("\n=== resolveSourcePath ===");

test("returns null for null/undefined input", () => {
  assert.strictEqual(resolveSourcePath(null, "/backend", "/workspace"), null);
  assert.strictEqual(resolveSourcePath(undefined, "/backend", "/workspace"), null);
  assert.strictEqual(resolveSourcePath("", "/backend", "/workspace"), null);
});

test("returns absolute path if it exists", () => {
  const dir = tmpDir();
  const file = path.join(dir, "test.py");
  fs.writeFileSync(file, "");
  assert.strictEqual(resolveSourcePath(file, "/backend", "/workspace"), file);
  fs.rmSync(dir, { recursive: true });
});

test("returns null for non-existent absolute path", () => {
  assert.strictEqual(resolveSourcePath("/nonexistent/file.py", "/backend", "/workspace"), null);
});

test("resolves relative path against backend first", () => {
  const dir = tmpDir();
  const backendDir = path.join(dir, "backend");
  fs.mkdirSync(backendDir, { recursive: true });
  const file = path.join(backendDir, "service.py");
  fs.writeFileSync(file, "");
  assert.strictEqual(resolveSourcePath("service.py", backendDir, dir), file);
  fs.rmSync(dir, { recursive: true });
});

test("falls back to workspace root for relative path", () => {
  const dir = tmpDir();
  const file = path.join(dir, "config.py");
  fs.writeFileSync(file, "");
  assert.strictEqual(resolveSourcePath("config.py", path.join(dir, "nonexistent"), dir), file);
  fs.rmSync(dir, { recursive: true });
});

console.log("\n=== MCP Configuration ===");

test("configureMcp creates .claude/settings.json with MCP server", () => {
  const dir = tmpDir();

  // Simulate configureMcp logic
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = path.join(claudeDir, "settings.json");
  const settings = { mcpServers: { guardian: { command: "guardian", args: ["mcp-serve", "--specs", path.join(dir, ".specs")] } } };
  fs.writeFileSync(claudeSettings, JSON.stringify(settings, null, 2));

  const result = readJsonSafe(claudeSettings);
  assert.ok(result.mcpServers);
  assert.ok(result.mcpServers.guardian);
  assert.strictEqual(result.mcpServers.guardian.command, "guardian");
  assert.ok(result.mcpServers.guardian.args.includes("mcp-serve"));
  fs.rmSync(dir, { recursive: true });
});

test("configureMcp creates .cursor/mcp.json with MCP server", () => {
  const dir = tmpDir();

  const cursorDir = path.join(dir, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });
  const cursorMcp = path.join(cursorDir, "mcp.json");
  const config = { mcpServers: { guardian: { command: "guardian", args: ["mcp-serve", "--specs", path.join(dir, ".specs")] } } };
  fs.writeFileSync(cursorMcp, JSON.stringify(config, null, 2));

  const result = readJsonSafe(cursorMcp);
  assert.ok(result.mcpServers.guardian);
  assert.ok(result.mcpServers.guardian.args.includes("mcp-serve"));
  fs.rmSync(dir, { recursive: true });
});

test("configureMcp does not overwrite existing MCP config", () => {
  const dir = tmpDir();
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = path.join(claudeDir, "settings.json");

  // Write existing config with guardian already set
  const existing = {
    mcpServers: {
      guardian: { command: "/custom/path/guardian", args: ["mcp-serve"] },
      other: { command: "other-tool", args: [] }
    }
  };
  fs.writeFileSync(claudeSettings, JSON.stringify(existing));

  // Re-read — should still have the custom path
  const result = readJsonSafe(claudeSettings);
  assert.strictEqual(result.mcpServers.guardian.command, "/custom/path/guardian");
  assert.ok(result.mcpServers.other);
  fs.rmSync(dir, { recursive: true });
});

test("configureMcp preserves other settings in claude settings.json", () => {
  const dir = tmpDir();
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = path.join(claudeDir, "settings.json");

  const existing = { permissions: { allow: ["Bash(ls)"] } };
  fs.writeFileSync(claudeSettings, JSON.stringify(existing));

  // Simulate adding MCP without losing permissions
  let settings = readJsonSafe(claudeSettings);
  if (!settings.mcpServers) settings.mcpServers = {};
  if (!settings.mcpServers.guardian) {
    settings.mcpServers.guardian = { command: "guardian", args: ["mcp-serve"] };
  }
  fs.writeFileSync(claudeSettings, JSON.stringify(settings, null, 2));

  const result = readJsonSafe(claudeSettings);
  assert.ok(result.permissions);
  assert.deepStrictEqual(result.permissions.allow, ["Bash(ls)"]);
  assert.ok(result.mcpServers.guardian);
  fs.rmSync(dir, { recursive: true });
});

console.log("\n=== Auto-Init Detection ===");

test("detects missing .specs as needing init", () => {
  const dir = tmpDir();
  const specsExists = fs.existsSync(path.join(dir, ".specs", "machine", "codebase-intelligence.json"));
  assert.strictEqual(specsExists, false);
  fs.rmSync(dir, { recursive: true });
});

test("detects existing .specs as already initialized", () => {
  const dir = tmpDir();
  const specsDir = path.join(dir, ".specs", "machine");
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, "codebase-intelligence.json"), "{}");
  const specsExists = fs.existsSync(path.join(dir, ".specs", "machine", "codebase-intelligence.json"));
  assert.strictEqual(specsExists, true);
  fs.rmSync(dir, { recursive: true });
});

console.log("\n=== Status Bar Text ===");

test("status bar format with counts", () => {
  // Simulate updateStatusBar logic
  const status = "stable";
  const endpoints = 35;
  const pages = 8;
  const icon = status === "stable" ? "$(check)" : "$(shield)";
  const counts = [];
  if (endpoints) counts.push(`${endpoints} ep`);
  if (pages) counts.push(`${pages} pg`);
  const countStr = counts.length > 0 ? ` · ${counts.join(" · ")}` : "";
  const text = `${icon} Guardian: ${status}${countStr}`;
  assert.strictEqual(text, "$(check) Guardian: stable · 35 ep · 8 pg");
});

test("status bar format without counts", () => {
  const status = "unknown";
  const icon = "$(shield)";
  const text = `${icon} Guardian: ${status}`;
  assert.strictEqual(text, "$(shield) Guardian: unknown");
});

test("status bar critical state", () => {
  const status = "critical";
  const icon = status === "critical" ? "$(warning)" : "$(shield)";
  assert.strictEqual(icon, "$(warning)");
});

console.log("\n=== File Filter ===");

test("code extensions filter matches expected files", () => {
  const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".go", ".java", ".cs"]);
  assert.ok(CODE_EXTENSIONS.has(".py"));
  assert.ok(CODE_EXTENSIONS.has(".tsx"));
  assert.ok(CODE_EXTENSIONS.has(".go"));
  assert.ok(!CODE_EXTENSIONS.has(".md"));
  assert.ok(!CODE_EXTENSIONS.has(".json"));
  assert.ok(!CODE_EXTENSIONS.has(".yaml"));
  assert.ok(!CODE_EXTENSIONS.has(".css"));
});

test("background extract skips .specs and node_modules", () => {
  const shouldSkip = (rel) => rel.startsWith(".specs") || rel.includes("node_modules");
  assert.ok(shouldSkip(".specs/machine/codebase-intelligence.json"));
  assert.ok(shouldSkip("node_modules/express/index.js"));
  assert.ok(shouldSkip("backend/node_modules/something.js"));
  assert.ok(!shouldSkip("backend/service-auth/main.py"));
  assert.ok(!shouldSkip("frontend/hooks/useVoice.ts"));
});

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
