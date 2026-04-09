import { createRequire } from "node:module";
import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction,
  FunctionRecord,
} from "./types.js";

const require = createRequire(import.meta.url);
const Go = require("tree-sitter-go");

function text(node: Parser.SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

// ── Function-level intelligence ───────────────────────────────────────────

// Tree-sitter query — runs in C, fast regardless of file size.
const GO_FUNC_QUERY = `
  (function_declaration name: (identifier) @name) @fn
  (method_declaration   name: (field_identifier) @name) @fn
`;

/** Walk a single node's subtree iteratively (stack-based, no recursion). */
function walkBody(
  body: Parser.SyntaxNode,
  visitor: (n: Parser.SyntaxNode) => void
): void {
  const stack: Parser.SyntaxNode[] = [body];
  while (stack.length > 0) {
    const n = stack.pop()!;
    visitor(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

function collectGoBodyIntel(
  body: Parser.SyntaxNode
): { stringLiterals: string[]; regexPatterns: string[]; calls: string[]; isAsync: boolean } {
  const strings = new Set<string>();
  const calls = new Set<string>();
  let isAsync = false;

  walkBody(body, (n) => {
    if (n.type === "interpreted_string_literal" || n.type === "raw_string_literal") {
      const val = n.text.slice(1, -1);
      if (val.length > 0 && val.length < 300) strings.add(val);
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) calls.add(fn.text.split("\n")[0].trim());
    } else if (n.type === "go_statement") {
      isAsync = true;
    }
  });

  return { stringLiterals: [...strings], regexPatterns: [], calls: [...calls], isAsync };
}

function extractGoFunctions(
  language: any,
  file: string,
  root: Parser.SyntaxNode
): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const query = new Parser.Query(language, GO_FUNC_QUERY);

  for (const match of query.matches(root)) {
    const fnNode = match.captures.find((c) => c.name === "fn")?.node;
    const nameNode = match.captures.find((c) => c.name === "name")?.node;
    if (!fnNode || !nameNode) continue;

    const funcName = nameNode.text;
    const bodyNode = fnNode.childForFieldName("body");
    const intel = bodyNode
      ? collectGoBodyIntel(bodyNode)
      : { stringLiterals: [], regexPatterns: [], calls: [], isAsync: false };

    records.push({
      id: `${file}#${funcName}:${fnNode.startPosition.row + 1}`,
      name: funcName,
      file,
      lines: [fnNode.startPosition.row + 1, fnNode.endPosition.row + 1],
      calls: intel.calls,
      stringLiterals: intel.stringLiterals,
      regexPatterns: intel.regexPatterns,
      isAsync: intel.isAsync,
      language: "go",
    });
  }

  return records;
}

export const GoAdapter: SpecGuardAdapter = {
  name: "Go Gin Adapter",
  language: Go,
  fileExtensions: [".go"],
  queries: {
    // Endpoints: r.GET("/route", handler)
    endpoints: "(call_expression function: (selector_expression field: (field_identifier) @method) arguments: (argument_list (interpreted_string_literal) @path)) @endpoint",
    // Models: type User struct { ... }
    models: "(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @model",
    // Tests: func TestXxx(t *testing.T)
    tests: `(function_declaration name: (identifier) @test_name (#match? @test_name "^Test"))`
  },
  extract(file: string, source: string, root: Parser.SyntaxNode) {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = [];
    const tests: TestExtraction[] = [];

    const epQuery = new Parser.Query(this.language as any, this.queries.endpoints!);
    const mdQuery = new Parser.Query(this.language as any, this.queries.models!);

    // Extract Gin Endpoints
    const epMatches = epQuery.matches(root);
    for (const match of epMatches) {
      const methodNode = match.captures.find(c => c.name === "method")?.node;
      const pathNode = match.captures.find(c => c.name === "path")?.node;
      const endpointNode = match.captures.find(c => c.name === "endpoint")?.node;

      if (methodNode && pathNode && endpointNode) {
        let routePath = text(pathNode).replace(/\\"/g, "");
        const method = text(methodNode).toUpperCase();
        
        // Filter out non-http methods dynamically
        if (!["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "ANY"].includes(method)) continue;
        
        // Find handler: It's the last argument in the call.
        let handler = "anonymous";
        const argsNode = endpointNode.childForFieldName("arguments");
        if (argsNode && argsNode.childCount > 0) {
           const lastChild = argsNode.child(argsNode.childCount - 2); // -1 is ')', -2 is the last arg
           if (lastChild) handler = text(lastChild);
        }

        endpoints.push({
          method,
          path: routePath,
          handler,
          file,
          request_schema: null,
          response_schema: null,
          service_calls: []
        });
      }
    }

    // Extract Struct Models
    const mdMatches = mdQuery.matches(root);
    for (const match of mdMatches) {
      const nameNode = match.captures.find(c => c.name === "name")?.node;
      const modelNode = match.captures.find(c => c.name === "model")?.node;

      if (nameNode && modelNode) {
        const name = text(nameNode);
        const fields: string[] = [];

        const typeSpec = modelNode.child(0);
        if (typeSpec) {
            const structType = typeSpec.childForFieldName("type");
            if (structType && structType.type === "struct_type") {
                const fieldList = structType.childForFieldName("field_declaration_list");
                if (fieldList) {
                    for (let i = 0; i < fieldList.childCount; i++) {
                        const child = fieldList.child(i);
                        if (!child) continue;
                        if (child.type === "field_declaration") {
                            const fieldNameNode = child.childForFieldName("name");
                            if (fieldNameNode) fields.push(text(fieldNameNode));
                        }
                    }
                }
            }
        }

        models.push({
          name,
          file,
          framework: "go-struct",
          fields,
          relationships: []
        });
      }
    }

    const functions = extractGoFunctions(this.language, file, root);
    return { endpoints, models, components, tests, functions };
  }
};
