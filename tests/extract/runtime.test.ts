import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeRuntime } from "../../src/extract/runtime.js";
import type { SpecGuardConfig } from "../../src/config.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "runtime");

const DEFAULT_CONFIG: SpecGuardConfig = {
  ignore: {
    directories: ["node_modules", ".git"],
    paths: [],
  },
};

async function scaffold() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });

  // package.json
  await fs.writeFile(
    path.join(FIXTURE_DIR, "package.json"),
    JSON.stringify({
      scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
      dependencies: { express: "^4.18.0", zod: "^3.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    })
  );

  // Makefile
  await fs.writeFile(
    path.join(FIXTURE_DIR, "Makefile"),
    "build:\n\tgo build .\n\ntest:\n\tgo test ./...\n\nclean:\n\trm -rf dist\n"
  );

  // GitHub workflow
  await fs.mkdir(path.join(FIXTURE_DIR, ".github", "workflows"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(FIXTURE_DIR, ".github", "workflows", "ci.yml"),
    "name: CI Pipeline\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n"
  );

  // Shell scripts
  await fs.writeFile(
    path.join(FIXTURE_DIR, "deploy.sh"),
    "#!/bin/bash\necho deploy"
  );
  await fs.writeFile(
    path.join(FIXTURE_DIR, "setup.ps1"),
    "Write-Host setup"
  );

  // Random root markdown
  await fs.writeFile(path.join(FIXTURE_DIR, "README.md"), "# Hello");

  // Dockerfile
  await fs.writeFile(
    path.join(FIXTURE_DIR, "Dockerfile"),
    "FROM node:20\nCOPY . .\n"
  );

  // tsconfig (unknown kind)
  await fs.writeFile(
    path.join(FIXTURE_DIR, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } })
  );
}

async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("analyzeRuntime — Manifest Parsing", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("extracts package.json as npm manifest with commands, deps, and devDeps", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const npm = result.manifests.find((m) => m.file === "package.json");
    expect(npm).toBeDefined();
    expect(npm!.kind).toBe("npm");
    expect(npm!.commands).toEqual(["build", "test", "lint"]);
    expect(npm!.dependencies).toEqual(["express", "zod"]);
    expect(npm!.dev_dependencies).toEqual(["vitest"]);
  });

  it("extracts Makefile targets as commands", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const mk = result.manifests.find((m) => m.file === "Makefile");
    expect(mk).toBeDefined();
    expect(mk!.kind).toBe("makefile");
    expect(mk!.commands).toContain("build");
    expect(mk!.commands).toContain("test");
    expect(mk!.commands).toContain("clean");
  });

  it("skips .github directory (dot-prefix ignore rule)", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const gh = result.manifests.find((m) =>
      m.file.startsWith(".github/workflows/")
    );
    // .github is skipped by the dot-prefix ignore rule in ignore.ts
    expect(gh).toBeUndefined();
  });

  it("discovers shell scripts by extension", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    expect(result.shell_scripts).toContain("deploy.sh");
    expect(result.shell_scripts).toContain("setup.ps1");
  });

  it("discovers Dockerfiles", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    expect(result.dockerfiles).toContain("Dockerfile");
  });

  it("classifies root markdown as doc kind without description", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const readme = result.manifests.find((m) => m.file === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.kind).toBe("doc");
    expect(readme!.description).toBeUndefined();
  });

  it("classifies unknown json/yaml as unknown kind", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const ts = result.manifests.find((m) => m.file === "tsconfig.json");
    expect(ts).toBeDefined();
    expect(ts!.kind).toBe("unknown");
  });

  it("sorts manifests deterministically by file path", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const files = result.manifests.map((m) => m.file);
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
  });

  it("sorts shell scripts deterministically", async () => {
    const result = await analyzeRuntime(FIXTURE_DIR, DEFAULT_CONFIG);
    const sorted = [...result.shell_scripts].sort((a, b) =>
      a.localeCompare(b)
    );
    expect(result.shell_scripts).toEqual(sorted);
  });
});
