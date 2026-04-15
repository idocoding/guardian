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
import { spawn } from "node:child_process";

export type McpServeOptions = {
  specs: string;
  quiet?: boolean;
};

// ── CLI proxy ──
// Resolve the guardian CLI binary relative to this file (dist/cli.js).
const CLI_BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../cli.js");

/** Run a guardian CLI subcommand and return stdout. */
function runCli(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", () => resolve(out.trim() || err.trim() || "{}"));
  });
}

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

// ── Session flag — written on every guardian tool call so the PreToolUse hook knows guardian is active ──
const SESSION_FLAG = "/tmp/guardian-last-call";

// ── Response cache (dedup repeated queries within a session) ──

const responseCache = new Map<string, { text: string; time: number }>();
const CACHE_TTL = 30_000;

function getCached(key: string): string | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.text;
  return null;
}

function setCache(key: string, text: string): void {
  responseCache.set(key, { text, time: Date.now() });
}

// ── Tool implementations — thin CLI proxies ──
// All logic lives in `guardian search`. MCP tools are just structured wrappers.

let specsInputDir = "";

async function orient(): Promise<string> {
  return runCli(["search", "--orient", "--input", specsInputDir]);
}

async function context(args: { target: string }): Promise<string> {
  return runCli(["search", "--file", args.target, "--input", specsInputDir]);
}

async function impact(args: { target: string }): Promise<string> {
  return runCli(["search", "--impact", args.target, "--input", specsInputDir]);
}

async function search(args: { query: string }): Promise<string> {
  return runCli(["search", "--query", args.query, "--format", "json", "--backend", "auto", "--input", specsInputDir]);
}

async function model(args: { name: string }): Promise<string> {
  return runCli(["search", "--model", args.name, "--input", specsInputDir]);
}

/**
 * guardian_grep — semantic grep via guardian search.
 *
 * Replaces raw Grep tool calls. Runs guardian BM25+vector search and returns
 * matching symbols (file:line:name) and files, formatted like grep output.
 * Claude gets richer context (call-graph, authority) with zero token overhead.
 */
async function grep(args: { query: string; path?: string }): Promise<string> {
  const raw = await runCli([
    "search", "--query", args.query, "--format", "json", "--backend", "auto", "--input", specsInputDir,
  ]);
  try {
    const data = JSON.parse(raw);
    const lines: string[] = [`guardian_grep("${args.query}")`];
    if (data.symbols?.length) {
      lines.push("\nSymbols (file:line: name):");
      for (const s of (data.symbols as Array<{ file: string; line: number; name: string }>).slice(0, 25)) {
        lines.push(`  ${s.file}:${s.line}: ${s.name}`);
      }
    }
    if (data.files?.length) {
      lines.push("\nFiles:");
      for (const f of (data.files as Array<{ file_path: string }>).slice(0, 15)) {
        lines.push(`  ${f.file_path}`);
      }
    }
    if (lines.length === 1) lines.push("  (no matches — try a different query)");
    return lines.join("\n");
  } catch {
    return raw; // passthrough if search returns plain text
  }
}

/**
 * guardian_glob — semantic file discovery via guardian search.
 *
 * Replaces raw Glob tool calls. Extracts meaningful keywords from the glob
 * pattern and searches the guardian index for matching files. Falls back to
 * guiding the user toward a more descriptive query for pure extension patterns.
 */
