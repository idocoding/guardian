/**
 * FileSpecsStore — filesystem implementation of SpecsStore.
 *
 * This is a drop-in wrapper around the existing file-based behavior.
 * It maps each SpecsStore call to the exact same read/write the codebase
 * did before the interface existed, so no existing behavior changes.
 *
 * File layout (unchanged):
 *   <machineDir>/
 *     architecture.snapshot.yaml
 *     ux.snapshot.yaml
 *     codebase-intelligence.json
 *     structural-intelligence.json
 *     function-intelligence.json
 *     mcp-metrics.jsonl
 *   <humanDir>/
 *     overview.md
 *     modules/
 *       src-extract.md
 *       ...
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  SpecsStore,
  SpecEntry,
  DocEntry,
  MetricEvent,
  SpecFormat,
  Tier,
} from "./specs-store.js";

/** Maps spec name → filename on disk. */
const SPEC_FILENAMES: Record<string, string> = {
  "architecture.snapshot":    "architecture.snapshot.yaml",
  "ux.snapshot":              "ux.snapshot.yaml",
  "codebase-intelligence":    "codebase-intelligence.json",
  "structural-intelligence":  "structural-intelligence.json",
  "function-intelligence":    "function-intelligence.json",
  "mcp-metrics":              "mcp-metrics.jsonl",
};

function nameToFilename(name: string): string {
  return SPEC_FILENAMES[name] ?? `${name}.json`;
}

function filenameToFormat(filename: string): SpecFormat {
  if (filename.endsWith(".yaml")) return "yaml";
  if (filename.endsWith(".jsonl")) return "jsonl";
  if (filename.endsWith(".json")) return "json";
  return "text";
}

export class FileSpecsStore implements SpecsStore {
  constructor(
    private readonly machineDir: string,
    private readonly humanDir: string,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.machineDir, { recursive: true });
    await fs.mkdir(this.humanDir, { recursive: true });
  }

  async close(): Promise<void> {
    // nothing to close for file IO
  }

  // ── Spec blobs ─────────────────────────────────────────────────────────────

  async readSpec(name: string): Promise<SpecEntry | null> {
    const filename = nameToFilename(name);
    const filePath = path.join(this.machineDir, filename);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const stat = await fs.stat(filePath);
      return {
        name,
        format: filenameToFormat(filename),
        content,
        tier: "free",
        updatedAt: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async writeSpec(name: string, content: string, format: SpecFormat, tier: Tier = "free"): Promise<void> {
    const filename = nameToFilename(name);
    await fs.writeFile(path.join(this.machineDir, filename), content, "utf8");
  }

  async listSpecs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.machineDir);
      return entries
        .filter(e => e.endsWith(".json") || e.endsWith(".yaml") || e.endsWith(".jsonl"))
        .map(e => {
          const found = Object.entries(SPEC_FILENAMES).find(([, v]) => v === e);
          return found ? found[0] : e;
        });
    } catch {
      return [];
    }
  }

  async hasSpec(name: string): Promise<boolean> {
    const filename = nameToFilename(name);
    try {
      await fs.stat(path.join(this.machineDir, filename));
      return true;
    } catch {
      return false;
    }
  }

  // ── Human docs ─────────────────────────────────────────────────────────────

  async readDoc(id: string): Promise<DocEntry | null> {
    const filePath = this._docPath(id);
    try {
      const body = await fs.readFile(filePath, "utf8");
      const stat = await fs.stat(filePath);
      const title = body.match(/^#\s+(.+)$/m)?.[1] ?? id;
      return { id, section: id.split(":")[0], title, body, tier: "free", updatedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  async writeDoc(entry: Omit<DocEntry, "updatedAt">): Promise<void> {
    const filePath = this._docPath(entry.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, entry.body, "utf8");
  }

  async listDocs(section?: string): Promise<DocEntry[]> {
    const results: DocEntry[] = [];
    await this._walkDocs(this.humanDir, results, section);
    return results;
  }

  private async _walkDocs(dir: string, acc: DocEntry[], section?: string): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await this._walkDocs(full, acc, section);
      } else if (e.endsWith(".md")) {
        const id = path.relative(this.humanDir, full).replace(/\.md$/, "").replace(/\\/g, "/");
        if (section && !id.startsWith(section)) continue;
        const body = await fs.readFile(full, "utf8");
        const title = body.match(/^#\s+(.+)$/m)?.[1] ?? id;
        acc.push({ id, section: id.split("/")[0], title, body, tier: "free", updatedAt: stat.mtimeMs });
      }
    }
  }

  private _docPath(id: string): string {
    return path.join(this.humanDir, `${id.replace(/:/g, "/")}.md`);
  }

  // ── Metrics log ────────────────────────────────────────────────────────────

  async appendMetric(event: string, payload: object): Promise<void> {
    const line = JSON.stringify({ ts: Date.now(), event, payload }) + "\n";
    await fs.appendFile(path.join(this.machineDir, "mcp-metrics.jsonl"), line, "utf8");
  }

  async readMetrics(limit = 1000): Promise<MetricEvent[]> {
    try {
      const raw = await fs.readFile(path.join(this.machineDir, "mcp-metrics.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map(l => JSON.parse(l) as MetricEvent);
    } catch {
      return [];
    }
  }
}
