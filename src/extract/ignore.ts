import path from "node:path";
import type { SpecGuardConfig } from "../config.js";

export type IgnoreMatcher = {
  isIgnoredDir: (name: string, fullPath: string) => boolean;
  isIgnoredPath: (relativePath: string) => boolean;
};

export function createIgnoreMatcher(config: SpecGuardConfig, baseRoot: string): IgnoreMatcher {
  const ignoreDirs = new Set(config.ignore?.directories ?? []);
  const ignorePaths = normalizeIgnorePaths(config.ignore?.paths ?? [], baseRoot);

  const isIgnoredPath = (relativePath: string): boolean => {
    const normalized = normalizeRelative(relativePath);
    if (!normalized) {
      return false;
    }

    for (const prefix of ignorePaths) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
    }

    const segments = normalized.split("/").filter(Boolean);
    return segments.some((segment) => ignoreDirs.has(segment));
  };

  const isIgnoredDir = (name: string, fullPath: string): boolean => {
    if (name.startsWith(".")) {
      return true;
    }
    if (ignoreDirs.has(name)) {
      return true;
    }
    const relative = path.relative(baseRoot, fullPath);
    return isIgnoredPath(relative);
  };

  return { isIgnoredDir, isIgnoredPath };
}

function normalizeIgnorePaths(paths: string[], baseRoot: string): string[] {
  const normalized = new Set<string>();
  for (const entry of paths) {
    const resolved = path.isAbsolute(entry) ? path.relative(baseRoot, entry) : entry;
    const cleaned = normalizeRelative(resolved);
    if (cleaned) {
      normalized.add(cleaned);
    }
  }
  return Array.from(normalized);
}

function normalizeRelative(relativePath: string): string {
  const cleaned = relativePath.split(path.sep).join("/");
  const trimmed = cleaned.startsWith("./") ? cleaned.slice(2) : cleaned;
  return trimmed.trim();
}
