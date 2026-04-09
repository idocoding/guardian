import { describe, it, expect } from "vitest";
import { buildFunctionIntelligence } from "../../src/extract/function-intel.js";
import type { FunctionRecord } from "../../src/adapters/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const tsFunc: FunctionRecord = {
  id: "src/engine.ts#processStream:10",
  name: "processStream",
  file: "src/engine.ts",
  lines: [10, 40],
  calls: ["getDisplay", "splitSentences", "re.sub"],
  stringLiterals: ["<thought>.*?</thought>", "data: "],
  regexPatterns: ["<thought>.*?</thought>"],
  isAsync: true,
  language: "typescript",
};

const tsHelper: FunctionRecord = {
  id: "src/engine.ts#getDisplay:42",
  name: "getDisplay",
  file: "src/engine.ts",
  lines: [42, 48],
  calls: ["re.sub"],
  stringLiterals: ["<thought>.*?</thought>"],
  regexPatterns: ["<thought>.*?</thought>"],
  isAsync: false,
  language: "typescript",
};

const pyFunc: FunctionRecord = {
  id: "backend/engine.py#generate_opening:55",
  name: "generate_opening",
  file: "backend/engine.py",
  lines: [55, 80],
  calls: ["re.sub", "self.llm.chat.completions.create"],
  stringLiterals: ["<thought>.*?</thought>", "Greet the child"],
  regexPatterns: ["<thought>.*?</thought>"],
  isAsync: true,
  language: "python",
};

const unrelatedFunc: FunctionRecord = {
  id: "src/util.ts#formatDate:5",
  name: "formatDate",
  file: "src/util.ts",
  lines: [5, 10],
  calls: ["Date.prototype.toISOString"],
  stringLiterals: ["YYYY-MM-DD"],
  regexPatterns: [],
  isAsync: false,
  language: "typescript",
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildFunctionIntelligence", () => {
  it("returns correct total_functions count", () => {
    const intel = buildFunctionIntelligence([tsFunc, tsHelper, pyFunc]);
    expect(intel.total_functions).toBe(3);
  });

  it("preserves all FunctionRecord entries in functions array", () => {
    const intel = buildFunctionIntelligence([tsFunc, tsHelper]);
    expect(intel.functions).toHaveLength(2);
    expect(intel.functions.map((f) => f.name)).toContain("processStream");
    expect(intel.functions.map((f) => f.name)).toContain("getDisplay");
  });

  it("sets version and generated_at", () => {
    const intel = buildFunctionIntelligence([tsFunc]);
    expect(intel.version).toBe("0.1");
    expect(intel.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  describe("call_graph", () => {
    it("records outgoing calls for each function", () => {
      const intel = buildFunctionIntelligence([tsFunc, tsHelper]);
      expect(intel.call_graph["processStream"].calls).toContain("getDisplay");
      expect(intel.call_graph["processStream"].calls).toContain("splitSentences");
    });

    it("builds called_by inverse index", () => {
      const intel = buildFunctionIntelligence([tsFunc, tsHelper]);
      expect(intel.call_graph["getDisplay"].called_by).toContain("processStream");
    });

    it("deduplicates outgoing calls", () => {
      const dupFn: FunctionRecord = {
        ...tsFunc,
        calls: ["foo", "foo", "bar"],
      };
      const intel = buildFunctionIntelligence([dupFn]);
      expect(intel.call_graph["dupFunc"] ?? intel.call_graph[dupFn.name]).toBeDefined();
      const calls = intel.call_graph[dupFn.name].calls;
      expect(calls.filter((c) => c === "foo")).toHaveLength(1);
    });

    it("handles functions with no calls", () => {
      const silent: FunctionRecord = { ...unrelatedFunc, calls: [] };
      const intel = buildFunctionIntelligence([silent]);
      expect(intel.call_graph["formatDate"].calls).toEqual([]);
      expect(intel.call_graph["formatDate"].called_by).toEqual([]);
    });
  });

  describe("literal_index", () => {
    it("indexes string literals by token", () => {
      const intel = buildFunctionIntelligence([tsFunc]);
      // "thought" is a token inside "<thought>.*?</thought>"
      expect(intel.literal_index["thought"]).toBeDefined();
      const hit = intel.literal_index["thought"]?.find(
        (h) => h.function === "processStream"
      );
      expect(hit).toBeDefined();
      expect(hit?.file).toBe("src/engine.ts");
    });

    it("indexes regex patterns by token", () => {
      const intel = buildFunctionIntelligence([tsHelper]);
      expect(intel.literal_index["thought"]).toBeDefined();
      const hit = intel.literal_index["thought"]?.find(
        (h) => h.function === "getDisplay"
      );
      expect(hit).toBeDefined();
    });

    it("returns hits across multiple files and languages", () => {
      const intel = buildFunctionIntelligence([tsFunc, tsHelper, pyFunc]);
      const hits = intel.literal_index["thought"] ?? [];
      const files = hits.map((h) => h.file);
      expect(files).toContain("src/engine.ts");
      expect(files).toContain("backend/engine.py");
    });

    it("does not produce duplicate hits for the same function", () => {
      const fn: FunctionRecord = {
        ...tsFunc,
        // "thought" appears in both stringLiterals and regexPatterns
        stringLiterals: ["thought"],
        regexPatterns: ["thought"],
      };
      const intel = buildFunctionIntelligence([fn]);
      const hits = (intel.literal_index["thought"] ?? []).filter(
        (h) => h.function === fn.name
      );
      expect(hits.length).toBe(1);
    });

    it("does not index tokens shorter than 3 chars", () => {
      const fn: FunctionRecord = { ...tsFunc, stringLiterals: ["ab", "xy"] };
      const intel = buildFunctionIntelligence([fn]);
      expect(intel.literal_index["ab"]).toBeUndefined();
      expect(intel.literal_index["xy"]).toBeUndefined();
    });

    it("returns empty literal_index for functions with no literals", () => {
      const fn: FunctionRecord = {
        ...tsFunc,
        stringLiterals: [],
        regexPatterns: [],
      };
      const intel = buildFunctionIntelligence([fn]);
      // call tokens from calls field are not indexed (only literals/patterns)
      expect(Object.keys(intel.literal_index).length).toBe(0);
    });

    it("indexes full literal as a key when it is at least 3 chars", () => {
      const fn: FunctionRecord = {
        ...tsFunc,
        stringLiterals: ["hello world"],
        regexPatterns: [],
      };
      const intel = buildFunctionIntelligence([fn]);
      // "hello world" (truncated ≤100) should be a key
      expect(intel.literal_index["hello world"]).toBeDefined();
      // individual tokens "hello" and "world" should also be indexed
      expect(intel.literal_index["hello"]).toBeDefined();
      expect(intel.literal_index["world"]).toBeDefined();
    });
  });

  it("handles an empty function list without throwing", () => {
    const intel = buildFunctionIntelligence([]);
    expect(intel.total_functions).toBe(0);
    expect(intel.functions).toEqual([]);
    expect(intel.call_graph).toEqual({});
    expect(intel.literal_index).toEqual({});
  });
});
