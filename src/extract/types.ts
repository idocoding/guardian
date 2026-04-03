export type ModuleSummary = {
  id: string;
  path: string;
  type: "backend" | "frontend";
  layer: "core" | "middle" | "top" | "isolated";
  files: string[];
  endpoints: string[];
  imports: string[];
  exports: FileExportSummary[];
};

export type ExportKind = "default" | "named";

export type ExportDetail = {
  name: string;
  kind: ExportKind;
  alias?: string;
};

export type FrontendPageSummary = {
  path: string;
  component: string;
};

export type FrontendApiCallSummary = {
  method: string;
  path: string;
  source: string;
  request_fields?: string[];
};

export type BackendEndpoint = {
  id: string;
  method: string;
  path: string;
  handler: string;
  file: string;
  module: string;
  request_schema?: string | null;
  response_schema?: string | null;
  service_calls: string[];
  ai_operations: Array<{
    provider: "openai" | "anthropic" | "unknown";
    operation: string;
    model?: string | null;
    max_tokens?: number | null;
    max_output_tokens?: number | null;
    token_budget?: number | null;
  }>;
};

export type DataModelSummary = {
  name: string;
  file: string;
  framework: "sqlalchemy" | "django" | "pydantic";
  fields: string[];
  relationships: string[];
  field_details?: DataModelFieldSummary[];
};

export type DataModelFieldSummary = {
  name: string;
  type?: string | null;
  nullable?: boolean | null;
  primary_key?: boolean | null;
  foreign_key?: string | null;
  enum?: string | null;
  default?: string | null;
};

export type EnumSummary = {
  name: string;
  file: string;
  values: string[];
};

export type ConstantSummary = {
  name: string;
  file: string;
  type: string;
  value: string;
};

export type EndpointModelUsage = {
  endpoint_id: string;
  endpoint: string;
  models: Array<{
    name: string;
    access: "read" | "write" | "read_write" | "unknown";
  }>;
};

export type BackgroundTaskSummary = {
  name: string;
  file: string;
  kind: "celery" | "background";
  queue?: string | null;
  schedule?: string | null;
};

export type RuntimeServiceSummary = {
  name: string;
  source: string;
  image?: string;
  build?: string;
  ports?: string[];
  environment?: string[];
  depends_on?: string[];
};

export type SystemManifestSummary = {
  file: string;
  kind: "npm" | "poetry" | "pip" | "go" | "maven" | "gradle" | "makefile" | "github-action" | "doc" | "unknown";
  commands?: string[];
  dependencies?: string[];
  dev_dependencies?: string[];
  description?: string;
};

export type RuntimeTopology = {
  dockerfiles: string[];
  services: RuntimeServiceSummary[];
  manifests: SystemManifestSummary[];
  shell_scripts: string[];
};

export type ModuleDependency = {
  from: string;
  to: string;
  file: string;
};

export type FileDependency = {
  from: string;
  to: string;
};

export type FileExportSummary = {
  file: string;
  symbols: string[];
  exports: ExportDetail[];
};

export type UnusedExport = {
  file: string;
  symbol: string;
};

export type CapacityStatus = "ok" | "warning" | "critical" | "unbudgeted";

export type CapacityLayerUsage = {
  layer: string;
  nodes: number;
  edges: number;
  cross_layer_out: number;
  budget?: number;
  ratio?: number;
  remaining?: number;
  status: CapacityStatus;
};

export type DriftCapacityReport = {
  thresholds: {
    warning: number;
    critical: number;
  };
  total?: {
    budget?: number;
    used: number;
    ratio?: number;
    remaining?: number;
    status: CapacityStatus;
  };
  layers: CapacityLayerUsage[];
  status: CapacityStatus;
};

export type DriftGrowthReport = {
  edges_per_hour: number;
  edges_per_day: number;
  trend: "increasing" | "decreasing" | "stable" | "insufficient_data";
  window: {
    from?: string;
    to?: string;
    hours?: number;
  };
  status: "ok" | "critical" | "insufficient_data";
};