async function glob(args: { pattern: string }): Promise<string> {
  // Extract keywords: "src/auth/**/*.ts" → "auth", "src/middleware/error*" → "middleware error"
  const keywords = args.pattern
    .replace(/\*\*?/g, " ")
    .replace(/\.\w+$/, "")   // strip trailing extension
    .replace(/[[\]{}]/g, " ")
    .split(/[/\s]+/)
    .filter(s => s.length > 2 && !/^(src|lib|dist|app|index)$/.test(s))
    .join(" ")
    .trim();

  if (!keywords) {
    return [
      `guardian_glob("${args.pattern}"): pattern has no meaningful keywords.`,
      `Use guardian_search with a descriptive query instead, e.g.:`,
      `  guardian_search("TypeScript source files") — or describe what you're looking for.`,
    ].join("\n");
  }

  const raw = await runCli([
    "search", "--query", keywords, "--format", "json", "--backend", "auto", "--input", specsInputDir,
  ]);
  try {
    const data = JSON.parse(raw);
    const files = (data.files as Array<{ file_path: string }> | undefined) ?? [];
    const lines = [
      `guardian_glob("${args.pattern}") — searched: "${keywords}"`,
      `\nMatching files:`,
      ...files.slice(0, 20).map(f => `  ${f.file_path}`),
    ];
    if (files.length === 0) lines.push("  (no matches)");
    return lines.join("\n");
  } catch {
    return raw;
  }
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
    description: "Find endpoints, models, modules, exported symbols, files, enums, tasks, and pages by keyword. Returns compact one-line results.",
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
  {
    name: "guardian_grep",
    description: [
      "Semantic grep — find symbols and files matching a keyword or pattern.",
      "Use INSTEAD of the Grep tool. Returns matching function/class names with file:line locations.",
      "Backed by BM25 + call-graph authority so relevant source definitions surface first.",
      "Example: guardian_grep('validate token') → auth.py:42: validate_token, middleware.py:18: check_jwt",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for (natural language OK)" },
        path:  { type: "string", description: "Optional: restrict to files under this path prefix" },
      },
      required: ["query"],
    },
  },
  {
    name: "guardian_glob",
    description: [
      "Semantic file discovery — find files matching a path pattern.",
      "Use INSTEAD of the Glob tool. Extracts keywords from the pattern and searches the guardian index.",
      "Example: guardian_glob('src/auth/**/*.ts') → searches for 'auth typescript' files.",
      "For pure extension globs with no path context, use guardian_search with a descriptive query.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. 'src/auth/**/*.ts', '**/middleware*')" },
      },
      required: ["pattern"],
    },
  },
];

const TOOL_HANDLERS: Record<string, (args: any) => Promise<string>> = {
  guardian_orient:  orient,
  guardian_context: context,
  guardian_impact:  impact,
  guardian_search:  search,
  guardian_model:   model,
  guardian_metrics: async () => JSON.stringify(metrics.summary()),
  guardian_grep:    grep,
  guardian_glob:    glob,
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
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: { name: "guardian", version: "0.1.13" },
      });
      break;

    case "initialized":
      // Client acknowledgment — no response needed
      break;

    case "tools/list":
      respond(req.id, { tools: TOOLS });
      break;

    case "resources/list":
      respond(req.id, { resources: [] });
      break;

    case "resources/templates/list":
      respond(req.id, { resourceTemplates: [] });
      break;

    case "prompts/list":
      respond(req.id, { prompts: [] });
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
        // Write session flag so the PreToolUse hook knows guardian was called recently
        fs.writeFile(SESSION_FLAG, Date.now().toString(), "utf8").catch(() => {});
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
      // Notifications (no id) don't need a response
      if (req.id != null) {
        respondError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

// ── Entry point ──

export async function runMcpServe(options: McpServeOptions): Promise<void> {
  const specsDir = path.resolve(options.specs);
  const quiet = options.quiet ?? false;
  specsInputDir = specsDir;

  // Log to stderr (stdout is for MCP protocol)
  if (!quiet) {
    process.stderr.write(`Guardian MCP server started. Specs: ${specsDir}\n`);
    process.stderr.write(`Tools: ${TOOLS.map((t) => t.name).join(", ")}\n`);
  }

  // Read JSON-RPC messages from stdin, line by line
  const rl = readline.createInterface({ input: process.stdin });

  // Track in-flight async handlers so we can drain before exit.
  // Previously all handlers were instant (in-process); now they spawn subprocesses.
  const pending: Promise<void>[] = [];

  rl.on("line", (line) => {
    if (!line.trim()) return;
    const p = (async () => {
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        await handleRequest(req);
      } catch (err) {
        respondError(null, -32700, `Parse error: ${(err as Error).message}`);
      }
    })();
    pending.push(p);
  });

  rl.on("close", async () => {
    // Drain all in-flight handlers before persisting metrics and exiting.
    await Promise.allSettled(pending);
    // Persist session metrics to .specs/machine/mcp-metrics.jsonl
    const metricsPath = path.join(specsDir, "machine", "mcp-metrics.jsonl");
    try {
      const entry = JSON.stringify({
        ...metrics.summary(),
        session_end: new Date().toISOString(),
      });
      await fs.appendFile(metricsPath, entry + "\n", "utf8");
      if (!quiet) process.stderr.write(`Guardian metrics saved to ${metricsPath}\n`);
    } catch {}
    if (!quiet) process.stderr.write("Guardian MCP server stopped.\n");
    process.exit(0);
  });
}
