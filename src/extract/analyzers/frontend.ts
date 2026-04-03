import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { SpecGuardConfig } from "../../config.js";
import type {
  FrontendAnalysis,
  FrontendPageSummary,
  UxPageSummary,
  FrontendApiCallSummary,
  FileDependency,
  UnusedExport,
  UxComponentNode,
  UxComponentEdge,
  ExportDetail,
  ExportKind,
  TestExtractionSummary
} from "../types.js";
import { getAdapterForFile, runAdapter } from "../../adapters/index.js";
import { addEdge, ensureNode, inboundCounts, type DirectedGraph } from "../graph.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "../ignore.js";

const PAGE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mdx"]);
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mdx"]);
const JS_RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mdx"];
const ROUTE_FILE_BASENAMES = new Set([
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "not-found",
  "route"
]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const NAVIGATION_METHODS = new Set(["push", "replace"]);
const LINK_TAGS = new Set(["Link", "NavLink", "a"]);
const UTILITY_NAME_PATTERNS: RegExp[] = [
  /^Icon$/i,
  /^Icons$/i,
  /Icon$/i,
  /^Icon[A-Z]/,
  /^Icons[A-Z]/,
  /^(Spinner|Loader|Skeleton|Divider|Separator|Spacer|SrOnly|VisuallyHidden)$/i
];
const UTILITY_PATH_SEGMENTS = new Set([
  "icon",
  "icons",
  "utils",
  "utility",
  "utilities",
  "helpers",
  "helper"
]);
const ROUTER_FACTORY_NAMES = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
  "createRoutesFromElements"
]);

// File-based router frameworks where every file in app/ is a page
type FileRouterFramework = "expo-router" | "next" | null;
const EXPO_ROUTER_SKIP_BASENAMES = new Set(["_layout", "_error", "+not-found", "+html"]);

async function detectFileRouterFramework(frontendRoot: string): Promise<FileRouterFramework> {
  const root = path.resolve(frontendRoot);
  try {
    const pkgPath = path.join(root, "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["expo-router"]) return "expo-router";
    if (allDeps["next"]) return "next";
  } catch {
    // no package.json or parse failure
  }
  return null;
}

function isExpoRouterPage(filePath: string, appDir: string): boolean {
  const ext = path.extname(filePath);
  if (!PAGE_EXTENSIONS.has(ext)) return false;
  const base = path.basename(filePath, ext);
  if (EXPO_ROUTER_SKIP_BASENAMES.has(base)) return false;
  // Must be inside the app directory
  const relative = path.relative(appDir, filePath);
  return !relative.startsWith("..");
}

function expoRouteFromFile(appDir: string, filePath: string): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const relativeDir = path.relative(appDir, path.dirname(filePath));

  // index.tsx → /
  if (base === "index" && (!relativeDir || relativeDir === ".")) return "/";

  const segments = relativeDir
    .split(path.sep)
    .filter(Boolean)
    .filter((s) => !isRouteGroup(s));

  // index.tsx in a subdirectory → /parent/child
  if (base === "index") {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

  // session.tsx in child/ → /child/session
  segments.push(base);
  return `/${segments.join("/")}`;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath));
}

function isTsProgramFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
}

async function existsDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findAppDir(frontendRoot: string): Promise<string | null> {
  const root = path.resolve(frontendRoot);
  const candidates = [path.join(root, "src", "app"), path.join(root, "app")];

  for (const candidate of candidates) {
    if (await existsDir(candidate)) {
      return candidate;
    }
  }

  return null;
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

async function resolveJsImport(
  fromFile: string,
  specifier: string,
  aliases: AliasMapping[]
): Promise<string | null> {
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    return resolveFileCandidate(resolved, JS_RESOLVE_EXTENSIONS);
  }

  const aliasResolved = resolveAliasImport(specifier, aliases);
  if (aliasResolved) {
    return resolveFileCandidate(aliasResolved, JS_RESOLVE_EXTENSIONS);
  }

  return null;
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

function templateExpressionText(node: ts.TemplateExpression): string {
  let result = node.head.text;
  for (const span of node.templateSpans) {
    result += "${" + span.expression.getText() + "}" + span.literal.text;
  }
  return result;
}

function getExpressionText(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return templateExpressionText(node);
  }
  return null;
}

function isPascalCase(name: string): boolean {
  return !!name && name[0] === name[0].toUpperCase();
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function normalizeAliasKey(key: string): string {
  return key.replace(/\/\*$/, "");
}

function normalizeAliasTarget(target: string): string {
  return target.replace(/\/\*$/, "");
}

function resolveAliasImport(specifier: string, aliases: AliasMapping[]): string | null {
  for (const alias of aliases) {
    if (specifier === alias.alias) {
      return alias.target;
    }
    if (specifier.startsWith(`${alias.alias}/`)) {
      const rest = specifier.slice(alias.alias.length + 1);
      return path.join(alias.target, rest);
    }
  }
  return null;
}

async function loadAliasMappings(
  root: string,
  config: SpecGuardConfig
): Promise<AliasMapping[]> {
  const merged = new Map<string, string>();

  const tsconfigAliases = await readTsconfigAliases(root, config.frontend?.tsconfigPath);
  for (const [alias, target] of tsconfigAliases) {
    merged.set(alias, target);
  }

  const configAliases = config.frontend?.aliases ?? {};
  for (const [alias, target] of Object.entries(configAliases)) {
    const normalizedAlias = normalizeAliasKey(alias.trim());
    const normalizedTarget = normalizeAliasTarget(target.trim());
    if (!normalizedAlias || !normalizedTarget) {
      continue;
    }
    const absoluteTarget = path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.resolve(root, normalizedTarget);
    merged.set(normalizedAlias, absoluteTarget);
  }

  return Array.from(merged.entries())
    .map(([alias, target]) => ({ alias, target }))
    .sort((a, b) => b.alias.length - a.alias.length);
}

async function readTsconfigAliases(
  root: string,
  tsconfigPath?: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const resolvedPath = await resolveTsconfigPath(root, tsconfigPath);
  if (!resolvedPath) {
    return result;
  }

  const configFile = ts.readConfigFile(resolvedPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) {
    return result;
  }

  const compilerOptions = configFile.config.compilerOptions ?? {};
  const baseUrl = compilerOptions.baseUrl ?? ".";
  const paths: Record<string, string[]> = compilerOptions.paths ?? {};
  const baseDir = path.resolve(path.dirname(resolvedPath), baseUrl);

  for (const [aliasPattern, targetPatterns] of Object.entries(paths)) {
    if (!Array.isArray(targetPatterns) || targetPatterns.length === 0) {
      continue;
    }
    const targetPattern = targetPatterns[0];
    if (typeof targetPattern !== "string") {
      continue;
    }

    const alias = normalizeAliasKey(aliasPattern);
    const target = normalizeAliasTarget(targetPattern);
    if (!alias || !target) {
      continue;
    }

    const absoluteTarget = path.isAbsolute(target)
      ? target
      : path.resolve(baseDir, target);
    result.set(alias, absoluteTarget);
  }

  return result;
}

async function loadTsCompilerOptions(
  root: string,
  tsconfigPath?: string
): Promise<ts.CompilerOptions> {
  const resolvedPath = await resolveTsconfigPath(root, tsconfigPath);
  if (!resolvedPath) {
    return {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
      resolveJsonModule: true,
      skipLibCheck: true
    };
  }

  const configFile = ts.readConfigFile(resolvedPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) {
    return {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
      resolveJsonModule: true,
      skipLibCheck: true
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(resolvedPath)
  );

  return {
    ...parsed.options,
    allowJs: true,
    jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX,
    moduleResolution: parsed.options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    module: parsed.options.module ?? ts.ModuleKind.NodeNext,
    resolveJsonModule: true,
    skipLibCheck: true
  };
}

async function resolveTsconfigPath(root: string, tsconfigPath?: string): Promise<string | null> {
  if (tsconfigPath && tsconfigPath.trim()) {
    const resolved = path.isAbsolute(tsconfigPath) ? tsconfigPath : path.resolve(root, tsconfigPath);
    if (await fileExists(resolved)) {
      return resolved;
    }
    return null;
  }

  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(root, name));
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function joinRoutePaths(parent: string, child: string): string {
  const cleanedParent = parent === "/" ? "" : parent.replace(/\/$/, "");
  if (!child) {
    return cleanedParent || "/";
  }
  if (child.startsWith("/")) {
    return child;
  }
  if (child === "*") {
    return cleanedParent ? `${cleanedParent}/*` : "*";
  }
  if (!cleanedParent) {
    return `/${child}`;
  }
  return `${cleanedParent}/${child}`.replace(/\/+/g, "/");
}

function getJsxAttributeValue(
  attributes: ts.JsxAttributes,
  name: string
): { value: string | null; present: boolean } {
  for (const prop of attributes.properties) {
    if (!ts.isJsxAttribute(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name)) {
      continue;
    }
    if (prop.name.text !== name) {
      continue;
    }
    if (!prop.initializer) {
      return { value: null, present: true };
    }
    if (ts.isStringLiteral(prop.initializer)) {
      return { value: prop.initializer.text, present: true };
    }
    if (ts.isJsxExpression(prop.initializer)) {
      const literal = getStringLiteral(prop.initializer.expression);
      return { value: literal, present: true };
    }
    return { value: null, present: true };
  }
  return { value: null, present: false };
}

function getJsxAttributeText(attributes: ts.JsxAttributes, name: string): string | null {
  for (const prop of attributes.properties) {
    if (!ts.isJsxAttribute(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name)) {
      continue;
    }
    if (prop.name.text !== name) {
      continue;
    }
    if (!prop.initializer) {
      return null;
    }
    if (ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
    if (ts.isJsxExpression(prop.initializer)) {
      return getExpressionText(prop.initializer.expression);
    }
    return null;
  }
  return null;
}

function isLinkTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && LINK_TAGS.has(tagName.text);
}

function collectRoutesFromObjectLiteral(
  node: ts.ObjectLiteralExpression,
  parentPath: string,
  routes: Set<string>
): void {
  let pathValue: string | null = null;
  let isIndex = false;
  let children: ts.Expression | undefined;

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      continue;
    }

    const key = prop.name.text;
    if (key === "path") {
      pathValue = getStringLiteral(prop.initializer);
    } else if (key === "index") {
      if (prop.initializer && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        isIndex = true;
      } else if (!prop.initializer) {
        isIndex = true;
      }
    } else if (key === "children") {
      children = prop.initializer;
    }
  }

  let currentPath = parentPath;
  if (pathValue) {
    currentPath = joinRoutePaths(parentPath, pathValue);
    routes.add(currentPath);
  } else if (isIndex) {
    currentPath = parentPath || "/";
    routes.add(currentPath);
  }

  if (children && ts.isArrayLiteralExpression(children)) {
    for (const element of children.elements) {
      if (ts.isObjectLiteralExpression(element)) {
        collectRoutesFromObjectLiteral(element, currentPath, routes);
      }
    }
  }
}

