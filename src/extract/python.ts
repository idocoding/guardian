import fs from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";

export type PythonAstResult = {
  endpoints: Array<{
    file: string;
    method: string;
    path: string;
    handler: string;
    router?: string | null;
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
  }>;
  models: Array<{
    name: string;
    file: string;
    framework: "sqlalchemy" | "django" | "pydantic";
    fields: string[];
    relationships: string[];
    field_details?: Array<{
      name: string;
      type?: string | null;
      nullable?: boolean | null;
      primary_key?: boolean | null;
      foreign_key?: string | null;
      enum?: string | null;
      default?: string | null;
    }>;
  }>;
  tasks: Array<{
    name: string;
    file: string;
    kind: "celery" | "background";
    queue?: string | null;
    schedule?: string | null;
  }>;
  endpoint_model_usage: Array<{
    file: string;
    handler: string;
    models: string[];
  }>;
  enums: Array<{
    name: string;
    file: string;
    values: string[];
  }>;
  constants: Array<{
    name: string;
    file: string;
    type: string;
    value: string;
  }>;
};

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head"
]);

type ParsedFile = {
  file: string;
  source: string;
  root: Parser.SyntaxNode;
};

type CallArguments = {
  positional: Parser.SyntaxNode[];
  keyword: Map<string, Parser.SyntaxNode>;
};

type DjangoImportInfo = {
  djangoModelsAliases: Set<string>;
  djangoModelClasses: Set<string>;
};

export function extractPythonAst(files: string[]): PythonAstResult | null {
  if (files.length === 0) {
    return { endpoints: [], models: [], tasks: [], endpoint_model_usage: [], enums: [], constants: [] };
  }

  const moduleToFile = buildPythonModuleFileMap(files);
  const parser = new Parser();
  parser.setLanguage(Python);

  const parsedFiles: ParsedFile[] = [];
  for (const file of files) {
    try {
      const source = fs.readFileSync(file, "utf8");
      let tree: Parser.Tree;
      try {
        tree = parser.parse(source);
      } catch {
        continue;
      }
      parsedFiles.push({ file, source, root: tree.rootNode });
    } catch {
      continue;
    }
  }

  const allModels: PythonAstResult["models"] = [];
  const modelNames = new Set<string>();

  for (const parsed of parsedFiles) {
    const { djangoModelsAliases, djangoModelClasses } = collectDjangoImports(parsed.root, parsed.source);
    const models = extractModelsFromTree(
      parsed,
      djangoModelsAliases,
      djangoModelClasses
    );
    for (const model of models) {
      if (modelNames.has(model.name)) {
        continue;
      }
      modelNames.add(model.name);
      allModels.push(model);
    }
  }

  const endpoints: PythonAstResult["endpoints"] = [];
  const tasks: PythonAstResult["tasks"] = [];
  const endpointModelUsage: PythonAstResult["endpoint_model_usage"] = [];
  const enums: PythonAstResult["enums"] = [];
  const constants: PythonAstResult["constants"] = [];
  const includeRouterPrefixes = new Map<string, string[]>();

  for (const parsed of parsedFiles) {
    const { djangoModelsAliases, djangoModelClasses } = collectDjangoImports(parsed.root, parsed.source);
    const routerPrefixes = collectRouterPrefixes(parsed.root, parsed.source);

    const fileEndpoints = collectDecoratedEndpoints(
      parsed,
      routerPrefixes
    );
    endpoints.push(...fileEndpoints);

    const fileTasks = collectDecoratedTasks(parsed);
    tasks.push(...fileTasks);

    const backgroundTasks = collectBackgroundTasks(parsed);
    tasks.push(...backgroundTasks);

    const importAliases = collectPythonImportAliases(parsed.root, parsed.source);
    const fileIncludePrefixes = collectIncludeRouterPrefixes(parsed, importAliases, moduleToFile);
    for (const [targetFile, prefixes] of fileIncludePrefixes.entries()) {
      const existing = includeRouterPrefixes.get(targetFile) ?? [];
      existing.push(...prefixes);
      includeRouterPrefixes.set(targetFile, existing);
    }

    const urlEndpoints = collectUrlPatternEndpoints(parsed);
    endpoints.push(...urlEndpoints);

    const fileModelAliases = collectModelAliases(parsed.root, parsed.source, modelNames);
    const modelUsage = collectEndpointModelUsage(
      parsed,
      modelNames,
      fileModelAliases
    );
    endpointModelUsage.push(...modelUsage);

    const fileEnumsAndConstants = collectEnumsAndConstants(parsed);
    enums.push(...fileEnumsAndConstants.enums);
    constants.push(...fileEnumsAndConstants.constants);

    const models = extractModelsFromTree(
      parsed,
      djangoModelsAliases,
      djangoModelClasses
    );
    for (const model of models) {
      if (modelNames.has(model.name)) {
        continue;
      }
      modelNames.add(model.name);
      allModels.push(model);
    }
  }

  for (const endpoint of endpoints) {
    const prefixes = includeRouterPrefixes.get(endpoint.file);
    if (!prefixes || prefixes.length === 0) {
      continue;
    }
    endpoint.path = applyIncludeRouterPrefix(endpoint.path, prefixes);
  }

  return {
    endpoints,
    models: allModels,
    tasks,
    endpoint_model_usage: endpointModelUsage,
    enums,
    constants
  };
}

