import CSharp from "tree-sitter-c-sharp";
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

const CS_FUNC_QUERY = `
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

function collectCSharpBodyIntel(
  body: Parser.SyntaxNode
): { stringLiterals: string[]; regexPatterns: string[]; calls: string[] } {
  const strings = new Set<string>();
  const calls = new Set<string>();

  walkBody(body, (n) => {
    if (n.type === "string_literal" || n.type === "verbatim_string_literal") {
      const raw = n.text.replace(/^@?"/, "").replace(/"$/, "");
      if (raw.length > 0 && raw.length < 300) strings.add(raw);
    } else if (n.type === "interpolated_string_expression") {
      const raw = n.text.replace(/^\$"/, "").replace(/"$/, "");
      if (raw.length > 0 && raw.length < 300) strings.add(raw);
    } else if (n.type === "invocation_expression") {
      const fn = n.childForFieldName("function");
      if (fn) calls.add(fn.text.split("\n")[0].trim());
    }
  });

  return { stringLiterals: [...strings], regexPatterns: [], calls: [...calls] };
}

function extractCSharpFunctions(
  language: any,
  file: string,
  root: Parser.SyntaxNode
): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const query = new Parser.Query(language, CS_FUNC_QUERY);

  for (const match of query.matches(root)) {
    const fnNode = match.captures.find((c) => c.name === "fn")?.node;
    const nameNode = match.captures.find((c) => c.name === "name")?.node;
    if (!fnNode || !nameNode) continue;

    const funcName = text(nameNode);

    // async: scan direct children for modifier — no full-tree walk needed
    let isAsync = false;
    for (const child of fnNode.children) {
      if (child.type === "modifier" && child.text === "async") { isAsync = true; break; }
    }

    const bodyNode = fnNode.childForFieldName("body");
    const intel = bodyNode
      ? collectCSharpBodyIntel(bodyNode)
      : { stringLiterals: [], regexPatterns: [], calls: [] };

    records.push({
      id: `${file}#${funcName}:${fnNode.startPosition.row + 1}`,
      name: funcName,
      file,
      lines: [fnNode.startPosition.row + 1, fnNode.endPosition.row + 1],
      calls: intel.calls,
      stringLiterals: intel.stringLiterals,
      regexPatterns: intel.regexPatterns,
      isAsync,
      language: "csharp",
    });
  }

  return records;
}

export const CSharpAdapter: SpecGuardAdapter = {
  name: "C# ASP.NET Core Adapter",
  language: CSharp,
  fileExtensions: [".cs"],
  queries: {
    // Endpoints: Methods with an attribute [HttpXxx("...")]
    endpoints: "(method_declaration name: (identifier) @handler) @endpoint",
    // Models: C# classes without Controller or Service suffixes usually.
    models: "(class_declaration name: (identifier) @name) @model",
    // Tests: Methods with [Fact], [Test], [TestMethod], [Theory]
    tests: `
      (method_declaration
        (attribute_list (attribute name: (identifier) @test_attr (#match? @test_attr "^Fact$|^Test$|^TestMethod$|^Theory$")))
        name: (identifier) @test_name
      )
    `
  },
  extract(file: string, source: string, root: Parser.SyntaxNode) {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = []; // N/A
    const tests: TestExtraction[] = [];

    const epQuery = new Parser.Query(this.language as any, this.queries.endpoints!);
    const mdQuery = new Parser.Query(this.language as any, this.queries.models!);

    // Extract C# Endpoints
    const epMatches = epQuery.matches(root);
    for (const match of epMatches) {
      const handlerNode = match.captures.find(c => c.name === "handler")?.node;
      const endpointNode = match.captures.find(c => c.name === "endpoint")?.node;

      if (handlerNode && endpointNode) {
        let isEndpoint = false;
        let method = "ANY";
        let routePath = "/";

        // Scan the attributes of this method dynamically
        for (let i = 0; i < endpointNode.childCount; i++) {
             const child = endpointNode.child(i);
             if (!child) continue;
             if (child.type === "attribute_list") {
                 const attrText = text(child);
                 if (attrText.includes("HttpGet")) { isEndpoint = true; method = "GET"; }
                 else if (attrText.includes("HttpPost")) { isEndpoint = true; method = "POST"; }
                 else if (attrText.includes("HttpPut")) { isEndpoint = true; method = "PUT"; }
                 else if (attrText.includes("HttpDelete")) { isEndpoint = true; method = "DELETE"; }
                 else if (attrText.includes("HttpPatch")) { isEndpoint = true; method = "PATCH"; }

                 // Extract path if present
                 const strMatch = attrText.match(/\\"([^\\"]+)\\"/);
                 if (strMatch) routePath = strMatch[1];
             }
        }

        if (isEndpoint) {
             let requestSchema: string | null = null;
             let responseSchema: string | null = null;

             const typeNode = endpointNode.childForFieldName("type");
             if (typeNode) responseSchema = text(typeNode);

             const paramsNode = endpointNode.childForFieldName("parameters");
             if (paramsNode) {
                 for (let i = 0; i < paramsNode.childCount; i++) {
                     const pChild = paramsNode.child(i);
                     if (!pChild) continue;
                     if (text(pChild).includes("[FromBody]")) {
                         const typeChild = pChild.childForFieldName("type");
                         if (typeChild) requestSchema = text(typeChild);
                     } else if (pChild.type === "parameter") {
                         // Default ASP.NET Core Model Binding implicit body binding
                         const typeChild = pChild.childForFieldName("type");
                         if (typeChild && !["string", "int", "long", "boolean"].includes(text(typeChild).toLowerCase())) {
                              if (!requestSchema) requestSchema = text(typeChild);
                         }
                     }
                 }
             }

             endpoints.push({
               method,
               path: routePath,
               handler: text(handlerNode),
               file,
               request_schema: requestSchema,
               response_schema: responseSchema,
               service_calls: []
             });
        }
      }
    }

    // Extract C# Models
    const mdMatches = mdQuery.matches(root);
    for (const match of mdMatches) {
      const nameNode = match.captures.find(c => c.name === "name")?.node;
      const modelNode = match.captures.find(c => c.name === "model")?.node;

      if (nameNode && modelNode) {
        const name = text(nameNode);
        
        // Skip controllers, services, interfaces (which start with I usually), and unmapped classes
        if (name.endsWith("Controller") || name.endsWith("Service") || name.startsWith("I")) {
             continue;
        }

        const fields: string[] = [];

        const bodyNode = modelNode.childForFieldName("body");
        if (bodyNode) {
            for (let i = 0; i < bodyNode.childCount; i++) {
                 const child = bodyNode.child(i);
                 if (!child) continue;
                 if (child.type === "property_declaration") {
                     const fieldNameNode = child.childForFieldName("name");
                     if (fieldNameNode) fields.push(text(fieldNameNode));
                 }
            }
        }

        if (fields.length > 0) {
            models.push({
              name,
              file,
              framework: "csharp-poco",
              fields,
              relationships: []
            });
        }
      }
    }

    const functions = extractCSharpFunctions(this.language, file, root);
    return { endpoints, models, components, tests, functions };
  }
};
