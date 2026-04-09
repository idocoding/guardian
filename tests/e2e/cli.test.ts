import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "cli-e2e");

async function scaffold() {
  const srcDir = path.join(FIXTURE_DIR, "src");
  await fs.mkdir(srcDir, { recursive: true });

  await fs.writeFile(
    path.join(FIXTURE_DIR, "package.json"),
    JSON.stringify({
      name: "test-e2e-project",
      scripts: { build: "echo build" },
      dependencies: { express: "^4.0.0" },
    })
  );

  await fs.writeFile(
    path.join(srcDir, "app.ts"),
    `
import { Router } from "express";
const app = Router();
app.get("/api/health", (req, res) => res.json({ ok: true }));
export default app;
`
  );

  await fs.writeFile(path.join(FIXTURE_DIR, "README.md"), "# E2E Test");
}

async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

function runCli(command: string): string {
  return execSync(`node ${path.join(PROJECT_ROOT, "dist", "cli.js")} ${command}`, {
    cwd: FIXTURE_DIR,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("CLI End-to-End", () => {
  beforeAll(async () => {
    await scaffold();
    execSync("npm run build", { cwd: PROJECT_ROOT, encoding: "utf8" });
  }, 120_000); // tsc can take 30-60s — give it 2 minutes
  afterAll(teardown);

  it("`generate --ai-context` produces architecture-context.md", () => {
    runCli("generate . --ai-context");
    const contextPath = path.join(FIXTURE_DIR, ".specs", "machine", "architecture-context.md");
    const exists = require("node:fs").existsSync(contextPath);
    expect(exists).toBe(true);

    const content = require("node:fs").readFileSync(contextPath, "utf8");
    expect(content).toContain("guardian:ai-context");
    expect(content).toContain("Codebase Map");
  });

  it("context file includes project name from directory", () => {
    const contextPath = path.join(FIXTURE_DIR, ".specs", "machine", "architecture-context.md");
    const content = require("node:fs").readFileSync(contextPath, "utf8");
    expect(content).toContain("cli-e2e");
  });

  it("`extract` produces architecture snapshot YAML", () => {
    runCli("extract .");
    const snapshotPath = path.join(FIXTURE_DIR, ".specs", "machine", "architecture.snapshot.yaml");
    const exists = require("node:fs").existsSync(snapshotPath);
    expect(exists).toBe(true);
  });

  it("`extract` produces infra.md with npm manifest", () => {
    const infraPath = path.join(FIXTURE_DIR, ".specs", "machine", "docs", "infra.md");
    const exists = require("node:fs").existsSync(infraPath);
    expect(exists).toBe(true);

    const content = require("node:fs").readFileSync(infraPath, "utf8");
    expect(content).toContain("[npm]");
    expect(content).toContain("build");
  });

  it("`extract` produces docs index listing infra.md", () => {
    const indexPath = path.join(FIXTURE_DIR, ".specs", "machine", "docs", "index.md");
    const exists = require("node:fs").existsSync(indexPath);
    expect(exists).toBe(true);

    const content = require("node:fs").readFileSync(indexPath, "utf8");
    expect(content).toContain("infra.md");
  });
});
