/**
 * Pattern Registry — deterministically extracts implementation patterns from an ArchitectureSnapshot.
 *
 * Analogous to the ref book entity tables (FM/AT/MM) — a catalog of established patterns
 * in the codebase that LLMs and developers can reference when implementing features.
 *
 * Patterns detected:
 *   P1  Service Delegation      — endpoint delegates to a named service method
 *   P2  Auth-Gated Endpoint     — endpoint file contains auth/permission decorators
 *   P3  LLM Operation           — endpoint calls an AI provider
 *   P4  Background Task Dispatch— endpoint dispatches a celery/background task
 *   P5  CRUD Endpoint           — endpoint is part of a standard CRUD set on a resource
 *   P6  Multi-Model Write       — endpoint writes to 3+ models
 *   P7  Cross-Stack Contract    — endpoint has a verified frontend caller
 *   P8  Paginated List          — endpoint is a GET list with "page"/"limit" in path/query naming
 */

import type { ArchitectureSnapshot } from "./types.js";

export type PatternEntry = {
  id: string;              // "P1"
  name: string;            // "Service Delegation"
  description: string;
  occurrences: number;
  example_endpoints: string[];  // up to 3 representative endpoints
  example_files: string[];      // up to 3 representative files
};

export type PatternRegistry = {
  generated_at: string;
  patterns: PatternEntry[];
};

export function buildPatternRegistry(architecture: ArchitectureSnapshot): PatternRegistry {
  const endpoints = architecture.endpoints;
  const endpointModelUsage = architecture.endpoint_model_usage;
  const crossStack = architecture.cross_stack_contracts ?? [];

  const modelWriteMap = new Map<string, number>();
  for (const usage of endpointModelUsage) {
    const writes = usage.models.filter((m) => m.access === "write" || m.access === "read_write").length;
    modelWriteMap.set(usage.endpoint_id, writes);
  }

  const crossStackVerified = new Set(
    crossStack.filter((c) => c.status === "ok").map((c) => c.endpoint_id)
  );

  // P1 — Service Delegation
  const p1 = endpoints.filter((ep) => ep.service_calls.length > 0);

  // P2 — Auth-Gated (heuristic: file path contains "auth", "permission", "security", or handler mentions it)
  const p2 = endpoints.filter((ep) => {
    const lower = (ep.file + ep.handler).toLowerCase();
    return (
      lower.includes("auth") ||
      lower.includes("permission") ||
      lower.includes("require_") ||
      lower.includes("depends(get_current")
    );
  });

  // P3 — LLM Operation
  const p3 = endpoints.filter((ep) => ep.ai_operations && ep.ai_operations.length > 0);

  // P4 — Background Task Dispatch (service_calls referencing task patterns)
  const p4 = endpoints.filter((ep) =>
    ep.service_calls.some((s) => {
      const lower = s.toLowerCase();
      return (
        lower.includes("task") ||
        lower.includes(".delay(") ||
        lower.includes(".apply_async") ||
        lower.includes("background")
      );
    })
  );

  // P5 — CRUD set: resource has GET list + GET detail + POST + PATCH/PUT + DELETE
  const resourceMethods = new Map<string, Set<string>>();
  for (const ep of endpoints) {
    // Normalise path to resource key: strip trailing /{id} variant
    const resource = ep.path.replace(/\/\{[^}]+\}$/, "").replace(/\/:[^/]+$/, "");
    const entry = resourceMethods.get(resource) ?? new Set<string>();
    entry.add(ep.method.toUpperCase());
    resourceMethods.set(resource, entry);
  }
  const crudResources = new Set<string>();
  for (const [resource, methods] of resourceMethods) {
    if (methods.has("GET") && methods.has("POST") && (methods.has("PATCH") || methods.has("PUT"))) {
      crudResources.add(resource);
    }
  }
  const p5 = endpoints.filter((ep) => {
    const resource = ep.path.replace(/\/\{[^}]+\}$/, "").replace(/\/:[^/]+$/, "");
    return crudResources.has(resource);
  });

  // P6 — Multi-Model Write (3+ model writes)
  const p6 = endpoints.filter((ep) => (modelWriteMap.get(ep.id) ?? 0) >= 3);

  // P7 — Cross-Stack Contract (verified frontend caller)
  const p7 = endpoints.filter((ep) => crossStackVerified.has(ep.id));

  // P8 — Paginated List (GET endpoints with "list" or "page" in name/path)
  const p8 = endpoints.filter((ep) => {
    if (ep.method.toUpperCase() !== "GET") return false;
    const lower = (ep.path + ep.handler).toLowerCase();
    return lower.includes("list") || lower.includes("page") || lower.includes("paginate");
  });

  const definitions: Array<{
    id: string;
    name: string;
    description: string;
    matches: typeof endpoints;
  }> = [
    {
      id: "P1",
      name: "Service Delegation",
      description:
        "Endpoint delegates business logic to a named service method. Route handler is thin; all logic lives in service layer.",
      matches: p1,
    },
    {
      id: "P2",
      name: "Auth-Gated Endpoint",
      description:
        "Endpoint requires authentication or permission check before executing. Uses auth dependency injection or decorator.",
      matches: p2,
    },
    {
      id: "P3",
      name: "LLM Operation",
      description:
        "Endpoint calls an AI provider (OpenAI, Anthropic, etc.). May involve prompt construction, model selection, and token budgeting.",
      matches: p3,
    },
    {
      id: "P4",
      name: "Background Task Dispatch",
      description:
        "Endpoint dispatches work to a background task queue (Celery, FastAPI BackgroundTasks) and returns immediately.",
      matches: p4,
    },
    {
      id: "P5",
      name: "CRUD Resource",
      description:
        "Endpoint is part of a full CRUD set (GET list + GET detail + POST + PATCH/PUT + DELETE) on a single resource.",
      matches: p5,
    },
    {
      id: "P6",
      name: "Multi-Model Write",
      description:
        "Endpoint writes to 3 or more ORM models in a single request. Likely requires a transaction.",
      matches: p6,
    },
    {
      id: "P7",
      name: "Cross-Stack Contract",
      description:
        "Endpoint has a verified frontend caller with matching request/response fields. Schema contract is enforced.",
      matches: p7,
    },
    {
      id: "P8",
      name: "Paginated List",
      description:
        "GET endpoint returns a paginated collection. Supports page/limit/cursor parameters.",
      matches: p8,
    },
  ];

  const patterns: PatternEntry[] = definitions.map(({ id, name, description, matches }) => ({
    id,
    name,
    description,
    occurrences: matches.length,
    example_endpoints: matches
      .slice(0, 3)
      .map((ep) => `${ep.method} ${ep.path}`),
    example_files: Array.from(new Set(matches.slice(0, 3).map((ep) => ep.file))),
  }));

  return {
    generated_at: new Date().toISOString(),
    patterns,
  };
}
