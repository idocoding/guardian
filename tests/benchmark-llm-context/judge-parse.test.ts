import { describe, it, expect } from "vitest";
import { parseJudgeJson } from "../../scripts/benchmark-llm-context/judge.js";

describe("parseJudgeJson", () => {
  it("parses bare JSON", () => {
    const r = parseJudgeJson(`{"pass": true, "confidence": 0.9, "reason": "grounded"}`);
    expect(r?.pass).toBe(true);
    expect(r?.confidence).toBe(0.9);
  });

  it("extracts from surrounding text", () => {
    const r = parseJudgeJson(`Here: {"pass": false, "confidence": 0.2, "reason": "x"}`);
    expect(r?.pass).toBe(false);
  });
});
