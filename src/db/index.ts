/**
 * Public API for the specs store module.
 *
 * Usage:
 *   import { openSpecsStore } from "./db/index.js";
 *   const store = await openSpecsStore(layout);
 *   const entry = await store.readSpec("codebase-intelligence");
 *   await store.close();
 *
 * The adapter is chosen automatically:
 *   - If guardian.db exists in the specs root → SqliteSpecsStore
 *   - Otherwise → FileSpecsStore (current behavior, fully backward-compatible)
 *
 * To force SQLite (e.g. during `guardian extract --backend sqlite`):
 *   const store = await openSpecsStore(layout, { backend: "sqlite" });
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OutputLayout } from "../output-layout.js";
import type { SpecsStore } from "./specs-store.js";
import { FileSpecsStore } from "./file-specs-store.js";
import { SqliteSpecsStore, DB_FILENAME } from "./sqlite-specs-store.js";

export type { SpecsStore, SpecEntry, DocEntry, MetricEvent, SpecFormat, Tier } from "./specs-store.js";
export { FileSpecsStore } from "./file-specs-store.js";
export { SqliteSpecsStore, DB_FILENAME } from "./sqlite-specs-store.js";

export type StoreBackend = "auto" | "file" | "sqlite";

export interface OpenStoreOptions {
  backend?: StoreBackend;
}

/**
 * Open the appropriate SpecsStore for the given output layout.
 * Always calls store.init() before returning.
 *
 * backend "auto" (default): use SQLite if guardian.db exists, else file
 * backend "sqlite":         require SQLite (caller must handle missing db)
 * backend "file":           always use file store
 */
export async function openSpecsStore(
  layout: OutputLayout,
  options: OpenStoreOptions = {},
): Promise<SpecsStore> {
  // "auto" and undefined both probe for guardian.db
  const requested = options.backend ?? "auto";
  const resolved = requested === "auto" || requested === undefined
    ? await detectBackend(layout.rootDir)
    : requested;

  let store: SpecsStore;
  if (resolved === "sqlite") {
    store = new SqliteSpecsStore(layout.rootDir);
  } else {
    store = new FileSpecsStore(layout.machineDir, layout.humanDir);
  }

  await store.init();
  return store;
}

async function detectBackend(rootDir: string): Promise<StoreBackend> {
  try {
    await fs.stat(path.join(rootDir, DB_FILENAME));
    return "sqlite";
  } catch {
    return "file";
  }
}