function buildPythonModuleFileMap(files: string[]): Map<string, string> {
  const root = findCommonDirectory(files);
  const moduleToFile = new Map<string, string>();

  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (!relative || relative.startsWith("../") || !relative.endsWith(".py")) {
      continue;
    }
    const withoutExt = relative.replace(/\.py$/, "");
    const moduleName = withoutExt.endsWith("/__init__")
      ? withoutExt.slice(0, -"/__init__".length)
      : withoutExt;
    if (!moduleName) {
      continue;
    }
    moduleToFile.set(moduleName.split("/").join("."), file);
  }

  return moduleToFile;
}

function findCommonDirectory(files: string[]): string {
  const [first, ...rest] = files.map((file) => path.resolve(file));
  const segments = first.split(path.sep);
  let shared = segments;

  for (const current of rest) {
    const currentSegments = current.split(path.sep);
    let index = 0;
    while (
      index < shared.length &&
      index < currentSegments.length &&
      shared[index] === currentSegments[index]
    ) {
      index += 1;
    }
    shared = shared.slice(0, index);
  }

  return shared.join(path.sep) || path.sep;
}

function collectDjangoImports(
  root: Parser.SyntaxNode,
  source: string
): DjangoImportInfo {
  const djangoModelsAliases = new Set<string>();
  const djangoModelClasses = new Set<string>();

  walk(root, (node) => {
    if (node.type !== "import_from_statement") {
      return;
    }
    const moduleNode = node.childForFieldName("module_name");
    const moduleName = moduleNode ? nodeText(moduleNode, source) : "";
    if (!moduleName) {
      return;
    }

    if (moduleName.startsWith("django.db")) {
      const names = collectImportNames(node, source);
      for (const entry of names) {
        if (entry.name === "models") {
          djangoModelsAliases.add(entry.alias ?? entry.name);
        }
      }
    }

    if (moduleName.startsWith("django.db.models")) {
      const names = collectImportNames(node, source);
      for (const entry of names) {
        if (entry.name === "Model") {
          djangoModelClasses.add(entry.alias ?? entry.name);
        }
      }
    }
  });

  return { djangoModelsAliases, djangoModelClasses };
}

function extractModelsFromTree(
  parsed: ParsedFile,
  djangoModelsAliases: Set<string>,
  djangoModelClasses: Set<string>
): PythonAstResult["models"] {
  const models: PythonAstResult["models"] = [];

  walk(parsed.root, (node) => {
    if (node.type !== "class_definition") {
      return;
    }

    const nameNode = node.childForFieldName("name");
    const className = nameNode ? nodeText(nameNode, parsed.source) : null;
    if (!className) {
      return;
    }

    const superNode = node.childForFieldName("superclasses");
    const baseNames = superNode
      ? collectBaseNames(superNode, parsed.source)
      : [];

    let isDjango = false;
    for (const base of baseNames) {
      if (djangoModelClasses.has(base)) {
        isDjango = true;
      }
      for (const alias of djangoModelsAliases) {
        if (base === `${alias}.Model`) {
          isDjango = true;
        }
      }
    }

    const isSqlAlchemy = baseNames.some(
      (base) =>
        base === "Base" ||
        base.endsWith(".Base") ||
        base.endsWith("DeclarativeBase") ||
        base.endsWith("db.Model")
    );
    const isPydantic = baseNames.some(
      (base) => base === "BaseModel" || base.endsWith(".BaseModel")
    );

    if (!isDjango && !isSqlAlchemy && !isPydantic) {
      return;
    }

    const fields: string[] = [];
    const relationships: string[] = [];
    const fieldDetails: Array<{
      name: string;
      type?: string | null;
      nullable?: boolean | null;
      primary_key?: boolean | null;
      foreign_key?: string | null;
      enum?: string | null;
      default?: string | null;
    }> = [];
    const bodyNode = node.childForFieldName("body");
    if (bodyNode) {
      for (const child of bodyNode.namedChildren) {
        const assignment =
          child.type === "assignment"
            ? child
            : child.type === "expression_statement"
            ? child.namedChildren.find((entry) => entry.type === "assignment") ?? null
            : null;
        if (!assignment) {
          continue;
        }
        const left = assignment.childForFieldName("left");
        const right = assignment.childForFieldName("right");
        const target = left ? extractAssignedName(left, parsed.source) : null;
        if (!target || !right || right.type !== "call") {
          continue;
        }
        const callName = exprName(
          right.childForFieldName("function"),
          parsed.source
        );
        if (!callName) {
          continue;
        }

        if (isSqlAlchemy) {
          if (callName === "Column" || callName === "mapped_column") {
            fields.push(target);
            const details = extractSqlAlchemyFieldDetails(right, parsed.source);
            fieldDetails.push({ name: target, ...details });
          }
          if (callName.endsWith("relationship")) {
            relationships.push(target);
          }
        }

        if (isDjango) {
          const isModelsCall =
            callName.startsWith("models.") ||
            Array.from(djangoModelsAliases).some((alias) =>
              callName.startsWith(`${alias}.`)
            );
          if (isModelsCall) {
            fields.push(target);
            const details = extractDjangoFieldDetails(right, parsed.source, callName);
            fieldDetails.push({ name: target, ...details });
            if (
              callName.endsWith("ForeignKey") ||
              callName.endsWith("ManyToManyField") ||
              callName.endsWith("OneToOneField")
            ) {
              relationships.push(`${target}:${callName.split(".").pop() ?? callName}`);
            }
          }
        }
      }
    }

    if (isPydantic && bodyNode) {
      const pydanticFields = extractPydanticFieldDetails(bodyNode, parsed.source);
      for (const detail of pydanticFields) {
        fields.push(detail.name);
        fieldDetails.push(detail);
      }
    }

    const framework =
      isPydantic ? "pydantic" : isDjango && !isSqlAlchemy ? "django" : "sqlalchemy";
    models.push({
      name: className,
      file: parsed.file,
      framework,
      fields: Array.from(new Set(fields)).sort(),
      relationships: Array.from(new Set(relationships)).sort(),
      field_details: fieldDetails.length > 0 ? fieldDetails : undefined
    });
  });

  return models;
}

