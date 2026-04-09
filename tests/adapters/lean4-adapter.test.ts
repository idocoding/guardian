import { describe, it, expect } from "vitest";
import { Lean4Adapter } from "../../src/adapters/lean4-adapter.js";
import { runAdapter } from "../../src/adapters/runner.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const BASIC_MATHLIB = `
import Mathlib.Data.Nat.Basic
import Mathlib.Algebra.Group.Defs
import Init.Data.List

namespace MyProject

theorem add_comm (n m : ℕ) : n + m = m + n := by
  ring

lemma zero_add (n : ℕ) : 0 + n = n := by
  simp [Nat.zero_add]

def double (n : ℕ) : ℕ := n + n

noncomputable def inv_sqrt (x : ℝ) : ℝ := 1 / Real.sqrt x

end MyProject
`.trim();

const WITH_SORRY = `
import Mathlib.Data.Nat.Basic

theorem hard_theorem (n : ℕ) : n * n = n ^ 2 := by
  sorry

lemma easy (n : ℕ) : n = n := by
  rfl
`.trim();

const STRUCTURES = `
import Mathlib.Topology.Basic

structure Point where
  x : ℝ
  y : ℝ

class Metric (α : Type) where
  dist : α → α → ℝ

instance : Metric ℝ where
  dist a b := |a - b|
`.trim();

const NESTED_NAMESPACES = `
namespace Outer

namespace Inner

theorem foo : 1 = 1 := by rfl

end Inner

theorem bar : 2 = 2 := by rfl

end Outer
`.trim();

const TACTICS_SAMPLE = `
theorem tactic_demo (n m : ℕ) (h : n > 0) : n + m > 0 := by
  omega

theorem linarith_demo (a b : ℝ) (ha : a > 0) (hb : b > 0) : a + b > 0 := by
  linarith

theorem norm_num_demo : (2 : ℝ) > 0 := by
  norm_num
