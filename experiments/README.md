# Guardian Agent-in-Loop Experiments

Two experiments that together produce publishable evidence for Guardian's value
as a codebase orientation tool for LLM agents.

## Experiment 1 — Navigation Quality (offline, done)

Already complete: Guardian-Bench 4-metric suite.
Results: F1@5=38.6%, any-hit=93.5%, recall@5=77.4%, context coverage=100%.
Run: `guardian benchmark --tasks tests/benchmark/multi-codebase-tasks.jsonl`

---

## Experiment 2 — Agent-in-Loop: Does orientation improve navigation accuracy?

### Research question
Does access to `guardian_search` + `guardian_orient` help an LLM agent correctly
identify the files and symbols needed to complete a task, compared to raw file
exploration?

### Design

**Two conditions per task:**

| Condition | Tools available |
|-----------|----------------|
| **Baseline** | `list_dir`, `read_file` |
| **Guardian** | `list_dir`, `read_file`, `guardian_search`, `guardian_orient` |

**Model:** gemma4:latest (8B, local via ollama — fully reproducible, no API cost)

**Tasks:** 31 tasks from `tests/benchmark/multi-codebase-tasks.jsonl`
Each task gives the agent:
- A natural language task description (the `description` field)
- The repo root directory
- Tools (condition-dependent)
- A stop condition: declare found files + symbols

**What the agent is asked to do:**
> "You are navigating a codebase. Your task: {description}. Find the files and
> symbols that implement this. When confident, call `declare_answer(files, symbols)`.
> Do not write any code."

This is a **navigation-only task** — no code execution needed, making it safe
to run locally and easy to evaluate objectively against ground truth.

### Metrics per task

| Metric | Definition |
|--------|-----------|
| `files_hit@k` | Ground truth files found in declared answer |
| `symbols_hit@k` | Ground truth symbols found in declared answer |
| `tool_calls` | Total tool invocations before declare_answer |
| `tokens_in` | Total input tokens consumed |
| `tokens_out` | Total output tokens generated |
| `turns` | Number of agent turns |
| `first_hit_turn` | Turn at which first correct file was found |
| `declared_correctly` | Boolean: ≥1 correct file in declared answer |

### Aggregate comparison

- Mean files_hit: Guardian vs Baseline
- Mean turns to first hit: Guardian vs Baseline
- Mean total tokens: Guardian vs Baseline (the efficiency claim)
- Pass rate (declared_correctly): Guardian vs Baseline

### Expected outputs

Papers cite this as: "Using guardian_search, agents found the correct file in
X fewer turns and Y% fewer tokens compared to raw file exploration, with Z%
higher declaration accuracy."

---

## Experiment 3 — Token Efficiency: Context window impact at scale

### Research question
At what codebase size does guardian's token compression become critical — i.e.,
at what point does raw file exploration exhaust the context window before finding
the answer?

### Design

**Synthetic scale ladder:**
Test the same navigation task against repos of increasing size:
- Small: ~20 files (test-fixtures)
- Medium: ~100 files (guardian self)
- Large: ~500 files (ghostwriter, yowi_app)
- Very large: ~2000+ files (fastapi)

**For each scale point:**
1. Measure how many tokens raw exploration consumes before finding the target
2. Measure how many tokens guardian orientation consumes
3. Record whether gemma4's 128K context window would be exhausted

**Key comparison:**
At what file count does the Baseline agent hit context limits before finding
the answer? Guardian's compression advantage grows non-linearly with codebase size.

### Metrics

- `raw_orient_tokens(n)`: tokens to find target file via list_dir + read_file at scale n
- `guardian_orient_tokens(n)`: tokens for guardian_search + guardian_orient at scale n
- `compression_ratio(n)`: raw/guardian at each scale point
- `context_exhaustion_threshold`: file count at which raw exploration fails

---

## Implementation Plan

### Step 1: Agent harness (`experiments/agent_harness.py`)

```
AgentHarness(
  model="gemma4:latest",          # ollama model
  condition="baseline|guardian",  # which tools
  task=BenchmarkTask,             # from multi-codebase-tasks.jsonl
  repo_root=str,                  # absolute path to repo
  specs_dir=str,                  # path to .specs for guardian condition
  max_turns=15,                   # prevent infinite loops
  max_tokens=60_000               # context budget
)
```

Tools available in **baseline** condition:
- `list_dir(path)` → directory listing
- `read_file(path)` → file contents (truncated at 3000 chars)

Tools added in **guardian** condition:
- `guardian_search(query)` → calls `node dist/cli.js search --query`
- `guardian_orient()` → returns architecture-context.md guardian block

Stop tool (both conditions):
- `declare_answer(files: list[str], symbols: list[str])` → terminates episode

### Step 2: Task runner (`experiments/run_experiment.py`)

```
python experiments/run_experiment.py \
  --tasks tests/benchmark/multi-codebase-tasks.jsonl \
  --condition baseline          # or guardian \
  --model gemma4:latest \
  --output experiments/results/baseline.jsonl
```

Runs all 31 tasks, writes per-task results. Takes ~2-4 hours on a Mac M-series
for 31 tasks × 2 conditions with gemma4.

### Step 3: Analysis (`experiments/analyze.py`)

Loads both result files, computes all metrics, outputs:
- Paper-ready table (LaTeX + markdown)
- Per-task breakdown CSV
- Statistical significance (Wilcoxon signed-rank on paired tasks)

---

## File Structure

```
experiments/
  README.md                    ← this file
  agent_harness.py             ← core agent loop with tool dispatch
  run_experiment.py            ← CLI runner for batch execution
  analyze.py                   ← results analysis + table generation
  prompts/
    system_baseline.txt        ← system prompt for baseline condition
    system_guardian.txt        ← system prompt for guardian condition
  results/
    baseline.jsonl             ← per-task results, baseline condition
    guardian.jsonl             ← per-task results, guardian condition
    analysis.md                ← generated comparison report
```

---

## Research Claim Being Tested

> "Guardian reduces the number of agent turns and tokens required to correctly
> identify relevant code locations by providing a compressed, pre-indexed
> orientation layer. On 31 navigation tasks across 6 programming languages,
> agents equipped with Guardian found correct files in X fewer turns and consumed
> Y% fewer tokens, while achieving Z% higher declaration accuracy compared to
> agents using only direct file exploration."

If Z ≥ 10pp and Y ≥ 30%, that's a publishable result at a workshop venue
(MSR, ICSE NIER, FSE Ideas). If Z ≥ 20pp, it's a full paper contribution.