export type DriftScaleLevel = "function" | "file" | "module" | "domain";

export type DriftScaleReport = {
  level: DriftScaleLevel;
  metrics: {
    entropy: number;
    cross_layer_ratio: number;
    cycle_density: number;
    modularity_gap: number;
  };
  D_t: number;
  K_t: number;
  delta: number;
  status: "stable" | "critical" | "drift";
  capacity: DriftCapacityReport;
  growth: DriftGrowthReport;
  alerts: string[];
  details: {
    nodes: number;
    edges: number;
    cycles: number;
    cross_layer_edges: number;
    layers: string[];
    fingerprint: string;
    shape_fingerprint: string;
  };
};

export type DriftReport = {
  version: "0.3";
  graph_level: DriftScaleLevel;
  metrics: DriftScaleReport["metrics"];
  D_t: number;
  K_t: number;
  delta: number;
  status: "stable" | "critical" | "drift";
  capacity: DriftCapacityReport;
  growth: DriftGrowthReport;
  alerts: string[];
  details: DriftScaleReport["details"];
  scales: DriftScaleReport[];
};

export type DuplicateFunctionGroup = {
  hash: string;
  size: number;
  functions: Array<{
    id: string;
    name: string;
    file: string;
    language: "ts" | "js" | "py";
    size: number;
  }>;
};

export type SimilarFunctionGroup = {
  similarity: number;
  basis: "call_pattern" | "ast_structure";
  functions: Array<{
    id: string;
    name: string;
    file: string;
    language: "ts" | "js" | "py";
  }>;
};

export type ArchitectureSnapshot = {
  version: "1.0";
  metadata: {
    generated_at: string;
    duration_ms: number;
    target_backend?: string | null;
    target_frontend?: string | null;
  };
  project: {
    name: string;
    workspace_root: string;
    backend_root: string;
    frontend_root: string;
    resolution_source: "auto" | "config" | "cli";
    entrypoints: string[];
  };
  modules: ModuleSummary[];
  frontend_files: string[];
  frontend: {
    pages: FrontendPageSummary[];
    api_calls: FrontendApiCallSummary[];
  };
  endpoints: BackendEndpoint[];
  data_models: DataModelSummary[];
  enums: EnumSummary[];
  constants: ConstantSummary[];
  endpoint_model_usage: EndpointModelUsage[];
  cross_stack_contracts: CrossStackContract[];
  tasks: BackgroundTaskSummary[];
  runtime: RuntimeTopology;
  data_flows: Array<{
    page: string;
    endpoint_id: string;
    models: string[];
  }>;
  dependencies: {
    module_graph: ModuleDependency[];
    file_graph: FileDependency[];
  };
  drift: DriftReport;
  tests?: TestExtractionSummary[];
  structural_intelligence?: StructuralIntelligenceReport[];
  analysis: {
    circular_dependencies: string[][];
    orphan_modules: string[];
    orphan_files: string[];
    frontend_orphan_files: string[];
    module_usage: Record<string, number>;
    unused_exports: UnusedExport[];
    frontend_unused_exports: UnusedExport[];
    unused_endpoints: string[];
    frontend_unused_api_calls: string[];
    duplicate_functions: DuplicateFunctionGroup[];
    similar_functions: SimilarFunctionGroup[];
    test_coverage: TestGapSummary;
    endpoint_test_coverage: EndpointTestCoverage[];
    function_test_coverage: FunctionTestCoverage[];
  };
};

export type CrossStackContract = {
  endpoint_id: string;
  method: string;
  path: string;
  backend_request_schema: string | null;
  backend_response_schema: string | null;
  backend_request_fields: string[];
  frontend_request_fields: string[];
  frontend_callers: Array<{
    component: string;
    file: string;
  }>;
  status: "ok" | "mismatched" | "unverified";
  issues: string[];
};

export type TestCoverageSummary = {
  test_file: string;
  source_file: string | null;
  match_type: "exact" | "implicit" | "none";
};

