import type {
  ArchitectureSnapshot,
  CrossStackContract,
  DataModelSummary,
  FrontendApiCallSummary,
  UxSnapshot
} from "./types.js";

export function buildCrossStackContracts(params: {
  endpoints: ArchitectureSnapshot["endpoints"];
  apiCalls: FrontendApiCallSummary[];
  ux: UxSnapshot;
  dataModels: DataModelSummary[];
}): CrossStackContract[] {
  const { endpoints, apiCalls, ux, dataModels } = params;
  const endpointByKey = new Map<string, ArchitectureSnapshot["endpoints"]>();
  for (const endpoint of endpoints) {
    const key = `${normalizeMethod(endpoint.method)} ${normalizePathPattern(endpoint.path)}`;
    const entry = endpointByKey.get(key) ?? [];
    entry.push(endpoint);
    endpointByKey.set(key, entry);
  }

  const dataModelsByName = new Map(
    dataModels.map((model) => [model.name, model])
  );
  const componentById = new Map(ux.components.map((component) => [component.id, component]));
  const callersByEndpoint = buildCallerIndex(ux, componentById, apiCalls);
  const groupedCalls = new Map<string, FrontendApiCallSummary[]>();

  for (const call of apiCalls) {
    const key = `${normalizeMethod(call.method)} ${normalizePathPattern(call.path)}`;
    const entry = groupedCalls.get(key) ?? [];
    entry.push(call);
    groupedCalls.set(key, entry);
  }

  const contracts: CrossStackContract[] = [];
  const seen = new Set<string>();

  for (const [key, calls] of groupedCalls) {
    const [method, ...pathParts] = key.split(" ");
    const pathValue = pathParts.join(" ");
    const candidates = findMatchingEndpoints({
      endpoints,
      endpointByKey,
      method,
      pathValue
    });
    for (const endpoint of candidates) {
      const contractKey = endpoint.id;
      if (seen.has(contractKey)) {
        continue;
      }
      seen.add(contractKey);

      const backendRequestModel = endpoint.request_schema
        ? dataModelsByName.get(endpoint.request_schema)
        : null;
      const backendRequestFields = backendRequestModel?.fields ?? [];
      const frontendRequestFields = Array.from(
        new Set(
          calls.flatMap((call) => call.request_fields ?? [])
        )
      ).sort((a, b) => a.localeCompare(b));
      const callers = callersByEndpoint.get(key) ?? callersByEndpoint.get(`ANY ${pathValue}`) ?? [];
      const issues: string[] = [];

      if (endpoint.request_schema && !backendRequestModel) {
        issues.push(`backend request schema '${endpoint.request_schema}' not extracted`);
      }

      if (backendRequestFields.length > 0 && frontendRequestFields.length === 0) {
        issues.push("frontend request fields not inferred");
      }

      if (backendRequestFields.length > 0 && frontendRequestFields.length > 0) {
        const backendOnly = backendRequestFields.filter(
          (field) => !frontendRequestFields.includes(field)
        );
        const frontendOnly = frontendRequestFields.filter(
          (field) => !backendRequestFields.includes(field)
        );
        for (const field of backendOnly) {
          issues.push(`frontend missing field '${field}'`);
        }
        for (const field of frontendOnly) {
          issues.push(`frontend extra field '${field}'`);
        }
      }

      let status: CrossStackContract["status"] = "ok";
      if (issues.length > 0 && issues.some((issue) => issue.startsWith("frontend"))) {
        status = "mismatched";
      } else if (
        endpoint.request_schema ||
        endpoint.response_schema ||
        frontendRequestFields.length > 0
      ) {
        status =
          backendRequestFields.length > 0 && issues.length === 0 ? "ok" : "unverified";
      }

      contracts.push({
        endpoint_id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        backend_request_schema: endpoint.request_schema ?? null,
        backend_response_schema: endpoint.response_schema ?? null,
        backend_request_fields: backendRequestFields,
        frontend_request_fields: frontendRequestFields,
        frontend_callers: callers,
        status,
        issues
      });
    }
  }

  contracts.sort((a, b) => {
    const path = a.path.localeCompare(b.path);
    if (path !== 0) {
      return path;
    }
    return a.method.localeCompare(b.method);
  });

  return contracts;
}

function buildCallerIndex(
  ux: UxSnapshot,
  componentById: Map<string, UxSnapshot["components"][number]>,
  apiCalls: FrontendApiCallSummary[]
): Map<string, Array<{ component: string; file: string }>> {
  const callers = new Map<string, Map<string, { component: string; file: string }>>();

  for (const page of ux.pages) {
    for (const entry of page.component_api_calls) {
      for (const call of entry.api_calls) {
        const key = normalizeApiCallKey(call);
        if (!key) {
          continue;
        }
        const file = componentById.get(entry.component_id)?.file ?? "unknown";
        const existing = callers.get(key) ?? new Map<string, { component: string; file: string }>();
        existing.set(`${entry.component}|${file}`, {
          component: entry.component,
          file
        });
        callers.set(key, existing);
      }
    }
  }

  const componentsByFile = new Map<string, Array<{ component: string; file: string }>>();
  for (const component of ux.components) {
    const entry = componentsByFile.get(component.file) ?? [];
    entry.push({ component: component.name, file: component.file });
    componentsByFile.set(component.file, entry);
  }
  for (const call of apiCalls) {
    const key = `${normalizeMethod(call.method)} ${normalizePathPattern(call.path)}`;
    if (callers.has(key)) {
      continue;
    }
    const components = componentsByFile.get(call.source) ?? [];
    if (components.length === 0) {
      continue;
    }
    callers.set(
      key,
      new Map(components.map((component) => [`${component.component}|${component.file}`, component]))
    );
  }

  return new Map(
    Array.from(callers.entries()).map(([key, value]) => [
      key,
      Array.from(value.values()).sort((a, b) => {
        const component = a.component.localeCompare(b.component);
        if (component !== 0) {
          return component;
        }
        return a.file.localeCompare(b.file);
      })
    ])
  );
}

function findMatchingEndpoints(params: {
  endpoints: ArchitectureSnapshot["endpoints"];
  endpointByKey: Map<string, ArchitectureSnapshot["endpoints"]>;
  method: string;
  pathValue: string;
}): ArchitectureSnapshot["endpoints"] {
  const exact =
    params.endpointByKey.get(`${params.method} ${params.pathValue}`) ??
    params.endpointByKey.get(`ANY ${params.pathValue}`);
  if (exact && exact.length > 0) {
    return exact;
  }

  return params.endpoints.filter((endpoint) => {
    const endpointMethod = normalizeMethod(endpoint.method);
    if (endpointMethod !== "ANY" && endpointMethod !== params.method) {
      return false;
    }
    const endpointPath = normalizePathPattern(endpoint.path);
    return pathsCompatible(endpointPath, params.pathValue);
  });
}

function pathsCompatible(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  return a.endsWith(b) || b.endsWith(a);
}

function normalizeApiCallKey(value: string): string | null {
  const parts = value.split(" ");
  if (parts.length < 2) {
    return null;
  }
  return `${normalizeMethod(parts[0])} ${normalizePathPattern(parts.slice(1).join(" "))}`;
}

function normalizeMethod(method: string): string {
  return method ? method.toUpperCase() : "GET";
}

function normalizePathPattern(value: string): string {
  if (!value) {
    return "/";
  }
  const withoutQuery = value.split("?")[0] ?? value;
  return withoutQuery
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/<[^>]+>/g, ":param")
    .replace(/:\w+/g, ":param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}