function collectRoutesFromJsx(node: ts.Node, parentPath: string, routes: Set<string>): void {
  if (ts.isJsxElement(node)) {
    const tagName = node.openingElement.tagName;
    if (ts.isIdentifier(tagName) && tagName.text === "Route") {
      const pathAttr = getJsxAttributeValue(node.openingElement.attributes, "path");
      const indexAttr = getJsxAttributeValue(node.openingElement.attributes, "index");

      let currentPath = parentPath;
      if (pathAttr.value) {
        currentPath = joinRoutePaths(parentPath, pathAttr.value);
        routes.add(currentPath);
      } else if (indexAttr.present) {
        currentPath = parentPath || "/";
        routes.add(currentPath);
      }

      for (const child of node.children) {
        collectRoutesFromJsx(child, currentPath, routes);
      }
      return;
    }
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName;
    if (ts.isIdentifier(tagName) && tagName.text === "Route") {
      const pathAttr = getJsxAttributeValue(node.attributes, "path");
      const indexAttr = getJsxAttributeValue(node.attributes, "index");
      if (pathAttr.value) {
        routes.add(joinRoutePaths(parentPath, pathAttr.value));
      } else if (indexAttr.present) {
        routes.add(parentPath || "/");
      }
      return;
    }
  }

  ts.forEachChild(node, (child) => collectRoutesFromJsx(child, parentPath, routes));
}

type ImportUsage = {
  specifier: string;
  symbols: string[];
  wildcard: boolean;
  localNames: string[];
};

type AliasMapping = {
  alias: string;
  target: string;
};

type JsxTagUsage = {
  full: string;
  base: string;
};

function isComponentLikeName(name: string): boolean {
  return name.length > 0 && name[0] === name[0]?.toUpperCase();
}

function jsxTagName(tag: ts.JsxTagNameExpression): JsxTagUsage | null {
  if (ts.isIdentifier(tag)) {
    return { full: tag.text, base: tag.text };
  }
  if (ts.isPropertyAccessExpression(tag)) {
    const parts: string[] = [];
    let current: ts.Expression = tag;
    while (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      return { full: parts.join("."), base: current.text };
    }
  }
  return null;
}

function isHookCall(expression: ts.Expression, hookName: string): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === hookName;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === hookName;
  }
  return false;
}

function extractNavigationTarget(expression: ts.Expression | undefined): string | null {
  const literal = getExpressionText(expression);
  if (literal) {
    return literal;
  }
  if (expression && ts.isObjectLiteralExpression(expression)) {
    for (const prop of expression.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        continue;
      }
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (!key) {
        continue;
      }
      if (key === "pathname" || key === "href" || key === "to") {
        const value = getExpressionText(prop.initializer as ts.Expression);
        if (value) {
          return value;
        }
      }
    }
  }
  return null;
}