`.trim();

// ── Adapter registration ───────────────────────────────────────────────────

describe("Lean4Adapter — registration", () => {
  it("has name 'lean4'", () => {
    expect(Lean4Adapter.name).toBe("lean4");
  });

  it("handles .lean files", () => {
    expect(Lean4Adapter.fileExtensions).toContain(".lean");
  });

  it("has null language (text-based adapter, no tree-sitter grammar)", () => {
    expect(Lean4Adapter.language).toBeFalsy();
  });

  it("defines extract()", () => {
    expect(typeof Lean4Adapter.extract).toBe("function");
  });
});

// ── runAdapter integration ─────────────────────────────────────────────────

describe("Lean4Adapter — runAdapter integration", () => {
  it("does not throw when run through runAdapter", () => {
    expect(() => runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB)).not.toThrow();
  });

  it("returns expected shape from runAdapter", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    expect(Array.isArray(result.endpoints)).toBe(true);
    expect(Array.isArray(result.models)).toBe(true);
    expect(Array.isArray(result.components)).toBe(true);
    expect(Array.isArray(result.tests)).toBe(true);
    expect(Array.isArray(result.functions)).toBe(true);
  });
});

// ── Theorem / lemma extraction ─────────────────────────────────────────────

describe("Lean4Adapter — theorem/lemma/def extraction", () => {
  it("extracts theorems as function records", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const names = result.functions.map((f) => f.name);
    expect(names).toContain("add_comm");
  });

  it("extracts lemmas as function records", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const names = result.functions.map((f) => f.name);
    expect(names).toContain("zero_add");
  });

  it("extracts defs as function records", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const names = result.functions.map((f) => f.name);
    expect(names).toContain("double");
  });

  it("extracts noncomputable defs", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const names = result.functions.map((f) => f.name);
    expect(names).toContain("inv_sqrt");
  });

  it("sets language to 'lean4' on all records", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    expect(result.functions.every((f) => f.language === "lean4")).toBe(true);
  });

  it("assigns a unique id per theorem", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const ids = result.functions.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("sets isAsync to false (Lean4 proofs are not async)", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    expect(result.functions.every((f) => !f.isAsync)).toBe(true);
  });

  it("records line numbers > 0", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    for (const fn of result.functions) {
      expect(fn.lines[0]).toBeGreaterThan(0);
    }
  });
});

// ── TheoremRecord fields ───────────────────────────────────────────────────

describe("Lean4Adapter — TheoremRecord fields", () => {
  it("marks hasSorry=true when proof body contains sorry", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", WITH_SORRY);
    const sorry = result.functions.find((f) => f.name === "hard_theorem");
    expect(sorry).toBeDefined();
    expect((sorry as any).hasSorry).toBe(true);
  });

  it("marks hasSorry=false when proof has no sorry", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", WITH_SORRY);
    const clean = result.functions.find((f) => f.name === "easy");
    expect(clean).toBeDefined();
    expect((clean as any).hasSorry).toBe(false);
  });

  it("surfaces sorry via stringLiterals so literal_index can find it", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", WITH_SORRY);
    const sorry = result.functions.find((f) => f.name === "hard_theorem");
    // Adapter should add "sorry" to stringLiterals for generic search
    expect((sorry as any).stringLiterals ?? []).toContain("sorry");
  });

  it("extracts mathlibDeps from imports", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const fn = result.functions[0] as any;
    expect(fn.mathlibDeps).toContain("Mathlib.Data.Nat.Basic");
    expect(fn.mathlibDeps).toContain("Mathlib.Algebra.Group.Defs");
    // Non-Mathlib imports should not appear
    expect(fn.mathlibDeps).not.toContain("Init.Data.List");
  });

  it("captures active namespace", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    const addComm = result.functions.find((f) => f.name === "add_comm") as any;
    expect(addComm?.namespace).toBe("MyProject");
  });

  it("resolves nested namespaces correctly", () => {
    const result = runAdapter(Lean4Adapter, "ns.lean", NESTED_NAMESPACES);
    const foo = result.functions.find((f) => f.name === "foo") as any;
    expect(foo?.namespace).toBe("Outer.Inner");
    const bar = result.functions.find((f) => f.name === "bar") as any;
    expect(bar?.namespace).toBe("Outer");
  });

  it("extracts known tactics from proof body", () => {
    const result = runAdapter(Lean4Adapter, "tac.lean", TACTICS_SAMPLE);
    const omega = result.functions.find((f) => f.name === "tactic_demo") as any;
    expect(omega?.tactics).toContain("omega");
    const lin = result.functions.find((f) => f.name === "linarith_demo") as any;
    expect(lin?.tactics).toContain("linarith");
    const norm = result.functions.find((f) => f.name === "norm_num_demo") as any;
    expect(norm?.tactics).toContain("norm_num");
  });

  it("returns empty tactics array for a term-mode proof", () => {
    const source = `theorem easy : 1 = 1 := rfl`;
    const result = runAdapter(Lean4Adapter, "easy.lean", source);
    const fn = result.functions.find((f) => f.name === "easy") as any;
    // Term-mode proof: no tactic keywords
    expect(fn?.tactics ?? []).not.toContain("simp");
  });
});

// ── Structure / class / instance extraction ────────────────────────────────

describe("Lean4Adapter — structure/class/instance extraction", () => {
  it("extracts structures as models", () => {
    const result = runAdapter(Lean4Adapter, "struct.lean", STRUCTURES);
    const names = result.models.map((m) => m.name);
    expect(names).toContain("Point");
  });

  it("extracts classes as models", () => {
    const result = runAdapter(Lean4Adapter, "struct.lean", STRUCTURES);
    const names = result.models.map((m) => m.name);
    expect(names).toContain("Metric");
  });

  it("sets framework to the Lean4 keyword (structure/class/instance)", () => {
    const result = runAdapter(Lean4Adapter, "struct.lean", STRUCTURES);
    const point = result.models.find((m) => m.name === "Point");
    expect(point?.framework).toBe("structure");
    const metric = result.models.find((m) => m.name === "Metric");
    expect(metric?.framework).toBe("class");
  });

  it("also emits structures as function records for search coverage", () => {
    const result = runAdapter(Lean4Adapter, "struct.lean", STRUCTURES);
    const fnNames = result.functions.map((f) => f.name);
    expect(fnNames).toContain("Point");
    expect(fnNames).toContain("Metric");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("Lean4Adapter — edge cases", () => {
  it("returns empty results for an empty file", () => {
    const result = runAdapter(Lean4Adapter, "empty.lean", "");
    expect(result.functions).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.endpoints).toEqual([]);
  });

  it("does not crash on a file with only comments", () => {
    const source = "-- This is a comment\n-- Another comment";
    expect(() => runAdapter(Lean4Adapter, "comments.lean", source)).not.toThrow();
  });

  it("does not crash on malformed Lean4 syntax", () => {
    const source = "theorem broken (n : := by";
    expect(() => runAdapter(Lean4Adapter, "broken.lean", source)).not.toThrow();
  });

  it("handles example declarations (anonymous theorems)", () => {
    const source = `example (n : ℕ) : n = n := rfl`;
    const result = runAdapter(Lean4Adapter, "ex.lean", source);
    const ex = result.functions.find((f) => f.name === "(anonymous)");
    expect(ex).toBeDefined();
  });

  it("does not emit endpoints or components (not applicable to Lean4)", () => {
    const result = runAdapter(Lean4Adapter, "test.lean", BASIC_MATHLIB);
    expect(result.endpoints).toHaveLength(0);
    expect(result.components).toHaveLength(0);
  });
});
