import { z } from "zod";

export const moduleSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  type: z.enum(["backend", "frontend"]),
  layer: z.enum(["core", "middle", "top", "isolated"]),
  files: z.array(z.string()),
  endpoints: z.array(z.string()),
  imports: z.array(z.string()),
  exports: z.array(
    z.object({
      file: z.string(),
      symbols: z.array(z.string()),
      exports: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["default", "named"]),
          alias: z.string().optional()
        })
      )
    })
  )
});

export const frontendPageSummarySchema = z.object({
  path: z.string(),
  component: z.string()
});

export const frontendApiCallSummarySchema = z.object({
  method: z.string(),
  path: z.string(),
  source: z.string(),
  request_fields: z.array(z.string()).optional()
});

export const backendEndpointSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  handler: z.string(),
  file: z.string(),
  module: z.string(),
  request_schema: z.string().nullable().optional(),
  response_schema: z.string().nullable().optional(),
  service_calls: z.array(z.string()),
  ai_operations: z.array(
    z.object({
      provider: z.enum(["openai", "anthropic", "unknown"]),
      operation: z.string(),
      model: z.string().nullable().optional(),
      max_tokens: z.number().nullable().optional(),
      max_output_tokens: z.number().nullable().optional(),
      token_budget: z.number().nullable().optional()
    })
  )
});

export const dataModelSchema = z.object({
  name: z.string(),
  file: z.string(),
  framework: z.enum(["sqlalchemy", "django", "pydantic"]),
  fields: z.array(z.string()),
  relationships: z.array(z.string()),
  field_details: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().nullable().optional(),
        nullable: z.boolean().nullable().optional(),
        primary_key: z.boolean().nullable().optional(),
        foreign_key: z.string().nullable().optional(),
        enum: z.string().nullable().optional(),
        default: z.string().nullable().optional()
      })
    )
    .optional()
});

export const enumSummarySchema = z.object({
  name: z.string(),
  file: z.string(),
  values: z.array(z.string())
});

export const constantSummarySchema = z.object({
  name: z.string(),
  file: z.string(),
  type: z.string(),
  value: z.string()
});

export const endpointModelUsageSchema = z.object({
  endpoint_id: z.string(),
  endpoint: z.string(),
  models: z.array(
    z.object({
      name: z.string(),
      access: z.enum(["read", "write", "read_write", "unknown"])
    })
  )
});

export const testCoverageSummarySchema = z.object({
  test_file: z.string(),
  source_file: z.string().nullable(),
  match_type: z.enum(["exact", "implicit", "none"])
});

export const testGapSummarySchema = z.object({
  untested_source_files: z.array(z.string()),
  test_files_missing_source: z.array(z.string()),
  coverage_map: z.array(testCoverageSummarySchema)
});

export const endpointTestCoverageSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  path: z.string(),
  file: z.string(),
  covered: z.boolean(),
  coverage_type: z.enum(["file", "none"]),
  test_files: z.array(z.string())
});

export const functionTestCoverageSchema = z.object({
  function_id: z.string(),
  file: z.string(),
  covered: z.boolean(),
  coverage_type: z.enum(["file", "none"]),
  test_files: z.array(z.string())
});

export const backgroundTaskSchema = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.enum(["celery", "background"]),
  queue: z.string().nullable().optional(),
  schedule: z.string().nullable().optional()
});

export const runtimeServiceSchema = z.object({
  name: z.string(),
  source: z.string(),
  image: z.string().optional(),
  build: z.string().optional(),
  ports: z.array(z.string()).optional(),
  environment: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional()
});

export const systemManifestSchema = z.object({
  file: z.string(),
  kind: z.enum(["npm", "poetry", "pip", "go", "maven", "gradle", "makefile", "github-action", "doc", "unknown"]),
  commands: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  dev_dependencies: z.array(z.string()).optional(),
  description: z.string().optional()
});

export const runtimeTopologySchema = z.object({
  dockerfiles: z.array(z.string()),
  services: z.array(runtimeServiceSchema),
  manifests: z.array(systemManifestSchema),
  shell_scripts: z.array(z.string())
});

export const moduleDependencySchema = z.object({
  from: z.string(),
  to: z.string(),
  file: z.string()
});

export const fileDependencySchema = z.object({
  from: z.string(),
  to: z.string()
});

const capacityStatusSchema = z.enum(["ok", "warning", "critical", "unbudgeted"]);

const capacityLayerUsageSchema = z.object({
  layer: z.string(),
  nodes: z.number(),
  edges: z.number(),
  cross_layer_out: z.number(),
  budget: z.number().optional(),
  ratio: z.number().optional(),
  remaining: z.number().optional(),
  status: capacityStatusSchema
});

const driftCapacitySchema = z.object({
  thresholds: z.object({
    warning: z.number(),
    critical: z.number()
  }),
  total: z
    .object({
      budget: z.number().optional(),
      used: z.number(),
      ratio: z.number().optional(),
      remaining: z.number().optional(),
      status: capacityStatusSchema
    })
    .optional(),
  layers: z.array(capacityLayerUsageSchema),
  status: capacityStatusSchema
});

const driftGrowthSchema = z.object({
  edges_per_hour: z.number(),
  edges_per_day: z.number(),
  trend: z.enum(["increasing", "decreasing", "stable", "insufficient_data"]),
  window: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    hours: z.number().optional()
  }),
  status: z.enum(["ok", "critical", "insufficient_data"])
});

