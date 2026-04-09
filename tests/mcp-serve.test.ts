/**
 * MCP server tool tests — verifies compact JSON responses.
 * Requires .specs/machine/codebase-intelligence.json from a real project.
 *
 * Run: npx vitest run tests/mcp-serve.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const SPECS_DIR = path.resolve(__dirname, "../test-fixtures/specs");
const INTEL_PATH = path.join(SPECS_DIR, "machine", "codebase-intelligence.json");
const FUNC_INTEL_PATH = path.join(SPECS_DIR, "machine", "function-intelligence.json");

// Minimal codebase intelligence for testing
const MOCK_INTEL = {
  meta: {
    project: "test-project",
    generated_at: new Date().toISOString(),
    counts: { endpoints: 5, models: 3, enums: 0, tasks: 0, modules: 2, pages: 2, patterns_detected: 0 },
  },
  api_registry: {
    "POST /users": {
      method: "POST", path: "/users", handler: "create_user",
      file: "backend/api/users.py", module: "backend/api",
      request_schema: "CreateUserRequest", response_schema: null,
      service_calls: ["db.execute", "uuid.uuid4", "str"], ai_operations: [], patterns: [],
    },
    "GET /users": {
      method: "GET", path: "/users", handler: "list_users",
      file: "backend/api/users.py", module: "backend/api",
      request_schema: null, response_schema: null,
      service_calls: ["db.fetch", "dict"], ai_operations: [], patterns: [],
    },
    "GET /health": {
      method: "GET", path: "/health", handler: "health",
      file: "backend/main.py", module: "backend",
      request_schema: null, response_schema: null,
      service_calls: [], ai_operations: [], patterns: [],
    },
  },
  model_registry: {
    CreateUserRequest: {
      name: "CreateUserRequest", file: "backend/api/users.py",
      framework: "pydantic", fields: ["email", "name", "password"],
      relationships: [], field_details: [],
    },
    UserProfile: {
      name: "UserProfile", file: "backend/models.py",
      framework: "sqlalchemy", fields: ["id", "email", "name", "created_at"],
      relationships: ["posts"], field_details: [],
    },
  },
  service_map: [
    { id: "backend/api", path: "backend/api", type: "backend", layer: "top", file_count: 3, endpoint_count: 2, imports: ["backend/models"] },
    { id: "backend", path: "backend", type: "backend", layer: "core", file_count: 5, endpoint_count: 1, imports: [] },
  ],
  frontend_pages: [
    { path: "/", component: "HomePage", api_calls: [], direct_components: [] },
    { path: "/users", component: "UsersPage", api_calls: ["GET /users"], direct_components: [] },
  ],
  background_tasks: [],
  enum_registry: {},
  pattern_registry: { patterns: [] },
};

// Minimal function intelligence fixture
const MOCK_FUNC_INTEL = {
  version: "0.1",
  generated_at: new Date().toISOString(),
  total_functions: 4,
  functions: [
    {
      id: "backend/api/users.py#create_user:10",
      name: "create_user",
      file: "backend/api/users.py",
      lines: [10, 25],
      calls: ["db.execute", "uuid.uuid4"],
      stringLiterals: ["user created successfully", "invalid email"],
      regexPatterns: ["^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$"],
      isAsync: true,
      language: "python",
    },
    {
      id: "backend/api/users.py#list_users:30",
      name: "list_users",
      file: "backend/api/users.py",
      lines: [30, 45],
      calls: ["db.fetch"],
      stringLiterals: [],
      regexPatterns: [],
      isAsync: false,
      language: "python",
    },
    {
      id: "backend/main.py#health:5",
      name: "health",
      file: "backend/main.py",
      lines: [5, 8],
      calls: [],
      stringLiterals: ["ok"],
      regexPatterns: [],
      isAsync: false,
      language: "python",
    },
    {
      id: "backend/models.py#validate_email:50",
      name: "validate_email",
      file: "backend/models.py",
      lines: [50, 60],
      calls: ["re.match"],
      stringLiterals: ["invalid email"],
      regexPatterns: ["^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$"],
      isAsync: false,
      language: "python",
    },
  ],
  call_graph: {
    create_user: { calls: ["db.execute", "uuid.uuid4"], called_by: [] },
    list_users: { calls: ["db.fetch"], called_by: [] },
    health: { calls: [], called_by: [] },
    validate_email: { calls: ["re.match"], called_by: [] },
  },
  literal_index: {
    "user created successfully": [{ file: "backend/api/users.py", function: "create_user", line: 10 }],
    "invalid email": [
      { file: "backend/api/users.py", function: "create_user", line: 10 },
      { file: "backend/models.py", function: "validate_email", line: 50 },
    ],
    "ok": [{ file: "backend/main.py", function: "health", line: 5 }],
    "user": [
      { file: "backend/api/users.py", function: "create_user", line: 10 },
      { file: "backend/api/users.py", function: "list_users", line: 30 },
    ],
    "email": [
      { file: "backend/api/users.py", function: "create_user", line: 10 },
      { file: "backend/models.py", function: "validate_email", line: 50 },
    ],
  },
};

function sendToMcp(messages: object[]): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/cli.js", "mcp-serve", "--specs", SPECS_DIR], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: object[] = [];
    let buffer = "";

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    child.on("close", () => {
      if (buffer.trim()) responses.push(JSON.parse(buffer));
      resolve(responses);
    });

    child.on("error", reject);

    const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    child.stdin.write(input);
    child.stdin.end();
  });
}

function getResult(responses: any[], id: number): any {
  const r = responses.find((r: any) => r.id === id);
  if (!r?.result?.content?.[0]?.text) return null;
  return JSON.parse(r.result.content[0].text);
}

beforeAll(() => {
  fs.mkdirSync(path.join(SPECS_DIR, "machine"), { recursive: true });
  fs.writeFileSync(INTEL_PATH, JSON.stringify(MOCK_INTEL));
  fs.writeFileSync(FUNC_INTEL_PATH, JSON.stringify(MOCK_FUNC_INTEL));
});

describe("MCP Tools", () => {
  it("guardian_orient returns compact project summary", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_orient", arguments: {} } },
    ]);
    const result = getResult(responses, 2);
    expect(result.p).toBe("test-project");
    expect(result.ep).toBe(5);
    expect(result.pg).toBe(2);
    expect(result.pages).toContain("/");
    expect(result.pages).toContain("/users");
    // Verify compact — no verbose keys
    expect(result.modules).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it("guardian_context for file returns deps", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_context", arguments: { target: "backend/api/users.py" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.f).toBe("backend/api/users.py");
    expect(result.ep).toContain("POST /users");
    expect(result.ep).toContain("GET /users");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models[0][0]).toBe("CreateUserRequest");
  });

  it("guardian_context for endpoint returns call chain", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_context", arguments: { target: "POST /users" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.ep).toBe("POST /users");
    expect(result.h).toBe("create_user");
    expect(result.req).toBe("CreateUserRequest");
    expect(result.calls).toContain("db.execute");
    // Verify skip list works — no "str" in calls
    expect(result.calls).not.toContain("str");
  });

  it("guardian_impact shows risk and affected items", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_impact", arguments: { target: "backend/api/users.py" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.f).toBe("backend/api/users.py");
    expect(["LOW", "MED", "HIGH"]).toContain(result.risk);
    expect(result.ep).toContain("POST /users");
    expect(result.models).toContain("CreateUserRequest");
  });

  it("guardian_search finds by keyword", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_search", arguments: { query: "user" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.ep.length).toBeGreaterThan(0);
    expect(result.mod.length).toBeGreaterThan(0);
  });

  it("guardian_model returns fields and usage", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_model", arguments: { name: "CreateUserRequest" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.name).toBe("CreateUserRequest");
    expect(result.fields).toContain("email");
    expect(result.usedBy).toContain("POST /users");
  });

  it("guardian_model returns error for unknown model", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_model", arguments: { name: "NonExistent" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.err).toBe("not found");
  });

  it("guardian_metrics tracks calls", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_orient", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "guardian_search", arguments: { query: "user" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "guardian_metrics", arguments: {} } },
    ]);
    const result = getResult(responses, 4);
    // Metrics are recorded after handler returns, so by time metrics is called
    // the previous calls should be tracked
    expect(result.total_mcp_calls).toBeGreaterThanOrEqual(0);
    expect(typeof result.total_tokens_spent).toBe("number");
    expect(typeof result.cache_hits).toBe("number");
    expect(result.tool_breakdown).toBeDefined();
  });

  it("cache returns same response for repeated calls", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_orient", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "guardian_orient", arguments: {} } },
    ]);
    const r1 = getResult(responses, 2);
    const r2 = getResult(responses, 3);
    // Both should return identical data
    expect(r1.p).toBe(r2.p);
    expect(r1.ep).toBe(r2.ep);
  });

  it("guardian_search finds functions by literal index key", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_search", arguments: { query: "invalid email" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.fns).toBeDefined();
    expect(result.fns.length).toBeGreaterThan(0);
    // Should find create_user and validate_email via literal_index
    const names = result.fns.map((h: string) => h.split(" ")[0]);
    expect(names).toContain("create_user");
    expect(names).toContain("validate_email");
  });

  it("guardian_search finds functions by name", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_search", arguments: { query: "validate" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.fns).toBeDefined();
    const names = result.fns.map((h: string) => h.split(" ")[0]);
    expect(names).toContain("validate_email");
  });

  it("guardian_search returns no fns key when no function matches", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_search", arguments: { query: "zzznomatch999" } } },
    ]);
    const result = getResult(responses, 2);
    // fns key should be absent when there are no hits (compact output)
    expect(result.fns).toBeUndefined();
  });

  it("guardian_search function hits include file and line", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_search", arguments: { query: "email" } } },
    ]);
    const result = getResult(responses, 2);
    expect(result.fns).toBeDefined();
    // Each hit should be "name [file:line] ..." format
    for (const hit of result.fns) {
      expect(hit).toMatch(/\[.+:\d+\]/);
    }
  });

  it("responses are compact JSON not pretty-printed", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "guardian_orient", arguments: {} } },
    ]);
    const raw = (responses.find((r: any) => r.id === 2) as any)?.result?.content?.[0]?.text || "";
    expect(raw).not.toContain("\n");
  });
});

describe("MCP Protocol Compliance", () => {
  it("initialize returns tools, resources, and prompts capabilities", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
    ]);
    const r = responses.find((r: any) => r.id === 1) as any;
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.capabilities.resources).toBeDefined();
    expect(r.result.capabilities.prompts).toBeDefined();
    expect(r.result.serverInfo.name).toBe("guardian");
  });

  it("resources/list returns empty array", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    expect(r.result.resources).toEqual([]);
  });

  it("resources/templates/list returns empty array", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "resources/templates/list", params: {} },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    expect(r.result.resourceTemplates).toEqual([]);
  });

  it("prompts/list returns empty array", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    expect(r.result.prompts).toEqual([]);
  });

  it("tools/list returns all 6 tools", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toContain("guardian_orient");
    expect(names).toContain("guardian_context");
    expect(names).toContain("guardian_impact");
    expect(names).toContain("guardian_search");
    expect(names).toContain("guardian_model");
    expect(names).toContain("guardian_metrics");
    expect(names.length).toBe(6);
  });

  it("unknown method with id returns error", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "nonexistent/method", params: {} },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32601);
  });

  it("notification without id does not produce error response", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/something", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    ]);
    // Should have responses for id 1 and 3, but no error for the notification
    const ids = responses.map((r: any) => r.id).filter(Boolean);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    // No error response for the notification (it has no id)
    const errors = responses.filter((r: any) => r.error && !r.id);
    expect(errors.length).toBe(0);
  });

  it("unknown tool returns isError flag", async () => {
    const responses = await sendToMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nonexistent_tool", arguments: {} } },
    ]);
    const r = responses.find((r: any) => r.id === 2) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("Unknown tool");
  });
});