function parseJsFile(content: string, filePath: string): {
  usages: ImportUsage[];
  exports: string[];
  exportDetails: ExportDetail[];
  apiCalls: Array<{ method: string; url: string; requestFields: string[] }>;
  routes: string[];
  stateVariables: string[];
  navigationTargets: string[];
  jsxTags: JsxTagUsage[];
  localDeclarations: string[];
  defaultExportName: string | null;
} {
  const usages: ImportUsage[] = [];
  const exports = new Set<string>();
  const exportDetailMap = new Map<string, ExportDetail>();
  const apiCalls = new Map<string, { method: string; url: string; requestFields: Set<string> }>();
  const routePaths = new Set<string>();
  const stateVariables = new Set<string>();
  const navigationTargets = new Set<string>();
  const routerIdentifiers = new Set<string>();
  const routerMethodIdentifiers = new Set<string>();
  const navigateIdentifiers = new Set<string>();
  const jsxTags = new Map<string, JsxTagUsage>();
  const localDeclarations = new Set<string>();
  const objectLiteralBindings = new Map<string, string[]>();
  let defaultExportName: string | null = null;

  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(filePath)
  );

  const addUsage = (
    specifier: string,
    symbols: string[],
    wildcard: boolean,
    localNames: string[]
  ): void => {
    usages.push({ specifier, symbols, wildcard, localNames });
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
    const isDefault = modifiers?.some(
      (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
    );
    if (isDefault) {
      exports.add("default");
      if (name?.text) {
        defaultExportName = name.text;
      }
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

  const recordStateFromBinding = (binding: ts.BindingName): void => {
    if (!ts.isArrayBindingPattern(binding)) {
      return;
    }
    const first = binding.elements[0];
    if (!first || !ts.isBindingElement(first)) {
      return;
    }
    if (ts.isIdentifier(first.name)) {
      stateVariables.add(first.name.text);
    }
  };

  const recordRouterBinding = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      routerIdentifiers.add(binding.text);
      return;
    }
    if (!ts.isObjectBindingPattern(binding)) {
      return;
    }
    for (const element of binding.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      const propertyName = element.propertyName;
      const key =
        propertyName && (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName))
          ? propertyName.text
          : element.name.text;
      if (NAVIGATION_METHODS.has(key)) {
        routerMethodIdentifiers.add(element.name.text);
      }
    }
  };

  const recordNavigationTarget = (expression: ts.Expression | undefined): void => {
    const target = extractNavigationTarget(expression);
    if (target) {
      navigationTargets.add(target);
    }
  };

  const recordNavigationFromJsx = (attributes: ts.JsxAttributes): void => {
    const href = getJsxAttributeText(attributes, "href");
    const to = getJsxAttributeText(attributes, "to");
    const target = href ?? to;
    if (target) {
      navigationTargets.add(target);
    }
  };

  const addApiCall = (entry: { method: string; url: string; requestFields?: string[] }): void => {
    const key = `${entry.method}|${entry.url}`;
    const current =
      apiCalls.get(key) ?? {
        method: entry.method,
        url: entry.url,
        requestFields: new Set<string>()
      };
    for (const field of entry.requestFields ?? []) {
      current.requestFields.add(field);
    }
    apiCalls.set(key, current);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (isHookCall(callee, "useState") || isHookCall(callee, "useReducer")) {
        recordStateFromBinding(node.name);
      }
      if (isHookCall(callee, "useRouter")) {
        recordRouterBinding(node.name);
      }
      if (isHookCall(callee, "useNavigate")) {
        if (ts.isIdentifier(node.name)) {
          navigateIdentifiers.add(node.name.text);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const fields = extractRequestFields(node.initializer, source, objectLiteralBindings);
      if (fields.length > 0) {
        objectLiteralBindings.set(node.name.text, fields);
      }
    }

    if (ts.isImportDeclaration(node)) {
      const specifier = getStringLiteral(node.moduleSpecifier);
      if (specifier) {
        const symbols: string[] = [];
        let wildcard = false;
        const localNames: string[] = [];

        const clause = node.importClause;
        if (clause) {
          if (clause.name) {
            symbols.push("default");
            localNames.push(clause.name.text);
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              wildcard = true;
              localNames.push(clause.namedBindings.name.text);
            } else if (ts.isNamedImports(clause.namedBindings)) {
              for (const element of clause.namedBindings.elements) {
                const original = element.propertyName?.text ?? element.name.text;
                symbols.push(original);
                localNames.push(element.name.text);
              }
            }
          }
        }

        addUsage(specifier, symbols, wildcard, localNames);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = getStringLiteral(node.moduleReference.expression);
        if (specifier) {
          addUsage(specifier, [], true, []);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier ? getStringLiteral(node.moduleSpecifier) : null;
      if (specifier) {
        if (!node.exportClause) {
          addUsage(specifier, [], true, []);
        } else if (ts.isNamedExports(node.exportClause)) {
          const symbols = node.exportClause.elements.map((element) =>
            element.propertyName?.text ?? element.name.text
          );
          addUsage(specifier, symbols, false, []);
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
      if (ts.isIdentifier(node.expression)) {
        defaultExportName = node.expression.text;
      }
      addExportDetail({
        name: ts.isIdentifier(node.expression) ? node.expression.text : "default",
        kind: "default"
      });
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
      if (node.name?.text && isComponentLikeName(node.name.text)) {
        localDeclarations.add(node.name.text);
      }
    } else if (ts.isClassDeclaration(node)) {
      if (node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) {
        handleExportedDeclaration(node, node.name);
      }
      if (node.name?.text && isComponentLikeName(node.name.text)) {
        localDeclarations.add(node.name.text);
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
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isComponentLikeName(declaration.name.text)) {
          localDeclarations.add(declaration.name.text);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const apiCall = extractApiCallFromCall(node, source, objectLiteralBindings);
      if (apiCall) {
        addApiCall(apiCall);
      }
      if (ts.isIdentifier(node.expression) && ROUTER_FACTORY_NAMES.has(node.expression.text)) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          if (ts.isArrayLiteralExpression(firstArg)) {
            for (const element of firstArg.elements) {
              if (ts.isObjectLiteralExpression(element)) {
                collectRoutesFromObjectLiteral(element, "", routePaths);
              }
            }
          } else if (ts.isCallExpression(firstArg)) {
            if (ts.isIdentifier(firstArg.expression) && firstArg.expression.text === "createRoutesFromElements") {
              const jsxArg = firstArg.arguments[0];
              if (jsxArg) {
                collectRoutesFromJsx(jsxArg, "", routePaths);
              }
            }
          } else if (ts.isJsxElement(firstArg) || ts.isJsxSelfClosingElement(firstArg)) {
            collectRoutesFromJsx(firstArg, "", routePaths);
          }
        }
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = getStringLiteral(node.arguments[0]);
        if (specifier) {
          addUsage(specifier, [], true, []);
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const specifier = getStringLiteral(node.arguments[0]);
        if (specifier) {
          addUsage(specifier, [], true, []);
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;
        if (ts.isIdentifier(receiver) && routerIdentifiers.has(receiver.text)) {
          if (NAVIGATION_METHODS.has(method)) {
            recordNavigationTarget(node.arguments[0]);
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        if (navigateIdentifiers.has(node.expression.text) || routerMethodIdentifiers.has(node.expression.text)) {
          recordNavigationTarget(node.arguments[0]);
        }
      }
    }

    if (ts.isJsxElement(node)) {
      const tagInfo = jsxTagName(node.openingElement.tagName);
      if (tagInfo && isComponentLikeName(tagInfo.base)) {
        jsxTags.set(tagInfo.full, tagInfo);
      }
      if (isLinkTag(node.openingElement.tagName)) {
        recordNavigationFromJsx(node.openingElement.attributes);
      }
    } else if (ts.isJsxSelfClosingElement(node)) {
      const tagInfo = jsxTagName(node.tagName);
      if (tagInfo && isComponentLikeName(tagInfo.base)) {
        jsxTags.set(tagInfo.full, tagInfo);
      }
      if (isLinkTag(node.tagName)) {
        recordNavigationFromJsx(node.attributes);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  collectRoutesFromJsx(source, "", routePaths);

  return {
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
    }),
    apiCalls: Array.from(apiCalls.values())
      .map((entry) => ({
        method: entry.method,
        url: entry.url,
        requestFields: Array.from(entry.requestFields).sort((a, b) => a.localeCompare(b))
      }))
      .sort((a, b) => {
        const method = a.method.localeCompare(b.method);
        if (method !== 0) {
          return method;
        }
        return a.url.localeCompare(b.url);
      }),
    routes: Array.from(routePaths).sort((a, b) => a.localeCompare(b)),
    stateVariables: Array.from(stateVariables).sort((a, b) => a.localeCompare(b)),
    navigationTargets: Array.from(navigationTargets).sort((a, b) => a.localeCompare(b)),
    jsxTags: Array.from(jsxTags.values()),
    localDeclarations: Array.from(localDeclarations).sort((a, b) => a.localeCompare(b)),
    defaultExportName
  };
}

function isPageFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!PAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  return path.basename(filePath, ext) === "page";
}

function isRouteFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!PAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  const base = path.basename(filePath, ext);
  return ROUTE_FILE_BASENAMES.has(base);
}

async function resolveComponentRoots(root: string): Promise<string[]> {
  const candidates = [
    path.join(root, "components"),
    path.join(root, "app"),
    path.join(root, "src", "components"),
    path.join(root, "src", "app")
  ];

  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (await existsDir(candidate)) {
      resolved.push(candidate);
    }
  }

  return resolved;
}

function isUtilityComponent(name: string, origin: string): boolean {
  if (UTILITY_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }

  const segments = origin.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.some((segment) => UTILITY_PATH_SEGMENTS.has(segment));
}

function componentId(file: string, name: string): string {
  return `${file}#${name}`;
}

type ComponentPropSummary = {
  name: string;
  type: string;
  optional: boolean;
};

function isUnknownType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Any) !== 0 ||
    (type.flags & ts.TypeFlags.Unknown) !== 0
  );
}

function propsFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node
): ComponentPropSummary[] {
  const props: ComponentPropSummary[] = [];
  for (const symbol of type.getProperties()) {
    const name = symbol.getName();
    if (name.startsWith("__")) {
      continue;
    }
    const propType = checker.getTypeOfSymbolAtLocation(symbol, location);
    const typeText = checker.typeToString(propType) || "unknown";
    const optional = (symbol.getFlags() & ts.SymbolFlags.Optional) !== 0;
    props.push({ name, type: typeText, optional });
  }
  return props;
}