const driftScaleSchema = z.object({
  level: z.enum(["function", "file", "module", "domain"]),
  metrics: z.object({
    entropy: z.number(),
    cross_layer_ratio: z.number(),
    cycle_density: z.number(),
    modularity_gap: z.number()
  }),
  D_t: z.number(),
  K_t: z.number(),
  delta: z.number(),
  status: z.enum(["stable", "critical", "drift"]),
  capacity: driftCapacitySchema,
  growth: driftGrowthSchema,
  alerts: z.array(z.string()),
  details: z.object({
    nodes: z.number(),
    edges: z.number(),
    cycles: z.number(),
    cross_layer_edges: z.number(),
    layers: z.array(z.string()),
    fingerprint: z.string(),
    shape_fingerprint: z.string()
  })
});

export const driftReportSchema = z.object({
  version: z.literal("0.3"),
  graph_level: z.enum(["function", "file", "module", "domain"]),
  metrics: driftScaleSchema.shape.metrics,
  D_t: z.number(),
  K_t: z.number(),
  delta: z.number(),
  status: z.enum(["stable", "critical", "drift"]),
  capacity: driftCapacitySchema,
  growth: driftGrowthSchema,
  alerts: z.array(z.string()),
  details: driftScaleSchema.shape.details,
  scales: z.array(driftScaleSchema)
});

export const testExtractionSummarySchema = z.object({
  file: z.string(),
  test_name: z.string(),
  suite_name: z.string().nullable().optional()
});

export type TestExtractionSummary = z.infer<typeof testExtractionSummarySchema>;

export const structuralIntelligenceReportSchema = z.object({
  feature: z.string(),
  structure: z.object({ nodes: z.number(), edges: z.number() }),
  metrics: z.object({
    depth: z.number(),
    fanout_avg: z.number(),
    fanout_max: z.number(),
    density: z.number(),
    has_cycles: z.boolean()
  }),
  scores: z.object({
    depth_score: z.number(),
    fanout_score: z.number(),
    density_score: z.number(),
    cycle_score: z.number(),
    query_score: z.number()
  }),
  confidence: z.object({ value: z.number(), level: z.enum(["WEAK", "MODERATE", "STRONG"]) }),
  ambiguity: z.object({ level: z.enum(["LOW", "MEDIUM", "HIGH"]) }),
  classification: z.object({
    depth_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
    propagation: z.enum(["LOCAL", "MODERATE", "STRONG"]),
    compressible: z.enum(["COMPRESSIBLE", "PARTIAL", "NON_COMPRESSIBLE"])
  }),
  recommendation: z.object({
    primary: z.object({ pattern: z.string(), confidence: z.number() }),
    fallback: z.object({ pattern: z.string(), condition: z.string() }),
    avoid: z.array(z.string())
  }),
  guardrails: z.object({ enforce_if_confidence_above: z.number() }),
  override: z.object({ allowed: z.literal(true), requires_reason: z.literal(true) })
});

export const architectureSnapshotSchema = z.object({
  version: z.literal("1.0"),
  metadata: z.object({
    generated_at: z.string(),
    duration_ms: z.number(),
    target_backend: z.string().nullable().optional(),
    target_frontend: z.string().nullable().optional()
  }),
  runtime: runtimeTopologySchema.optional(),
  modules: z.array(moduleSummarySchema),
  endpoints: z.array(backendEndpointSchema),
  data_models: z.array(dataModelSchema),
  enums: z.array(enumSummarySchema).optional(),
  constants: z.array(constantSummarySchema).optional(),
  endpoint_model_usage: z.array(endpointModelUsageSchema),
  cross_stack_contracts: z.array(
    z.object({
      endpoint_id: z.string(),
      method: z.string(),
      path: z.string(),
      backend_request_schema: z.string().nullable(),
      backend_response_schema: z.string().nullable(),
      backend_request_fields: z.array(z.string()),
      frontend_request_fields: z.array(z.string()),
      frontend_callers: z.array(
        z.object({
          component: z.string(),
          file: z.string()
        })
      ),
      status: z.enum(["ok", "mismatched", "unverified"]),
      issues: z.array(z.string())
    })
  ),
  tasks: z.array(backgroundTaskSchema),
  data_flows: z.array(
    z.object({
      page: z.string(),
      endpoint_id: z.string(),
      models: z.array(z.string())
    })
  ),
  dependencies: z.object({
    module_graph: z.array(moduleDependencySchema),
    file_graph: z.array(fileDependencySchema)
  }),
  tests: z.array(testExtractionSummarySchema).optional(),
  structural_intelligence: z.array(structuralIntelligenceReportSchema).optional(),
  drift: driftReportSchema,
  analysis: z.object({
    circular_dependencies: z.array(z.array(z.string())),
    orphan_modules: z.array(z.string()),
    orphan_files: z.array(z.string()),
    frontend_orphan_files: z.array(z.string()),
    module_usage: z.record(z.number()),
    unused_exports: z.array(
      z.object({
        file: z.string(),
        symbol: z.string()
      })
    ),
    frontend_unused_exports: z.array(
      z.object({
        file: z.string(),
        symbol: z.string()
      })
    ),
    unused_endpoints: z.array(z.string()),
    frontend_unused_api_calls: z.array(z.string()),
    duplicate_functions: z.array(
      z.object({
        hash: z.string(),
        size: z.number(),
        functions: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            file: z.string(),
            language: z.enum(["ts", "js", "py"]),
            size: z.number()
          })
        )
      })
    ),
    similar_functions: z.array(
      z.object({
        similarity: z.number(),
        basis: z.enum(["call_pattern", "ast_structure"]),
        functions: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            file: z.string(),
            language: z.enum(["ts", "js", "py"])
          })
        )
      })
    ),
    test_coverage: testGapSummarySchema,
    endpoint_test_coverage: z.array(endpointTestCoverageSchema),
    function_test_coverage: z.array(functionTestCoverageSchema)
  })
});