function extractPydanticFieldDetails(
  bodyNode: Parser.SyntaxNode,
  source: string
): Array<{
  name: string;
  type?: string | null;
  nullable?: boolean | null;
  default?: string | null;
}> {
  const details: Array<{
    name: string;
    type?: string | null;
    nullable?: boolean | null;
    default?: string | null;
  }> = [];

  for (const child of bodyNode.namedChildren) {
    if (child.type !== "expression_statement") {
      continue;
    }
    const assignment =
      child.namedChildren.find((entry) => entry.type === "assignment") ?? child;
    const line = source.slice(assignment.startIndex, assignment.endIndex).trim();
    if (!line) {
      continue;
    }
    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=#]+?)(?:\s*=\s*(.+))?$/
    );
    if (!match) {
      continue;
    }
    const [, name, typeText, defaultText] = match;
    details.push({
      name,
      type: typeText.trim(),
      nullable:
        typeText.includes("Optional[") ||
        typeText.includes("| None") ||
        typeText.includes("None |"),
      default: defaultText?.trim() ?? null
    });
  }

  if (details.length > 0) {
    return details;
  }

  const blockText = source.slice(bodyNode.startIndex, bodyNode.endIndex);
  for (const rawLine of blockText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (
      line.startsWith("def ") ||
      line.startsWith("class ") ||
      line.startsWith("@") ||
      line.startsWith("return ") ||
      line.startsWith("if ") ||
      line.startsWith("for ")
    ) {
      continue;
    }
    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=#]+?)(?:\s*=\s*(.+))?$/
    );
    if (!match) {
      continue;
    }
    const [, name, typeText, defaultText] = match;
    details.push({
      name,
      type: typeText.trim(),
      nullable:
        typeText.includes("Optional[") ||
        typeText.includes("| None") ||
        typeText.includes("None |"),
      default: defaultText?.trim() ?? null
    });
  }

  return details;
}

function collectRouterPrefixes(
  root: Parser.SyntaxNode,
  source: string
): Map<string, string> {
  const prefixes = new Map<string, string>();
  walk(root, (node) => {
    if (node.type !== "assignment") {
      return;
    }
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right || right.type !== "call") {
      return;
    }
    const callName = exprName(right.childForFieldName("function"), source);
    if (!callName || !callName.endsWith("APIRouter")) {
      return;
    }
    const { keyword } = collectCallArguments(right, source);
    const prefixNode = keyword.get("prefix");
    const prefix = prefixNode ? stringLiteralValue(prefixNode, source) : null;
    const names = extractAssignedNames(left, source);
    for (const name of names) {
      prefixes.set(name, prefix ?? "");
    }
  });
  return prefixes;
}

