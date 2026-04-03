import { describe, it, expect } from "vitest";
import { computeTestCoverage } from "../../src/extract/tests.js";

describe("computeTestCoverage", () => {
  it("matches .test.ts files to their source counterparts", () => {
    const result = computeTestCoverage([
      "src/config.ts",
      "src/config.test.ts",
    ]);
    expect(result.coverage_map.length).toBe(1);
    expect(result.coverage_map[0].source_file).toBe("src/config.ts");
    expect(result.coverage_map[0].match_type).toBe("exact");
  });

  it("matches .spec.ts files to source files", () => {
    const result = computeTestCoverage([
      "src/utils.ts",
      "src/utils.spec.ts",
    ]);
    expect(result.coverage_map[0].source_file).toBe("src/utils.ts");
  });

  it("matches _test.py (Python convention)", () => {
    const result = computeTestCoverage([
      "app/models.py",
      "app/models_test.py",
    ]);
    expect(result.coverage_map.length).toBe(1);
    expect(result.coverage_map[0].source_file).toBe("app/models.py");
  });

  it("reports untested source files", () => {
    const result = computeTestCoverage([
      "src/config.ts",
      "src/utils.ts",
      "src/config.test.ts",
    ]);
    expect(result.untested_source_files).toContain("src/utils.ts");
    expect(result.untested_source_files).not.toContain("src/config.ts");
  });

  it("reports test files without matching source", () => {
    const result = computeTestCoverage([
      "tests/integration.test.ts",
    ]);
    expect(result.test_files_missing_source).toContain("tests/integration.test.ts");
  });

  it("classifies files inside tests/ directories as test files", () => {
    const result = computeTestCoverage([
      "src/app.ts",
      "tests/app.test.ts",
    ]);
    expect(result.coverage_map.length).toBe(1);
    // It's a test file, not a source file
    expect(result.untested_source_files).not.toContain("tests/app.test.ts");
  });

  it("handles empty file list", () => {
    const result = computeTestCoverage([]);
    expect(result.untested_source_files).toEqual([]);
    expect(result.test_files_missing_source).toEqual([]);
    expect(result.coverage_map).toEqual([]);
  });

  it("sorts output deterministically", () => {
    const result = computeTestCoverage([
      "src/c.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.untested_source_files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});
