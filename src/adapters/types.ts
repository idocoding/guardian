import type Parser from "tree-sitter";

export interface EndpointExtraction {
  file: string;
  method: string;
  path: string;
  handler: string;
  router?: string | null;
  request_schema?: string | null;
  response_schema?: string | null;
  service_calls: string[];
}

export interface ModelExtraction {
  name: string;
  file: string;
  framework: string;
  fields: string[];
  relationships: string[];
}

export interface ComponentExtraction {
  id: string;
  name: string;
  file: string;
  export_kind: "default" | "named" | "unknown";
  props?: Array<{ name: string; type: string }>;
}

export interface TestExtraction {
  file: string;
  test_name: string;
  suite_name?: string | null;
}

export interface AdapterQueries {
  /**
   * Tree-sitter S-expression query that captures endpoints/routes.
   * Required captures: @method, @path, @handler
   * Optional captures: @router, @request, @response
   */
  endpoints?: string;

  /**
   * Tree-sitter S-expression query that captures data models.
   * Required captures: @name
   * Optional captures: @field, @relationship
   */
  models?: string;

  /**
   * Tree-sitter S-expression query that captures UI components.
   * Required captures: @name
   * Optional captures: @prop, @prop_type
   */
  components?: string;

  /**
   * Tree-sitter S-expression query that captures behavioral tests.
   * Required captures: @test_name
   * Optional captures: @suite_name
   */
  tests?: string;
}

export interface SpecGuardAdapter {
  name: string;
  language: any; // Tree-sitter language object natively
  fileExtensions: string[];
  
  /**
   * Defines the Tree-sitter queries this adapter supports.
   */
  queries: AdapterQueries;

  /**
   * A unified extraction pipeline that processes a single file root against the adapter's queries.
   * This is called by the Universal Graph engine.
   */
  extract(file: string, source: string, root: Parser.SyntaxNode): {
    endpoints: EndpointExtraction[];
    models: ModelExtraction[];
    components: ComponentExtraction[];
    tests: TestExtraction[];
  };
}