function collectDecoratedEndpoints(
  parsed: ParsedFile,
  routerPrefixes: Map<string, string>
): PythonAstResult["endpoints"] {
  const endpoints: PythonAstResult["endpoints"] = [];

  walk(parsed.root, (node) => {
    if (node.type !== "decorated_definition") {
      return;
    }
    const definition = node.childForFieldName("definition");
    if (!definition || definition.type !== "function_definition") {
      return;
    }
    const handlerNode = definition.childForFieldName("name");
    const handler = handlerNode ? nodeText(handlerNode, parsed.source) : null;
    if (!handler) {
      return;
    }

    for (const decoratorNode of node.namedChildren) {
      if (decoratorNode.type !== "decorator") {
        continue;
      }
      const expr = decoratorNode.namedChildren[0];
      if (!expr || expr.type !== "call") {
        continue;
      }
      const funcNode = expr.childForFieldName("function");
      if (!funcNode || funcNode.type !== "attribute") {
        continue;
      }
      const attrNode = funcNode.childForFieldName("attribute");
      const baseNode = funcNode.childForFieldName("object");
      const attr = attrNode ? nodeText(attrNode, parsed.source) : "";
      const baseName = exprName(baseNode, parsed.source);
      if (HTTP_METHODS.has(attr)) {
        const { positional, keyword } = collectCallArguments(expr, parsed.source);
        const pathNode = positional[0];
        const pathValue = pathNode ? stringLiteralValue(pathNode, parsed.source) : null;
        if (!pathValue) {
          continue;
        }
        const prefix = routerPrefixes.get(baseName ?? "") ?? "";
          
          let responseSchema: string | null = null;
          const responseModelNode = keyword.get("response_model");
          if (responseModelNode) {
            responseSchema = exprName(responseModelNode, parsed.source);
          }

          let requestSchema: string | null = null;
          const paramsNode = definition.childForFieldName("parameters");
          if (paramsNode) {
            for (const param of paramsNode.namedChildren) {
               if (param.type === "typed_parameter" || param.type === "typed_default_parameter") {
                   const typeNode = param.childForFieldName("type");
                   if (typeNode) {
                       const typeName = exprName(typeNode, parsed.source);
                       if (typeName && typeName !== "Request" && typeName !== "Response" && typeName !== "Session" && typeName !== "Depends") {
                           requestSchema = typeName;
                           break;
                       }
                   }
               }
            }
            if (!requestSchema) {
              requestSchema = extractRequestSchemaFromParameters(paramsNode, parsed.source);
            }
          }

          let serviceCalls: string[] = [];
          let aiOperations: Array<{
            provider: "openai" | "anthropic" | "unknown";
            operation: string;
            model?: string | null;
            max_tokens?: number | null;
            max_output_tokens?: number | null;
            token_budget?: number | null;
          }> = [];
          const bodyNode = definition.childForFieldName("body");
          if (bodyNode) {
             walk(bodyNode, (childNode) => {
                if (childNode.type === "call") {
                   const callName = exprName(childNode.childForFieldName("function"), parsed.source);
                   if (callName && callName !== "Depends") {
                       serviceCalls.push(callName);
                       
                       const lowerCall = callName.toLowerCase();
                       if (lowerCall.includes("openai") || lowerCall.includes("chatcompletions") || lowerCall.includes("anthropic")) {
                           const { keyword } = collectCallArguments(childNode, parsed.source);
                           const modelNode = keyword.get("model");
                           const model = modelNode ? stringLiteralValue(modelNode, parsed.source) : null;
                           const tokenBudget = extractTokenBudget(keyword, parsed.source);
                           aiOperations.push({
                               provider: lowerCall.includes("openai") ? "openai" : "anthropic",
                               operation: callName,
                               model,
                               max_tokens: tokenBudget.maxTokens,
                               max_output_tokens: tokenBudget.maxOutputTokens,
                               token_budget: tokenBudget.tokenBudget
                           });
                       }
                   }
                }
             });
          }

          endpoints.push({
            file: parsed.file,
            method: attr.toUpperCase(),
            path: normalizePath(prefix, pathValue),
            handler,
            router: baseName,
            request_schema: requestSchema,
            response_schema: responseSchema,
            service_calls: Array.from(new Set(serviceCalls)).sort(),
            ai_operations: aiOperations
          });
      } else if (attr === "api_route") {
        const { positional, keyword } = collectCallArguments(expr, parsed.source);
        const pathNode = positional[0];
        const pathValue = pathNode ? stringLiteralValue(pathNode, parsed.source) : null;
        if (!pathValue) {
          continue;
        }
        const methodsNode = keyword.get("methods") ?? positional[1];
        const methods = methodsNode ? collectStringList(methodsNode, parsed.source) : [];
        const prefix = routerPrefixes.get(baseName ?? "") ?? "";
          const methodList = methods.length > 0 ? methods : ["ANY"];
          
          let responseSchema: string | null = null;
          const responseModelNode = keyword.get("response_model");
          if (responseModelNode) {
            responseSchema = exprName(responseModelNode, parsed.source);
          }

          let requestSchema: string | null = null;
          const paramsNode = definition.childForFieldName("parameters");
          if (paramsNode) {
            for (const param of paramsNode.namedChildren) {
               if (param.type === "typed_parameter" || param.type === "typed_default_parameter") {
                   const typeNode = param.childForFieldName("type");
                   if (typeNode) {
                       const typeName = exprName(typeNode, parsed.source);
                       if (typeName && typeName !== "Request" && typeName !== "Response" && typeName !== "Session" && typeName !== "Depends") {
                           requestSchema = typeName;
                           break;
                       }
                   }
               }
            }
            if (!requestSchema) {
              requestSchema = extractRequestSchemaFromParameters(paramsNode, parsed.source);
            }
          }

          let serviceCalls: string[] = [];
          let aiOperations: Array<{
            provider: "openai" | "anthropic" | "unknown";
            operation: string;
            model?: string | null;
            max_tokens?: number | null;
            max_output_tokens?: number | null;
            token_budget?: number | null;
          }> = [];
          const bodyNode = definition.childForFieldName("body");
          if (bodyNode) {
             walk(bodyNode, (childNode) => {
                if (childNode.type === "call") {
                   const callName = exprName(childNode.childForFieldName("function"), parsed.source);
                   if (callName && callName !== "Depends") {
                       serviceCalls.push(callName);
                       
                       const lowerCall = callName.toLowerCase();
                       if (lowerCall.includes("openai") || lowerCall.includes("chatcompletions") || lowerCall.includes("anthropic")) {
                           const { keyword } = collectCallArguments(childNode, parsed.source);
                           const modelNode = keyword.get("model");
                           const model = modelNode ? stringLiteralValue(modelNode, parsed.source) : null;
                           const tokenBudget = extractTokenBudget(keyword, parsed.source);
                           aiOperations.push({
                               provider: lowerCall.includes("openai") ? "openai" : "anthropic",
                               operation: callName,
                               model,
                               max_tokens: tokenBudget.maxTokens,
                               max_output_tokens: tokenBudget.maxOutputTokens,
                               token_budget: tokenBudget.tokenBudget
                           });
                       }
                   }
                }
             });
          }

          for (const method of methodList) {
            endpoints.push({
              file: parsed.file,
              method: method.toUpperCase(),
              path: normalizePath(prefix, pathValue),
              handler,
              router: baseName,
              request_schema: requestSchema,
              response_schema: responseSchema,
              service_calls: Array.from(new Set(serviceCalls)).sort(),
              ai_operations: aiOperations
            });
          }
      }
    }
  });

  return endpoints;
}

