import crypto from "node:crypto";
import path from "node:path";
import ts from "typescript";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import type {
  DuplicateFunctionGroup,
  SimilarFunctionGroup
} from "./types.js";

type FunctionFingerprint = {
  id: string;
  name: string;
  file: string;
  language: "ts" | "js" | "py";
  size: number;
  hash: string;
  calls: string[];
  kindSet: string[];
};

export async function findDuplicateFunctions(params: {
  files: string[];
  baseRoot: string;
  fileContents: Map<string, string>;
}): Promise<{
  duplicateFunctions: DuplicateFunctionGroup[];
  similarFunctions: SimilarFunctionGroup[];
}> {
  const { files, baseRoot, fileContents } = params;
  const fingerprints: FunctionFingerprint[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const language = ext === ".py" ? "py" : "ts";
    const content = fileContents.get(file);
    if (typeof content !== "string" || content.length === 0) {
      continue;
    }
    if (language === "py") {
      fingerprints.push(...extractPythonFunctions(file, content));
    } else if (isTsLike(ext)) {
      const lang =
        ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs"
          ? "js"
          : "ts";
      fingerprints.push(...extractTsFunctions(file, content, lang));
    }
  }

  const duplicates = groupByHash(fingerprints);
  const similar = [
    ...findSimilarByCallPattern(fingerprints),
    ...findSimilarByAstStructure(fingerprints)
  ]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 50);

  return {
    duplicateFunctions: duplicates,
    similarFunctions: similar
  };
}

function groupByHash(fingerprints: FunctionFingerprint[]): DuplicateFunctionGroup[] {
  const grouped = new Map<string, FunctionFingerprint[]>();
  for (const fingerprint of fingerprints) {
    const entry = grouped.get(fingerprint.hash) ?? [];
    entry.push(fingerprint);
    grouped.set(fingerprint.hash, entry);
  }

  const groups: DuplicateFunctionGroup[] = [];
  for (const [hash, entries] of grouped.entries()) {
    if (entries.length < 2) {
      continue;
    }
    const size = Math.max(...entries.map((entry) => entry.size));
    groups.push({
      hash,
      size,
      functions: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        file: entry.file,
        language: entry.language,
        size: entry.size
      }))
    });
  }

  groups.sort((a, b) => b.size - a.size || b.functions.length - a.functions.length);
  return groups;
}

function findSimilarByCallPattern(fingerprints: FunctionFingerprint[]): SimilarFunctionGroup[] {
  const bySize = new Map<number, FunctionFingerprint[]>();
  for (const fp of fingerprints) {
    const callSize = fp.calls.length;
    if (callSize === 0) {
      continue;
    }
    const entry = bySize.get(callSize) ?? [];
    entry.push(fp);
    bySize.set(callSize, entry);
  }

  const pairs: SimilarFunctionGroup[] = [];
  const sizes = Array.from(bySize.keys()).sort((a, b) => a - b);
  const threshold = 0.8;
  const maxPairs = 50;

  for (const size of sizes) {
    const bucket = bySize.get(size) ?? [];
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const sim = jaccard(bucket[i].calls, bucket[j].calls);
        if (sim >= threshold) {
          pairs.push({
            similarity: round(sim, 3),
            basis: "call_pattern",
            functions: [
              pickSummary(bucket[i]),
              pickSummary(bucket[j])
            ]
          });
          if (pairs.length >= maxPairs) {
            return pairs;
          }
        }
      }
    }
  }

  return pairs;
}

function findSimilarByAstStructure(fingerprints: FunctionFingerprint[]): SimilarFunctionGroup[] {
  const minSize = 12;
  const bucketSize = 10;
  const buckets = new Map<number, FunctionFingerprint[]>();
  for (const fp of fingerprints) {
    if (fp.size < minSize) {
      continue;
    }
    const key = Math.floor(fp.size / bucketSize);
    const entry = buckets.get(key) ?? [];
    entry.push(fp);
    buckets.set(key, entry);
  }

  const pairs: SimilarFunctionGroup[] = [];
  const seen = new Set<string>();
  const threshold = 0.8;
  const maxPairs = 50;
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);

  for (const key of keys) {
    const group = buckets.get(key) ?? [];
    const next = buckets.get(key + 1) ?? [];
    for (let i = 0; i < group.length; i += 1) {
      const base = group[i];
      const candidates = [...group.slice(i + 1), ...next];
      for (const candidate of candidates) {
        if (base.hash === candidate.hash) {
          continue;
        }
        const pairKey =
          base.id < candidate.id ? `${base.id}::${candidate.id}` : `${candidate.id}::${base.id}`;
        if (seen.has(pairKey)) {
          continue;
        }
        seen.add(pairKey);
        const sim = jaccard(base.kindSet, candidate.kindSet);
        if (sim >= threshold) {
          pairs.push({
            similarity: round(sim, 3),
            basis: "ast_structure",
            functions: [
              pickSummary(base),
              pickSummary(candidate)
            ]
          });
          if (pairs.length >= maxPairs) {
            return pairs;
          }
        }
      }
    }
  }

  return pairs;
}

