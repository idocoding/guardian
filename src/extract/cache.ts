import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SPECS_DIR, type SpecGuardConfig } from "../config.js";
import type {
  BackgroundTaskSummary,
  BackendEndpoint,
  ConstantSummary,
  DataModelSummary,
  EnumSummary,
  ExportDetail
} from "./types.js";

const BACKEND_CACHE_VERSION = "specguard-backend-cache-v4";

export type CachedImportUsage = {
  specifier: string;
  symbols: string[];
  wildcard: boolean;
};

export type CachedEndpointModelUsage = {
  handler: string;
  models: string[];
};

export type BackendFileCacheEntry = {
  hash: string;
  mtime: number;
  language: "python" | "javascript";
  importUsages: CachedImportUsage[];
  exports: string[];
  exportDetails: ExportDetail[];
  endpoints: BackendEndpoint[];
  dataModels: DataModelSummary[];
  tasks: BackgroundTaskSummary[];
  enums: EnumSummary[];
  constants: ConstantSummary[];
  endpointModelUsage: CachedEndpointModelUsage[];
};

export type BackendExtractionCache = {
  version: string;
  configHash: string;
  files: Record<string, BackendFileCacheEntry>;
};

export async function loadBackendExtractionCache(params: {
  projectRoot: string;
  config: SpecGuardConfig;
}): Promise<{ cachePath: string; cache: BackendExtractionCache }> {
  const cachePath = path.join(params.projectRoot, DEFAULT_SPECS_DIR, ".cache", "file-hashes.json");
  const configHash = hashObject(params.config);

  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as BackendExtractionCache;
    if (
      parsed &&
      parsed.version === BACKEND_CACHE_VERSION &&
      parsed.configHash === configHash &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return { cachePath, cache: parsed };
    }
  } catch {
    // ignore
  }

  return {
    cachePath,
    cache: {
      version: BACKEND_CACHE_VERSION,
      configHash,
      files: {}
    }
  };
}

export async function saveBackendExtractionCache(
  cachePath: string,
  cache: BackendExtractionCache
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hashObject(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