function extractRequestSchemaFromParameters(
  paramsNode: Parser.SyntaxNode,
  source: string
): string | null {
  const raw = source.slice(paramsNode.startIndex, paramsNode.endIndex);
  const matches = raw.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=,\)\n]+)/g);
  const blocked = new Set([
    "Request",
    "Response",
    "Session",
    "Depends",
    "BackgroundTasks",
    "UploadFile",
    "File",
    "Form",
    "Query",
    "Path",
    "Body",
    "str",
    "int",
    "float",
    "bool",
    "dict",
    "list",
    "Dict",
    "List",
    "Optional",
    "Any"
  ]);

  for (const match of matches) {
    const paramName = match[1]?.trim() ?? "";
    const typeText = match[2]?.trim() ?? "";
    if (paramName === "self" || paramName === "cls" || /(^id$|_id$)/i.test(paramName)) {
      continue;
    }
    const cleaned = typeText
      .replace(/\s+/g, "")
      .replace(/^Annotated\[/, "")
      .split(/[,\[\]|]/)[0]
      .trim();
    if (!cleaned || blocked.has(cleaned)) {
      continue;
    }
    return cleaned.split(".").pop() ?? cleaned;
  }

  return null;
}

function collectDecoratedTasks(parsed: ParsedFile): PythonAstResult["tasks"] {
  const tasks: PythonAstResult["tasks"] = [];

  walk(parsed.root, (node) => {
    if (node.type !== "decorated_definition") {
      return;
    }
    const definition = node.childForFieldName("definition");
    if (!definition || definition.type !== "function_definition") {
      return;
    }
    const handlerNode = definition.childForFieldName("name");
    const handler = handlerNode ? nodeText(handlerNode, parsed.source) : "anonymous";

    for (const decoratorNode of node.namedChildren) {
      if (decoratorNode.type !== "decorator") {
        continue;
      }
      const expr = decoratorNode.namedChildren[0];
      if (!expr || expr.type !== "call") {
        continue;
      }
      const funcName = exprName(expr.childForFieldName("function"), parsed.source) ?? "";
      if (!funcName.endsWith("shared_task") && !funcName.endsWith("task")) {
        continue;
      }
      const { keyword } = collectCallArguments(expr, parsed.source);
      const nameNode = keyword.get("name");
      const queueNode = keyword.get("queue");
      const taskName = nameNode ? stringLiteralValue(nameNode, parsed.source) : null;
      const queue = queueNode ? stringLiteralValue(queueNode, parsed.source) : null;
      tasks.push({
        name: taskName ?? handler,
        file: parsed.file,
        kind: "celery",
        queue: queue ?? undefined,
        schedule: null
      });
    }
  });

  return tasks;
}

function collectBackgroundTasks(parsed: ParsedFile): PythonAstResult["tasks"] {
  const tasks: PythonAstResult["tasks"] = [];
  walk(parsed.root, (node) => {
    if (node.type !== "call") {
      return;
    }
    const funcName = exprName(node.childForFieldName("function"), parsed.source) ?? "";
    if (!funcName.endsWith("add_task")) {
      return;
    }
    const { positional } = collectCallArguments(node, parsed.source);
    const taskExpr = positional[0];
    const taskName = taskExpr ? exprName(taskExpr, parsed.source) ?? "anonymous" : "anonymous";
    tasks.push({
      name: taskName,
      file: parsed.file,
      kind: "background",
      queue: null,
      schedule: null
    });
  });
  return tasks;
}