function propsFromBindingPattern(pattern: ts.ObjectBindingPattern): ComponentPropSummary[] {
  const props: ComponentPropSummary[] = [];
  for (const element of pattern.elements) {
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
      const name = element.name.text;
      props.push({
        name,
        type: "unknown",
        optional: Boolean(element.initializer)
      });
    }
  }
  return props;
}

function extractPropsFromTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  location: ts.Node
): ComponentPropSummary[] {
  if (!typeNode) {
    return [];
  }
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments?.length) {
    const argType = checker.getTypeFromTypeNode(typeNode.typeArguments[0]);
    return propsFromType(argType, checker, location);
  }
  const type = checker.getTypeFromTypeNode(typeNode);
  return propsFromType(type, checker, location);
}

function extractPropsFromFunctionLike(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): ComponentPropSummary[] {
  const firstParam = node.parameters[0];
  if (!firstParam) {
    return [];
  }

  if (firstParam.type) {
    const props = extractPropsFromTypeNode(firstParam.type, checker, firstParam);
    if (props.length > 0) {
      return props;
    }
  }

  const paramType = checker.getTypeAtLocation(firstParam);
  if (!isUnknownType(paramType)) {
    const props = propsFromType(paramType, checker, firstParam);
    if (props.length > 0) {
      return props;
    }
  }

  if (ts.isObjectBindingPattern(firstParam.name)) {
    return propsFromBindingPattern(firstParam.name);
  }

  return [];
}

function extractPropsFromClass(
  node: ts.ClassDeclaration,
  checker: ts.TypeChecker
): ComponentPropSummary[] {
  if (!node.heritageClauses) {
    return [];
  }
  for (const clause of node.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const heritageType of clause.types) {
      if (!heritageType.typeArguments || heritageType.typeArguments.length === 0) {
        continue;
      }
      const propsType = checker.getTypeFromTypeNode(heritageType.typeArguments[0]);
      const props = propsFromType(propsType, checker, heritageType);
      if (props.length > 0) {
        return props;
      }
    }
  }
  return [];
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

function routeFromFile(appDir: string, filePath: string): string {
  const relativeDir = path.relative(appDir, path.dirname(filePath));
  if (!relativeDir) {
    return "/";
  }

  const segments = relativeDir
    .split(path.sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroup(segment));

  if (segments.length === 0) {
    return "/";
  }

  return `/${segments.join("/")}`;
}

function componentFromRoute(route: string): string {
  if (route === "/") {
    return "HomePage";
  }

  const segments = route.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "page";

  let cleaned = last.replace(/[\[\]]/g, "");
  cleaned = cleaned.replace(/^\.\.\./, "");
  cleaned = cleaned.replace(/^\.+/, "");

  const words = cleaned.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const pascal = words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join("");

  return `${pascal || "Page"}Page`;
}

