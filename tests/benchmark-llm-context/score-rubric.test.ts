import { describe, it, expect } from "vitest";
import { scoreRubric } from "../../scripts/benchmark-llm-context/runner.js";

describe("scoreRubric", () => {
  it("passes allOf", () => {
    const r = scoreRubric("Backend: . Frontend: ./vscode-extension", {
      allOf: ["backend", "./vscode-extension"]
    });
    expect(r.pass).toBe(true);
  });

  it("fails missing allOf", () => {
    const r = scoreRubric("only backend mentioned", { allOf: ["backend", "./vscode-extension"] });
    expect(r.pass).toBe(false);
  });

  it("passes anyOf", () => {
    expect(scoreRubric("use types.ts file", { anyOf: ["types.ts", "foo"] }).pass).toBe(true);
  });

  it("fails noneOf", () => {
    const r = scoreRubric("I don't know the answer", { anyOf: ["x"], noneOf: ["don't know"] });
    expect(r.pass).toBe(false);
  });
});
