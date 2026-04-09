import Java from "tree-sitter-java";
import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction,
  FunctionRecord,
} from "./types.js";

function text(node: Parser.SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

// ── Function-level intelligence ───────────────────────────────────────────

const JAVA_FUNC_QUERY = `
  (method_declaration      name: (identifier) @name) @fn
  (constructor_declaration name: (identifier) @name) @fn
`;

function walkBody(body: Parser.SyntaxNode, visitor: (n: Parser.SyntaxNode) => void): void {
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

function collectJavaBodyIntel(
  body: Parser.SyntaxNode
): { stringLiterals: string[]; regexPatterns: string[]; calls: string[] } {
  const strings = new Set<string>();
  const calls = new Set<string>();

  walkBody(body, (n) => {
    if (n.type === "string_literal") {
      const raw = n.text.replace(/^"/, "").replace(/"$/, "");
      if (raw.length > 0 && raw.length < 300) strings.add(raw);
    } else if (n.type === "text_block") {
      const raw = n.text.replace(/^"""/, "").replace(/"""$/, "").trim();
      if (raw.length > 0 && raw.length < 300) strings.add(raw);
    } else if (n.type === "method_invocation") {
      const nameNode = n.childForFieldName("name");
      const objNode = n.childForFieldName("object");
      if (nameNode) {
        const call = objNode ? `${text(objNode)}.${text(nameNode)}` : text(nameNode);
        calls.add(call.split("\n")[0].trim());
      }
    }
  });

  return { stringLiterals: [...strings], regexPatterns: [], calls: [...calls] };
}

function extractJavaFunctions(
  language: any,
  file: string,
  root: Parser.SyntaxNode
): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const query = new Parser.Query(language, JAVA_FUNC_QUERY);

  for (const match of query.matches(root)) {
    const fnNode = match.captures.find((c) => c.name === "fn")?.node;
    const nameNode = match.captures.find((c) => c.name === "name")?.node;
    if (!fnNode || !nameNode) continue;

    const funcName = text(nameNode);
    const bodyNode = fnNode.childForFieldName("body");
    const intel = bodyNode
      ? collectJavaBodyIntel(bodyNode)
      : { stringLiterals: [], regexPatterns: [], calls: [] };

    const typeNode = fnNode.childForFieldName("type");
    const isAsync = /CompletableFuture|Mono|Flux|Future/.test(text(typeNode));

    records.push({
      id: `${file}#${funcName}:${fnNode.startPosition.row + 1}`,
      name: funcName,
      file,
      lines: [fnNode.startPosition.row + 1, fnNode.endPosition.row + 1],
      calls: intel.calls,
      stringLiterals: intel.stringLiterals,
      regexPatterns: intel.regexPatterns,
      isAsync,
      language: "java",
    });
  }

  return records;
}

export const JavaAdapter: SpecGuardAdapter = {
  name: "Java Spring Boot Adapter",
  language: Java,
  fileExtensions: [".java"],
  queries: {
    // Endpoints: Methods annotated with @*Mapping (e.g., @GetMapping, @PostMapping)
    endpoints: `(method_declaration (modifiers (annotation name: (identifier) @mapping (#match? @mapping "Mapping$"))) name: (identifier) @handler) @endpoint`,
    
    // Models: Classes annotated with @Entity, @Table, @Document (MongoDB), etc.
    models: `(class_declaration (modifiers (annotation name: (identifier) @annot (#match? @annot "Entity|Table|Document|MappedSuperclass"))) name: (identifier) @name) @model`,
    
    // Tests: Methods annotated with @Test
    tests: `
      (method_declaration
        (modifiers (annotation name: (identifier) @test_annot (#match? @test_annot "Test")))
        name: (identifier) @test_name
      )
    `
  },
  extract(file: string, source: string, root: Parser.SyntaxNode) {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = []; // Not heavily used in backend Java MVCs
    const tests: TestExtraction[] = [];

    const epQuery = new Parser.Query(this.language as any, this.queries.endpoints!);
    const mdQuery = new Parser.Query(this.language as any, this.queries.models!);

    // Extract Spring Boot Endpoints
    const epMatches = epQuery.matches(root);
    for (const match of epMatches) {
      const mappingNode = match.captures.find(c => c.name === "mapping")?.node;
      const handlerNode = match.captures.find(c => c.name === "handler")?.node;
      const endpointNode = match.captures.find(c => c.name === "endpoint")?.node;

      if (mappingNode && handlerNode && endpointNode) {
        const mappingType = text(mappingNode); // e.g. "GetMapping"
        const method = mappingType.replace("Mapping", "").toUpperCase() || "ANY";
        const handler = text(handlerNode);

        // Find route path: @GetMapping("/api/users") -> "/api/users"
        let routePath = "/";
        const annotationNode = mappingNode.parent;
        if (annotationNode) {
           const strMatch = text(annotationNode).match(/\\"([^\\"]+)\\"/);
           if (strMatch) routePath = strMatch[1];
        }

        // Basic payload schemas from parameters
        let requestSchema: string | null = null;
        let responseSchema: string | null = null;

        // Try to find return type for response schema
        const typeNode = endpointNode.childForFieldName("type");
        if (typeNode) responseSchema = text(typeNode);

        // Try to find @RequestBody parameter for request schema
        const paramsNode = endpointNode.childForFieldName("parameters");
        if (paramsNode) {
            for (let i = 0; i < paramsNode.childCount; i++) {
                const child = paramsNode.child(i);
                if (!child) continue;
                if (text(child).includes("@RequestBody")) {
                    const typeChild = child.childForFieldName("type");
                    if (typeChild) requestSchema = text(typeChild);
                }
            }
        }

        endpoints.push({
          method,
          path: routePath,
          handler,
          file,
          request_schema: requestSchema,
          response_schema: responseSchema,
          service_calls: []
        });
      }
    }

    // Extract JPA Models
    const mdMatches = mdQuery.matches(root);
    for (const match of mdMatches) {
      const nameNode = match.captures.find(c => c.name === "name")?.node;
      const modelNode = match.captures.find(c => c.name === "model")?.node;

      if (nameNode && modelNode) {
        const name = text(nameNode);
        const fields: string[] = [];
        const relationships: string[] = [];

        // Scan class body for fields
        const bodyNode = modelNode.childForFieldName("body");
        if (bodyNode) {
            for (let i = 0; i < bodyNode.childCount; i++) {
                 const child = bodyNode.child(i);
                 if (!child) continue;
                 if (child.type === "field_declaration") {
                     const declaredNode = child.childForFieldName("declarator");
                     if (declaredNode) {
                         const fieldName = declaredNode.childForFieldName("name");
                         const fText = text(fieldName);
                         if (fText) fields.push(fText);

                         // Check annotations on the field for JPA Relations
                         if (text(child).includes("@OneToMany") || text(child).includes("@ManyToOne") || text(child).includes("@ManyToMany") || text(child).includes("@OneToOne")) {
                             relationships.push(fText);
                         }
                     }
                 }
            }
        }

        models.push({
          name,
          file,
          framework: "jpa-hibernate",
          fields,
          relationships
        });
      }
    }

    const functions = extractJavaFunctions(this.language, file, root);
    return { endpoints, models, components, tests, functions };
  }
};
