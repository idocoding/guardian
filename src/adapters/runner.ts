import Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction
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
} {
  const parser = new Parser();
  parser.setLanguage(adapter.language);
  const tree = parser.parse(source);
  
  if (adapter.extract) {
    return adapter.extract(file, source, tree.rootNode);
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

  return { endpoints, models, components, tests };
}
