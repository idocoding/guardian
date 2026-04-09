/**
 * Lean4 / Mathlib adapter for guardian.
 *
 * Uses deterministic regex-based extraction (no tree-sitter-lean4 dependency).
 * Captures: theorems, lemmas, defs, structures, classes, instances, `sorry`
 * locations, tactic usage, and Mathlib import dependencies.
 *
 * Implements SpecGuardAdapter with `language: null` — runner.ts calls
 * extract() directly without a tree-sitter parse step.
 */

import type Parser from "tree-sitter";
import type {
  SpecGuardAdapter,
  EndpointExtraction,
  ModelExtraction,
  ComponentExtraction,
  TestExtraction,
  FunctionRecord,
  TheoremRecord,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Well-known Lean4 tactic names. Checked as whole words in the proof body.
 * Kept in alphabetical order for maintainability.
 */
const KNOWN_TACTICS: string[] = [
  "Abel",
  "aesop",
  "all_goals",
  "any_goals",
  "apply",
  "apply?",
  "assumption",
  "by_cases",
  "by_contra",
  "calc",
  "cases",
  "change",
  "clear",
  "congr",
  "constructor",
  "contrapose",
  "conv",
  "decide",
  "dsimp",
  "exact",
  "exact?",
  "ext",
  "field_simp",
  "fin_cases",
  "first",
  "funext",
  "gcongr",
  "group",
  "have",
  "induction",
  "interval_cases",
  "intro",
  "intros",
  "linarith",
  "linear_combination",
  "module_cast",
  "native_decide",
  "nlinarith",
  "norm_cast",
  "norm_num",
  "norm_num?",
  "nth_rw",
  "obtain",
  "omega",
  "polyrith",
  "positivity",
  "push_cast",
  "push_neg",
  "rcases",
  "refine",
  "rename",
  "repeat",
  "revert",
  "rfl",
  "ring",
  "rw",
  "rw?",
  "set",
  "show",
  "simp",
  "simp?",
  "skip",
  "split",
  "suffices",
  "swap",
  "symm",
  "tauto",
  "trans",
  "trivial",
  "try",
  "unfold",
  "use",
];

// ── Regex patterns ────────────────────────────────────────────────────────

/**
 * Matches theorem/lemma/def/abbrev declarations (including noncomputable variants).
 * Group 1: keyword (e.g. "theorem", "noncomputable def")
 * Group 2: declaration name
 */
const THEOREM_RE =
  /^(?:[ \t]*(?:@\[[^\]]*\][ \t]*\n?[ \t]*)*)(?:private[ \t]+|protected[ \t]+)?(?:(noncomputable[ \t]+def|noncomputable[ \t]+abbrev|theorem|lemma|def|abbrev|example))(?:[ \t]+([^\s(:{\[]+))?/gm;

/**
 * Matches structure/class/inductive/instance declarations.
 * Group 1: keyword, Group 2: name (optional for anonymous instances)
 */
const STRUCT_RE =
  /^(?:[ \t]*(?:@\[[^\]]*\][ \t]*\n?[ \t]*)*)(?:private[ \t]+|protected[ \t]+)?(structure|class|inductive|instance|mutual)(?:[ \t]+([^\s(:{\[]+))?/gm;

/** Matches import statements. Group 1: module path */
const IMPORT_RE = /^import[ \t]+([\w.]+)/gm;

/** Matches namespace declarations. Group 1: namespace name */
const NS_OPEN_RE = /^namespace[ \t]+([\w.]+)/gm;

/** Matches end-of-namespace. Group 1: namespace name */
const NS_END_RE = /^end[ \t]+([\w.]+)/gm;

/** `sorry` as a standalone term or tactic */
const SORRY_RE = /\bsorry\b/g;

/** `:=` with optional trailing whitespace — used in proof body and statement extraction */
const ASSIGN_RE = /:=\s*/g;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a sorted array of newline offsets for O(log n) line lookups.
 * Index i holds the character offset of the start of line i+1 (0-based array, 1-based lines).
 */
function buildLineIndex(source: string): number[] {
  const starts: number[] = [0]; // line 1 starts at offset 0
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for a character offset, using precomputed line index. */
function lineOfFast(lineIndex: number[], offset: number): number {
  let lo = 0, hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** Extract all Lean4 import paths from source. */
function extractImports(source: string): string[] {
  const imports: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

// ── Namespace event type ──────────────────────────────────────────────────

interface NsEvent {
  idx: number;
  name: string;
  kind: "open" | "end";
}

/**
 * Scan the entire source once and return a sorted list of namespace open/end
 * events. Pass this to activeNamespaceAtFast() — O(1) amortised per declaration
 * when declarations are processed left-to-right (which THEOREM_RE guarantees).
 */
function buildNsEvents(source: string): NsEvent[] {
  const events: NsEvent[] = [];
  let m: RegExpExecArray | null;

  NS_OPEN_RE.lastIndex = 0;
  while ((m = NS_OPEN_RE.exec(source)) !== null) {
    events.push({ idx: m.index, name: m[1], kind: "open" });
  }

  NS_END_RE.lastIndex = 0;
  while ((m = NS_END_RE.exec(source)) !== null) {
    events.push({ idx: m.index, name: m[1], kind: "end" });
  }

  return events.sort((a, b) => a.idx - b.idx);
}

/**
 * Return the active namespace at `offset` using precomputed events.
 * Call this in declaration order (ascending offset) and pass the same
 * `eventIdx` cursor — the cursor advances monotonically, making this O(n)
 * total across all declarations rather than O(n²).
 */
function activeNamespaceAtFast(
  events: NsEvent[],
  offset: number,
  cursor: { i: number },
  stack: string[]
): string {
  // Advance cursor through all events that precede `offset`
  while (cursor.i < events.length && events[cursor.i].idx < offset) {
    const ev = events[cursor.i++];
    if (ev.kind === "open") {
      stack.push(ev.name);
    } else {
      const idx = stack.lastIndexOf(ev.name);
      if (idx >= 0) stack.splice(idx, 1);
    }
  }
  return stack.join(".");
}

/**
 * Extract the proof/definition body that follows a declaration's `:=` (or `by`).
 * Works directly on `source` from `startOffset` to avoid repeated string slicing.
 * Returns the raw text of the body, capped at 4000 chars to limit memory use.
 */
function extractProofBody(source: string, startOffset: number): string {
  // Search for := starting at startOffset without slicing the full source
  ASSIGN_RE.lastIndex = startOffset;
  const assignMatch = ASSIGN_RE.exec(source);
  if (!assignMatch) return "";

  const bodyStart = assignMatch.index + assignMatch[0].length;
  const bodyText = source.slice(bodyStart, bodyStart + 4000);

  // Stop at the next top-level declaration (unindented keyword)
  const stopRe =
    /\n(?=(?:theorem|lemma|def|abbrev|noncomputable|structure|class|inductive|instance|example|namespace|end|#|import)\b)/;
  const stopIdx = bodyText.search(stopRe);
  return stopIdx >= 0 ? bodyText.slice(0, stopIdx) : bodyText;
}

/**
 * Single combined regex that matches any known tactic in one pass.
 * Tactics with `?` (apply?, exact?, etc.) need the `?` escaped in the regex.
 * Using a non-global RegExp for the initial "does body contain any tactic?" check,
 * then a global one for collecting all matches.
 */
const TACTIC_COMBINED_RE = new RegExp(
  `\\b(${KNOWN_TACTICS.map((t) => t.replace(/[?]/g, "\\?")).join("|")})\\b`,
  "g"
);

/** Extract which known tactics appear in a proof body — single-pass scan. */
function extractTactics(body: string): string[] {
  TACTIC_COMBINED_RE.lastIndex = 0;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = TACTIC_COMBINED_RE.exec(body)) !== null) {
    found.add(m[1]);
  }
  TACTIC_COMBINED_RE.lastIndex = 0;
  return [...found].sort();
}

/** Return true if the body text contains `sorry`. Resets lastIndex after test. */
function containsSorry(body: string): boolean {
  SORRY_RE.lastIndex = 0;
  const result = SORRY_RE.test(body);
  SORRY_RE.lastIndex = 0;
  return result;
}

/** Estimate end line from start line + body newlines. */
function estimateEndLine(startLine: number, body: string): number {
  return startLine + (body.split("\n").length - 1);
}

// ── Adapter ───────────────────────────────────────────────────────────────

export const Lean4Adapter: SpecGuardAdapter = {
  name: "lean4",
  /**
   * No tree-sitter grammar — runner.ts calls extract() directly when
   * `language` is falsy. All extraction is done via regex on the source text.
   */
  language: null as any,
  fileExtensions: [".lean"],
  queries: {},

  extract(
    file: string,
    source: string,
    _root: Parser.SyntaxNode
  ): {
    endpoints: EndpointExtraction[];
    models: ModelExtraction[];
    components: ComponentExtraction[];
    tests: TestExtraction[];
    functions: FunctionRecord[];
  } {
    const endpoints: EndpointExtraction[] = [];
    const models: ModelExtraction[] = [];
    const components: ComponentExtraction[] = [];
    const tests: TestExtraction[] = [];
    const functions: FunctionRecord[] = [];

    const imports = extractImports(source);
    const mathlibDeps = imports.filter((i) => i.startsWith("Mathlib"));

    // ── Precompute indices — O(n) each, amortises all per-declaration lookups ──
    const lineIndex = buildLineIndex(source);
    const nsEvents = buildNsEvents(source);
    const nsCursor = { i: 0 };
    const nsStack: string[] = [];

    // ── Theorems / Lemmas / Defs ──────────────────────────────────────────

    THEOREM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = THEOREM_RE.exec(source)) !== null) {
      const rawKind = m[1]?.trim().replace(/\s+/g, "_") ?? "def";
      const name = m[2] ?? "(anonymous)";
      const offset = m.index;
      const startLine = lineOfFast(lineIndex, offset);
      const namespace = activeNamespaceAtFast(nsEvents, offset, nsCursor, nsStack);

      // Extract statement: text between end of match and :=
      const matchEnd = offset + m[0].length;
      ASSIGN_RE.lastIndex = matchEnd;
      const stmtMatch = ASSIGN_RE.exec(source);
      const statement = (stmtMatch
        ? source.slice(matchEnd, stmtMatch.index)
        : ""
      ).trim().slice(0, 500);

      const body = extractProofBody(source, offset + m[0].length);
      const hasSorry = containsSorry(body);
      const tactics = extractTactics(body);
      const endLine = estimateEndLine(startLine, body);

      // Normalise kind to the TheoremRecord union
      type TheoremKind = TheoremRecord["kind"];
      const kindMap: Record<string, TheoremKind> = {
        theorem: "theorem",
        lemma: "lemma",
        def: "def",
        noncomputable_def: "noncomputable_def",
        abbrev: "abbrev",
        noncomputable_abbrev: "abbrev",
        example: "example",
        inductive: "inductive",
      };
      const kind: TheoremKind = kindMap[rawKind] ?? "def";

      const record: TheoremRecord = {
        id: `${file}#${name}:${startLine}`,
        name,
        file,
        lines: [startLine, endLine],
        calls: [],
        // Push domain concepts into stringLiterals so the generic literal_index
        // can surface them — no language knowledge needed outside the adapter.
        stringLiterals: [
          ...(hasSorry ? ["sorry"] : []),          // `guardian search --query sorry`
          ...tactics.map((t) => `tactic:${t}`),     // `guardian search --query simp`
        ],
        regexPatterns: [],
        isAsync: false,
        language: "lean4",
        kind,
        namespace,
        statement,
        hasSorry,
        tactics,
        mathlibDeps,
      };

      functions.push(record);
    }

    // ── Structures / Classes / Instances ─────────────────────────────────
    // Fresh cursor for STRUCT_RE pass — offsets may interleave with THEOREM_RE
    const nsCursor2 = { i: 0 };
    const nsStack2: string[] = [];

    STRUCT_RE.lastIndex = 0;
    while ((m = STRUCT_RE.exec(source)) !== null) {
      const structKind = m[1];
      const name = m[2];
      if (!name) continue; // anonymous instance — skip for models

      models.push({
        name,
        file,
        framework: structKind,
        fields: [],
        relationships: [],
      });

      // Also emit a FunctionRecord so it appears in function search
      const startLine = lineOfFast(lineIndex, m.index);
      const kindMap: Record<string, TheoremRecord["kind"]> = {
        structure: "structure",
        class: "class",
        instance: "instance",
        inductive: "inductive",
        mutual: "def",
      };
      const record: TheoremRecord = {
        id: `${file}#${name}:${startLine}`,
        name,
        file,
        lines: [startLine, startLine],
        calls: [],
        stringLiterals: [],
        regexPatterns: [],
        isAsync: false,
        language: "lean4",
        kind: kindMap[structKind] ?? "structure",
        namespace: activeNamespaceAtFast(nsEvents, m.index, nsCursor2, nsStack2),
        statement: "",
        hasSorry: false,
        tactics: [],
        mathlibDeps,
      };
      functions.push(record);
    }

    return { endpoints, models, components, tests, functions };
  },
};
