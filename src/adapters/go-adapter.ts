import { createRequire } from "node:module";
import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction
} from "./types.js";

const require = createRequire(import.meta.url);
const Go = require("tree-sitter-go");

function text(node: Parser.SyntaxNode | null | undefined): string {
  return node ? node.text : "";
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

    return { endpoints, models, components, tests };
  }
};