function pickSummary(fp: FunctionFingerprint): SimilarFunctionGroup["functions"][number] {
  return {
    id: fp.id,
    name: fp.name,
    file: fp.file,
    language: fp.language
  };
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function extractTsFunctions(
  file: string,
  source: string,
  language: "ts" | "js"
): FunctionFingerprint[] {
  const kind = inferScriptKind(file);
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, kind);
  const functions: FunctionFingerprint[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.push(
        buildTsFingerprint(file, node.name.text, node.body, language)
      );
    }

    if (ts.isMethodDeclaration(node) && node.name && node.body) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : "method";
      const className =
        ts.isClassDeclaration(node.parent) && node.parent.name
          ? node.parent.name.text
          : "Class";
      functions.push(
        buildTsFingerprint(file, `${className}.${name}`, node.body, language)
      );
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        if (initializer.body) {
          functions.push(
            buildTsFingerprint(file, node.name.text, initializer.body, language)
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return functions;
}

function buildTsFingerprint(
  file: string,
  name: string,
  body: ts.Node,
  language: "ts" | "js"
): FunctionFingerprint {
  const tokens: string[] = [];
  const calls: string[] = [];

  const walk = (node: ts.Node): void => {
    tokens.push(normalizeTsKind(node));
    if (ts.isCallExpression(node)) {
      const callee = resolveTsCallee(node.expression);
      if (callee) {
        calls.push(callee);
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(body);
  const payload = tokens.join("|");
  const hash = crypto.createHash("sha1").update(payload).digest("hex");
  const kindSet = Array.from(new Set(tokens));
  const relative = file;
  return {
    id: `${relative}#${name}`,
    name,
    file: relative,
    language,
    size: tokens.length,
    hash,
    calls: Array.from(new Set(calls)),
    kindSet
  };
}

function normalizeTsKind(node: ts.Node): string {
  switch (node.kind) {
    case ts.SyntaxKind.Identifier:
      return "Identifier";
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
      return "Literal";
    default:
      return ts.SyntaxKind[node.kind] || "Node";
  }
}

function resolveTsCallee(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = resolveTsCallee(expr.expression);
    if (base) {
      return `${base}.${expr.name.text}`;
    }
    return expr.name.text;
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = resolveTsCallee(expr.expression);
    if (base) {
      return `${base}[]`;
    }
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return "this";
  }
  return null;
}

function extractPythonFunctions(file: string, source: string): FunctionFingerprint[] {
  const parser = new Parser();
  parser.setLanguage(Python);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return [];
  }
  const root = tree.rootNode;
  const functions: FunctionFingerprint[] = [];

  walk(root, (node) => {
    if (node.type === "function_definition") {
      if (!isTopLevel(node)) {
        return;
      }
      const nameNode = node.childForFieldName("name");
      const bodyNode = node.childForFieldName("body");
      if (!nameNode || !bodyNode) {
        return;
      }
      const name = nodeText(nameNode, source);
      functions.push(buildPythonFingerprint(file, name, bodyNode, source));
    }

    if (node.type === "class_definition") {
      if (!isTopLevel(node)) {
        return;
      }
      const classNameNode = node.childForFieldName("name");
      const bodyNode = node.childForFieldName("body");
      if (!classNameNode || !bodyNode) {
        return;
      }
      const className = nodeText(classNameNode, source);
      for (const child of bodyNode.namedChildren) {
        if (child.type !== "function_definition") {
          continue;
        }
        const methodNameNode = child.childForFieldName("name");
        const methodBody = child.childForFieldName("body");
        if (!methodNameNode || !methodBody) {
          continue;
        }
        const methodName = nodeText(methodNameNode, source);
        functions.push(buildPythonFingerprint(file, `${className}.${methodName}`, methodBody, source));
      }
    }
  });

  return functions;
}

function buildPythonFingerprint(
  file: string,
  name: string,
  body: Parser.SyntaxNode,
  source: string
): FunctionFingerprint {
  const tokens: string[] = [];
  const calls: string[] = [];

  walk(body, (node) => {
    tokens.push(normalizePythonNode(node, source));
    if (node.type === "call") {
      const callee = node.childForFieldName("function");
      if (callee) {
        const callName = exprName(callee, source);
        if (callName) {
          calls.push(callName);
        }
      }
    }
  });

  const hash = crypto.createHash("sha1").update(tokens.join("|")).digest("hex");
  const kindSet = Array.from(new Set(tokens));
  return {
    id: `${file}#${name}`,
    name,
    file,
    language: "py",
    size: tokens.length,
    hash,
    calls: Array.from(new Set(calls)),
    kindSet
  };
}

function normalizePythonNode(node: Parser.SyntaxNode, source: string): string {
  if (node.type === "identifier") {
    return "id";
  }
  if (
    node.type === "string" ||
    node.type === "integer" ||
    node.type === "float" ||
    node.type === "true" ||
    node.type === "false" ||
    node.type === "none"
  ) {
    return "lit";
  }
  if (node.type === "attribute") {
    return "attr";
  }
  return node.type;
}

function isTopLevel(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "module";
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function nodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function exprName(node: Parser.SyntaxNode, source: string): string | null {
  if (node.type === "identifier") {
    return nodeText(node, source);
  }
  if (node.type === "attribute") {
    const objectNode = node.childForFieldName("object");
    const attrNode = node.childForFieldName("attribute");
    const base = objectNode ? exprName(objectNode, source) : null;
    const attr = attrNode ? nodeText(attrNode, source) : null;
    if (base && attr) {
      return `${base}.${attr}`;
    }
    return attr ?? base;
  }
  return null;
}

function isTsLike(ext: string): boolean {
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts"
  ].includes(ext);
}

function inferScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") {
    return ts.ScriptKind.TSX;
  }
  if (ext === ".jsx") {
    return ts.ScriptKind.JSX;
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return ts.ScriptKind.JS;
  }
  if (ext === ".mts") {
    return ts.ScriptKind.TS;
  }
  if (ext === ".cts") {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.TS;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
