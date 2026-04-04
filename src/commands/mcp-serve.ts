/**
 * `guardian mcp-serve` — Model Context Protocol server.
 *
 * Runs as a background process. Claude Code / Cursor connect via stdio.
 * Exposes tools that query codebase-intelligence.json live.
 *
 * Tools:
 *   guardian_file_context   — get upstream/downstream deps for a file
 *   guardian_search         — search models, endpoints, components, modules
 *   guardian_endpoint_trace — trace an endpoint's full call chain
 *   guardian_impact_check   — what files/endpoints are affected by a change
 *   guardian_overview       — project summary and key metrics
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP standard)
 * Spec: https://modelcontextprotocol.io
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export type McpServeOptions = {
  specs: string;
};

// ── Types ──

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
};

// ── Metrics tracking ──

type ToolCallMetric = {
  tool: string;
  args: Record<string, string>;
  timestamp: number;
  response_chars: number;
  estimated_tokens: number;
  cache_hit: boolean;
};

const metrics = {
  session_start: Date.now(),
  calls: [] as ToolCallMetric[],
  intel_reloads: 0,
  cache_hits: 0,

  record(tool: string, args: Record<string, string>, responseText: string, cacheHit: boolean) {
    const chars = responseText.length;
    const estimatedTokens = Math.ceil(chars / 3.5); // rough token estimate
    this.calls.push({
      tool,
      args,
      timestamp: Date.now(),
      response_chars: chars,
      estimated_tokens: estimatedTokens,
      cache_hit: cacheHit,
    });
    if (cacheHit) this.cache_hits++;
  },

  summary() {
    const duration = Math.round((Date.now() - this.session_start) / 1000);
    const totalCalls = this.calls.length;
    const totalTokensSpent = this.calls.reduce((s, c) => s + c.estimated_tokens, 0);
    // Estimate tokens saved: each guardian call replaces ~3 Read/Grep calls (~400 tokens each)
    const estimatedTokensSaved = totalCalls * 400 - totalTokensSpent;
    const toolBreakdown: Record<string, { calls: number; tokens: number }> = {};
    for (const c of this.calls) {
      if (!toolBreakdown[c.tool]) toolBreakdown[c.tool] = { calls: 0, tokens: 0 };
      toolBreakdown[c.tool].calls++;
      toolBreakdown[c.tool].tokens += c.estimated_tokens;
    }

    return {
      session_duration_seconds: duration,
      total_mcp_calls: totalCalls,
      total_tokens_spent: totalTokensSpent,
      estimated_tokens_saved: Math.max(0, estimatedTokensSaved),
      savings_ratio: totalCalls > 0
        ? `${Math.round((estimatedTokensSaved / (totalCalls * 400)) * 100)}%`
        : "n/a",
      cache_hits: this.cache_hits,
      intel_reloads: this.intel_reloads,
      tool_breakdown: toolBreakdown,
      avg_tokens_per_call: totalCalls > 0 ? Math.round(totalTokensSpent / totalCalls) : 0,
    };
  },
};

// ── Response cache (dedup repeated queries) ──

const responseCache = new Map<string, { text: string; time: number }>();
const CACHE_TTL = 30_000; // 30s cache

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.text;
  return null;
}

function setCache(key: string, text: string): void {
  responseCache.set(key, { text, time: Date.now() });
}

// ── Intelligence loader ──

let intel: any = null;
let intelPath = "";
let lastLoadTime = 0;

async function loadIntel(): Promise<any> {
  // Reload if file changed (check every 5s max)
  const now = Date.now();
  if (intel && now - lastLoadTime < 5000) return intel;

  try {
    const raw = await fs.readFile(intelPath, "utf8");
    intel = JSON.parse(raw);
    lastLoadTime = now;
  } catch {
    // Return cached or empty
    if (!intel) {
      intel = { api_registry: {}, model_registry: {}, service_map: [], frontend_pages: [], meta: { project: "unknown", counts: {} } };
    }
  }
  return intel;
}

// ── Helpers ──

const SKIP_SERVICES = new Set(["str", "dict", "int", "len", "float", "max", "join", "getattr", "lower", "open", "params.append", "updates.append"]);

function compact(obj: any): string {
  return JSON.stringify(obj);
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/\//g, "/");
}

function findModule(data: any, file: string) {
  const f = normalize(file);
  return data.service_map?.find((m: any) => {
    const mp = normalize(m.path || "");
    return mp && (f.startsWith(mp + "/") || f === mp);
  }) || data.service_map?.find((m: any) => {
    // Fallback: match by module ID (handles doubled paths)
    const mid = normalize(m.id || "");
    return mid && f.includes(mid);
  });
}

function findEndpointsInFile(data: any, file: string) {
  const f = normalize(file);
  const basename = path.basename(f);
  return Object.values(data.api_registry || {}).filter((ep: any) => {
    const ef = normalize(ep.file || "");
    return ef && (f.includes(ef) || ef.includes(f) || ef.endsWith(basename));
  });
}

function findModelsInFile(data: any, file: string) {
  const f = normalize(file);
  const basename = path.basename(f);
  return Object.values(data.model_registry || {}).filter((m: any) => {
    const mf = normalize(m.file || "");
    return mf && (f.includes(mf) || mf.includes(f) || mf.endsWith(basename));
  });
}

// ── Tool implementations (compact JSON, no redundancy) ──

async function orient(): Promise<string> {
  // Read architecture-context.md first — it has the richest summary
  const contextPath = path.join(path.dirname(intelPath), "architecture-context.md");
  try {
    const raw = await fs.readFile(contextPath, "utf8");
    // Extract the content between guardian:context markers
    const match = raw.match(/<!-- guardian:context[^>]*-->([\s\S]*?)<!-- \/guardian:context -->/);
    if (match) {
      // Parse the markdown into compact structured data
      const content = match[1];
      const lines = content.split("\n").map((l: string) => l.trim()).filter(Boolean);

      // Extract key sections
      const desc = raw.match(/Description: (.+)/)?.[1] || "";
      const codeMap = lines.find((l: string) => l.startsWith("**Backend:**")) || "";

      // Module map with exports
      const moduleLines = lines.filter((l: string) => l.startsWith("- **backend/") || l.startsWith("- **frontend/"));
      const modules = moduleLines.map((l: string) => {
        const m = l.match(/\*\*([^*]+)\*\*\s*\(([^)]+)\)\s*[—–-]\s*(.*)/);
        return m ? [m[1], m[2], m[3].slice(0, 60)] : null;
      }).filter(Boolean);

      // Dependencies
      const deps = lines.filter((l: string) => l.includes("→")).map((l: string) => l.replace(/^- /, ""));

      // High-coupling files
      const coupling = lines.filter((l: string) => l.match(/score \d/)).map((l: string) => l.replace(/^- /, ""));

      // Structural intelligence
      const si = lines.filter((l: string) => l.includes("depth=")).map((l: string) => l.replace(/^- /, ""));

      // Model-endpoint map
      const modelEp = lines.filter((l: string) => l.includes("endpoints) ->")).map((l: string) => l.replace(/^- /, ""));

      return compact({
        desc: desc.slice(0, 120),
        map: codeMap,
        modules,
        deps,
        coupling: coupling.slice(0, 5),
        si: si.slice(0, 5),
        modelEp,
      });
    }
  } catch {}

  // Fallback: build from codebase-intelligence.json
  const d = await loadIntel();
  const c = d.meta?.counts || {};
  // Compute endpoint counts from api_registry (service_map counts are often 0)
  const epByMod: Record<string, number> = {};
  for (const ep of Object.values(d.api_registry || {}) as any[]) {
    epByMod[ep.module] = (epByMod[ep.module] || 0) + 1;
  }
  const mods = (d.service_map || []).filter((m: any) => m.file_count > 0);
  const topMods = mods
    .map((m: any) => ({ ...m, ep_count: epByMod[m.id] || 0 }))
    .sort((a: any, b: any) => b.ep_count - a.ep_count)
    .slice(0, 6);
  return compact({
    p: d.meta?.project,
    ep: c.endpoints, mod: c.models, pg: c.pages, m: c.modules,
    top: topMods.map((m: any) => [m.id, m.ep_count, m.layer]),
    pages: (d.frontend_pages || []).map((p: any) => p.path),
  });
}

async function context(args: { target: string }): Promise<string> {
  const d = await loadIntel();
  const t = args.target;

  // Check if target is an endpoint (e.g. "POST /sessions/start")
  const epMatch = t.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
  if (epMatch) {
    const ep: any = d.api_registry?.[`${epMatch[1].toUpperCase()} ${epMatch[2]}`]
      || Object.values(d.api_registry || {}).find((e: any) => e.method === epMatch![1].toUpperCase() && e.path === epMatch![2]);
    if (!ep) return compact({ err: "not found" });
    const svcs = (ep.service_calls || []).filter((s: string) => !SKIP_SERVICES.has(s));
    return compact({
      ep: `${ep.method} ${ep.path}`, h: ep.handler, f: ep.file, m: ep.module,
      req: ep.request_schema, res: ep.response_schema,
      calls: svcs, ai: ep.ai_operations?.length || 0,
    });
  }

  // Otherwise treat as file path
  const file = t.replace(/^\.\//, "");
  const mod = findModule(d, file);
  const eps = findEndpointsInFile(d, file);
  const models = findModelsInFile(d, file);

  const fileName = path.basename(file, path.extname(file));
  const calledBy: string[] = [];
  for (const ep of Object.values(d.api_registry || {}) as any[]) {
    if (ep.service_calls?.some((s: string) => s.toLowerCase().includes(fileName.toLowerCase()))) {
      calledBy.push(`${ep.method} ${ep.path}`);
    }
  }

  const calls = eps.flatMap((ep: any) => (ep.service_calls || []).filter((s: string) => !SKIP_SERVICES.has(s)));

  return compact({
    f: file,
    mod: mod ? [mod.id, mod.layer] : null,
    ep: eps.map((e: any) => `${e.method} ${e.path}`),
    models: models.map((m: any) => [m.name, m.fields?.length || 0]),
    calls: [...new Set(calls)],
    calledBy: calledBy.slice(0, 8),
  });
}

async function impact(args: { target: string }): Promise<string> {
  const d = await loadIntel();
  const file = args.target.replace(/^\.\//, "");

  const eps = findEndpointsInFile(d, file);
  const models = findModelsInFile(d, file);
  const modelNames = new Set(models.map((m: any) => m.name));

  const affectedEps = Object.values(d.api_registry || {}).filter((ep: any) =>
    (ep.request_schema && modelNames.has(ep.request_schema)) ||
    (ep.response_schema && modelNames.has(ep.response_schema))
  );

  const mod = findModule(d, file);
  const depMods = mod ? (d.service_map || []).filter((m: any) => m.imports?.includes(mod.id)) : [];

  const affectedPages = (d.frontend_pages || []).filter((p: any) =>
    p.api_calls?.some((call: string) => eps.some((ep: any) => call.includes(ep.path?.split("{")[0])))
  );

  const total = eps.length + affectedEps.length + depMods.length + affectedPages.length;

  return compact({
    f: file,
    risk: total > 5 ? "HIGH" : total > 2 ? "MED" : "LOW",
    ep: eps.map((e: any) => `${e.method} ${e.path}`),
    models: models.map((m: any) => m.name),
    affectedEp: affectedEps.map((e: any) => `${e.method} ${e.path}`),
    depMods: depMods.map((m: any) => m.id),
    pages: affectedPages.map((p: any) => p.path),
  });
}

async function search(args: { query: string }): Promise<string> {
  const d = await loadIntel();
  const q = args.query.toLowerCase();

  const eps = Object.values(d.api_registry || {}).filter((ep: any) =>
    ep.path?.toLowerCase().includes(q) || ep.handler?.toLowerCase().includes(q) ||
    ep.service_calls?.some((s: string) => s.toLowerCase().includes(q))
  ).slice(0, 8).map((ep: any) => `${(ep as any).method} ${(ep as any).path} [${(ep as any).module}]`);

  const models = Object.values(d.model_registry || {}).filter((m: any) =>
    m.name?.toLowerCase().includes(q) || m.fields?.some((f: string) => f.toLowerCase().includes(q))
  ).slice(0, 8).map((m: any) => `${(m as any).name}:${(m as any).fields?.length}f`);

  const mods = (d.service_map || []).filter((m: any) =>
    m.id?.toLowerCase().includes(q)
  ).slice(0, 5).map((m: any) => `${m.id}:${m.endpoint_count}ep`);

  return compact({ ep: eps, mod: models, m: mods });
}

async function model(args: { name: string }): Promise<string> {
  const d = await loadIntel();
  const m = d.model_registry?.[args.name];
  if (!m) return compact({ err: "not found" });

  const usedBy = Object.values(d.api_registry || {}).filter((ep: any) =>
    ep.request_schema === args.name || ep.response_schema === args.name
  ).map((ep: any) => `${ep.method} ${ep.path}`);

  return compact({
    name: m.name, fw: m.framework, f: m.file,
    fields: m.fields, rels: m.relationships,
    usedBy,
  });
}

// ── MCP protocol ──

const TOOLS: Tool[] = [
  {
    name: "guardian_orient",
    description: "Compact project summary. Call at session start. Returns: project name, counts, top modules, page routes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "guardian_context",
    description: "Get dependencies for a file or endpoint. Pass a file path (e.g. 'backend/service-conversation/engine.py') or an endpoint (e.g. 'POST /sessions/start').",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path or 'METHOD /path' endpoint" },
      },
      required: ["target"],
    },
  },
  {
    name: "guardian_impact",
    description: "What breaks if you change this file? Returns affected endpoints, models, modules, pages, and risk level.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path to check" },
      },
      required: ["target"],
    },
  },
  {
    name: "guardian_search",
    description: "Find endpoints, models, modules by keyword. Returns compact one-line results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
      },
      required: ["query"],
    },
  },
  {
    name: "guardian_model",
    description: "Get full field list and usage for a specific model. Only call when you need field details.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Model name (e.g. 'StartSessionRequest')" },
      },
      required: ["name"],
    },
  },
  {
    name: "guardian_metrics",
    description: "MCP usage stats for this session. Call at end to evaluate guardian's usefulness.",
    inputSchema: { type: "object", properties: {} },
  },
];

const TOOL_HANDLERS: Record<string, (args: any) => Promise<string>> = {
  guardian_orient: orient,
  guardian_context: context,
  guardian_impact: impact,
  guardian_search: search,
  guardian_model: model,
  guardian_metrics: async () => compact(metrics.summary()),
};

function respond(id: number | string | null, result: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: number | string | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "guardian", version: "0.1.0" },
      });
      break;

    case "initialized":
      // Client acknowledgment — no response needed
      break;

    case "tools/list":
      respond(req.id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = req.params?.name;
      const toolArgs = req.params?.arguments || {};
      const handler = TOOL_HANDLERS[toolName];

      if (!handler) {
        respond(req.id, {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
        break;
      }

      try {
        // Check cache first
        const cacheKey = `${toolName}:${JSON.stringify(toolArgs)}`;
        const cached = getCached(cacheKey);
        if (cached) {
          metrics.record(toolName, toolArgs, cached, true);
          respond(req.id, { content: [{ type: "text", text: cached }] });
          break;
        }

        const result = await handler(toolArgs);
        setCache(cacheKey, result);
        metrics.record(toolName, toolArgs, result, false);
        respond(req.id, {
          content: [{ type: "text", text: result }],
        });
      } catch (err) {
        respond(req.id, {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      respondError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ── Entry point ──

export async function runMcpServe(options: McpServeOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  intelPath = path.join(specsDir, "machine", "codebase-intelligence.json");

  // Pre-load intelligence
  await loadIntel();

  // Log to stderr (stdout is for MCP protocol)
  process.stderr.write(`Guardian MCP server started. Intelligence: ${intelPath}\n`);
  process.stderr.write(`Tools: ${TOOLS.map((t) => t.name).join(", ")}\n`);

  // Read JSON-RPC messages from stdin, line by line
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      await handleRequest(req);
    } catch (err) {
      respondError(null, -32700, `Parse error: ${(err as Error).message}`);
    }
  });

  rl.on("close", async () => {
    // Persist session metrics to .specs/machine/mcp-metrics.jsonl
    const metricsPath = path.join(specsDir, "machine", "mcp-metrics.jsonl");
    try {
      const entry = JSON.stringify({
        ...metrics.summary(),
        session_end: new Date().toISOString(),
      });
      await fs.appendFile(metricsPath, entry + "\n", "utf8");
      process.stderr.write(`Guardian metrics saved to ${metricsPath}\n`);
    } catch {}
    process.stderr.write("Guardian MCP server stopped.\n");
    process.exit(0);
  });
}
