import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SPECS_DIR, loadSpecGuardConfig, type SpecGuardConfig } from "./config.js";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  DEFAULT_SPECS_DIR,
  ".pytest_cache",
  ".mypy_cache",
  ".turbo"
]);

type ResolutionSource = "auto" | "config" | "cli";

export type ProjectResolutionOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
};

export type ResolvedProjectPaths = {
  workspaceRoot: string;
  backendRoot: string;
  frontendRoot: string;
  resolutionSource: ResolutionSource;
  config: SpecGuardConfig;
};

type Candidate = {
  path: string;
  score: number;
  reasons: string[];
};

export async function resolveProjectPaths(
  options: ProjectResolutionOptions
): Promise<ResolvedProjectPaths> {
  const startingRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = await loadSpecGuardConfig({
    projectRoot: startingRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });

  const configWorkspaceRoot = config.project?.root
    ? path.resolve(config.project.root)
    : startingRoot;
  const workspaceRoot = configWorkspaceRoot;
  const detectionEnabled = config.project?.discovery?.enabled ?? true;

  const explicitBackend = options.backendRoot
    ? await normalizeBackendRoot(path.resolve(options.backendRoot))
    : config.project?.backendRoot
      ? await normalizeBackendRoot(path.resolve(config.project.backendRoot))
      : null;
  const explicitFrontend = options.frontendRoot
    ? path.resolve(options.frontendRoot)
    : config.project?.frontendRoot
      ? path.resolve(config.project.frontendRoot)
      : null;

  let resolutionSource: ResolutionSource = "auto";
  if (options.backendRoot || options.frontendRoot) {
    resolutionSource = "cli";
  } else if (config.project?.backendRoot || config.project?.frontendRoot || config.project?.root) {
    resolutionSource = "config";
  }

  if (!detectionEnabled && (!explicitBackend || !explicitFrontend)) {
    throw new Error(
      "Project autodiscovery is disabled in config, but backend/frontend roots were not fully provided."
    );
  }

  const backendRoot =
    explicitBackend ??
    (await chooseBackendRoot(workspaceRoot));
  const frontendRoot =
    explicitFrontend ??
    (await chooseFrontendRoot(workspaceRoot));

  return {
    workspaceRoot,
    backendRoot,
    frontendRoot,
    resolutionSource,
    config
  };
}

export function logResolvedProjectPaths(resolved: ResolvedProjectPaths): void {
  console.log(
    `SpecGuard roots (${resolved.resolutionSource}): workspace=${resolved.workspaceRoot} backend=${resolved.backendRoot} frontend=${resolved.frontendRoot}`
  );
}

async function chooseBackendRoot(workspaceRoot: string): Promise<string> {
  const candidates = await discoverBackendCandidates(workspaceRoot);
  if (candidates.length === 0) {
    console.warn(`⚠️  Could not distinctly auto-detect a backend root. Defaulting to universal workspace root parsing: ${workspaceRoot}`);
    return workspaceRoot;
  }
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    console.warn(`⚠️  Backend autodetection is ambiguous between ${candidates[0].path} and ${candidates[1].path}. Defaulting to universal workspace root parsing.`);
    return workspaceRoot;
  }
  return normalizeBackendRoot(candidates[0].path);
}

async function chooseFrontendRoot(workspaceRoot: string): Promise<string> {
  const candidates = await discoverFrontendCandidates(workspaceRoot);
  if (candidates.length === 0) {
    console.warn(`⚠️  Could not distinctly auto-detect a frontend root. Defaulting to universal workspace root parsing: ${workspaceRoot}`);
    return workspaceRoot;
  }
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    console.warn(`⚠️  Frontend autodetection is ambiguous between ${candidates[0].path} and ${candidates[1].path}. Defaulting to universal workspace root parsing.`);
    return workspaceRoot;
  }
  return path.resolve(candidates[0].path);
}