function collectPythonImportAliases(
  root: Parser.SyntaxNode,
  source: string
): Map<string, string> {
  const aliases = new Map<string, string>();

  walk(root, (node) => {
    if (node.type !== "import_from_statement" && node.type !== "import_statement") {
      return;
    }

    const raw = nodeText(node, source)
      .replace(/#[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (node.type === "import_from_statement") {
      const match = raw.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
      if (!match) {
        return;
      }
      const modulePath = match[1];
      const importList = match[2].replace(/[()]/g, "");
      for (const part of importList.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        const aliasMatch = part.match(/^([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/);
        if (!aliasMatch) {
          continue;
        }
        const original = aliasMatch[1];
        const alias = aliasMatch[2] ?? original;
        aliases.set(alias, `${modulePath}.${original}`);
      }
      return;
    }

    const match = raw.match(/^import\s+(.+)$/);
    if (!match) {
      return;
    }
    for (const part of match[1].split(",").map((entry) => entry.trim()).filter(Boolean)) {
      const aliasMatch = part.match(/^([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/);
      if (!aliasMatch) {
        continue;
      }
      const original = aliasMatch[1];
      const alias = aliasMatch[2] ?? original.split(".").pop() ?? original;
      aliases.set(alias, original);
    }
  });

  return aliases;
}

function collectIncludeRouterPrefixes(
  parsed: ParsedFile,
  importAliases: Map<string, string>,
  moduleToFile: Map<string, string>
): Map<string, string[]> {
  const prefixes = new Map<string, string[]>();

  walk(parsed.root, (node) => {
    if (node.type !== "call") {
      return;
    }
    const funcName = exprName(node.childForFieldName("function"), parsed.source) ?? "";
    if (!funcName.endsWith("include_router")) {
      return;
    }
    const { positional, keyword } = collectCallArguments(node, parsed.source);
    const routerNode = positional[0];
    const routerName = routerNode ? exprName(routerNode, parsed.source) : null;
    if (!routerName) {
      return;
    }
    const targetFile = resolveImportedTargetFile(routerName, importAliases, moduleToFile);
    if (!targetFile) {
      return;
    }
    const prefixNode = keyword.get("prefix");
    const prefix = prefixNode ? stringLiteralValue(prefixNode, parsed.source) : "";
    const list = prefixes.get(targetFile) ?? [];
    list.push(prefix ?? "");
    prefixes.set(targetFile, list);
  });

  return prefixes;
}

function resolveImportedTargetFile(
  target: string,
  importAliases: Map<string, string>,
  moduleToFile: Map<string, string>
): string | null {
  const segments = target.split(".").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const [first, ...rest] = segments;
  const resolvedBase = importAliases.get(first) ?? first;
  let candidate = rest.length > 0 ? `${resolvedBase}.${rest.join(".")}` : resolvedBase;

  while (candidate) {
    const resolved = moduleToFile.get(candidate);
    if (resolved) {
      return resolved;
    }
    if (!candidate.includes(".")) {
      break;
    }
    candidate = candidate.slice(0, candidate.lastIndexOf("."));
  }

  return null;
}

function applyIncludeRouterPrefix(route: string, prefixes: string[]): string {
  const normalizedRoute = normalizePath("", route);
  const chosenPrefix = prefixes
    .filter((prefix) => typeof prefix === "string")
    .sort((a, b) => b.length - a.length)[0];

  if (!chosenPrefix) {
    return normalizedRoute;
  }

  const normalizedPrefix = normalizePath("", chosenPrefix);
  if (
    normalizedRoute === normalizedPrefix ||
    normalizedRoute.startsWith(`${normalizedPrefix}/`)
  ) {
    return normalizedRoute;
  }

  return normalizePath(normalizedPrefix, normalizedRoute);
}

function collectUrlPatternEndpoints(parsed: ParsedFile): PythonAstResult["endpoints"] {
  const endpoints: PythonAstResult["endpoints"] = [];

  walk(parsed.root, (node) => {
    if (node.type !== "assignment") {
      return;
    }
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right || right.type !== "list") {
      return;
    }
    const names = extractAssignedNames(left, parsed.source);
    if (!names.includes("urlpatterns")) {
      return;
    }
    for (const element of right.namedChildren) {
      if (element.type !== "call") {
        continue;
      }
      const funcName = exprName(element.childForFieldName("function"), parsed.source);
      const lastSegment = funcName ? funcName.split(".").pop() ?? funcName : "";
      if (lastSegment !== "path" && lastSegment !== "re_path" && lastSegment !== "url") {
        continue;
      }
      const { positional } = collectCallArguments(element, parsed.source);
      const pathNode = positional[0];
      const handlerNode = positional[1];
      const pathValue = pathNode ? stringLiteralValue(pathNode, parsed.source) : null;
      const handler = handlerNode ? exprName(handlerNode, parsed.source) : null;
      if (!pathValue || !handler) {
        continue;
      }
      endpoints.push({
        file: parsed.file,
        method: "ANY",
        path: normalizePath("", pathValue),
        handler,
        router: null,
        service_calls: [],
        ai_operations: []
      });
    }
  });

  return endpoints;
}

function collectEnumsAndConstants(parsed: ParsedFile): {
  enums: PythonAstResult["enums"];
  constants: PythonAstResult["constants"];
} {
  const enums: PythonAstResult["enums"] = [];
  const constants: PythonAstResult["constants"] = [];

  for (const node of parsed.root.namedChildren) {
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      const className = nameNode ? nodeText(nameNode, parsed.source) : null;
      if (!className) continue;

      const superNode = node.childForFieldName("superclasses");
      const baseNames = superNode ? collectBaseNames(superNode, parsed.source) : [];
      const isEnum = baseNames.some(base => base === "Enum" || base.endsWith(".Enum"));

      if (isEnum) {
        const values: string[] = [];
        const bodyNode = node.childForFieldName("body");
        if (bodyNode) {
          for (const child of bodyNode.namedChildren) {
             if (child.type === "assignment") {
                const target = child.childForFieldName("left");
                if (target) {
                   values.push(nodeText(target, parsed.source));
                }
             }
          }
        }
        enums.push({ name: className, file: parsed.file, values });
      }
    } else if (node.type === "assignment" || node.type === "expression_statement") {
      // Look for module-level constants (ALL_CAPS)
      // `MAX_RETRIES = 5` (assignment)
      // `MAX_RETRIES: int = 5` (expression_statement -> assignment)
      let assignmentNode = node;
      if (node.type === "expression_statement") {
         const firstChild = node.namedChildren[0];
         if (firstChild && firstChild.type === "assignment") {
            assignmentNode = firstChild;
         } else {
            continue;
         }
      }
      
      const left = assignmentNode.childForFieldName("left");
      const typeNode = assignmentNode.childForFieldName("type");
      const right = assignmentNode.childForFieldName("right");
      
      if (!left || !right) continue;
      
      const targetName = extractAssignedName(left, parsed.source);
      if (targetName && targetName === targetName.toUpperCase() && targetName !== "_") {
         constants.push({
            name: targetName,
            file: parsed.file,
            type: typeNode ? nodeText(typeNode, parsed.source) : "unknown",
            value: nodeText(right, parsed.source)
         });
      }
    }
  }

  return { enums, constants };
}

function collectEndpointModelUsage(
  parsed: ParsedFile,
  modelNames: Set<string>,
  aliases: Map<string, string>
): PythonAstResult["endpoint_model_usage"] {
  const usage: PythonAstResult["endpoint_model_usage"] = [];
  if (modelNames.size === 0) {
    return usage;
  }

  walk(parsed.root, (node) => {
    if (node.type !== "function_definition") {
      return;
    }
    const nameNode = node.childForFieldName("name");
    const handler = nameNode ? nodeText(nameNode, parsed.source) : null;
    if (!handler) {
      return;
    }
    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) {
      return;
    }
    const used = collectModelsUsed(bodyNode, parsed.source, modelNames, aliases);
    if (used.size > 0) {
      usage.push({
        file: parsed.file,
        handler,
        models: Array.from(used).sort()
      });
    }
  });

  return usage;
}

function collectModelAliases(
  root: Parser.SyntaxNode,
  source: string,
  modelNames: Set<string>
): Map<string, string> {
  const aliases = new Map<string, string>();
  if (modelNames.size === 0) {
    return aliases;
  }

  walk(root, (node) => {
    if (node.type === "import_statement") {
      const entries = collectImportNames(node, source);
      for (const entry of entries) {
        const name = entry.name.split(".").pop() ?? entry.name;
        if (modelNames.has(name)) {
          aliases.set(entry.alias ?? name, name);
        }
      }
    }

    if (node.type === "import_from_statement") {
      const entries = collectImportNames(node, source);
      for (const entry of entries) {
        const name = entry.name.split(".").pop() ?? entry.name;
        if (modelNames.has(name)) {
          aliases.set(entry.alias ?? name, name);
        }
      }
    }
  });

  return aliases;
}

function collectImportNames(
  node: Parser.SyntaxNode,
  source: string
): Array<{ name: string; alias?: string }> {
  const entries: Array<{ name: string; alias?: string }> = [];
  for (const child of node.namedChildren) {
    if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
      if (nameNode) {
        entries.push({
          name: nodeText(nameNode, source),
          alias: aliasNode ? nodeText(aliasNode, source) : undefined
        });
      }
    } else if (child.type === "dotted_name" || child.type === "identifier") {
      entries.push({ name: nodeText(child, source) });
    }
  }
  return entries;
}

