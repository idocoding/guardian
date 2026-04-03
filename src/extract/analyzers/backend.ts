import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { SpecGuardConfig } from "../../config.js";
import type {
  BackendAnalysis,
  ModuleSummary,
  ModuleDependency,
  FileExportSummary,
  ExportDetail,
  UnusedExport,
  FileDependency,
  BackendEndpoint,
  DataModelSummary,
  EndpointModelUsage,
  BackgroundTaskSummary,
  EnumSummary,
  ConstantSummary,
  TestExtractionSummary
} from "../types.js";
import { addEdge, ensureNode, findCycles, inboundCounts, type DirectedGraph } from "../graph.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "../ignore.js";
import { extractPythonAst } from "../python.js";
import { findDuplicateFunctions } from "../duplicates.js";
import { computeTestCoverage } from "../tests.js";
import {
  hashContent,
  loadBackendExtractionCache,
  saveBackendExtractionCache,
  type BackendFileCacheEntry
} from "../cache.js";
import { getAdapterForFile, runAdapter } from "../../adapters/index.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const JS_RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

type ImportUsage = {
  specifier: string;
  symbols: string[];
  wildcard: boolean;
};

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath));
}

async function listFiles(root: string, ignore: IgnoreMatcher, baseRoot: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignore.isIgnoredDir(entry.name, fullPath)) {
        continue;
      }
      files.push(...(await listFiles(fullPath, ignore, baseRoot)));
      continue;
    }

    if (entry.isFile()) {
      const relative = path.relative(baseRoot, fullPath);
      if (!ignore.isIgnoredPath(relative)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveFileCandidate(basePath: string, extensions: string[]): Promise<string | null> {
  const ext = path.extname(basePath);
  if (ext) {
    if (await fileExists(basePath)) {
      return basePath;
    }

    const withoutExt = basePath.slice(0, -ext.length);
    for (const replacement of extensions) {
      const candidate = `${withoutExt}${replacement}`;
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    for (const replacement of extensions) {
      const candidate = path.join(withoutExt, `index${replacement}`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  for (const replacement of extensions) {
    const candidate = `${basePath}${replacement}`;
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  for (const replacement of extensions) {
    const candidate = path.join(basePath, `index${replacement}`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveJsImport(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return resolveFileCandidate(resolved, JS_RESOLVE_EXTENSIONS);
}

async function resolvePythonImport(
  fromFile: string,
  specifier: string,
  backendRoot: string,
  absoluteRoots: Set<string>
): Promise<string | null> {
  if (specifier.startsWith(".")) {
    const match = specifier.match(/^(\.+)(.*)$/);
    if (!match) {
      return null;
    }

    const dotCount = match[1].length;
    const remainder = match[2] ? match[2].replace(/\./g, "/") : "";

    let baseDir = path.dirname(fromFile);
    for (let i = 1; i < dotCount; i += 1) {
      baseDir = path.dirname(baseDir);
    }

    const targetBase = remainder ? path.join(baseDir, remainder) : baseDir;

    const fileCandidate = await resolveFileCandidate(targetBase, [".py"]);
    if (fileCandidate) {
      return fileCandidate;
    }

    const initCandidate = path.join(targetBase, "__init__.py");
    if (await fileExists(initCandidate)) {
      return initCandidate;
    }

    return null;
  }

  const segments = specifier.split(".").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  if (!absoluteRoots.has(segments[0])) {
    return null;
  }

  const targetBase = path.join(backendRoot, ...segments);
  const fileCandidate = await resolveFileCandidate(targetBase, [".py"]);
  if (fileCandidate) {
    return fileCandidate;
  }

  const initCandidate = path.join(targetBase, "__init__.py");
  if (await fileExists(initCandidate)) {
    return initCandidate;
  }

  return null;
}

function extractPythonImportUsages(content: string): ImportUsage[] {
  const usages: ImportUsage[] = [];

  for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm)) {
    const specifier = match[1];

    let namesPart = match[2].split("#")[0]?.trim() ?? "";
    namesPart = namesPart.replace(/[()]/g, "");

    const names = namesPart
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    if (names.includes("*")) {
      usages.push({ specifier, symbols: [], wildcard: true });
      continue;
    }

    const symbols = names
      .map((name) => name.split(/\s+as\s+/i)[0]?.trim() ?? "")
      .filter(Boolean);

    usages.push({ specifier, symbols, wildcard: false });
  }

  for (const match of content.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
    const namesPart = match[1].split("#")[0]?.trim() ?? "";
    const parts = namesPart
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    for (const part of parts) {
      const specifier = part.split(/\s+as\s+/i)[0]?.trim() ?? "";
      usages.push({ specifier, symbols: [], wildcard: true });
    }
  }

  return usages;
}

function extractPythonExports(content: string): string[] {
  const exports = new Set<string>();
  const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/m);
  if (allMatch) {
    const entries = allMatch[1].match(/["']([^"']+)["']/g) ?? [];
    for (const entry of entries) {
      exports.add(entry.replace(/["']/g, ""));
    }
  }
  return Array.from(exports).sort((a, b) => a.localeCompare(b));
}

type EndpointCandidate = {
  method: string;
  path: string;
  handler: string;
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

function normalizeEndpointPath(raw: string): string {
  if (!raw) {
    return "/";
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  return `/${raw}`;
}

function extractPythonEndpoints(content: string): EndpointCandidate[] {
  const endpoints: EndpointCandidate[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const decoratorMatch = line.match(
      /^\s*@[\w.]+?\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/
    );
    if (decoratorMatch) {
      const method = decoratorMatch[1].toUpperCase();
      const pathValue = normalizeEndpointPath(decoratorMatch[2]);
      let handler = "anonymous";

      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim().startsWith("@")) {
          continue;
        }
        const defMatch = next.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (defMatch) {
          handler = defMatch[1];
        }
        break;
      }

      endpoints.push({ method, path: pathValue, handler, service_calls: [], ai_operations: [] });
      continue;
    }

    const djangoPathMatch = line.match(
      /^\s*(?:path|re_path)\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z0-9_.]+)/
    );
    if (djangoPathMatch) {
      const pathValue = normalizeEndpointPath(djangoPathMatch[1]);
      const handler = djangoPathMatch[2];
      endpoints.push({ method: "ANY", path: pathValue, handler, service_calls: [], ai_operations: [] });
    }
  }

  return endpoints;
}

function extractJsEndpoints(content: string, filePath: string): EndpointCandidate[] {
  const endpoints: EndpointCandidate[] = [];
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

  type HandlerInfo = {
    node: ts.FunctionLikeDeclaration;
    typeNode?: ts.TypeNode;
  };

  const handlerMap = new Map<string, HandlerInfo>();

  const registerHandler = (name: string, node: ts.FunctionLikeDeclaration, typeNode?: ts.TypeNode) => {
    handlerMap.set(name, { node, typeNode });
  };

  const collectHandlers = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      registerHandler(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        registerHandler(node.name.text, node.initializer, node.type);
      }
    }
    ts.forEachChild(node, collectHandlers);
  };

  collectHandlers(source);

  const extractHandlerName = (node: ts.Expression | undefined): string => {
    if (!node) {
      return "anonymous";
    }
    if (ts.isIdentifier(node)) {
      return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
      return `${node.expression.getText(source)}.${node.name.text}`;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return node.name?.text ?? "anonymous";
    }
    return "anonymous";
  };

  const extractRoutePath = (node: ts.Expression | undefined): string | null => {
    if (!node) {
      return null;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return normalizeEndpointPath(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      return normalizeEndpointPath(node.getText(source));
    }
    return null;
  };

  const resolveHandlerInfo = (node: ts.Expression | undefined): HandlerInfo | null => {
    if (!node) {
      return null;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return { node };
    }
    if (ts.isIdentifier(node)) {
      return handlerMap.get(node.text) ?? null;
    }
    return null;
  };

  const extractSchemasFromHandler = (
    handlerInfo: HandlerInfo | null
  ): { requestSchema: string | null; responseSchema: string | null } => {
    let requestSchema: string | null = null;
    let responseSchema: string | null = null;

    const parseRequestType = (typeNode: ts.TypeNode | undefined): void => {
      if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
        return;
      }
      const typeName = typeNode.typeName.getText(source);
      const args = typeNode.typeArguments ?? [];
      if (typeName.endsWith("RequestHandler") || typeName === "RequestHandler") {
        if (args[2]) {
          requestSchema = requestSchema ?? args[2].getText(source);
        }
        if (args[1]) {
          responseSchema = responseSchema ?? args[1].getText(source);
        }
      }
      if (typeName.endsWith("Request")) {
        if (args[2]) {
          requestSchema = requestSchema ?? args[2].getText(source);
        }
        if (args[1]) {
          responseSchema = responseSchema ?? args[1].getText(source);
        }
      }
      if (typeName.endsWith("Response") && args[0]) {
        responseSchema = responseSchema ?? args[0].getText(source);
      }
    };

    if (handlerInfo) {
      const params = handlerInfo.node.parameters;
      if (params[0]?.type) {
        parseRequestType(params[0].type);
      }
      if (params[1]?.type) {
        parseRequestType(params[1].type);
      }
      if ((!requestSchema || !responseSchema) && handlerInfo.typeNode) {
        parseRequestType(handlerInfo.typeNode);
      }
    }

    return { requestSchema, responseSchema };
  };

  const extractTokenBudget = (callNode: ts.CallExpression) => {
    const opts = callNode.arguments.find((arg) => ts.isObjectLiteralExpression(arg));
    if (!opts || !ts.isObjectLiteralExpression(opts)) {
      return { maxTokens: null, maxOutputTokens: null, tokenBudget: null };
    }
    return extractTokenBudgetFromObjectLiteral(opts);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        const method = expr.name.text;
        if (HTTP_METHODS.has(method)) {
          const pathValue = extractRoutePath(node.arguments[0]);
          if (pathValue) {
            const handlerArg = node.arguments[node.arguments.length - 1];
            const handler = extractHandlerName(handlerArg);
            
            // basic schema extraction from generic params
            let requestSchema: string | null = null;
            let responseSchema: string | null = null;
            
            if (node.typeArguments && node.typeArguments.length > 0) {
              const reqType = node.typeArguments[0];
              if (reqType) {
                 requestSchema = reqType.getText(source);
              }
              if (node.typeArguments.length > 1) {
                  const resType = node.typeArguments[1];
                  responseSchema = resType?.getText(source) ?? null;
              }
            }
            if (!requestSchema || !responseSchema) {
              const derived = extractSchemasFromHandler(resolveHandlerInfo(handlerArg));
              requestSchema = requestSchema ?? derived.requestSchema;
              responseSchema = responseSchema ?? derived.responseSchema;
            }

            let serviceCalls: string[] = [];
            let aiOperations: Array<{ provider: "openai" | "anthropic" | "unknown", operation: string, model?: string | null, max_tokens?: number | null, max_output_tokens?: number | null, token_budget?: number | null }> = [];
            const handlerNode = handlerArg;
            if (handlerNode) {
               const visitHandler = (n: ts.Node) => {
                  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
                     const callName = `${n.expression.expression.getText(source)}.${n.expression.name.text}`;
                     serviceCalls.push(callName);
                     
                     const lowerCall = callName.toLowerCase();
                     if (lowerCall.includes("openai") || lowerCall.includes("chatcompletions") || lowerCall.includes("anthropic")) {
                         // Very basic model extraction from second argument (options bag) for JS
                         let model: string | null = null;
                         const opts = n.arguments.find((arg) => ts.isObjectLiteralExpression(arg));
                         if (opts && ts.isObjectLiteralExpression(opts)) {
                             for (const prop of opts.properties) {
                                 if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "model") {
                                     model = getStringLiteral(prop.initializer) ?? null;
                                 }
                             }
                         }
                         const tokenBudget = extractTokenBudget(n);
                         aiOperations.push({
                             provider: lowerCall.includes("openai") ? "openai" : "anthropic",
                             operation: callName,
                             model,
                             max_tokens: tokenBudget.maxTokens,
                             max_output_tokens: tokenBudget.maxOutputTokens,
                             token_budget: tokenBudget.tokenBudget
                         });
                     }
                  } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
                     serviceCalls.push(n.expression.text);
                  }
                  ts.forEachChild(n, visitHandler);
               };
               ts.forEachChild(handlerNode, visitHandler);
            }

            endpoints.push({
              method: method.toUpperCase(),
              path: pathValue,
              handler,
              request_schema: requestSchema,
              response_schema: responseSchema,
              service_calls: Array.from(new Set(serviceCalls)).sort(),
              ai_operations: aiOperations
            });
          }
        }

        if (expr.name.text === "route" && node.arguments.length > 0) {
          const pathValue = extractRoutePath(node.arguments[0]);
          if (pathValue) {
            const parent = node.parent;
            if (
              parent &&
              ts.isPropertyAccessExpression(parent) &&
              HTTP_METHODS.has(parent.name.text)
            ) {
              const callParent = parent.parent;
              if (callParent && ts.isCallExpression(callParent)) {
                const handlerArg = callParent.arguments[callParent.arguments.length - 1];
                const handler = extractHandlerName(handlerArg);
                
                let requestSchema: string | null = null;
                let responseSchema: string | null = null;

                if (callParent.typeArguments && callParent.typeArguments.length > 0) {
                   const reqType = callParent.typeArguments[0];
                   if (reqType) {
                      requestSchema = reqType.getText(source);
                   }
                   if (callParent.typeArguments.length > 1) {
                      const resType = callParent.typeArguments[1];
                      responseSchema = resType?.getText(source) ?? null;
                   }
                }
                if (!requestSchema || !responseSchema) {
                  const derived = extractSchemasFromHandler(resolveHandlerInfo(handlerArg));
                  requestSchema = requestSchema ?? derived.requestSchema;
                  responseSchema = responseSchema ?? derived.responseSchema;
                }

                let serviceCalls: string[] = [];
                let aiOperations: Array<{ provider: "openai" | "anthropic" | "unknown", operation: string, model?: string | null, max_tokens?: number | null, max_output_tokens?: number | null, token_budget?: number | null }> = [];
                const handlerNode = handlerArg;
                if (handlerNode) {
                   const visitHandler = (n: ts.Node) => {
                      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
                         const callName = `${n.expression.expression.getText(source)}.${n.expression.name.text}`;
                         serviceCalls.push(callName);
                         
                         const lowerCall = callName.toLowerCase();
                         if (lowerCall.includes("openai") || lowerCall.includes("chatcompletions") || lowerCall.includes("anthropic")) {
                             let model: string | null = null;
                             const opts = n.arguments.find((arg) => ts.isObjectLiteralExpression(arg));
                             if (opts && ts.isObjectLiteralExpression(opts)) {
                                 for (const prop of opts.properties) {
                                     if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "model") {
                                         model = getStringLiteral(prop.initializer) ?? null;
                                     }
                                 }
                             }
                             const tokenBudget = extractTokenBudget(n);
                             aiOperations.push({
                                 provider: lowerCall.includes("openai") ? "openai" : "anthropic",
                                 operation: callName,
                                 model,
                                 max_tokens: tokenBudget.maxTokens,
                                 max_output_tokens: tokenBudget.maxOutputTokens,
                                 token_budget: tokenBudget.tokenBudget
                             });
                         }
                      } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
                         serviceCalls.push(n.expression.text);
                      }
                      ts.forEachChild(n, visitHandler);
                   };
                   ts.forEachChild(handlerNode, visitHandler);
                }

                endpoints.push({
                  method: parent.name.text.toUpperCase(),
                  path: pathValue,
                  handler,
                  request_schema: requestSchema,
                  response_schema: responseSchema,
                  service_calls: Array.from(new Set(serviceCalls)).sort(),
                  ai_operations: aiOperations
                });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return endpoints;
}

function extractCeleryTasks(content: string): Array<{ name: string; queue?: string | null }> {
  const tasks: Array<{ name: string; queue?: string | null }> = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const decoratorMatch = line.match(/^\s*@(?:\w+\.)?(shared_task|task)\b(?:\(([^)]*)\))?/);
    if (!decoratorMatch) {
      continue;
    }

    let queue: string | null = null;
    const args = decoratorMatch[2] ?? "";
    const queueMatch = args.match(/queue\s*=\s*["']([^"']+)["']/);
    if (queueMatch) {
      queue = queueMatch[1];
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim().startsWith("@")) {
        continue;
      }
      const defMatch = next.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (defMatch) {
        tasks.push({ name: defMatch[1], queue });
      }
      break;
    }
  }

  return tasks;
}

function extractSqlAlchemyModels(content: string, file: string): DataModelSummary[] {
  const models: DataModelSummary[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/);
    if (!classMatch) {
      continue;
    }
    const indent = classMatch[1].length;
    const name = classMatch[2];
    const bases = classMatch[3];

    const isSqlAlchemy =
      /\\bBase\\b/.test(bases) ||
      /DeclarativeBase/.test(bases) ||
      /db\\.Model/.test(bases) ||
      /SQLAlchemy/.test(content);

    if (!isSqlAlchemy) {
      continue;
    }

    const fields = new Set<string>();
    const relationships = new Set<string>();

    for (let j = i + 1; j < lines.length; j += 1) {
      const bodyLine = lines[j];
      const bodyIndent = bodyLine.match(/^\s*/)?.[0].length ?? 0;
      if (bodyIndent <= indent && bodyLine.trim()) {
        break;
      }
      const fieldMatch = bodyLine.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(Column|mapped_column)\s*\(/);
      if (fieldMatch) {
        fields.add(fieldMatch[1]);
        continue;
      }
      const relMatch = bodyLine.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*relationship\s*\(/);
      if (relMatch) {
        relationships.add(relMatch[1]);
      }
    }

    models.push({
      name,
      file,
      framework: "sqlalchemy",
      fields: Array.from(fields).sort((a, b) => a.localeCompare(b)),
      relationships: Array.from(relationships).sort((a, b) => a.localeCompare(b))
    });
  }

  return models;
}

function extractDjangoModels(content: string, file: string): DataModelSummary[] {
  const models: DataModelSummary[] = [];
  const lines = content.split(/\r?\n/);
  const hasDjangoImport = /django\\.db/.test(content);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/);
    if (!classMatch) {
      continue;
    }
    const indent = classMatch[1].length;
    const name = classMatch[2];
    const bases = classMatch[3];

    const isDjango =
      /models\\.Model/.test(bases) || (hasDjangoImport && /\\bModel\\b/.test(bases));

    if (!isDjango) {
      continue;
    }

    const fields = new Set<string>();
    const relationships = new Set<string>();

    for (let j = i + 1; j < lines.length; j += 1) {
      const bodyLine = lines[j];
      const bodyIndent = bodyLine.match(/^\s*/)?.[0].length ?? 0;
      if (bodyIndent <= indent && bodyLine.trim()) {
        break;
      }
      const fieldMatch = bodyLine.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*models\.([A-Za-z0-9_]+)\s*\(/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const fieldType = fieldMatch[2];
        fields.add(fieldName);
        if (/ForeignKey|ManyToMany|OneToOne/.test(fieldType)) {
          relationships.add(`${fieldName}:${fieldType}`);
        }
      }
    }

    models.push({
      name,
      file,
      framework: "django",
      fields: Array.from(fields).sort((a, b) => a.localeCompare(b)),
      relationships: Array.from(relationships).sort((a, b) => a.localeCompare(b))
    });
  }

  return models;
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".ts":
    default:
      return ts.ScriptKind.TS;
  }
}

