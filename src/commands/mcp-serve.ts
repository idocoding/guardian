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

// ── Tool implementations ──

async function fileContext(args: { file: string }): Promise<string> {
  const data = await loadIntel();
  const file = args.file.replace(/^\.\//, "");

  // Find which module this file belongs to
  const module = data.service_map?.find((m: any) =>
    m.path && file.startsWith(m.path.replace(/^\.\//, ""))
  );

  // Find endpoints in this file
  const endpoints = Object.values(data.api_registry || {}).filter((ep: any) =>
    ep.file && file.includes(ep.file.replace(/^\.\//, ""))
  );

  // Find models in this file
  const models = Object.values(data.model_registry || {}).filter((m: any) =>
    m.file && file.includes(m.file.replace(/^\.\//, ""))
  );

  // Find which endpoints call services defined in this file
  const calledBy: string[] = [];
  const fileName = path.basename(file, path.extname(file));
  for (const [key, ep] of Object.entries(data.api_registry || {})) {
    const e = ep as any;
    if (e.service_calls?.some((s: string) => s.toLowerCase().includes(fileName.toLowerCase()))) {
      calledBy.push(`${e.method} ${e.path} (${e.handler})`);
    }
  }

  // Find what this file's endpoints call
  const calls = endpoints.flatMap((ep: any) =>
    (ep.service_calls || []).filter((s: string) =>
      !["str", "dict", "int", "len", "float", "max", "join", "getattr"].includes(s)
    )
  );

  // Find frontend pages that use APIs from this module
  const pages = (data.frontend_pages || []).filter((p: any) =>
    p.api_calls?.some((call: string) =>
      endpoints.some((ep: any) => call.includes(ep.path?.split("{")[0]))
    )
  );

  return JSON.stringify({
    file,
    module: module ? { id: module.id, layer: module.layer, file_count: module.file_count, imports: module.imports } : null,
    endpoints_in_file: endpoints.map((ep: any) => `${ep.method} ${ep.path} → ${ep.handler}`),
    models_in_file: models.map((m: any) => `${m.name} (${m.framework}, ${m.fields?.length || 0} fields)`),
    calls_downstream: [...new Set(calls)],
    called_by_upstream: calledBy.slice(0, 10),
    frontend_pages_using: pages.map((p: any) => p.path),
    coupling: module?.coupling_score ?? null,
  }, null, 2);
}

async function search(args: { query: string; types?: string }): Promise<string> {
  const data = await loadIntel();
  const q = args.query.toLowerCase();
  const types = (args.types || "models,endpoints,modules").split(",").map((t: string) => t.trim());
  const results: any = {};

  if (types.includes("endpoints")) {
    results.endpoints = Object.values(data.api_registry || {})
      .filter((ep: any) =>
        ep.path?.toLowerCase().includes(q) ||
        ep.handler?.toLowerCase().includes(q) ||
        ep.service_calls?.some((s: string) => s.toLowerCase().includes(q))
      )
      .slice(0, 10)
      .map((ep: any) => `${ep.method} ${ep.path} → ${ep.handler} [${ep.module}]`);
  }

  if (types.includes("models")) {
    results.models = Object.values(data.model_registry || {})
      .filter((m: any) =>
        m.name?.toLowerCase().includes(q) ||
        m.fields?.some((f: string) => f.toLowerCase().includes(q))
      )
      .slice(0, 10)
      .map((m: any) => `${m.name} (${m.framework}, ${m.fields?.length} fields, ${m.file})`);
  }

  if (types.includes("modules")) {
    results.modules = (data.service_map || [])
      .filter((m: any) =>
        m.id?.toLowerCase().includes(q) ||
        m.path?.toLowerCase().includes(q)
      )
      .slice(0, 10)
      .map((m: any) => `${m.id} (${m.type}, ${m.endpoint_count} eps, ${m.file_count} files, imports: ${m.imports?.join(",") || "none"})`);
  }

  return JSON.stringify(results, null, 2);
}

async function endpointTrace(args: { method: string; path: string }): Promise<string> {
  const data = await loadIntel();
  const key = `${args.method.toUpperCase()} ${args.path}`;
  const ep = data.api_registry?.[key] || Object.values(data.api_registry || {}).find((e: any) =>
    e.method === args.method.toUpperCase() && e.path === args.path
  );

  if (!ep) return JSON.stringify({ error: `Endpoint ${key} not found` });

  // Find which frontend pages call this endpoint
  const frontendCallers = (data.frontend_pages || []).filter((p: any) =>
    p.api_calls?.some((call: string) => call.includes(args.path.split("{")[0]))
  );

  // Find what models this endpoint uses
  const models = Object.values(data.model_registry || {}).filter((m: any) =>
    (ep as any).request_schema === m.name || (ep as any).response_schema === m.name
  );

  return JSON.stringify({
    endpoint: `${(ep as any).method} ${(ep as any).path}`,
    handler: (ep as any).handler,
    file: (ep as any).file,
    module: (ep as any).module,
    request_schema: (ep as any).request_schema,
    response_schema: (ep as any).response_schema,
    service_calls: (ep as any).service_calls,
    ai_operations: (ep as any).ai_operations,
    patterns: (ep as any).patterns,
    models_used: models.map((m: any) => ({ name: m.name, fields: m.fields })),
    frontend_callers: frontendCallers.map((p: any) => p.path),
  }, null, 2);
}

async function impactCheck(args: { file: string }): Promise<string> {
  const data = await loadIntel();
  const file = args.file.replace(/^\.\//, "");

  // Find all endpoints in this file
  const endpoints = Object.values(data.api_registry || {}).filter((ep: any) =>
    ep.file && file.includes(ep.file.replace(/^\.\//, ""))
  );

  // Find all models in this file
  const models = Object.values(data.model_registry || {}).filter((m: any) =>
    m.file && file.includes(m.file.replace(/^\.\//, ""))
  );

  // Find endpoints that USE these models
  const modelNames = new Set(models.map((m: any) => m.name));
  const affectedEndpoints = Object.values(data.api_registry || {}).filter((ep: any) =>
    ep.request_schema && modelNames.has(ep.request_schema) ||
    ep.response_schema && modelNames.has(ep.response_schema)
  );

  // Find modules that import from this file's module
  const fileModule = data.service_map?.find((m: any) =>
    m.path && file.startsWith(m.path.replace(/^\.\//, ""))
  );
  const dependentModules = fileModule
    ? (data.service_map || []).filter((m: any) => m.imports?.includes(fileModule.id))
    : [];

  // Find frontend pages affected
  const affectedPages = (data.frontend_pages || []).filter((p: any) =>
    p.api_calls?.some((call: string) =>
      endpoints.some((ep: any) => call.includes(ep.path?.split("{")[0]))
    )
  );

  return JSON.stringify({
    file,
    direct_endpoints: endpoints.map((ep: any) => `${ep.method} ${ep.path}`),
    models_defined: models.map((m: any) => m.name),
    endpoints_using_these_models: affectedEndpoints.map((ep: any) => `${ep.method} ${ep.path}`),
    dependent_modules: dependentModules.map((m: any) => m.id),
    affected_frontend_pages: affectedPages.map((p: any) => p.path),
    risk: endpoints.length + affectedEndpoints.length + dependentModules.length > 5 ? "HIGH" : "LOW",
  }, null, 2);
}

async function overview(): Promise<string> {
  const data = await loadIntel();
  return JSON.stringify({
    project: data.meta?.project,
    counts: data.meta?.counts,
    modules: (data.service_map || [])
      .filter((m: any) => m.file_count > 0)
      .map((m: any) => ({ id: m.id, type: m.type, layer: m.layer, endpoints: m.endpoint_count, files: m.file_count, imports: m.imports })),
    pages: (data.frontend_pages || []).map((p: any) => ({ route: p.path, component: p.component })),
    top_endpoints: Object.values(data.api_registry || {})
      .sort((a: any, b: any) => (b.service_calls?.length || 0) - (a.service_calls?.length || 0))
      .slice(0, 5)
      .map((ep: any) => `${ep.method} ${ep.path} (${ep.service_calls?.length || 0} service calls)`),
  }, null, 2);
}

// ── MCP protocol ──

const TOOLS: Tool[] = [
  {
    name: "guardian_file_context",
    description: "Get upstream/downstream dependencies, endpoints, models, and coupling for a file. Call this BEFORE editing any file.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path relative to project root (e.g. 'backend/service-conversation/engine.py')" },
      },
      required: ["file"],
    },
  },
  {
    name: "guardian_search",
    description: "Search the codebase for endpoints, models, or modules matching a keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword (e.g. 'session', 'auth', 'TTS')" },
        types: { type: "string", description: "Comma-separated: models,endpoints,modules (default: all)" },
      },
      required: ["query"],
    },
  },
  {
    name: "guardian_endpoint_trace",
    description: "Trace an API endpoint's full chain: frontend callers, handler, service calls, models, AI operations.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE)" },
        path: { type: "string", description: "Endpoint path (e.g. '/sessions/start')" },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "guardian_impact_check",
    description: "Check what endpoints, models, modules, and pages are affected if you change a file. Call this BEFORE making changes to high-coupling files.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path to check impact for" },
      },
      required: ["file"],
    },
  },
  {
    name: "guardian_overview",
    description: "Get project summary: modules, pages, top endpoints, counts. Call this at session start for orientation.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const TOOL_HANDLERS: Record<string, (args: any) => Promise<string>> = {
  guardian_file_context: fileContext,
  guardian_search: search,
  guardian_endpoint_trace: endpointTrace,
  guardian_impact_check: impactCheck,
  guardian_overview: overview,
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
        const result = await handler(toolArgs);
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

  rl.on("close", () => {
    process.stderr.write("Guardian MCP server stopped.\n");
    process.exit(0);
  });
}