export type TestGapSummary = {
  untested_source_files: string[];
  test_files_missing_source: string[];
  coverage_map: TestCoverageSummary[];
};

export type EndpointTestCoverage = {
  endpoint: string;
  method: string;
  path: string;
  file: string;
  covered: boolean;
  coverage_type: "file" | "none";
  test_files: string[];
};

export type FunctionTestCoverage = {
  function_id: string;
  file: string;
  covered: boolean;
  coverage_type: "file" | "none";
  test_files: string[];
};

export type TestExtractionSummary = {
  file: string;
  test_name: string;
  suite_name?: string | null;
};

export type StructuralIntelligenceReport = {
  feature: string;
  structure: { nodes: number; edges: number };
  metrics: {
    depth: number;
    fanout_avg: number;
    fanout_max: number;
    density: number;
    has_cycles: boolean;
  };
  scores: {
    depth_score: number;
    fanout_score: number;
    density_score: number;
    cycle_score: number;
    query_score: number;
  };
  confidence: { value: number; level: "WEAK" | "MODERATE" | "STRONG" };
  ambiguity: { level: "LOW" | "MEDIUM" | "HIGH" };
  classification: {
    depth_level: "LOW" | "MEDIUM" | "HIGH";
    propagation: "LOCAL" | "MODERATE" | "STRONG";
    compressible: "COMPRESSIBLE" | "PARTIAL" | "NON_COMPRESSIBLE";
  };
  recommendation: {
    primary: { pattern: string; confidence: number };
    fallback: { pattern: string; condition: string };
    avoid: string[];
  };
  guardrails: { enforce_if_confidence_above: number };
  override: { allowed: true; requires_reason: true };
};

export type UxPageSummary = {
  path: string;
  component: string;
  component_id: string;
  components: string[];
  components_direct: string[];
  components_descendants: string[];
  components_direct_ids: string[];
  components_descendants_ids: string[];
  local_state_variables: string[];
  api_calls: string[];
  component_api_calls: Array<{
    component: string;
    component_id: string;
    api_calls: string[];
  }>;
  component_state_variables: Array<{
    component: string;
    component_id: string;
    local_state_variables: string[];
  }>;
  possible_navigation: string[];
};

export type UxComponentNode = {
  id: string;
  name: string;
  file: string;
  kind: "page" | "component";
  export_kind: ExportKind;
  props?: Array<{
    name: string;
    type: string;
    optional: boolean;
  }>;
};

export type UxComponentEdge = {
  from: string;
  to: string;
};

export type UxSnapshot = {
  version: "0.2";
  components: UxComponentNode[];
  component_graph: UxComponentEdge[];
  pages: UxPageSummary[];
};

export type BackendAnalysis = {
  modules: ModuleSummary[];
  moduleGraph: ModuleDependency[];
  fileGraph: FileDependency[];
  endpoints: BackendEndpoint[];
  dataModels: DataModelSummary[];
  enums: EnumSummary[];
  constants: ConstantSummary[];
  endpointModelUsage: EndpointModelUsage[];
  tasks: BackgroundTaskSummary[];
  circularDependencies: string[][];
  orphanModules: string[];
  orphanFiles: string[];
  moduleUsage: Record<string, number>;
  unusedExports: UnusedExport[];
  unusedEndpoints: string[];
  entrypoints: string[];
  duplicateFunctions: DuplicateFunctionGroup[];
  similarFunctions: SimilarFunctionGroup[];
  testCoverage: TestGapSummary;
  tests: TestExtractionSummary[];
};

export type FrontendAnalysis = {
  files: string[];
  pages: FrontendPageSummary[];
  apiCalls: FrontendApiCallSummary[];
  uxPages: UxPageSummary[];
  components: UxComponentNode[];
  componentGraph: UxComponentEdge[];
  fileGraph: FileDependency[];
  orphanFiles: string[];
  unusedExports: UnusedExport[];
  tests: TestExtractionSummary[];
};
