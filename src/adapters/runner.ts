import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction,
  FunctionRecord,
} from "./types.js";

export function runAdapter(
  adapter: SpecGuardAdapter,
  file: string,
  source: string
): {
  endpoints: EndpointExtraction[];
  models: ModelExtraction[];
  components: ComponentExtraction[];
  tests: TestExtraction[];
  functions: FunctionRecord[];
} {
  // Text-based adapters (e.g. Lean4) set language to null and rely entirely on
  // their extract() implementation — no tree-sitter parse step needed.
  if (!adapter.language) {
    if (adapter.extract) {
      const result = adapter.extract(file, source, null as any);
      return {
        endpoints: result.endpoints,
        models: result.models,
        components: result.components,
        tests: result.tests,
        functions: result.functions ?? [],
      };
    }
    return { endpoints: [], models: [], components: [], tests: [], functions: [] };
  }

  // tree-sitter's native binding throws "Invalid argument" for files with high AST
  // complexity — this can happen well below 1 MB for deeply-nested source files.
  // Parse defensively: try the whole file first, then fall back to chunked parsing
  // if tree-sitter throws.  Chunks are split at top-level definition boundaries so
  // each piece is syntactically self-contained.
  if (source.length > 1_000_000) {
    return { endpoints: [], models: [], components: [], tests: [], functions: [] };
  }

  const parser = new Parser();
  parser.setLanguage(adapter.language);

  let tree: ReturnType<typeof parser.parse>;
  try {
    tree = parser.parse(source);
  } catch {
    // File is too complex for a single parse — split at top-level definitions and
    // merge results.  Each chunk is a run of lines from one top-level def/class to
    // the next, so it is syntactically valid on its own.
    return runAdapterChunked(adapter, file, source, parser);
  }

  if (adapter.extract) {
    const result = adapter.extract(file, source, tree.rootNode);
    return {
      endpoints: result.endpoints,
      models: result.models,
      components: result.components,
      tests: result.tests,
      functions: result.functions ?? [],
    };
  }

  const endpoints: EndpointExtraction[] = [];
  const models: ModelExtraction[] = [];
  const components: ComponentExtraction[] = [];
  const tests: TestExtraction[] = [];

  if (adapter.queries.endpoints) {
    const query = new Parser.Query(adapter.language as any, adapter.queries.endpoints);
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
      let method = "GET";
      let path = "";
      let handler = "";
      for (const capture of match.captures) {
        const text = source.substring(capture.node.startIndex, capture.node.endIndex);
        if (capture.name === "method") method = text.replace(/['"]/g, "");
        if (capture.name === "path") path = text.replace(/['"]/g, "");
        if (capture.name === "handler") handler = text;
      }
      if (handler) {
        endpoints.push({ file, method, path, handler, service_calls: [] });
      }
    }
  }

  if (adapter.queries.models) {
    const query = new Parser.Query(adapter.language as any, adapter.queries.models);
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
      let name = "";
      for (const capture of match.captures) {
        if (capture.name === "name") {
          name = source.substring(capture.node.startIndex, capture.node.endIndex);
        }
      }
      if (name) {
        models.push({ name, file, framework: "unknown", fields: [], relationships: [] });
      }
    }
  }

  if (adapter.queries.tests) {
    const query = new Parser.Query(adapter.language as any, adapter.queries.tests);
    const matches = query.matches(tree.rootNode);
    for (const match of matches) {
      let test_name = "";
      let suite_name: string | null = null;
      for (const capture of match.captures) {
        if (capture.name === "test_name") {
          test_name = source.substring(capture.node.startIndex, capture.node.endIndex).replace(/['"]/g, "");
        }
        if (capture.name === "suite_name") {
          suite_name = source.substring(capture.node.startIndex, capture.node.endIndex).replace(/['"]/g, "");
        }
      }
      if (test_name) {
        tests.push({ file, test_name, suite_name });
      }
    }
  }

  return { endpoints, models, components, tests, functions: [] };
}

/**
 * Fallback for files that tree-sitter can't parse as a whole.
 * Splits source at top-level definition boundaries (lines starting with
 * "def ", "class ", "async def ", "fn ", "func ", "public class ", etc.),
 * parses each chunk independently with the same adapter, and merges results.
 */
function runAdapterChunked(
  adapter: SpecGuardAdapter,
  file: string,
  source: string,
  parser: Parser,
): ReturnType<typeof runAdapter> {
  const merged: ReturnType<typeof runAdapter> = {
    endpoints: [], models: [], components: [], tests: [], functions: [],
  };

  if (!adapter.extract) return merged;

  // Split at lines that start a new top-level definition.
  // Pattern covers Python, Go, Rust, JS/TS, Java, C#.
  const TOP_DEF = /^(?:(?:pub(?:\s+(?:unsafe\s+)?)?|private|protected|public|static|async|export\s+(?:default\s+)?|abstract\s+)*(?:def |class |fn |func |function |interface |struct |enum |impl |type ))/;

  const lines = source.split("\n");
  const splitPoints: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (TOP_DEF.test(lines[i])) splitPoints.push(i);
  }
  splitPoints.push(lines.length);

  // Group split points into chunks of up to ~25 KB to stay within parser limits.
  const CHUNK_BYTES = 25_000;
  let chunkBytes = 0;
  let chunkLines: string[] = [];

  function flushChunk() {
    if (chunkLines.length === 0) return;
    const chunk = chunkLines.join("\n");
    try {
      const tree = parser.parse(chunk);
      const result = adapter.extract!(file, chunk, tree.rootNode);
      merged.endpoints.push(...result.endpoints);
      merged.models.push(...result.models);
      merged.components.push(...result.components);
      merged.tests.push(...result.tests);
      merged.functions.push(...(result.functions ?? []));
    } catch {
      // skip unparseable chunk
    }
    chunkLines = [];
    chunkBytes = 0;
  }

  for (let s = 0; s < splitPoints.length - 1; s++) {
    const segLines = lines.slice(splitPoints[s], splitPoints[s + 1]);
    const segText = segLines.join("\n");
    if (chunkBytes + segText.length > CHUNK_BYTES && chunkLines.length > 0) {
      flushChunk();
    }
    chunkLines.push(...segLines);
    chunkBytes += segText.length;
  }
  flushChunk();

  return merged;
}
