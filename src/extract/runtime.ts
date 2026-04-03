import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { SpecGuardConfig } from "../config.js";
import type { RuntimeTopology, RuntimeServiceSummary, SystemManifestSummary } from "./types.js";
import { createIgnoreMatcher } from "./ignore.js";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isDockerfile(name: string): boolean {
  return name === "Dockerfile" || name.startsWith("Dockerfile.");
}

function isComposeFile(name: string): boolean {
  return (
    name === "docker-compose.yml" ||
    name === "docker-compose.yaml" ||
    name === "compose.yml" ||
    name === "compose.yaml"
  );
}

async function listFiles(root: string, ignore: ReturnType<typeof createIgnoreMatcher>): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignore.isIgnoredDir(entry.name, fullPath)) {
        continue;
      }
      files.push(...(await listFiles(fullPath, ignore)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeEnvironment(env: unknown): string[] | undefined {
  if (!env) {
    return undefined;
  }
  if (Array.isArray(env)) {
    return env.map((entry) => String(entry));
  }
  if (typeof env === "object") {
    return Object.entries(env as Record<string, unknown>).map(
      ([key, value]) => `${key}=${String(value)}`
    );
  }
  return undefined;
}

function normalizeArray(value: unknown): string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  return undefined;
}

function parseComposeServices(doc: unknown, source: string): RuntimeServiceSummary[] {
  if (!doc || typeof doc !== "object") {
    return [];
  }
  const services = (doc as Record<string, unknown>).services;
  if (!services || typeof services !== "object") {
    return [];
  }

  const result: RuntimeServiceSummary[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const service = raw as Record<string, unknown>;
    const entry: RuntimeServiceSummary = {
      name,
      source,
      image: typeof service.image === "string" ? service.image : undefined,
      build: typeof service.build === "string" ? service.build : undefined,
      ports: normalizeArray(service.ports),
      environment: normalizeEnvironment(service.environment),
      depends_on: normalizeArray(service.depends_on)
    };
    result.push(entry);
  }

  return result;
}

export async function analyzeRuntime(
  projectRoot: string,
  config: SpecGuardConfig
): Promise<RuntimeTopology> {
  const root = path.resolve(projectRoot);
  const ignore = createIgnoreMatcher(config, root);
  const files = await listFiles(root, ignore);

  const dockerfiles: string[] = [];
  const services: RuntimeServiceSummary[] = [];
  const manifests: SystemManifestSummary[] = [];
  const shell_scripts: string[] = [];

  for (const file of files) {
    const name = path.basename(file);
    const relative = toPosix(path.relative(root, file));

    if (name.endsWith(".sh") || name.endsWith(".bash") || name.endsWith(".zsh") || name.endsWith(".bat") || name.endsWith(".ps1")) {
      shell_scripts.push(relative);
      continue;
    }

    const isRoot = !relative.includes("/");
    const explicitConfigs = new Set([
      "package.json", "pyproject.toml", "requirements.txt", "go.mod", "go.sum",
      "pom.xml", "build.gradle", "Makefile", "makefile", "tslint.json", 
      "eslint.config.js", "tsconfig.json", ".npmrc", "yarn.lock", "package-lock.json"
    ]);

    if (explicitConfigs.has(name) || 
        (relative.startsWith(".github/") && (name.endsWith(".yml") || name.endsWith(".yaml"))) || 
        (isRoot && (name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".md") || name.endsWith(".toml")))) {
      if (!isComposeFile(name)) {
        const manifest = await parseManifest(file, relative, name);
        if (manifest) {
          manifests.push(manifest);
        }
      }
    }

    if (isDockerfile(name)) {
      dockerfiles.push(relative);
      continue;
    }

    if (isComposeFile(name)) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const doc = yaml.load(raw);
        services.push(...parseComposeServices(doc, relative));
      } catch {
        continue;
      }
    }
  }

  dockerfiles.sort((a, b) => a.localeCompare(b));
  manifests.sort((a, b) => a.file.localeCompare(b.file));
  shell_scripts.sort((a, b) => a.localeCompare(b));
  services.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.source.localeCompare(b.source);
  });

  return {
    dockerfiles,
    services,
    manifests,
    shell_scripts
  };
}

async function parseManifest(file: string, relative: string, name: string): Promise<SystemManifestSummary | null> {
  try {
    const raw = await fs.readFile(file, "utf8");

    if (name === "package.json") {
      const parsed = JSON.parse(raw);
      const commands = parsed.scripts ? Object.keys(parsed.scripts) : [];
      const dependencies = parsed.dependencies ? Object.keys(parsed.dependencies) : [];
      const dev_dependencies = parsed.devDependencies ? Object.keys(parsed.devDependencies) : [];
      return { file: relative, kind: "npm", commands, dependencies, dev_dependencies };
    }

    if (name === "Makefile" || name === "makefile") {
      const commands: string[] = [];
      const regex = /^([a-zA-Z0-9_-]+):/gm;
      let match;
      while ((match = regex.exec(raw)) !== null) {
        if (match[1] && match[1] !== ".PHONY") commands.push(match[1]);
      }
      return { file: relative, kind: "makefile", commands };
    }

    if (relative.startsWith(".github/") && (name.endsWith(".yml") || name.endsWith(".yaml"))) {
      const doc = yaml.load(raw) as any;
      if (doc && typeof doc === "object") {
        const description = doc.name || undefined;
        let commands: string[] = [];
        if (doc.jobs && typeof doc.jobs === "object") {
          commands = Object.keys(doc.jobs);
        }
        return { file: relative, kind: "github-action", description, commands };
      }
    }

    if (name === "pyproject.toml") {
      return { file: relative, kind: "poetry" };
    }

    if (name === "go.mod" || name === "go.sum") {
      return { file: relative, kind: "go" };
    }
    
    if (name === "pom.xml" || name === "build.gradle") {
      return { file: relative, kind: "maven" };
    }

    if (name.endsWith(".md")) {
      return { file: relative, kind: "doc" };
    }

    return { file: relative, kind: "unknown" };
  } catch {
    return null;
  }
}
