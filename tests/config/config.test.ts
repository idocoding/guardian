import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { loadSpecGuardConfig, type SpecGuardConfig } from "../../src/config.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "config");

async function scaffold() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
}
async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("Config Loader", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  it("returns defaults when no config file exists", async () => {
    const config = await loadSpecGuardConfig({
      projectRoot: FIXTURE_DIR,
    });
    expect(config).toBeDefined();
    expect(config.ignore?.directories).toContain("node_modules");
    expect(config.ignore?.directories).toContain(".git");
    expect(config.drift?.graphLevel).toBe("module");
    expect(config.drift?.criticalDelta).toBe(0.25);
  });

  it("loads and merges config from specguard.config.json", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        drift: { critical_delta: 0.5, graph_level: "function" },
        docs: { mode: "full" },
      })
    );

    const config = await loadSpecGuardConfig({
      configPath: configPath,
    });

    expect(config.drift?.criticalDelta).toBe(0.5);
    expect(config.drift?.graphLevel).toBe("function");
    expect(config.docs?.mode).toBe("full");
    // defaults should still be present
    expect(config.ignore?.directories).toContain("node_modules");

    await fs.rm(configPath);
  });

  it("normalizes snake_case keys to camelCase", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        drift: {
          graph_level: "function",
          baseline_path: "custom/baseline.json",
          history_path: "custom/history.jsonl",
        },
        python: {
          absolute_import_roots: ["src", "lib"],
        },
        frontend: {
          route_dirs: ["pages", "views"],
          tsconfig_path: "tsconfig.app.json",
        },
      })
    );

    const config = await loadSpecGuardConfig({
      configPath: configPath,
    });

    expect(config.drift?.graphLevel).toBe("function");
    expect(config.drift?.baselinePath).toBe("custom/baseline.json");
    expect(config.drift?.historyPath).toBe("custom/history.jsonl");
    expect(config.python?.absoluteImportRoots).toContain("src");
    expect(config.python?.absoluteImportRoots).toContain("lib");
    expect(config.frontend?.routeDirs).toContain("pages");
    expect(config.frontend?.tsconfigPath).toBe("tsconfig.app.json");

    await fs.rm(configPath);
  });

  it("merges arrays additively rather than replacing", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ignore: {
          directories: ["custom_dir"],
        },
      })
    );

    const config = await loadSpecGuardConfig({
      configPath: configPath,
    });

    // Should contain both default + custom
    expect(config.ignore?.directories).toContain("node_modules");
    expect(config.ignore?.directories).toContain("custom_dir");

    await fs.rm(configPath);
  });

  it("merges drift weights with defaults", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        drift: {
          weights: { entropy: 0.6 },
        },
      })
    );

    const config = await loadSpecGuardConfig({
      configPath: configPath,
    });

    expect(config.drift?.weights?.entropy).toBe(0.6);
    // Others should be defaults
    expect(config.drift?.weights?.crossLayer).toBe(0.3);
    expect(config.drift?.weights?.cycles).toBe(0.2);
    expect(config.drift?.weights?.modularity).toBe(0.1);

    await fs.rm(configPath);
  });

  it("normalizes llm snake_case keys", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        llm: {
          timeout_ms: 60000,
          prompt_template: "custom prompt",
        },
      })
    );

    const config = await loadSpecGuardConfig({
      configPath: configPath,
    });

    expect(config.llm?.timeoutMs).toBe(60000);
    expect(config.llm?.promptTemplate).toBe("custom prompt");

    await fs.rm(configPath);
  });

  it("throws on invalid config file path", async () => {
    await expect(
      loadSpecGuardConfig({
        configPath: path.join(FIXTURE_DIR, "nonexistent.json"),
      })
    ).rejects.toThrow();
  });

  it("resolves config from directory containing specguard.config.json", async () => {
    const configPath = path.join(FIXTURE_DIR, "specguard.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ docs: { mode: "full" } })
    );

    const config = await loadSpecGuardConfig({
      configPath: FIXTURE_DIR,
    });

    expect(config.docs?.mode).toBe("full");
    await fs.rm(configPath);
  });

  describe("resolveConfigPath and loadConfig edge cases", () => {
    it("handles absolute configPath pointing to a directory", async () => {
      const configPath = path.join(FIXTURE_DIR, "backend");
      await fs.mkdir(configPath, { recursive: true });
      await fs.writeFile(path.join(configPath, "specguard.config.json"), JSON.stringify({}));
      const config = await loadSpecGuardConfig({ configPath });
      expect(config).toBeDefined();
      expect(config.ignore?.directories).toContain("node_modules");
      await fs.rm(configPath, { recursive: true });
    });

    it("throws error when configPath points to non-existent directory", async () => {
      const badPath = path.join(FIXTURE_DIR, "does-not-exist");
      await expect(loadSpecGuardConfig({ configPath: badPath })).rejects.toThrow(/Config path not found/);
    });

    it("throws error when guardian.config.json is missing in provided configPath directory", async () => {
      const emptyDir = path.join(FIXTURE_DIR, "empty-dir");
      await fs.mkdir(emptyDir, { recursive: true });
      await expect(loadSpecGuardConfig({ configPath: emptyDir })).rejects.toThrow(/guardian.config.json not found/);
      await fs.rm(emptyDir, { recursive: true });
    });

    it("handles empty project structure and uses common root logic", async () => {
      // By passing irrelevant paths, it should fallback to process.cwd, which won't find a config,
      // and thus return the DEFAULT_CONFIG.
      const config = await loadSpecGuardConfig({
        projectRoot: "/tmp/fake/proj",
        backendRoot: "/tmp/fake/proj/backend",
      });
      expect(config).toBeDefined();
      // Default config doesn't have custom ignores
      expect(config.ignore?.directories || []).not.toContain("custom_ignore");
    });

    it("findCommonRoot works for disparate paths", async () => {
      // Since findCommonRoot is an internal helper, we test it indirectly
      // via loadConfig with paths that share a root where we put a config.
      const commonRoot = path.join(FIXTURE_DIR, "common-root-test");
      await fs.mkdir(path.join(commonRoot, "frontend", "src"), { recursive: true });
      await fs.mkdir(path.join(commonRoot, "backend", "api"), { recursive: true });
      
      await fs.writeFile(
        path.join(commonRoot, "specguard.config.json"),
        JSON.stringify({ ignore: { directories: ["common_test"] } })
      );

      const config = await loadSpecGuardConfig({
        frontendRoot: path.join(commonRoot, "frontend", "src"),
        backendRoot: path.join(commonRoot, "backend", "api"),
      });

      expect(config.ignore?.directories).toContain("common_test");

      await fs.rm(commonRoot, { recursive: true, force: true });
    });
  });
});