function collectCallArguments(
  callNode: Parser.SyntaxNode,
  source: string
): CallArguments {
  const positional: Parser.SyntaxNode[] = [];
  const keyword = new Map<string, Parser.SyntaxNode>();
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    return { positional, keyword };
  }
  for (const arg of argsNode.namedChildren) {
    if (arg.type === "keyword_argument") {
      const nameNode = arg.childForFieldName("name");
      const valueNode = arg.childForFieldName("value");
      if (nameNode && valueNode) {
        keyword.set(nodeText(nameNode, source), valueNode);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, keyword };
}

function collectModelsUsed(
  root: Parser.SyntaxNode,
  source: string,
  modelNames: Set<string>,
  aliases: Map<string, string>
): Set<string> {
  const used = new Set<string>();
  walk(root, (node) => {
    if (node.type === "identifier") {
      const name = nodeText(node, source);
      if (modelNames.has(name)) {
        used.add(name);
      }
      if (aliases.has(name)) {
        used.add(aliases.get(name) ?? name);
      }
    } else if (node.type === "attribute") {
      const attrNode = node.childForFieldName("attribute");
      const attr = attrNode ? nodeText(attrNode, source) : null;
      if (attr && modelNames.has(attr)) {
        used.add(attr);
      }
    }
  });
  return used;
}

function collectBaseNames(
  superNode: Parser.SyntaxNode,
  source: string
): string[] {
  const names: string[] = [];
  for (const child of superNode.namedChildren) {
    if (child.type === "keyword_argument") {
      continue;
    }
    const name = exprName(child, source);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function collectStringList(node: Parser.SyntaxNode, source: string): string[] {
  if (node.type === "list" || node.type === "tuple") {
    return node.namedChildren
      .map((child) => stringLiteralValue(child, source))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase());
  }
  const single = stringLiteralValue(node, source);
  return single ? [single.toUpperCase()] : [];
}

function extractAssignedNames(node: Parser.SyntaxNode, source: string): string[] {
  if (node.type === "identifier") {
    return [nodeText(node, source)];
  }
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "identifier") {
      names.push(nodeText(child, source));
    }
  }
  return names;
}

function extractAssignedName(node: Parser.SyntaxNode, source: string): string | null {
  const names = extractAssignedNames(node, source);
  return names[0] ?? null;
}

function normalizePath(prefix: string, route: string): string {
  const cleanedPrefix = prefix || "";
  const cleanedRoute = route || "";
  const pref = cleanedPrefix && !cleanedPrefix.startsWith("/") ? `/${cleanedPrefix}` : cleanedPrefix;
  const rt = cleanedRoute && !cleanedRoute.startsWith("/") ? `/${cleanedRoute}` : cleanedRoute;
  const combined = `${pref}${rt}`.replace(/\/+/g, "/");
  return combined || "/";
}