async function discoverBackendCandidates(workspaceRoot: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const preferredDirs = ["backend", "services", "apps", "server", "api"];

  for (const name of preferredDirs) {
    const target = path.join(workspaceRoot, name);
    const stats = await safeStat(target);
    if (!stats?.isDirectory()) {
      continue;
    }
    const candidate = await scoreBackendDirectory(target, workspaceRoot);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const workspaceCandidate = await scoreBackendDirectory(workspaceRoot, workspaceRoot);
  if (workspaceCandidate) {
    candidates.push(workspaceCandidate);
  }

  const childDirs = await listChildDirs(workspaceRoot);
  for (const dir of childDirs) {
    const candidate = await scoreBackendDirectory(dir, workspaceRoot);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return dedupeAndSortCandidates(candidates);
}

async function discoverFrontendCandidates(workspaceRoot: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const preferredDirs = ["frontend", "web", "client", "app", "ui"];

  for (const name of preferredDirs) {
    const target = path.join(workspaceRoot, name);
    const candidate = await scoreFrontendDirectory(target, workspaceRoot);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const workspaceCandidate = await scoreFrontendDirectory(workspaceRoot, workspaceRoot);
  if (workspaceCandidate) {
    candidates.push(workspaceCandidate);
  }

  const childDirs = await listChildDirs(workspaceRoot);
  for (const dir of childDirs) {
    const candidate = await scoreFrontendDirectory(dir, workspaceRoot);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return dedupeAndSortCandidates(candidates);
}

async function scoreBackendDirectory(dir: string, workspaceRoot: string): Promise<Candidate | null> {
  const stats = await safeStat(dir);
  if (!stats?.isDirectory()) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];
  const name = path.basename(dir).toLowerCase();
  if (name === "backend" || name === "services" || name === "api") {
    score += 4;
    reasons.push(name);
  }

  const files = await listDirNames(dir);
  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("manage.py")) {
    score += 5;
    reasons.push("python-manifest");
  }
  if (files.has("package.json")) {
    const pkg = await readTextIfExists(path.join(dir, "package.json"));
    if (pkg && /(express|fastify|nest|koa)/i.test(pkg)) {
      score += 4;
      reasons.push("node-backend");
    }
  }

  const serviceDirs = await listChildDirs(dir);
  let serviceLikeCount = 0;
  for (const serviceDir of serviceDirs) {
    const serviceFiles = await listDirNames(serviceDir);
    if (
      serviceFiles.has("pyproject.toml") ||
      serviceFiles.has("requirements.txt") ||
      serviceFiles.has("package.json")
    ) {
      serviceLikeCount += 1;
    }
  }
  if (serviceLikeCount >= 2) {
    score += 8 + serviceLikeCount;
    reasons.push(`services:${serviceLikeCount}`);
  }

  const markerFiles = ["main.py", "app.py", "server.py", "index.js", "server.js"];
  for (const marker of markerFiles) {
    const markerPath = path.join(dir, marker);
    const raw = await readTextIfExists(markerPath);
    if (raw && /(FastAPI|APIRouter|Flask|Django|express\(|NestFactory)/.test(raw)) {
      score += 4;
      reasons.push(`marker:${marker}`);
      break;
    }
  }

  if (dir === workspaceRoot && score < 5) {
    return null;
  }

  return score > 0 ? { path: dir, score, reasons } : null;
}

async function scoreFrontendDirectory(dir: string, workspaceRoot: string): Promise<Candidate | null> {
  const stats = await safeStat(dir);
  if (!stats?.isDirectory()) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];
  const name = path.basename(dir).toLowerCase();
  if (["frontend", "web", "client", "ui"].includes(name)) {
    score += 5;
    reasons.push(name);
  }

  const files = await listDirNames(dir);
  const hasPackage = files.has("package.json");
  if (files.has("next.config.js") || files.has("next.config.mjs") || files.has("next.config.ts")) {
    score += 8;
    reasons.push("next");
  }
  if (files.has("vite.config.ts") || files.has("vite.config.js")) {
    score += 7;
    reasons.push("vite");
  }
  if (hasPackage) {
    score += 3;
    const pkg = await readTextIfExists(path.join(dir, "package.json"));
    if (pkg && /(next|react|vue|svelte)/i.test(pkg)) {
      score += 4;
      reasons.push("frontend-package");
    }
  }
  if (files.has("tsconfig.json")) {
    score += 1;
  }

  for (const routeDir of ["app", "pages", path.join("src", "app"), path.join("src", "pages")]) {
    const stat = await safeStat(path.join(dir, routeDir));
    if (stat?.isDirectory()) {
      score += 4;
      reasons.push(`routes:${routeDir}`);
    }
  }

  if (dir === workspaceRoot && score < 5) {
    return null;
  }

  return score > 0 ? { path: dir, score, reasons } : null;
}

function dedupeAndSortCandidates(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    const existing = best.get(resolved);
    if (!existing || candidate.score > existing.score) {
      best.set(resolved, { ...candidate, path: resolved });
    }
  }
  return Array.from(best.values()).sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path)
  );
}

function formatCandidates(candidates: Candidate[]): string {
  return candidates
    .slice(0, 4)
    .map((candidate) => `${candidate.path} (score ${candidate.score})`)
    .join(", ");
}

async function listChildDirs(root: string): Promise<string[]> {
  const entries = await safeReadDir(root);
  return entries
    .filter((entry) => entry.isDirectory() && !IGNORE_DIRS.has(entry.name))
    .map((entry) => path.join(root, entry.name));
}

async function listDirNames(dir: string): Promise<Set<string>> {
  const entries = await safeReadDir(dir);
  return new Set(entries.map((entry) => entry.name));
}

async function safeReadDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function normalizeBackendRoot(backendRoot: string): Promise<string> {
  const resolved = path.resolve(backendRoot);
  const base = path.basename(resolved).toLowerCase();
  if (base === "backend" || base === "src" || base === "services") {
    return resolved;
  }

  const backendCandidate = path.join(resolved, "backend");
  const srcCandidate = path.join(resolved, "src");
  const servicesCandidate = path.join(resolved, "services");

  if ((await safeStat(backendCandidate))?.isDirectory()) {
    return backendCandidate;
  }
  if ((await safeStat(servicesCandidate))?.isDirectory()) {
    return servicesCandidate;
  }
  if ((await safeStat(srcCandidate))?.isDirectory()) {
    return srcCandidate;
  }

  return resolved;
}