function getStringLiteral(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function getNumberLiteral(node: ts.Expression | undefined): number | null {
  if (!node) {
    return null;
  }
  if (ts.isNumericLiteral(node)) {
    const parsed = Number(node.text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const sign = node.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    const parsed = Number(node.operand.text);
    return Number.isFinite(parsed) ? sign * parsed : null;
  }
  return null;
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

function extractTokenBudgetFromObjectLiteral(
  obj: ts.ObjectLiteralExpression
): { maxTokens: number | null; maxOutputTokens: number | null; tokenBudget: number | null } {
  let maxTokens: number | null = null;
  let maxOutputTokens: number | null = null;

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const key = getPropertyNameText(prop.name);
    if (!key) {
      continue;
    }
    const value = getNumberLiteral(prop.initializer);
    if (value === null) {
      continue;
    }
    switch (key) {
      case "max_tokens":
      case "maxTokens":
      case "max_completion_tokens":
      case "maxCompletionTokens":
      case "max_new_tokens":
      case "maxNewTokens":
      case "token_limit":
      case "tokenLimit":
      case "tokens":
        maxTokens = value;
        break;
      case "max_output_tokens":
      case "maxOutputTokens":
        maxOutputTokens = value;
        break;
      default:
        break;
    }
  }

  const tokenBudget = maxOutputTokens ?? maxTokens;
  return { maxTokens, maxOutputTokens, tokenBudget };
}

function parseJsFile(content: string, filePath: string): {
  imports: string[];
  usages: ImportUsage[];
  exports: string[];
  exportDetails: ExportDetail[];
} {
  const imports = new Set<string>();
  const usages: ImportUsage[] = [];
  const exports = new Set<string>();
  const exportDetailMap = new Map<string, ExportDetail>();

  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(filePath)
  );

  const addUsage = (specifier: string, symbols: string[], wildcard: boolean): void => {
    imports.add(specifier);
    usages.push({ specifier, symbols, wildcard });
  };

  const addExport = (name: string | undefined): void => {
    if (name) {
      exports.add(name);
    }
  };

  const addExportDetail = (detail: ExportDetail): void => {
    const key = `${detail.kind}|${detail.name}|${detail.alias ?? ""}`;
    exportDetailMap.set(key, detail);
  };

  const handleExportedDeclaration = (node: ts.Node, name?: ts.Identifier): void => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault) {
      exports.add("default");
      addExportDetail({
        name: name?.text ?? "default",
        kind: "default"
      });
      return;
    }
    if (name?.text) {
      exports.add(name.text);
      addExportDetail({
        name: name.text,
        kind: "named"
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = getStringLiteral(node.moduleSpecifier);
      if (specifier) {
        const symbols: string[] = [];
        let wildcard = false;

        const clause = node.importClause;
        if (clause) {
          if (clause.name) {
            symbols.push("default");
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              wildcard = true;
            } else if (ts.isNamedImports(clause.namedBindings)) {
              for (const element of clause.namedBindings.elements) {
                const original = element.propertyName?.text ?? element.name.text;
                symbols.push(original);
              }
            }
          }
        }

        addUsage(specifier, symbols, wildcard);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = getStringLiteral(node.moduleReference.expression);
        if (specifier) {
          addUsage(specifier, [], true);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier ? getStringLiteral(node.moduleSpecifier) : null;
      if (specifier) {
        if (!node.exportClause) {
          addUsage(specifier, [], true);
        } else if (ts.isNamedExports(node.exportClause)) {
          const symbols = node.exportClause.elements.map((element) =>
            element.propertyName?.text ?? element.name.text
          );
          addUsage(specifier, symbols, false);
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.add(element.name.text);
          addExportDetail({
            name: element.propertyName?.text ?? element.name.text,
            kind: "named",
            alias:
              element.propertyName && element.propertyName.text !== element.name.text
                ? element.name.text
                : undefined
          });
        }
      }
    } else if (ts.isExportAssignment(node)) {
      exports.add("default");
      addExportDetail({
        name: ts.isIdentifier(node.expression) ? node.expression.text : "default",
        kind: "default"
      });
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
    } else if (ts.isClassDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
    } else if (ts.isEnumDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
    } else if (ts.isVariableStatement(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exports.add(declaration.name.text);
            addExportDetail({
              name: declaration.name.text,
              kind: "named"
            });
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = getStringLiteral(node.arguments[0]);
        if (specifier) {
          addUsage(specifier, [], true);
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const specifier = getStringLiteral(node.arguments[0]);
        if (specifier) {
          addUsage(specifier, [], true);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return {
    imports: Array.from(imports).sort((a, b) => a.localeCompare(b)),
    usages,
    exports: Array.from(exports).sort((a, b) => a.localeCompare(b)),
    exportDetails: Array.from(exportDetailMap.values()).sort((a, b) => {
      const kind = a.kind.localeCompare(b.kind);
      if (kind !== 0) {
        return kind;
      }
      const name = a.name.localeCompare(b.name);
      if (name !== 0) {
        return name;
      }
      return (a.alias ?? "").localeCompare(b.alias ?? "");
    })
  };
}

function classifyLayer(inbound: number, outbound: number): ModuleSummary["layer"] {
  if (inbound === 0 && outbound === 0) {
    return "isolated";
  }
  if (outbound === 0 && inbound > 0) {
    return "core";
  }
  if (inbound === 0 && outbound > 0) {
    return "top";
  }
  return "middle";
}

async function resolveEntrypointCandidates(entry: string, baseDir: string): Promise<string[]> {
  const candidates: string[] = [];
  const absPath = path.resolve(baseDir, entry);
  candidates.push(absPath);

  const ext = path.extname(absPath);
  if (ext) {
    const withoutExt = absPath.slice(0, -ext.length);
    candidates.push(`${withoutExt}.ts`);
    candidates.push(`${withoutExt}.tsx`);
  } else {
    candidates.push(`${absPath}.ts`);
    candidates.push(`${absPath}.tsx`);
    candidates.push(`${absPath}.js`);
    candidates.push(`${absPath}.jsx`);
    candidates.push(`${absPath}.mjs`);
    candidates.push(`${absPath}.cjs`);
  }

  if (absPath.includes(`${path.sep}dist${path.sep}`)) {
    candidates.push(absPath.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`));
  }
  if (absPath.includes(`${path.sep}lib${path.sep}`)) {
    candidates.push(absPath.replace(`${path.sep}lib${path.sep}`, `${path.sep}src${path.sep}`));
  }

  return candidates;
}

async function detectEntrypoints(backendRoot: string, baseRoot: string): Promise<Set<string>> {
  const entrypoints = new Set<string>();
  const packageCandidates = [
    path.join(backendRoot, "package.json"),
    path.join(baseRoot, "package.json")
  ];

  for (const pkgPath of packageCandidates) {
    let pkgRaw: string | null = null;
    try {
      pkgRaw = await fs.readFile(pkgPath, "utf8");
    } catch {
      continue;
    }

    let pkg: { main?: string; bin?: string | Record<string, string> } | null = null;
    try {
      pkg = JSON.parse(pkgRaw);
    } catch {
      pkg = null;
    }
    if (!pkg) {
      continue;
    }

    const baseDir = path.dirname(pkgPath);
    const entries: string[] = [];
    if (pkg.main) {
      entries.push(pkg.main);
    }
    if (pkg.bin) {
      if (typeof pkg.bin === "string") {
        entries.push(pkg.bin);
      } else {
        entries.push(...Object.values(pkg.bin));
      }
    }

    for (const entry of entries) {
      const candidates = await resolveEntrypointCandidates(entry, baseDir);
      for (const candidate of candidates) {
        const resolved = await resolveFileCandidate(candidate, JS_RESOLVE_EXTENSIONS);
        if (resolved) {
          entrypoints.add(toPosix(path.relative(baseRoot, resolved)));
        }
      }
    }
  }

  const pyMain = path.join(backendRoot, "__main__.py");
  if (await fileExists(pyMain)) {
    entrypoints.add(toPosix(path.relative(baseRoot, pyMain)));
  }

  return entrypoints;
}

async function detectPythonPackageRoots(
  backendRoot: string,
  ignore: IgnoreMatcher
): Promise<string[]> {
  const roots: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(backendRoot, { withFileTypes: true });
  } catch {
    return roots;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(backendRoot, entry.name);
    if (ignore.isIgnoredDir(entry.name, fullPath)) {
      continue;
    }
    const initPath = path.join(fullPath, "__init__.py");
    if (await fileExists(initPath)) {
      roots.push(entry.name);
    }
  }

  return roots.sort((a, b) => a.localeCompare(b));
}

function extractJsEnums(content: string, filePath: string): EnumSummary[] {
  const enums: EnumSummary[] = [];
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(filePath)
  );

  const visit = (node: ts.Node): void => {
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const values: string[] = [];
      for (const member of node.members) {
        if (ts.isIdentifier(member.name)) {
          values.push(member.name.text);
        } else if (ts.isStringLiteral(member.name)) {
          values.push(member.name.text);
        }
      }
      enums.push({ name, file: filePath, values });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return enums;
}

function extractJsConstants(content: string, filePath: string): ConstantSummary[] {
  const constants: ConstantSummary[] = [];
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(filePath)
  );

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      if (node.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const name = declaration.name.text;
            if (name === name.toUpperCase() && name !== "_") {
              const type = declaration.type ? declaration.type.getText(source) : "unknown";
              const value = declaration.initializer ? declaration.initializer.getText(source) : "unknown";
              constants.push({ name, file: filePath, type, value });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

type CachedPythonFileResult = Pick<
  BackendFileCacheEntry,
  | "importUsages"
  | "exports"
  | "exportDetails"
  | "endpoints"
  | "dataModels"
  | "tasks"
  | "enums"
  | "constants"
  | "endpointModelUsage"
>;

function emptyPythonFileResult(): CachedPythonFileResult {
  return {
    importUsages: [],
    exports: [],
    exportDetails: [],
    endpoints: [],
    dataModels: [],
    tasks: [],
    enums: [],
    constants: [],
    endpointModelUsage: []
  };
}

export async function analyzeBackend(
  backendRoot: string,
  config: SpecGuardConfig
): Promise<BackendAnalysis> {
  const root = path.resolve(backendRoot);
  const baseRoot = path.dirname(root);
  const ignore = createIgnoreMatcher(config, baseRoot);
  const pythonPackageRoots = await detectPythonPackageRoots(root, ignore);
  const absoluteImportRoots = new Set<string>([
    ...pythonPackageRoots,
    ...(config.python?.absoluteImportRoots ?? [])
  ]);
  const entries = await fs.readdir(root, { withFileTypes: true });

  const modules: ModuleSummary[] = [];
  const rootFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (entry.isFile()) {
        const absoluteFile = path.join(root, entry.name);
        const relative = path.relative(baseRoot, absoluteFile);
        if (isCodeFile(absoluteFile) && !ignore.isIgnoredPath(relative)) {
          rootFiles.push(toPosix(relative));
        }
      }
      continue;
    }
    if (ignore.isIgnoredDir(entry.name, path.join(root, entry.name))) {
      continue;
    }

    const moduleRoot = path.join(root, entry.name);
    const files = (await listFiles(moduleRoot, ignore, baseRoot))
      .map((file) => toPosix(path.relative(baseRoot, file)))
      .sort((a, b) => a.localeCompare(b));

    modules.push({
      id: entry.name,
      path: toPosix(path.relative(baseRoot, moduleRoot)),
      type: "backend",
      layer: "isolated",
      files,
      endpoints: [],
      imports: [],
      exports: []
    });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));

  const fileToModule = new Map<string, string>();
  const moduleImports = new Map<string, Set<string>>();
  const codeFiles: string[] = [];
  const fileExports = new Map<string, string[]>();
  const fileContents = new Map<string, string>();
  const endpoints: BackendEndpoint[] = [];
  const endpointKeys = new Set<string>();
  const dataModels: DataModelSummary[] = [];
  const dataModelKeys = new Set<string>();
  const tasks: BackgroundTaskSummary[] = [];
  const enums: EnumSummary[] = [];
  const constants: ConstantSummary[] = [];

  for (const module of modules) {
    moduleImports.set(module.id, new Set());
    for (const file of module.files) {
      fileToModule.set(file, module.id);
      if (isCodeFile(file)) {
        codeFiles.push(file);
      }
    }
  }

  for (const file of rootFiles) {
    if (!codeFiles.includes(file)) {
      codeFiles.push(file);
    }
  }

  codeFiles.sort((a, b) => a.localeCompare(b));

  const knownFiles = new Set(codeFiles);
  const { cachePath, cache } = await loadBackendExtractionCache({
    projectRoot: baseRoot,
    config
  });
  const activeAbsoluteFiles = new Set(codeFiles.map((file) => path.join(baseRoot, file)));
  for (const cachedFile of Object.keys(cache.files)) {
    if (!activeAbsoluteFiles.has(cachedFile)) {
      delete cache.files[cachedFile];
    }
  }

  const pythonFilesAbs = codeFiles
    .filter((file) => path.extname(file) === ".py")
    .map((file) => path.join(baseRoot, file));
  const pythonResultsByFile = new Map<string, CachedPythonFileResult>();
  let canReusePythonCache = pythonFilesAbs.length > 0;

  for (const absoluteFile of pythonFilesAbs) {
    const cached = cache.files[absoluteFile];
    if (!cached || cached.language !== "python") {
      canReusePythonCache = false;
      break;
    }
    try {
      const stat = await fs.stat(absoluteFile);
      if (cached.mtime !== stat.mtimeMs) {
        const content = await fs.readFile(absoluteFile, "utf8");
        const hash = hashContent(content);
        if (hash !== cached.hash) {
          canReusePythonCache = false;
          break;
        }
        cached.mtime = stat.mtimeMs;
      }
    } catch {
      canReusePythonCache = false;
      break;
    }
  }

  if (canReusePythonCache) {
    for (const absoluteFile of pythonFilesAbs) {
      const cached = cache.files[absoluteFile];
      if (!cached) {
        continue;
      }
      pythonResultsByFile.set(toPosix(path.relative(baseRoot, absoluteFile)), {
        importUsages: cached.importUsages,
        exports: cached.exports,
        exportDetails: cached.exportDetails,
        endpoints: cached.endpoints,
        dataModels: cached.dataModels,
        tasks: cached.tasks,
        enums: cached.enums,
        constants: cached.constants,
        endpointModelUsage: cached.endpointModelUsage
      });
    }
  } else if (pythonFilesAbs.length > 0) {
    const pythonAst = extractPythonAst(pythonFilesAbs);
    const grouped = new Map<string, CachedPythonFileResult>();
    for (const absoluteFile of pythonFilesAbs) {
      grouped.set(toPosix(path.relative(baseRoot, absoluteFile)), emptyPythonFileResult());
    }

    if (pythonAst) {
      for (const endpoint of pythonAst.endpoints) {
        const relativeFile = toPosix(path.relative(baseRoot, endpoint.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.endpoints.push({
          id: "",
          method: endpoint.method,
          path: endpoint.path,
          handler: endpoint.handler,
          file: relativeFile,
          module: fileToModule.get(relativeFile) ?? "root",
          request_schema: endpoint.request_schema,
          response_schema: endpoint.response_schema,
          service_calls: endpoint.service_calls,
          ai_operations: endpoint.ai_operations
        });
        grouped.set(relativeFile, entry);
      }
      for (const model of pythonAst.models) {
        const relativeFile = toPosix(path.relative(baseRoot, model.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.dataModels.push({
          ...model,
          file: relativeFile
        });
        grouped.set(relativeFile, entry);
      }
      for (const task of pythonAst.tasks) {
        const relativeFile = toPosix(path.relative(baseRoot, task.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.tasks.push({
          name: task.name,
          file: relativeFile,
          kind: task.kind,
          queue: task.queue ?? null,
          schedule: task.schedule ?? null
        });
        grouped.set(relativeFile, entry);
      }
      for (const item of pythonAst.enums) {
        const relativeFile = toPosix(path.relative(baseRoot, item.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.enums.push({ ...item, file: relativeFile });
        grouped.set(relativeFile, entry);
      }
      for (const item of pythonAst.constants) {
        const relativeFile = toPosix(path.relative(baseRoot, item.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.constants.push({ ...item, file: relativeFile });
        grouped.set(relativeFile, entry);
      }
      for (const usage of pythonAst.endpoint_model_usage) {
        const relativeFile = toPosix(path.relative(baseRoot, usage.file));
        const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
        entry.endpointModelUsage.push({
          handler: usage.handler,
          models: usage.models
        });
        grouped.set(relativeFile, entry);
      }
    }

    for (const absoluteFile of pythonFilesAbs) {
      const relativeFile = toPosix(path.relative(baseRoot, absoluteFile));
      const content = await fs.readFile(absoluteFile, "utf8");
      const stat = await fs.stat(absoluteFile);
      const hash = hashContent(content);
      const entry = grouped.get(relativeFile) ?? emptyPythonFileResult();
      entry.importUsages = extractPythonImportUsages(content);
      entry.exports = extractPythonExports(content);
      pythonResultsByFile.set(relativeFile, entry);
      cache.files[absoluteFile] = {
        hash,
        mtime: stat.mtimeMs,
        language: "python",
        importUsages: entry.importUsages,
        exports: entry.exports,
        exportDetails: [],
        endpoints: entry.endpoints,
        dataModels: entry.dataModels,
        tasks: entry.tasks,
        enums: entry.enums,
        constants: entry.constants,
        endpointModelUsage: entry.endpointModelUsage
      };
    }
  }

  const fileGraph: DirectedGraph = new Map();
  for (const file of codeFiles) {
    ensureNode(fileGraph, file);
  }

  const moduleGraph: ModuleDependency[] = [];
  const moduleGraphKeys = new Set<string>();

  const fileUsedSymbols = new Map<string, Set<string>>();
  const fileWildcardUse = new Set<string>();
  const fileExportDetails = new Map<string, ExportDetail[]>();
  const pythonEndpointModelUsageByFile = new Map<
    string,
    Array<{ handler: string; models: string[] }>
  >();

  const recordUsage = (targetFile: string, symbols: string[], wildcard: boolean): void => {
    if (wildcard) {
      fileWildcardUse.add(targetFile);
      return;
    }
    if (symbols.length === 0) {
      return;
    }
    const current = fileUsedSymbols.get(targetFile) ?? new Set<string>();
    for (const symbol of symbols) {
      current.add(symbol);
    }
    fileUsedSymbols.set(targetFile, current);
  };

  for (const file of codeFiles) {
    const absoluteFile = path.join(baseRoot, file);
    let content = "";
    try {
      content = await fs.readFile(absoluteFile, "utf8");
    } catch {
      continue;
    }
    fileContents.set(file, content);

    const ext = path.extname(file);
    let importUsages: ImportUsage[] = [];
    let exports: string[] = [];
    let exportDetails: ExportDetail[] = [];
    const moduleId = fileToModule.get(file) ?? "root";

    if (ext === ".py") {
      const cachedPython = pythonResultsByFile.get(file);
      if (cachedPython) {
        importUsages = cachedPython.importUsages;
        exports = cachedPython.exports;
        exportDetails = cachedPython.exportDetails;
        pythonEndpointModelUsageByFile.set(file, cachedPython.endpointModelUsage);

        for (const endpoint of cachedPython.endpoints) {
          const signature = `${endpoint.method} ${endpoint.path}`;
          const id = endpointKeys.has(signature) ? `${signature} (${file})` : signature;
          endpointKeys.add(id);
          endpoints.push({
            ...endpoint,
            id,
            file,
            module: moduleId
          });
        }

        for (const model of cachedPython.dataModels) {
          const key = `${model.framework}|${model.name}|${model.file}`;
          if (dataModelKeys.has(key)) {
            continue;
          }
          dataModelKeys.add(key);
          dataModels.push(model);
        }

        tasks.push(...cachedPython.tasks);
        enums.push(...cachedPython.enums);
        constants.push(...cachedPython.constants);
      } else {
        importUsages = extractPythonImportUsages(content);
        exports = extractPythonExports(content);
        for (const endpoint of extractPythonEndpoints(content)) {
          const signature = `${endpoint.method} ${endpoint.path}`;
          const id = endpointKeys.has(signature) ? `${signature} (${file})` : signature;
          endpointKeys.add(id);
          endpoints.push({
            id,
            method: endpoint.method,
            path: endpoint.path,
            handler: endpoint.handler,
            file,
            module: moduleId,
            request_schema: endpoint.request_schema,
            response_schema: endpoint.response_schema,
            service_calls: endpoint.service_calls,
            ai_operations: endpoint.ai_operations
          });
        }

        for (const task of extractCeleryTasks(content)) {
          tasks.push({
            name: task.name,
            file,
            kind: "celery",
            queue: task.queue ?? null,
            schedule: null
          });
        }

        const modelCandidates = [
          ...extractSqlAlchemyModels(content, file),
          ...extractDjangoModels(content, file)
        ];
        for (const model of modelCandidates) {
          const key = `${model.framework}|${model.name}|${model.file}`;
          if (dataModelKeys.has(key)) {
            continue;
          }
          dataModelKeys.add(key);
          dataModels.push(model);
        }
      }
    } else {
      const stat = await fs.stat(absoluteFile);
      const hash = hashContent(content);
      const cached = cache.files[absoluteFile];
      const canReuse =
        cached &&
        cached.language === "javascript" &&
        cached.hash === hash;

      if (canReuse) {
        cached.mtime = stat.mtimeMs;
        importUsages = cached.importUsages;
        exports = cached.exports;
        exportDetails = cached.exportDetails;
        for (const endpoint of cached.endpoints) {
          const signature = `${endpoint.method} ${endpoint.path}`;
          const id = endpointKeys.has(signature) ? `${signature} (${file})` : signature;
          endpointKeys.add(id);
          endpoints.push({
            ...endpoint,
            id,
            file,
            module: moduleId
          });
        }
        for (const model of cached.dataModels) {
          const key = `${model.framework}|${model.name}|${model.file}`;
          if (dataModelKeys.has(key)) {
            continue;
          }
          dataModelKeys.add(key);
          dataModels.push(model);
        }
        tasks.push(...cached.tasks);
        enums.push(...cached.enums);
        constants.push(...cached.constants);
      } else {
        const parsed = parseJsFile(content, file);
        importUsages = parsed.usages;
        exports = parsed.exports;
        exportDetails = parsed.exportDetails;

        const fileEndpoints: BackendEndpoint[] = [];
        for (const endpoint of extractJsEndpoints(content, file)) {
          const signature = `${endpoint.method} ${endpoint.path}`;
          const id = endpointKeys.has(signature) ? `${signature} (${file})` : signature;
          endpointKeys.add(id);
          const entry = {
            id,
            method: endpoint.method,
            path: endpoint.path,
            handler: endpoint.handler,
            file,
            module: moduleId,
            request_schema: endpoint.request_schema,
            response_schema: endpoint.response_schema,
            service_calls: endpoint.service_calls,
            ai_operations: endpoint.ai_operations
          };
          fileEndpoints.push(entry);
          endpoints.push(entry);
        }

        const fileEnums = extractJsEnums(content, file);
        const fileConstants = extractJsConstants(content, file);
        enums.push(...fileEnums);
        constants.push(...fileConstants);
        cache.files[absoluteFile] = {
          hash,
          mtime: stat.mtimeMs,
          language: "javascript",
          importUsages,
          exports,
          exportDetails,
          endpoints: fileEndpoints.map((endpoint) => ({
            ...endpoint,
            id: "",
            file
          })),
          dataModels: [],
          tasks: [],
          enums: fileEnums,
          constants: fileConstants,
          endpointModelUsage: []
        };
      }
    }

    if (exports.length > 0) {
      fileExports.set(file, exports);
      fileExportDetails.set(file, exportDetails);
    }

    for (const usage of importUsages) {
      const resolved =
        ext === ".py"
          ? await resolvePythonImport(absoluteFile, usage.specifier, root, absoluteImportRoots)
          : await resolveJsImport(absoluteFile, usage.specifier);

      if (!resolved) {
        continue;
      }

      const resolvedRel = toPosix(path.relative(baseRoot, resolved));
      if (!knownFiles.has(resolvedRel)) {
        continue;
      }

      addEdge(fileGraph, file, resolvedRel);
      recordUsage(resolvedRel, usage.symbols, usage.wildcard);

      const targetModule = fileToModule.get(resolvedRel);
      const sourceModule = fileToModule.get(file);
      if (!targetModule || !sourceModule || targetModule === sourceModule) {
        continue;
      }

      moduleImports.get(sourceModule)?.add(targetModule);
      const edgeKey = `${sourceModule}|${targetModule}|${file}`;
      if (!moduleGraphKeys.has(edgeKey)) {
        moduleGraphKeys.add(edgeKey);
        moduleGraph.push({ from: sourceModule, to: targetModule, file });
      }
    }
  }

  for (const module of modules) {
    module.imports = Array.from(moduleImports.get(module.id) ?? []).sort((a, b) => a.localeCompare(b));
  }

  moduleGraph.sort((a, b) => {
    const from = a.from.localeCompare(b.from);
    if (from !== 0) return from;
    const to = a.to.localeCompare(b.to);
    if (to !== 0) return to;
    return a.file.localeCompare(b.file);
  });

  const fileGraphEdges: FileDependency[] = [];
  for (const [from, targets] of fileGraph) {
    for (const to of targets) {
      fileGraphEdges.push({ from, to });
    }
  }
  fileGraphEdges.sort((a, b) => {
    const from = a.from.localeCompare(b.from);
    if (from !== 0) return from;
    return a.to.localeCompare(b.to);
  });

  const moduleAdjacency: DirectedGraph = new Map();
  for (const module of modules) {
    ensureNode(moduleAdjacency, module.id);
  }
  for (const edge of moduleGraph) {
    addEdge(moduleAdjacency, edge.from, edge.to);
  }

  const entrypoints = await detectEntrypoints(root, baseRoot);
  const fileInbound = inboundCounts(fileGraph, codeFiles);

  const moduleUsage: Record<string, number> = {};

  const orphanFiles = codeFiles
    .filter((file) => (fileInbound.get(file) ?? 0) === 0)
    .filter((file) => !entrypoints.has(file))
    .sort((a, b) => a.localeCompare(b));

  const moduleInbound = new Map<string, number>();
  for (const module of modules) {
    moduleInbound.set(module.id, 0);
  }
  for (const neighbors of fileGraph.values()) {
    for (const neighbor of neighbors) {
      const targetModule = fileToModule.get(neighbor);
      if (!targetModule) {
        continue;
      }
      moduleInbound.set(targetModule, (moduleInbound.get(targetModule) ?? 0) + 1);
    }
  }

  for (const module of modules) {
    const inbound = moduleInbound.get(module.id) ?? 0;
    moduleUsage[module.id] = inbound;
  }

  const moduleEntrypoints = new Map<string, boolean>();
  for (const module of modules) {
    const hasEntry = Array.from(entrypoints).some((entry) => {
      const modulePath = module.path;
      return entry === modulePath || entry.startsWith(`${modulePath}/`);
    });
    moduleEntrypoints.set(module.id, hasEntry);
  }

  const orphanModules = modules
    .filter((module) => (moduleInbound.get(module.id) ?? 0) === 0)
    .filter((module) => (module.endpoints ?? []).length === 0)
    .filter((module) => !moduleEntrypoints.get(module.id))
    .map((module) => module.id)
    .sort((a, b) => a.localeCompare(b));

  const circularDependencies = findCycles(moduleAdjacency);

  const unusedExports: UnusedExport[] = [];
  for (const [file, symbols] of fileExports) {
    if (entrypoints.has(file)) {
      continue;
    }
    if (fileWildcardUse.has(file)) {
      continue;
    }
    const used = fileUsedSymbols.get(file) ?? new Set<string>();
    for (const symbol of symbols) {
      if (!used.has(symbol)) {
        unusedExports.push({ file, symbol });
      }
    }
  }
  unusedExports.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return a.symbol.localeCompare(b.symbol);
  });

  for (const module of modules) {
    const exports: FileExportSummary[] = [];
    for (const file of module.files) {
      const symbols = fileExports.get(file);
      if (symbols && symbols.length > 0) {
        exports.push({
          file,
          symbols,
          exports: fileExportDetails.get(file) ?? symbols.map((name) => ({
            name,
            kind: name === "default" ? "default" : "named"
          }))
        });
      }
    }
    module.exports = exports;
  }

  for (const module of modules) {
    module.layer = classifyLayer(moduleInbound.get(module.id) ?? 0, module.imports.length);
  }

  const accessForMethod = (
    method: string
  ): "read" | "write" | "read_write" | "unknown" => {
    const upper = method.toUpperCase();
    if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") {
      return "read";
    }
    if (upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE") {
      return "write";
    }
    if (upper === "ANY") {
      return "read_write";
    }
    return "unknown";
  };

  const endpointModelUsage: EndpointModelUsage[] = [];
  const cachedPythonUsages = Array.from(pythonEndpointModelUsageByFile.entries());
  if (cachedPythonUsages.length > 0) {
    for (const [relativeFile, usages] of cachedPythonUsages) {
      for (const usage of usages) {
      const matches = endpoints.filter(
        (endpoint) =>
          endpoint.file === relativeFile &&
          endpoint.handler === usage.handler
      );
      for (const endpoint of matches) {
        const models = usage.models.map((name) => ({
          name,
          access: accessForMethod(endpoint.method)
        }));
        endpointModelUsage.push({
          endpoint_id: endpoint.id,
          endpoint: `${endpoint.method} ${endpoint.path}`,
          models
        });
      }
      }
    }
  } else if (dataModels.length > 0 && endpoints.length > 0) {
    const modelNames = dataModels.map((model) => model.name);
    const modelPatterns = modelNames.map((name) => new RegExp(`\\b${name}\\b`));

    for (const endpoint of endpoints) {
      const content = fileContents.get(endpoint.file) ?? "";
      const modelsForEndpoint: Array<{ name: string; access: "read" | "write" | "read_write" | "unknown" }> = [];

      modelPatterns.forEach((pattern, index) => {
        if (pattern.test(content)) {
          modelsForEndpoint.push({
            name: modelNames[index],
            access: accessForMethod(endpoint.method)
          });
        }
      });

      if (modelsForEndpoint.length > 0) {
        endpointModelUsage.push({
          endpoint_id: endpoint.id,
          endpoint: `${endpoint.method} ${endpoint.path}`,
          models: modelsForEndpoint
        });
      }
    }
  }

  const { duplicateFunctions, similarFunctions } = await findDuplicateFunctions({
    files: codeFiles,
    baseRoot,
    fileContents
  });

  const testCoverage = computeTestCoverage(Array.from(knownFiles));
  await saveBackendExtractionCache(cachePath, cache);

  // --- 6. Extract Tests Natively using Universal Adapters ---
  const tests: TestExtractionSummary[] = [];
  for (const relativeFile of codeFiles) {
    if (!relativeFile.includes("test") && !relativeFile.includes("spec") && !relativeFile.includes("Test")) continue;
    
    const absoluteFile = path.join(baseRoot, relativeFile);
    try {
      const content = await fs.readFile(absoluteFile, "utf8");
      const adapter = getAdapterForFile(relativeFile);
      if (adapter && adapter.queries.tests) {
        const result = runAdapter(adapter, relativeFile, content);
        tests.push(...result.tests);
      }
    } catch {
      // gracefully ignore unparseable or inaccessible test files
    }
  }

  return {
    modules,
    moduleGraph,
    fileGraph: fileGraphEdges,
    endpoints,
    dataModels,
    endpointModelUsage,
    tasks,
    circularDependencies,
    orphanModules,
    orphanFiles,
    moduleUsage,
    unusedExports,
    unusedEndpoints: [],
    entrypoints: Array.from(entrypoints).sort((a, b) => a.localeCompare(b)),
    duplicateFunctions,
    similarFunctions,
    enums,
    constants,
    testCoverage,
    tests
  };
}
