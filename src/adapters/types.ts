import type Parser from "tree-sitter";

// ── Function-level intelligence ────────────────────────────────────────────

/**
 * A function (or method, arrow function) extracted from any supported language.
 * Carries the literals, calls, and regex patterns inside its body — enabling
 * guardian search to find where a string constant, regex, or call site lives.
 */
export interface FunctionRecord {
  /** Unique ID: "relative/path/file.ext#name:startLine" */
  id: string;
  name: string;
  file: string;
  /** [startLine, endLine] — 1-based */
  lines: [number, number];
  /** Qualified or simple names of functions/methods called from this body */
  calls: string[];
  /** String literal values found inside the function body (capped at 300 chars each) */
  stringLiterals: string[];
  /** Regex pattern strings: /pattern/ literals and strings passed to re.compile/re.sub */
  regexPatterns: string[];
  isAsync: boolean;
  /** "typescript" | "python" | "lean4" | … */
  language: string;
}

/**
 * Lean4-specific extension of FunctionRecord for theorems, lemmas, and defs.
 * Maps to the Mathlib proof assistant domain.
 */
export interface TheoremRecord extends FunctionRecord {
  kind:
    | "theorem"
    | "lemma"
    | "def"
    | "noncomputable_def"
    | "abbrev"
    | "structure"
    | "class"
    | "instance"
    | "example"
    | "inductive";
  /** Qualified namespace: e.g. "Mathlib.Topology.Basic" */
  namespace: string;
  /** The proposition/type — text between the name and := */
  statement: string;
  /** True when the proof body contains `sorry` (incomplete proof) */
  hasSorry: boolean;
  /** Lean4 tactic names used: simp, ring, omega, linarith, … */
  tactics: string[];
  /** Mathlib module paths imported by the file: ["Mathlib.Data.Nat.Basic", …] */
  mathlibDeps: string[];
}

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
   *
   * `functions` is optional — adapters that support function-level intelligence populate it.
   * Adapters that do not support it simply omit the field; callers treat absence as [].
   */
  extract(file: string, source: string, root: Parser.SyntaxNode): {
    endpoints: EndpointExtraction[];
    models: ModelExtraction[];
    components: ComponentExtraction[];
    tests: TestExtraction[];
    functions?: FunctionRecord[];
  };
}
