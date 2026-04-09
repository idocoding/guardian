import Python from "tree-sitter-python";
import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction,
  FunctionRecord,
} from "./types.js";

// Utility to recursively find children of a certain type
function findChildren(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  if (node.type === type) results.push(node);
  for (const child of node.namedChildren) {
    results.push(...findChildren(child, type));
  }
  return results;
}

// ── Function-level intelligence helpers ──────────────────────────────────

/** re.* functions whose first argument is a regex pattern string */
const RE_FUNCS = new Set(["compile", "sub", "subn", "match", "search", "fullmatch", "findall", "finditer", "split"]);

/**
 * Collect string literals, regex patterns (strings passed to re.*), and call
 * targets from a Python function body subtree.
 */
function collectPythonBodyIntel(
  body: Parser.SyntaxNode,
  getText: (n: Parser.SyntaxNode) => string
): { stringLiterals: string[]; regexPatterns: string[]; calls: string[] } {
  const strings = new Set<string>();
  const regexes = new Set<string>();
  const calls = new Set<string>();

  function walk(n: Parser.SyntaxNode): void {
    if (n.type === "string") {
      // Python string: "text", 'text', """text""", r"pattern"
      const raw = getText(n);
      // Strip leading r/b/f/u prefix and quote chars
      const stripped = raw.replace(/^[rRbBuUfF]*/u, "").replace(/^'''|^"""|^'|^"/u, "").replace(/'''$|"""$|'$|"$/u, "");
      if (stripped.length > 0 && stripped.length < 300) {
        strings.add(stripped);

        // Is this string the first argument to a re.* call?
        const parent = n.parent;
        if (parent?.type === "argument_list") {
          const callNode = parent.parent;
          if (callNode?.type === "call") {
            const funcNode = callNode.childForFieldName("function");
            if (funcNode) {
              const fnText = getText(funcNode);
              // re.sub, re.compile, re.match, …
              const simple = fnText.split(".").pop() ?? "";
              if (fnText.startsWith("re.") && RE_FUNCS.has(simple)) {
                regexes.add(stripped);
              }
            }
          }
        }
      }
    } else if (n.type === "call") {
      const funcNode = n.childForFieldName("function");
      if (funcNode) {
        calls.add(getText(funcNode).trim());
      }
    }
    for (const child of n.namedChildren) walk(child);
  }

  walk(body);
  return {
    stringLiterals: [...strings],
    regexPatterns: [...regexes],
    calls: [...calls],
  };
}

/**
 * Recursively extract FunctionRecord entries from a Python AST node.
 * Handles top-level functions, methods inside classes, and nested functions.
 */
function extractPyFunctions(
  file: string,
  source: string,
  node: Parser.SyntaxNode
): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const getText = (n: Parser.SyntaxNode) => source.substring(n.startIndex, n.endIndex);

  function process(n: Parser.SyntaxNode): void {
    if (n.type === "function_definition") {
      const nameN = n.childForFieldName("name");
      const bodyN = n.childForFieldName("body");
      if (nameN && bodyN) {
        const funcName = getText(nameN);
        // Detect async: check if "async" keyword precedes the def
        const srcBefore = source.substring(n.startIndex, nameN.startIndex);
        const isAsync = /\basync\b/.test(srcBefore);
        const intel = collectPythonBodyIntel(bodyN, getText);
        records.push({
          id: `${file}#${funcName}:${n.startPosition.row + 1}`,
          name: funcName,
          file,
          lines: [n.startPosition.row + 1, n.endPosition.row + 1],
          calls: intel.calls,
          stringLiterals: intel.stringLiterals,
          regexPatterns: intel.regexPatterns,
          isAsync,
          language: "python",
        });
      }
    }
    for (const child of n.namedChildren) process(child);
  }

  process(node);
  return records;
}

export const PythonAdapter: SpecGuardAdapter = {
  name: "python",
  language: Python,
  fileExtensions: [".py"],
  queries: {
    endpoints: `
      (decorated_definition (decorator) @decorator definition: (function_definition name: (identifier) @handler))
      (call function: (identifier) @func_name (#match? @func_name "^path$|^re_path$")) @django_route
    `,
    models: `
      (class_definition name: (identifier) @name body: (block))
    `,
    tests: `
      (class_definition name: (identifier) @suite_name (#match? @suite_name "^Test"))
      (function_definition name: (identifier) @test_name (#match? @test_name "^test_"))
    `
  },
  extract(file: string, source: string, root: Parser.SyntaxNode) {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = [];
    const tests: TestExtraction[] = [];

    // Helper to get text
    const text = (n: Parser.SyntaxNode) => source.substring(n.startIndex, n.endIndex);

    // 1. Process Endpoints
    const epQuery = new Parser.Query(this.language as any, this.queries.endpoints!);
    const epMatches = epQuery.matches(root);

    for (const match of epMatches) {
      let isFastAPI = false;
      let isDjango = false;
      let method = "GET";
      let routePath = "";
      let handler = "";
      let decoratorNode: Parser.SyntaxNode | null = null;
      let handlerNode: Parser.SyntaxNode | null = null;

      for (const cap of match.captures) {
        if (cap.name === "decorator") decoratorNode = cap.node;
        if (cap.name === "handler") {
          handlerNode = cap.node;
          handler = text(cap.node);
        }
        if (cap.name === "django_route") isDjango = true;
      }

      if (decoratorNode) {
        const decText = text(decoratorNode);
        if (decText.includes(".get(") || decText.includes(".post(") || decText.includes(".put(") || decText.includes(".delete(") || decText.includes(".patch(")) {
          isFastAPI = true;
          if (decText.includes(".post(")) method = "POST";
          else if (decText.includes(".put(")) method = "PUT";
          else if (decText.includes(".delete(")) method = "DELETE";
          else if (decText.includes(".patch(")) method = "PATCH";
          else method = "GET";
          const strMatch = decText.match(/['"](.*?)['"]/);
          routePath = strMatch ? strMatch[1] : "";
        }
      }

      if (!isFastAPI && !isDjango) continue; // Not an endpoint

      const service_calls: string[] = [];
      let request_schema: string | null = null;
      let response_schema: string | null = null;

      // Deep Intra-node inspection
      if (handlerNode && handlerNode.parent) {
        // Find request schema from arguments
        const paramsNode = handlerNode.parent.childForFieldName("parameters");
        if (paramsNode) {
          for (const param of paramsNode.namedChildren) {
            if (param.type === "typed_parameter") {
              const typeNode = param.childForFieldName("type");
              if (typeNode) {
                const t = text(typeNode);
                if (t !== "Request" && t !== "Response" && t !== "Session" && t !== "Depends") {
                  request_schema = t;
                  break;
                }
              }
            }
          }
        }

        // Find service calls
        const bodyNode = handlerNode.parent.childForFieldName("body");
        if (bodyNode) {
          const calls = findChildren(bodyNode, "call");
          for (const call of calls) {
            const funcNode = call.childForFieldName("function");
            if (funcNode) {
              const fname = text(funcNode);
              if (fname !== "Depends") service_calls.push(fname);
            }
          }
        }
      }

      // Find response schema from decorator
      if (decoratorNode) {
        const decText = text(decoratorNode);
        const rmMatch = decText.match(/response_model=([a-zA-Z0-9_]+)/);
        if (rmMatch) response_schema = rmMatch[1];
      }

      endpoints.push({
        file,
        method,
        path: routePath,
        handler,
        request_schema,
        response_schema,
        service_calls: Array.from(new Set(service_calls))
      });
    }

    // 2. Process Models

    const mdQuery = new Parser.Query(this.language as any, this.queries.models!);
    const mdMatches = mdQuery.matches(root);

    for (const match of mdMatches) {
      let name = "";
      let classNode: Parser.SyntaxNode | null = null;

      for (const cap of match.captures) {
        if (cap.name === "name") {
          name = text(cap.node);
          classNode = cap.node.parent;
        }
      }

      if (!classNode) continue;
      
      const superclasses = classNode.childForFieldName("superclasses");
      const baseText = superclasses ? text(superclasses) : "";
      
      let framework = "unknown";
      if (baseText.includes("BaseModel")) framework = "pydantic";
      else if (baseText.includes("Model")) framework = "django";
      else if (baseText.includes("Base")) framework = "sqlalchemy";

      if (framework === "unknown") continue; // Not a recognized model

      const fields: string[] = [];
      const relationships: string[] = [];
      
      const body = classNode.childForFieldName("body");
      if (body) {
        // Collect class-level assignments
        const assignments = findChildren(body, "expression_statement")
          .map(e => e.namedChildren.find(c => c.type === "assignment" || c.type === "type" || c.type === "typed_parameter") || e);

        for (const stmt of assignments) {
          const stmtText = text(stmt);
          const matchField = stmtText.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\\s*[:=]/);
          if (matchField) {
            fields.push(matchField[1]);
            if (stmtText.includes("ForeignKey") || stmtText.includes("relationship(") || stmtText.includes("ManyTo")) {
              relationships.push(matchField[1]);
            }
          }
        }
      }

      models.push({
        name,
        file,
        framework,
        fields,
        relationships
      });
    }

    const functions = extractPyFunctions(file, source, root);

    return { endpoints, models, components, tests, functions };
  }
};