function componentNameFromFile(filePath: string): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  if (base.toLowerCase() === "index") {
    const dir = path.basename(path.dirname(filePath));
    return `${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
  }
  const words = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const pascal = words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join("");
  return pascal || "Component";
}

async function resolveRouteDirs(root: string, routeDirs: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of routeDirs) {
    const candidate = path.isAbsolute(entry) ? entry : path.join(root, entry);
    if (await existsDir(candidate)) {
      resolved.push(candidate);
    }
  }
  return resolved;
}

function normalizeRoutePath(route: string): string {
  if (!route) {
    return "/";
  }
  if (route === "*" || route.startsWith("/")) {
    return route;
  }
  return `/${route}`;
}

function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function extractFetchCalls(content: string): Array<{ method: string; url: string }> {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchPattern = /\bfetch\s*\(\s*(["'`])([^"'`]+)\1/g;

  let match: RegExpExecArray | null;
  while ((match = fetchPattern.exec(content))) {
    const url = match[2];
    const snippet = content.slice(match.index, match.index + 300);
    const methodMatch = snippet.match(/method\s*:\s*["'`]([A-Za-z]+)["'`]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";

    calls.push({ method, url });
  }

  return calls;
}

function extractAxiosCalls(content: string): Array<{ method: string; url: string }> {
  const calls: Array<{ method: string; url: string }> = [];

  const axiosMethodPattern =
    /\baxios\.(get|post|put|patch|delete|head|options)\s*(?:<[^>]+>)?\s*\(\s*(["'`])([^"'`]+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = axiosMethodPattern.exec(content))) {
    calls.push({ method: match[1].toUpperCase(), url: match[3] });
  }

  const axiosConfigPattern = /\baxios\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((match = axiosConfigPattern.exec(content))) {
    const snippet = match[1];
    const methodMatch = snippet.match(/method\s*:\s*["'`]([A-Za-z]+)["'`]/i);
    const urlMatch = snippet.match(/url\s*:\s*["'`]([^"'`]+)["'`]/i);

    if (urlMatch) {
      const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
      calls.push({ method, url: urlMatch[1] });
    }
  }

  return calls;
}

function extractApiClientCalls(content: string): Array<{ method: string; url: string }> {
  const calls: Array<{ method: string; url: string }> = [];
  const clientPattern =
    /\b([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|patch|delete|head|options|fetch)\s*(?:<[^>]+>)?\s*\(\s*(["'`])([^"'`]+)\3/g;

  let match: RegExpExecArray | null;
  while ((match = clientPattern.exec(content))) {
    const client = match[1];
    if (client !== "api" && !client.endsWith("Api") && !client.endsWith("API")) {
      continue;
    }
    let method = match[2].toUpperCase();
    if (method === "FETCH") {
      method = "GET";
    }
    calls.push({ method, url: match[4] });
  }

  return calls;
}

function normalizeApiCalls(
  calls: Array<{ method: string; url: string }>
): Array<{ method: string; url: string }> {
  const seen = new Set<string>();
  const result: Array<{ method: string; url: string }> = [];

  for (const call of calls) {
    const key = `${call.method}|${call.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(call);
  }

  return result;
}

function getObjectLiteralString(
  node: ts.Expression | undefined,
  key: string,
  sourceFile: ts.SourceFile
): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return null;
  }
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (name !== key) {
      continue;
    }
    if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
    if (ts.isTemplateExpression(prop.initializer)) {
      return prop.initializer.getText(sourceFile);
    }
  }
  return null;
}

function extractObjectLiteralFieldsFromNode(
  node: ts.ObjectLiteralExpression
): string[] {
  const fields = new Set<string>();
  for (const prop of node.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      fields.add(prop.name.text);
      continue;
    }
    if (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
      const name =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isComputedPropertyName(prop.name)
            ? prop.name.expression.getText()
            : null;
      if (name) {
        fields.add(name);
      }
    }
  }
  return Array.from(fields).sort((a, b) => a.localeCompare(b));
}

function extractRequestFields(
  node: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  objectLiteralBindings: Map<string, string[]>
): string[] {
  if (!node) {
    return [];
  }
  if (ts.isObjectLiteralExpression(node)) {
    return extractObjectLiteralFieldsFromNode(node);
  }
  if (ts.isIdentifier(node)) {
    return objectLiteralBindings.get(node.text) ?? [];
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    node.expression.name.text === "stringify"
  ) {
    return extractRequestFields(node.arguments[0], sourceFile, objectLiteralBindings);
  }
  if (ts.isParenthesizedExpression(node)) {
    return extractRequestFields(node.expression, sourceFile, objectLiteralBindings);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return extractRequestFields(node.expression, sourceFile, objectLiteralBindings);
  }
  return [];
}

function extractApiCallFromCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  objectLiteralBindings: Map<string, string[]>
): { method: string; url: string; requestFields: string[] } | null {
  const expression = node.expression;

  if (ts.isIdentifier(expression) && expression.text === "fetch") {
    const url = getExpressionText(node.arguments[0]);
    if (!url) {
      return null;
    }
    const method =
      getObjectLiteralString(node.arguments[1], "method", sourceFile)?.toUpperCase() ?? "GET";
    let requestFields: string[] = [];
    const optionsArg = node.arguments[1];
    if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
      for (const prop of optionsArg.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "body"
        ) {
          requestFields = extractRequestFields(prop.initializer, sourceFile, objectLiteralBindings);
        }
      }
    }
    return { method, url, requestFields };
  }

  if (ts.isIdentifier(expression) && expression.text === "axios") {
    const configArg = node.arguments[0];
    const url = getObjectLiteralString(configArg, "url", sourceFile);
    if (!url) {
      return null;
    }
    const method =
      getObjectLiteralString(configArg, "method", sourceFile)?.toUpperCase() ?? "GET";
    let requestFields: string[] = [];
    if (configArg && ts.isObjectLiteralExpression(configArg)) {
      for (const prop of configArg.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "data"
        ) {
          requestFields = extractRequestFields(prop.initializer, sourceFile, objectLiteralBindings);
        }
      }
    }
    return { method, url, requestFields };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const method = expression.name.text.toLowerCase();
    if (!HTTP_METHODS.has(method) && method !== "fetch") {
      return null;
    }
    const receiver = expression.expression;
    let receiverName: string | null = null;
    if (ts.isIdentifier(receiver)) {
      receiverName = receiver.text;
    } else if (ts.isPropertyAccessExpression(receiver)) {
      receiverName = receiver.name.text;
    }
    if (!receiverName) {
      return null;
    }
    if (receiverName !== "axios" && receiverName !== "api" && !receiverName.endsWith("Api") && !receiverName.endsWith("API")) {
      return null;
    }
    const url = getExpressionText(node.arguments[0]);
    if (!url) {
      return null;
    }
    const normalizedMethod = method === "fetch" ? "GET" : method.toUpperCase();
    const requestFields =
      method === "get" || method === "delete" || method === "fetch"
        ? []
        : extractRequestFields(node.arguments[1], sourceFile, objectLiteralBindings);
    return { method: normalizedMethod, url, requestFields };
  }

  return null;
}

function collectResolvedApiCalls(params: {
  node: ts.CallExpression;
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  objectLiteralBindings: Map<string, string[]>;
  visitedSymbols?: Set<string>;
  depth?: number;
}): Array<{ method: string; url: string; requestFields: string[] }> {
  const direct = extractApiCallFromCall(
    params.node,
    params.sourceFile,
    params.objectLiteralBindings
  );
  if (direct) {
    return [direct];
  }

  const depth = params.depth ?? 0;
  if (depth >= 2) {
    return [];
  }

  const symbol = resolveCallSymbol(params.node.expression, params.checker);
  if (!symbol) {
    return [];
  }

  const visitedSymbols = params.visitedSymbols ?? new Set<string>();
  const symbolKey = `${symbol.getName()}::${symbol.declarations?.[0]?.getSourceFile().fileName ?? ""}`;
  if (visitedSymbols.has(symbolKey)) {
    return [];
  }
  visitedSymbols.add(symbolKey);

  const results: Array<{ method: string; url: string; requestFields: string[] }> = [];
  for (const declaration of symbol.getDeclarations() ?? []) {
    const fileName = declaration.getSourceFile().fileName;
    if (fileName.includes("node_modules")) {
      continue;
    }
    const body = getCallableBody(declaration);
    if (!body) {
      continue;
    }
    const localBindings = new Map<string, string[]>();
    ts.forEachChild(body, function visit(child): void {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer
      ) {
        const fields = extractRequestFields(
          child.initializer,
          declaration.getSourceFile(),
          localBindings
        );
        if (fields.length > 0) {
          localBindings.set(child.name.text, fields);
        }
      }
      if (ts.isCallExpression(child)) {
        const nested = collectResolvedApiCalls({
          node: child,
          sourceFile: declaration.getSourceFile(),
          checker: params.checker,
          objectLiteralBindings: localBindings,
          visitedSymbols,
          depth: depth + 1
        });
        results.push(...nested);
      }
      ts.forEachChild(child, visit);
    });
  }

  return dedupeResolvedApiCalls(results);
}

function resolveCallSymbol(
  expression: ts.LeftHandSideExpression,
  checker: ts.TypeChecker
): ts.Symbol | null {
  let symbol: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(expression)) {
    symbol = checker.getSymbolAtLocation(expression.name);
  } else if (ts.isIdentifier(expression)) {
    symbol = checker.getSymbolAtLocation(expression);
  }
  if (!symbol) {
    return null;
  }
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function getCallableBody(declaration: ts.Declaration): ts.Node | null {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    return declaration.body ?? null;
  }
  if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
    return declaration.body;
  }
  if (
    ts.isPropertyAssignment(declaration) &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer.body;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer.body;
  }
  return null;
}

function dedupeResolvedApiCalls(
  calls: Array<{ method: string; url: string; requestFields: string[] }>
): Array<{ method: string; url: string; requestFields: string[] }> {
  const byKey = new Map<string, { method: string; url: string; requestFields: Set<string> }>();
  for (const call of calls) {
    const key = `${call.method}|${call.url}`;
    const entry =
      byKey.get(key) ?? {
        method: call.method,
        url: call.url,
        requestFields: new Set<string>()
      };
    for (const field of call.requestFields) {
      entry.requestFields.add(field);
    }
    byKey.set(key, entry);
  }
  return Array.from(byKey.values()).map((entry) => ({
    method: entry.method,
    url: entry.url,
    requestFields: Array.from(entry.requestFields).sort((a, b) => a.localeCompare(b))
  }));
}

function getDefaultExportName(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): string | null {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return null;
  }
  const exports = checker.getExportsOfModule(moduleSymbol);
  const defaultExport = exports.find((symbol) => symbol.escapedName === "default");
  if (!defaultExport) {
    return null;
  }
  const declarations = defaultExport.getDeclarations() ?? [];
  for (const decl of declarations) {
    if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) {
      if (decl.name?.text) {
        return decl.name.text;
      }
    }
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }
  return null;
}

function isComponentFunction(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): boolean {
  return containsJsx(node);
}

function isComponentClass(node: ts.ClassDeclaration): boolean {
  if (!node.name?.text || !isPascalCase(node.name.text)) {
    return false;
  }
  if (node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue;
      }
      for (const type of clause.types) {
        const name = type.expression.getText();
        if (name.includes("Component") || name.includes("PureComponent")) {
          return true;
        }
      }
    }
  }
  for (const member of node.members) {
    if (ts.isMethodDeclaration(member) && member.name.getText() === "render" && member.body) {
      if (containsJsx(member.body)) {
        return true;
      }
    }
  }
  return false;
}

function resolveComponentFromSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  root: string,
  componentRoots: string[]
): { id: string; name: string; file: string } | null {
  if (!symbol) {
    return null;
  }
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = resolved.getDeclarations() ?? [];
  for (const decl of declarations) {
    const sourceFile = decl.getSourceFile();
    const fileName = sourceFile.fileName;
    if (fileName.includes("node_modules")) {
      continue;
    }
    const rel = toPosix(path.relative(root, fileName));
    const abs = path.resolve(fileName);
    if (!componentRoots.some((dir) => isSubPath(dir, abs))) {
      continue;
    }
    const name =
      (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) && decl.name?.text
        ? decl.name.text
        : ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)
          ? decl.name.text
          : resolved.getName() === "default"
            ? componentNameFromFile(fileName)
            : resolved.getName();
    const id = componentId(rel, name);
    return { id, name, file: rel };
  }
  return null;
}

type ComponentAnalysisResult = {
  componentNodes: Map<string, UxComponentNode>;
  componentEdges: Set<string>;
  componentApiCalls: Map<string, Set<string>>;
  componentStateVariables: Map<string, Set<string>>;
  componentNavigation: Map<string, Set<string>>;
  pageComponentIds: Map<string, string>;
};

function resolveComponentExportKind(params: {
  componentName: string;
  file: string;
  kind: "page" | "component";
  fileExportDetails: Map<string, ExportDetail[]>;
  defaultExportNames: Map<string, string | null>;
}): ExportKind {
  const { componentName, file, kind, fileExportDetails, defaultExportNames } = params;
  if (kind === "page") {
    return "default";
  }

  const exportDetails = fileExportDetails.get(file) ?? [];
  for (const detail of exportDetails) {
    const publicName = detail.alias ?? detail.name;
    if (detail.kind === "default") {
      if (
        detail.name === componentName ||
        publicName === componentName ||
        publicName === "default"
      ) {
        return "default";
      }
      continue;
    }

    if (detail.name === componentName || publicName === componentName) {
      return "named";
    }
  }

  if (defaultExportNames.get(file) === componentName) {
    return "default";
  }

  if (exportDetails.length === 1 && exportDetails[0]?.kind === "default") {
    return "default";
  }

  return "named";
}

async function analyzeComponentsAst(params: {
  root: string;
  files: string[];
  pageFileToRoute: Map<string, string>;
  routePageFile: Map<string, string>;
  pageMap: Map<string, FrontendPageSummary>;
  componentRoots: string[];
  fileExportDetails: Map<string, ExportDetail[]>;
  defaultExportNames: Map<string, string | null>;
  config: SpecGuardConfig;
}): Promise<ComponentAnalysisResult> {
  const {
    root,
    files,
    pageFileToRoute,
    routePageFile,
    pageMap,
    componentRoots,
    fileExportDetails,
    defaultExportNames,
    config
  } = params;
  const compilerOptions = await loadTsCompilerOptions(root, config.frontend?.tsconfigPath);
  const program = ts.createProgram({ rootNames: files, options: compilerOptions });
  const checker = program.getTypeChecker();

  const componentNodes = new Map<string, UxComponentNode>();
  const componentEdges = new Set<string>();
  const componentApiCalls = new Map<string, Set<string>>();
  const componentStateVariables = new Map<string, Set<string>>();
  const componentNavigation = new Map<string, Set<string>>();
  const pageComponentIds = new Map<string, string>();

  const registerComponent = (
    id: string,
    name: string,
    file: string,
    kind: "page" | "component",
    props?: ComponentPropSummary[]
  ) => {
    const exportKind = resolveComponentExportKind({
      componentName: name,
      file,
      kind,
      fileExportDetails,
      defaultExportNames
    });
    const existing = componentNodes.get(id);
    if (!existing) {
      componentNodes.set(id, {
        id,
        name,
        file,
        kind,
        export_kind: exportKind,
        props: props && props.length > 0 ? props : undefined
      });
    } else if (existing.kind !== "page" && kind === "page") {
      componentNodes.set(id, {
        ...existing,
        kind: "page",
        export_kind: "default",
        props: props && props.length > 0 ? props : existing.props
      });
    } else if (existing.export_kind !== "default" && exportKind === "default") {
      componentNodes.set(id, {
        ...existing,
        export_kind: exportKind,
        props: props && props.length > 0 ? props : existing.props
      });
    } else if (props && props.length > 0 && (!existing.props || existing.props.length === 0)) {
      componentNodes.set(id, { ...existing, props });
    }
  };

  const addSignal = (map: Map<string, Set<string>>, id: string, values: string[]): void => {
    if (values.length === 0) {
      return;
    }
    const entry = map.get(id) ?? new Set<string>();
    for (const value of values) {
      entry.add(value);
    }
    map.set(id, entry);
  };

  for (const filePath of files) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      continue;
    }
    const relative = toPosix(path.relative(root, filePath));
    const route = pageFileToRoute.get(relative);
    const defaultExportName = getDefaultExportName(sourceFile, checker);
    if (route && defaultExportName) {
      const summary = pageMap.get(route);
      if (summary) {
        summary.component = defaultExportName;
      }
    }

    const componentStack: string[] = [];
    const routerIdentifiers = new Map<string, Set<string>>();
    const routerMethodIdentifiers = new Map<string, Set<string>>();
    const navigateIdentifiers = new Map<string, Set<string>>();
    const objectLiteralBindings = new Map<string, string[]>();

    const registerRouterBinding = (componentId: string, binding: ts.BindingName): void => {
      if (ts.isIdentifier(binding)) {
        const set = routerIdentifiers.get(componentId) ?? new Set<string>();
        set.add(binding.text);
        routerIdentifiers.set(componentId, set);
        return;
      }
      if (ts.isObjectBindingPattern(binding)) {
        for (const element of binding.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) {
            continue;
          }
          const propertyName = element.propertyName;
          const key =
            propertyName && (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName))
              ? propertyName.text
              : element.name.text;
          if (NAVIGATION_METHODS.has(key)) {
            const set = routerMethodIdentifiers.get(componentId) ?? new Set<string>();
            set.add(element.name.text);
            routerMethodIdentifiers.set(componentId, set);
          }
        }
      }
    };

    const registerNavigateBinding = (componentId: string, binding: ts.BindingName): void => {
      if (ts.isIdentifier(binding)) {
        const set = navigateIdentifiers.get(componentId) ?? new Set<string>();
        set.add(binding.text);
        navigateIdentifiers.set(componentId, set);
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text && isPascalCase(node.name.text)) {
        if (isComponentFunction(node)) {
          const id = componentId(relative, node.name.text);
          const props = extractPropsFromFunctionLike(node, checker);
          registerComponent(id, node.name.text, relative, "component", props);
          componentStack.push(id);
          if (node.body) {
            ts.forEachChild(node.body, visit);
          }
          componentStack.pop();
          return;
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isPascalCase(node.name.text)) {
        const initializer = node.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          if (isComponentFunction(initializer)) {
            const id = componentId(relative, node.name.text);
            const typeProps = extractPropsFromTypeNode(node.type, checker, node);
            const paramProps = extractPropsFromFunctionLike(initializer, checker);
            const props = typeProps.length > 0 ? typeProps : paramProps;
            registerComponent(id, node.name.text, relative, "component", props);
            componentStack.push(id);
            if (initializer.body) {
              ts.forEachChild(initializer.body, visit);
            }
            componentStack.pop();
            return;
          }
        }
      }

      if (ts.isClassDeclaration(node) && node.name?.text && isComponentClass(node)) {
        const id = componentId(relative, node.name.text);
        const props = extractPropsFromClass(node, checker);
        registerComponent(id, node.name.text, relative, "component", props);
        componentStack.push(id);
        ts.forEachChild(node, visit);
        componentStack.pop();
        return;
      }

      const currentComponentId = componentStack[componentStack.length - 1];
      if (currentComponentId) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
          const callee = node.initializer.expression;
          if (isHookCall(callee, "useState") || isHookCall(callee, "useReducer")) {
            if (ts.isArrayBindingPattern(node.name) && node.name.elements.length > 0) {
              const first = node.name.elements[0];
              if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
                addSignal(componentStateVariables, currentComponentId, [first.name.text]);
              }
            }
          }
          if (isHookCall(callee, "useRouter")) {
            registerRouterBinding(currentComponentId, node.name);
          }
          if (isHookCall(callee, "useNavigate")) {
            registerNavigateBinding(currentComponentId, node.name);
          }
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const fields = extractRequestFields(node.initializer, sourceFile, objectLiteralBindings);
          if (fields.length > 0) {
            objectLiteralBindings.set(node.name.text, fields);
          }
        }

        if (ts.isCallExpression(node)) {
          const apiCalls = collectResolvedApiCalls({
            node,
            sourceFile,
            checker,
            objectLiteralBindings
          });
          for (const apiCall of apiCalls) {
            addSignal(componentApiCalls, currentComponentId, [
              `${apiCall.method} ${apiCall.url}`
            ]);
          }

          if (ts.isPropertyAccessExpression(node.expression)) {
            const receiver = node.expression.expression;
            const method = node.expression.name.text;
            if (ts.isIdentifier(receiver)) {
              const routers = routerIdentifiers.get(currentComponentId) ?? new Set<string>();
              if (routers.has(receiver.text) && NAVIGATION_METHODS.has(method)) {
                const target = extractNavigationTarget(node.arguments[0]);
                if (target) {
                  addSignal(componentNavigation, currentComponentId, [target]);
                }
              }
            }
          } else if (ts.isIdentifier(node.expression)) {
            const navigate = navigateIdentifiers.get(currentComponentId) ?? new Set<string>();
            const methods = routerMethodIdentifiers.get(currentComponentId) ?? new Set<string>();
            if (navigate.has(node.expression.text) || methods.has(node.expression.text)) {
              const target = extractNavigationTarget(node.arguments[0]);
              if (target) {
                addSignal(componentNavigation, currentComponentId, [target]);
              }
            }
          }
        }

        if (ts.isJsxElement(node)) {
          const tagInfo = jsxTagName(node.openingElement.tagName);
          if (tagInfo) {
            const symbol = checker.getSymbolAtLocation(node.openingElement.tagName);
            const resolved = resolveComponentFromSymbol(symbol, checker, root, componentRoots);
            if (resolved && !isUtilityComponent(resolved.name, resolved.file)) {
              registerComponent(resolved.id, resolved.name, resolved.file, "component");
              componentEdges.add(`${currentComponentId}|${resolved.id}`);
            }
          }
          if (isLinkTag(node.openingElement.tagName)) {
            const target = getJsxAttributeText(node.openingElement.attributes, "href") ??
              getJsxAttributeText(node.openingElement.attributes, "to");
            if (target) {
              addSignal(componentNavigation, currentComponentId, [target]);
            }
          }
        } else if (ts.isJsxSelfClosingElement(node)) {
          const tagInfo = jsxTagName(node.tagName);
          if (tagInfo) {
            const symbol = checker.getSymbolAtLocation(node.tagName);
            const resolved = resolveComponentFromSymbol(symbol, checker, root, componentRoots);
            if (resolved && !isUtilityComponent(resolved.name, resolved.file)) {
              registerComponent(resolved.id, resolved.name, resolved.file, "component");
              componentEdges.add(`${currentComponentId}|${resolved.id}`);
            }
          }
          if (isLinkTag(node.tagName)) {
            const target = getJsxAttributeText(node.attributes, "href") ??
              getJsxAttributeText(node.attributes, "to");
            if (target) {
              addSignal(componentNavigation, currentComponentId, [target]);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (route) {
      const componentName = defaultExportName ?? componentFromRoute(route);
      const id = componentId(relative, componentName);
      registerComponent(id, componentName, relative, "page");
      pageComponentIds.set(route, id);
    }
  }

  for (const [route, file] of routePageFile) {
    if (!pageComponentIds.has(route)) {
      const componentName = componentFromRoute(route);
      const id = componentId(file, componentName);
      registerComponent(id, componentName, file, "page");
      pageComponentIds.set(route, id);
    }
  }

  return {
    componentNodes,
    componentEdges,
    componentApiCalls,
    componentStateVariables,
    componentNavigation,
    pageComponentIds
  };
}

export async function analyzeFrontend(
  frontendRoot: string,
  config: SpecGuardConfig
): Promise<FrontendAnalysis> {
  const root = path.resolve(frontendRoot);
  const baseRoot = path.dirname(root);
  const ignore = createIgnoreMatcher(config, baseRoot);
  const aliases = await loadAliasMappings(root, config);
  const appDir = await findAppDir(frontendRoot);
  const componentRoots = await resolveComponentRoots(root);
  const componentRootsToUse = componentRoots.length > 0 ? componentRoots : [root];

  const pageMap = new Map<string, FrontendPageSummary>();
  const routeFiles = new Set<string>();
  const routeRoots = new Map<string, Set<string>>();
  const pageFileToRoute = new Map<string, string>();
  const routePageFile = new Map<string, string>();

  const addRouteRoot = (route: string, file: string): void => {
    const current = routeRoots.get(route) ?? new Set<string>();
    current.add(file);
    routeRoots.set(route, current);
  };

  const fileRouter = await detectFileRouterFramework(frontendRoot);

  if (appDir) {
    if (fileRouter === "expo-router") {
      // Expo Router: every .tsx in app/ is a page (except _layout, _error, etc.)
      const allAppFiles = (await listFiles(appDir, ignore, baseRoot)).filter(
        (f) => isExpoRouterPage(f, appDir)
      );
      for (const filePath of allAppFiles) {
        const route = expoRouteFromFile(appDir, filePath);
        const relative = toPosix(path.relative(root, filePath));
        routeFiles.add(relative);
        addRouteRoot(route, relative);
        pageFileToRoute.set(relative, route);
        if (!routePageFile.has(route)) {
          routePageFile.set(route, relative);
        }
        if (!pageMap.has(route)) {
          pageMap.set(route, {
            path: route,
            component: componentFromRoute(route)
          });
        }
      }
    } else {
      // Next.js / default: only page.tsx files are pages
      const routeFilesInApp = (await listFiles(appDir, ignore, baseRoot)).filter(isRouteFile);
      for (const filePath of routeFilesInApp) {
        const route = routeFromFile(appDir, filePath);
        const relative = toPosix(path.relative(root, filePath));
        routeFiles.add(relative);
        addRouteRoot(route, relative);

        if (isPageFile(filePath)) {
          pageFileToRoute.set(relative, route);
          if (!routePageFile.has(route)) {
            routePageFile.set(route, relative);
          }
          if (!pageMap.has(route)) {
            pageMap.set(route, {
              path: route,
              component: componentFromRoute(route)
            });
          }
        }
      }
    }
  }

  const apiCalls: FrontendApiCallSummary[] = [];
  const apiCallMap = new Map<string, FrontendApiCallSummary>();

  const files = (await listFiles(root, ignore, baseRoot)).filter(isCodeFile);
  const routeDirs = await resolveRouteDirs(root, config.frontend?.routeDirs ?? []);
  const routeScanSet = new Set<string>();
  if (routeDirs.length === 0) {
    for (const file of files) {
      routeScanSet.add(file);
    }
  } else {
    for (const file of files) {
      if (routeDirs.some((dir) => isSubPath(dir, file))) {
        routeScanSet.add(file);
      }
    }
  }
  const relativeFiles = files.map((filePath) => toPosix(path.relative(root, filePath))).sort();

  const knownFiles = new Set(relativeFiles);
  const fileGraph: DirectedGraph = new Map();
  for (const file of relativeFiles) {
    ensureNode(fileGraph, file);
  }

  const fileGraphEdges: FileDependency[] = [];
  const fileInbound = new Map<string, number>();
  const fileExports = new Map<string, string[]>();
  const fileExportDetails = new Map<string, ExportDetail[]>();
  const defaultExportNames = new Map<string, string | null>();
  const fileUsedSymbols = new Map<string, Set<string>>();
  const fileWildcardUse = new Set<string>();

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

  for (const filePath of files) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const source = toPosix(path.relative(root, filePath));

    const parsed = parseJsFile(content, filePath);
    if (parsed.exports.length > 0) {
      fileExports.set(source, parsed.exports);
    }
    if (parsed.exportDetails.length > 0) {
      fileExportDetails.set(source, parsed.exportDetails);
    }
    defaultExportNames.set(source, parsed.defaultExportName);

    for (const call of parsed.apiCalls) {
      const key = `${call.method}|${call.url}|${source}`;
      const existing = apiCallMap.get(key);
      if (!existing) {
        apiCallMap.set(key, {
          method: call.method,
          path: call.url,
          source,
          request_fields: call.requestFields
        });
      } else {
        existing.request_fields = Array.from(
          new Set([...(existing.request_fields ?? []), ...call.requestFields])
        ).sort((a, b) => a.localeCompare(b));
      }
    }

    if (routeScanSet.has(filePath)) {
      for (const route of parsed.routes) {
        const normalizedRoute = normalizeRoutePath(route);
        if (!pageMap.has(normalizedRoute)) {
          pageMap.set(normalizedRoute, {
            path: normalizedRoute,
            component: componentFromRoute(normalizedRoute)
          });
        }
        addRouteRoot(normalizedRoute, source);
      }
      if (parsed.routes.length > 0) {
        routeFiles.add(source);
      }
    }

    for (const usage of parsed.usages) {
      const resolved = await resolveJsImport(filePath, usage.specifier, aliases);
      if (!resolved) {
        continue;
      }

      const resolvedRel = toPosix(path.relative(root, resolved));
      if (!knownFiles.has(resolvedRel)) {
        continue;
      }

      addEdge(fileGraph, source, resolvedRel);
      recordUsage(resolvedRel, usage.symbols, usage.wildcard);
    }
  }

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

  const inbound = inboundCounts(fileGraph, relativeFiles);
  for (const [file, count] of inbound) {
    fileInbound.set(file, count);
  }

  const frontendEntrypoints = new Set(
    [
      "src/main.tsx",
      "src/main.jsx",
      "src/main.ts",
      "src/main.js",
      "src/index.tsx",
      "src/index.jsx",
      "src/index.ts",
      "src/index.js",
      "main.tsx",
      "main.jsx",
      "main.ts",
      "main.js",
      "index.tsx",
      "index.jsx",
      "index.ts",
      "index.js"
    ].filter((entry) => relativeFiles.includes(entry))
  );

  const orphanFiles = relativeFiles
    .filter((file) => (fileInbound.get(file) ?? 0) === 0)
    .filter((file) => !routeFiles.has(file))
    .filter((file) => !frontendEntrypoints.has(file))
    .sort((a, b) => a.localeCompare(b));

  const unusedExports: UnusedExport[] = [];
  for (const [file, symbols] of fileExports) {
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

  const componentFiles = files.filter(isTsProgramFile);
  const componentAnalysis = await analyzeComponentsAst({
    root,
    files: componentFiles,
    pageFileToRoute,
    routePageFile,
    pageMap,
    componentRoots: componentRootsToUse,
    fileExportDetails,
    defaultExportNames,
    config
  });

  const { componentNodes, componentEdges, componentApiCalls, componentStateVariables, componentNavigation, pageComponentIds } =
    componentAnalysis;

  apiCalls.push(...apiCallMap.values());

  apiCalls.sort((a, b) => {
    const method = a.method.localeCompare(b.method);
    if (method !== 0) return method;
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.source.localeCompare(b.source);
  });

  const pages = Array.from(pageMap.values()).sort((a, b) => a.path.localeCompare(b.path));

  const componentAdjacency: DirectedGraph = new Map();
  for (const node of componentNodes.values()) {
    ensureNode(componentAdjacency, node.id);
  }

  const componentEdgeList: UxComponentEdge[] = [];
  for (const edgeKey of componentEdges) {
    const [from, to] = edgeKey.split("|");
    if (!from || !to) {
      continue;
    }
    addEdge(componentAdjacency, from, to);
    componentEdgeList.push({ from, to });
  }
  componentEdgeList.sort((a, b) => {
    const from = a.from.localeCompare(b.from);
    if (from !== 0) return from;
    return a.to.localeCompare(b.to);
  });

  const componentNameById = new Map<string, string>();
  for (const node of componentNodes.values()) {
    componentNameById.set(node.id, node.name);
  }

  const collectReachable = (start: string): string[] => {
    const visited = new Set<string>();
    const stack = [start];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const neighbors = componentAdjacency.get(current);
      if (!neighbors) {
        continue;
      }
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    return Array.from(visited);
  };

  const gatherComponentValues = (ids: Set<string>, map: Map<string, Set<string>>): string[] => {
    const result = new Set<string>();
    for (const id of ids) {
      const values = map.get(id);
      if (!values) {
        continue;
      }
      for (const value of values) {
        result.add(value);
      }
    }
    return Array.from(result).sort((a, b) => a.localeCompare(b));
  };

  const uxPages: UxPageSummary[] = pages.map((page) => {
    const pageComponentId =
      pageComponentIds.get(page.path) ?? componentId(`route:${page.path}`, page.component);
    const directIds = Array.from(componentAdjacency.get(pageComponentId) ?? []);
    directIds.sort((a, b) => a.localeCompare(b));

    const reachable = collectReachable(pageComponentId);
    const reachableSet = new Set(reachable);
    reachableSet.delete(pageComponentId);
    for (const id of directIds) {
      reachableSet.delete(id);
    }
    const descendantIds = Array.from(reachableSet).sort((a, b) => a.localeCompare(b));

    const pageComponentIdSet = new Set<string>([pageComponentId, ...directIds, ...descendantIds]);

    const componentsDirect = directIds.map((id) => componentNameById.get(id) ?? id);
    const componentsDesc = descendantIds.map((id) => componentNameById.get(id) ?? id);
    const componentsAll = [...new Set([...componentsDirect, ...componentsDesc])].sort((a, b) =>
      a.localeCompare(b)
    );

    const componentApiCallsList = Array.from(pageComponentIdSet)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        component: componentNameById.get(id) ?? id,
        component_id: id,
        api_calls: Array.from(componentApiCalls.get(id) ?? []).sort((a, b) => a.localeCompare(b))
      }))
      .filter((entry) => entry.api_calls.length > 0);

    const componentStateList = Array.from(pageComponentIdSet)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        component: componentNameById.get(id) ?? id,
        component_id: id,
        local_state_variables: Array.from(componentStateVariables.get(id) ?? []).sort((a, b) =>
          a.localeCompare(b)
        )
      }))
      .filter((entry) => entry.local_state_variables.length > 0);

    return {
      path: page.path,
      component: page.component,
      component_id: pageComponentId,
      components: componentsAll,
      components_direct: componentsDirect,
      components_descendants: componentsDesc,
      components_direct_ids: directIds,
      components_descendants_ids: descendantIds,
      local_state_variables: gatherComponentValues(pageComponentIdSet, componentStateVariables),
      api_calls: gatherComponentValues(pageComponentIdSet, componentApiCalls),
      component_api_calls: componentApiCallsList,
      component_state_variables: componentStateList,
      possible_navigation: gatherComponentValues(pageComponentIdSet, componentNavigation)
    };
  });

  const componentList = Array.from(componentNodes.values()).sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.file.localeCompare(b.file);
  });

  // --- 6. Extract Tests Natively using Universal Adapters ---
  const tests: TestExtractionSummary[] = [];
  for (const relativeFile of relativeFiles) {
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
    files: relativeFiles,
    pages,
    apiCalls,
    uxPages,
    components: componentList,
    componentGraph: componentEdgeList,
    fileGraph: fileGraphEdges,
    orphanFiles,
    unusedExports,
    tests
  };
}
