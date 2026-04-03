import path from "node:path";
import type { TestGapSummary, TestCoverageSummary } from "./types.js";

export function computeTestCoverage(files: string[]): TestGapSummary {
  const testFiles = new Set<string>();
  const sourceFiles = new Set<string>();

  for (const file of files) {
    const isTest =
      file.includes(".test.") ||
      file.includes(".spec.") ||
      file.includes("_test.") ||
      file.includes("test_") ||
      file.startsWith("tests/") ||
      file.includes("/tests/");

    if (isTest) {
      testFiles.add(file);
    } else {
      sourceFiles.add(file);
    }
  }

  const coverageMap: TestCoverageSummary[] = [];
  const coveredSourceFiles = new Set<string>();

  for (const testFile of testFiles) {
    const basename = path.basename(testFile);
    let potentialSourceName = basename
      .replace(/\.test\./, ".")
      .replace(/\.spec\./, ".")
      .replace(/_test\./, ".")
      .replace(/^test_/, "");

    // Search for an exact match in sourceFiles
    let exactMatch: string | null = null;
    let implicitMatch: string | null = null;

    for (const sourceFile of sourceFiles) {
      if (path.basename(sourceFile) === potentialSourceName) {
        // If they share exactly the same dirname logic, it's exact
        // Otherwise, it's an implicit match
        if (path.dirname(testFile).replace(/\/tests?(\/|$)/, "/") === path.dirname(sourceFile)) {
          exactMatch = sourceFile;
          break;
        } else {
          implicitMatch = sourceFile;
        }
      }
    }

    const match = exactMatch ?? implicitMatch;
    if (match) {
      coveredSourceFiles.add(match);
      coverageMap.push({
        test_file: testFile,
        source_file: match,
        match_type: exactMatch ? "exact" : "implicit"
      });
    } else {
      coverageMap.push({
        test_file: testFile,
        source_file: null,
        match_type: "none"
      });
    }
  }

  const untestedSourceFiles = Array.from(sourceFiles)
    .filter((file) => !coveredSourceFiles.has(file))
    .sort((a, b) => a.localeCompare(b));

  const testFilesMissingSource = coverageMap
    .filter((cov) => cov.match_type === "none")
    .map((cov) => cov.test_file)
    .sort((a, b) => a.localeCompare(b));

  coverageMap.sort((a, b) => a.test_file.localeCompare(b.test_file));

  return {
    untested_source_files: untestedSourceFiles,
    test_files_missing_source: testFilesMissingSource,
    coverage_map: coverageMap
  };
}
