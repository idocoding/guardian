import TypeScript from "tree-sitter-typescript";
import Parser from "tree-sitter";
import path from "node:path";
import type { SpecGuardAdapter, EndpointExtraction, ModelExtraction, ComponentExtraction } from "./types.js";

// Utility to recursively find children of a certain type
function findChildren(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  if (node.type === type) results.push(node);
  for (const child of node.namedChildren) {
    results.push(...findChildren(child, type));
  }
  return results;
}

export const TypeScriptAdapter: SpecGuardAdapter = {
  name: "typescript",
  language: TypeScript.tsx, // We use the TSX grammar to capture both TS and TSX seamlessly
  fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
  queries: {
    // Endpoints: Express "app.get('/route', (req, res) => {})" or NextJS Route Handlers
    endpoints: `
      (call_expression
        function: (member_expression
          object: (identifier) @app_instance
          property: (property_identifier) @method (#match? @method "^get$|^post$|^put$|^delete$|^patch|use$")
        )
        arguments: (arguments (string (string_fragment) @path))
      ) @express_route

      (export_statement
        declaration: (lexical_declaration
          (variable_declarator
            name: (identifier) @method (#match? @method "^GET$|^POST$|^PUT$|^DELETE$|^PATCH$")
            value: (arrow_function)
          )
        )
      ) @next_route
    `,
    // Components: React functions returning JSX, or default exports
    components: `
      (function_declaration
        name: (identifier) @name
        parameters: (formal_parameters)? @params
      ) @react_component
    `,
    // Tests: Jest/Vitest describe and it/test blocks
    tests: `
      (call_expression
        function: (identifier) @suite_func (#match? @suite_func "^describe$")
        arguments: (arguments (string (string_fragment) @suite_name))
      )
      (call_expression
        function: (identifier) @test_func (#match? @test_func "^it$|^test$")
        arguments: (arguments (string (string_fragment) @test_name))
      )
    `
  },
  extract(file: string, source: string, root: Parser.SyntaxNode) {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = [];
    const tests: any[] = [];

    const text = (n: Parser.SyntaxNode) => source.substring(n.startIndex, n.endIndex);

    const isNextJS = source.includes("next/server") || source.includes("next/router") || file.includes("app/") || file.includes("pages/");

    // 1. Process Endpoints
    const epQuery = new Parser.Query(this.language as any, this.queries.endpoints!);
    const epMatches = epQuery.matches(root);

    for (const match of epMatches) {
      let isExpress = false;
      let isNextRoute = false;
      let method = "GET";
      let routePath = "";
      
      for (const cap of match.captures) {
        if (cap.name === "express_route") isExpress = true;
        if (cap.name === "next_route") isNextRoute = true;
        if (cap.name === "method") method = text(cap.node).toUpperCase();
        if (cap.name === "path") routePath = text(cap.node);
      }

      if (isNextRoute && isNextJS) {
        // NextJS App Router infers path from the filesystem
        const parts = file.split("app/");
        if (parts.length > 1) {
          routePath = "/" + path.dirname(parts[1]);
          if (routePath.endsWith("/.")) routePath = routePath.slice(0, -2);
        }
      }

      if (isExpress || isNextRoute) {
        endpoints.push({
          file,
          method,
          path: routePath || "/",
          handler: isNextRoute ? method : "anonymous_handler",
          request_schema: null,
          response_schema: null,
          service_calls: []
        });
      }
    }

    // 2. Process React Components
    const compQuery = new Parser.Query(this.language as any, this.queries.components!);
    const compMatches = compQuery.matches(root);

    for (const match of compMatches) {
      let name = path.basename(file, path.extname(file)); // Fallback name
      let export_kind: "default" | "named" = "named";
      let propsNode: Parser.SyntaxNode | null = null;
      let id = "";

      for (const cap of match.captures) {
        if (cap.name === "name") name = text(cap.node);
        if (cap.name === "default_react_component") export_kind = "default";
        if (cap.name === "params") propsNode = cap.node;
      }
      
      id = file + "#" + name;

      const props: Array<{ name: string; type: string }> = [];

      // Extract React Prop definitions if typed
      if (propsNode) {
        const firstParam = propsNode.namedChildren[0];
        if (firstParam && firstParam.type === "required_parameter") {
          const pattern = firstParam.childForFieldName("pattern");
          const typeAnn = firstParam.childForFieldName("type");
          if (pattern && pattern.type === "object_pattern") {
            // Destructured props { title, className }
            for (const prop of pattern.namedChildren) {
              if (prop.type === "shorthand_property_identifier") {
                props.push({ name: text(prop), type: "any" });
              }
            }
          }
          if (typeAnn) {
            // If it's a typed parameter (props: ItemProps)
             const t = text(typeAnn).replace(/^:\\s*/, "");
             if (props.length === 0) {
               props.push({ name: "props", type: t });
             } else {
                props.forEach(p => p.type = t); // Assign the generic interface type
             }
          }
        }
      }

      components.push({
        id,
        name,
        file,
        export_kind,
        props
      });
    }

    // 3. Process Tests
    if (this.queries.tests) {
      const testsQuery = new Parser.Query(this.language as any, this.queries.tests);
      const testsMatches = testsQuery.matches(root);
      
      let currentSuite: string | null = null;
      for (const match of testsMatches) {
        let test_name = "";
        let suite_name: string | null = null;
        for (const cap of match.captures) {
          if (cap.name === "suite_name") suite_name = text(cap.node);
          if (cap.name === "test_name") test_name = text(cap.node);
        }
        
        // Very basic tracking: if we see a describe block, we remember its name.
        if (suite_name) currentSuite = suite_name;
        
        if (test_name) {
          tests.push({ file, test_name, suite_name: currentSuite });
        }
      }
    }

    return { endpoints, models, components, tests };
  }
};