function stringLiteralValue(
  node: Parser.SyntaxNode,
  source: string
): string | null {
  if (node.type !== "string") {
    return null;
  }
  const raw = nodeText(node, source).trim();
  const match = raw.match(/^([rubfRUBF]*)(['"]{1,3})([\s\S]*?)\2$/);
  if (!match) {
    return null;
  }
  return match[3];
}

function exprName(
  node: Parser.SyntaxNode | null,
  source: string
): string | null {
  if (!node) {
    return null;
  }
  if (node.type === "identifier") {
    return nodeText(node, source);
  }
  if (node.type === "attribute") {
    const obj = node.childForFieldName("object");
    const attr = node.childForFieldName("attribute");
    const base = exprName(obj, source);
    const attrName = attr ? nodeText(attr, source) : null;
    if (base && attrName) {
      return `${base}.${attrName}`;
    }
    return attrName ?? base;
  }
  if (node.type === "call") {
    return exprName(node.childForFieldName("function"), source);
  }
  if (node.type === "dotted_name") {
    return nodeText(node, source);
  }
  return null;
}

function booleanLiteralValue(
  node: Parser.SyntaxNode | undefined,
  source: string
): boolean | null {
  if (!node) {
    return null;
  }
  if (node.type === "true") {
    return true;
  }
  if (node.type === "false") {
    return false;
  }
  return null;
}

function numberLiteralValue(
  node: Parser.SyntaxNode | undefined,
  source: string
): number | null {
  if (!node) {
    return null;
  }
  if (node.type === "integer" || node.type === "float") {
    const raw = nodeText(node, source);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function literalValue(
  node: Parser.SyntaxNode | undefined,
  source: string
): string | null {
  if (!node) {
    return null;
  }
  const str = stringLiteralValue(node, source);
  if (str !== null) {
    return str;
  }
  if (node.type === "integer" || node.type === "float") {
    return nodeText(node, source);
  }
  if (node.type === "true" || node.type === "false" || node.type === "none") {
    return node.type;
  }
  return exprName(node, source);
}

function extractSqlAlchemyFieldDetails(
  callNode: Parser.SyntaxNode,
  source: string
): {
  type?: string | null;
  nullable?: boolean | null;
  primary_key?: boolean | null;
  foreign_key?: string | null;
  enum?: string | null;
  default?: string | null;
} {
  const { positional, keyword } = collectCallArguments(callNode, source);
  let typeName: string | null = null;
  let enumName: string | null = null;
  let foreignKey: string | null = null;

  for (const arg of positional) {
    if (arg.type === "call") {
      const fnName = exprName(arg.childForFieldName("function"), source) ?? "";
      if (fnName.endsWith("ForeignKey")) {
        const { positional: fkArgs } = collectCallArguments(arg, source);
        const fk = fkArgs[0] ? literalValue(fkArgs[0], source) : null;
        if (fk) {
          foreignKey = fk;
        }
        continue;
      }
      if (fnName.endsWith("Enum") || fnName === "Enum") {
        typeName = "Enum";
        const { positional: enumArgs } = collectCallArguments(arg, source);
        const enumCandidate = enumArgs[0] ? exprName(enumArgs[0], source) : null;
        if (enumCandidate) {
          enumName = enumCandidate;
        }
        continue;
      }
    }

    if (!typeName) {
      const name = exprName(arg, source);
      if (name) {
        typeName = name;
      }
    }
  }

  const nullable = booleanLiteralValue(keyword.get("nullable"), source);
  const primaryKey = booleanLiteralValue(keyword.get("primary_key"), source);
  const defaultValue = literalValue(keyword.get("default"), source);

  return {
    type: typeName,
    nullable,
    primary_key: primaryKey,
    foreign_key: foreignKey,
    enum: enumName,
    default: defaultValue
  };
}

function extractDjangoFieldDetails(
  callNode: Parser.SyntaxNode,
  source: string,
  callName: string
): {
  type?: string | null;
  nullable?: boolean | null;
  primary_key?: boolean | null;
  foreign_key?: string | null;
  enum?: string | null;
  default?: string | null;
} {
  const { positional, keyword } = collectCallArguments(callNode, source);
  const type = callName.split(".").pop() ?? callName;
  const nullable = booleanLiteralValue(keyword.get("null"), source);
  const primaryKey = booleanLiteralValue(keyword.get("primary_key"), source);
  const defaultValue = literalValue(keyword.get("default"), source);

  let foreignKey: string | null = null;
  if (
    type.endsWith("ForeignKey") ||
    type.endsWith("OneToOneField") ||
    type.endsWith("ManyToManyField")
  ) {
    const target = positional[0]
      ? literalValue(positional[0], source)
      : literalValue(keyword.get("to"), source);
    if (target) {
      foreignKey = target;
    }
  }

  let enumName: string | null = null;
  const choicesNode = keyword.get("choices");
  if (choicesNode) {
    const choicesExpr = exprName(choicesNode, source);
    if (choicesExpr && choicesExpr.endsWith(".choices")) {
      enumName = choicesExpr.replace(/\.choices$/, "");
    }
  }

  return {
    type,
    nullable,
    primary_key: primaryKey,
    foreign_key: foreignKey,
    enum: enumName,
    default: defaultValue
  };
}

function extractTokenBudget(
  keyword: Map<string, Parser.SyntaxNode>,
  source: string
): { maxTokens: number | null; maxOutputTokens: number | null; tokenBudget: number | null } {
  const maxTokens = numberLiteralValue(
    keyword.get("max_tokens") ??
      keyword.get("max_completion_tokens") ??
      keyword.get("max_new_tokens") ??
      keyword.get("tokens") ??
      keyword.get("token_limit"),
    source
  );
  const maxOutputTokens = numberLiteralValue(
    keyword.get("max_output_tokens"),
    source
  );
  const tokenBudget = maxOutputTokens ?? maxTokens;
  return {
    maxTokens,
    maxOutputTokens,
    tokenBudget
  };
}

function nodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function walk(
  node: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => void
): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}
