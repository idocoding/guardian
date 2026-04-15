"""
Deep benchmark harness — Level 1 / 2 / 3 evaluation.

Extends the baseline claude_harness with:
  Level 1 — file accuracy (same as before, edge cases)
  Level 2 — symbol accuracy: does the agent identify the right function/class?
  Level 3 — location precision: does the agent cite the correct line number (±5)?

New metrics vs claude_harness:
  declared_symbols        — function/class names the agent declared
  symbols_hit             — GT symbols found in agent's answer
  symbols_correct         — majority of GT symbols declared
  search_symbol_recall    — GT symbol appeared in guardian_search response (search engine quality)
  location_hit            — GT symbol cited within ±5 lines of truth (Level 3 only)

Usage:
  python experiments/deep_harness.py --condition guardian
  python experiments/deep_harness.py --condition both --workers 4
  python experiments/deep_harness.py --tasks tests/benchmark/deep-tasks.jsonl --smoke 10
"""

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
RESULTS_DIR = ROOT / "experiments/results"
GUARDIAN_CLI = ROOT / "dist/cli.js"

CLAUDE_BIN = Path(os.environ.get("CLAUDE_BIN", Path.home() / ".local/bin/claude"))

# ── Prompt templates ───────────────────────────────────────────────────────────

GUARDIAN_SYSTEM = """You are a code navigation expert. You have access to guardian_search —
a pre-built semantic index of this codebase. Always use guardian_search FIRST before reading files.
It returns relevant files with their symbols (including function names and line numbers),
imports, and reverse-dependencies. Use the symbols[] array in search results to pinpoint
exact functions without reading entire files."""

BASELINE_SYSTEM = """You are a code navigation expert. Use Glob, Grep, and Read to explore
the codebase and find relevant files and functions."""

# Single unified prompt — always asks for files, symbols, and locations.
# The harness scores whatever ground truth is available per task.
TASK_PROMPT = """Find the source files and specific functions relevant to this task:

Task: {description}

Instructions:
1. Search or explore the codebase to identify the relevant files and functions
2. Read key files to confirm exact function names and line numbers
3. Output your final answer as valid JSON on its own line:
   {{"files": ["path/to/file.py"], "symbols": ["function_name"], "locations": [{{"file": "path/to/file.py", "name": "function_name", "line": 42}}]}}

Rules:
- files[]: repo-relative paths only, directly relevant files
- symbols[]: exact function or class names (use [] if no specific function is the answer)
- locations[]: one entry per symbol with its exact starting line number"""


# ── MCP config ─────────────────────────────────────────────────────────────────

def make_mcp_config(specs_abs_dir: str) -> dict:
    return {
        "mcpServers": {
            "guardian": {
                "type": "stdio",
                "command": "node",
                "args": [str(GUARDIAN_CLI), "mcp-serve", "--specs", specs_abs_dir],
            }
        }
    }


# ── Result dataclass ───────────────────────────────────────────────────────────

@dataclass
class EpisodeResult:
    task_id: str
    level: int
    condition: str
    model: str
    # File accuracy (Level 1+)
    gt_files: list[str]
    declared_files: list[str] = field(default_factory=list)
    files_hit: int = 0
    files_correct: bool = False
    # Symbol accuracy (Level 2+)
    gt_symbols: list[str] = field(default_factory=list)
    declared_symbols: list[str] = field(default_factory=list)
    symbols_hit: int = 0
    symbols_correct: bool = False
    # Location precision (Level 3)
    gt_locations: list[dict] = field(default_factory=list)
    declared_locations: list[dict] = field(default_factory=list)
    location_hit: bool = False
    # Search engine quality (guardian only)
    search_symbol_recall: bool = False   # GT symbol appeared in any guardian_search result
    guardian_symbols_returned: list[dict] = field(default_factory=list)
    # Efficiency
    tool_calls: int = 0
    guardian_search_calls: int = 0
    read_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    duration_sec: float = 0.0
    error: str = ""


# ── Stream-JSON parser ─────────────────────────────────────────────────────────

def parse_stream_json(lines: list[str]) -> dict:
    tool_calls = 0
    guardian_search_calls = 0
    read_calls = 0
    tokens_in = 0
    tokens_out = 0
    all_text: list[str] = []
    guardian_symbols: list[dict] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        t = obj.get("type", "")

        if t == "assistant":
            msg = obj.get("message", {})
            for block in msg.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tool_calls += 1
                    name = block.get("name", "")
                    if "guardian" in name:
                        guardian_search_calls += 1
                    elif name in ("Read", "Bash", "Grep", "Glob"):
                        read_calls += 1
                elif block.get("type") == "text":
                    all_text.append(block.get("text", ""))

        # Parse tool results — capture guardian_search symbol responses
        if t == "user":
            msg = obj.get("message", {})
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    content = block.get("content", [])
                    # content is either a list of blocks or a plain string
                    if isinstance(content, str):
                        content = [{"type": "text", "text": content}]
                    for inner in content:
                        if not isinstance(inner, dict):
                            continue
                        if inner.get("type") == "text":
                            try:
                                result_json = json.loads(inner["text"])
                                syms = result_json.get("symbols", [])
                                if syms:
                                    guardian_symbols.extend(syms)
                            except (json.JSONDecodeError, TypeError):
                                pass

        if t == "result":
            usage = obj.get("usage", {})
            tokens_in  += usage.get("input_tokens", 0)
            tokens_out += usage.get("output_tokens", 0)
            result_text = obj.get("result", "")
            if result_text:
                all_text.append(result_text)

    return {
        "tool_calls": tool_calls,
        "guardian_search_calls": guardian_search_calls,
        "read_calls": read_calls,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "text": "\n".join(all_text),
        "guardian_symbols": guardian_symbols,
    }


# ── Extractors ─────────────────────────────────────────────────────────────────

def extract_answer(text: str) -> dict:
    """Extract {files, symbols, locations} from agent's final JSON answer.

    Uses brace-balanced extraction to handle nested objects in 'locations'.
    """
    # Find all positions where a '{' starts a top-level JSON object
    candidates = []
    i = 0
    while i < len(text):
        if text[i] == '{':
            # Walk forward balancing braces
            depth = 0
            j = i
            in_str = False
            escape = False
            while j < len(text):
                c = text[j]
                if escape:
                    escape = False
                elif c == '\\' and in_str:
                    escape = True
                elif c == '"':
                    in_str = not in_str
                elif not in_str:
                    if c == '{':
                        depth += 1
                    elif c == '}':
                        depth -= 1
                        if depth == 0:
                            candidates.append(text[i:j+1])
                            break
                j += 1
        i += 1

    for candidate in candidates:
        if '"files"' not in candidate:
            continue
        try:
            obj = json.loads(candidate)
            if isinstance(obj.get("files"), list):
                return {
                    "files": [str(f) for f in obj.get("files", []) if f],
                    "symbols": [str(s) for s in obj.get("symbols", []) if s],
                    "locations": obj.get("locations", []),
                }
        except json.JSONDecodeError:
            pass
    return {"files": [], "symbols": [], "locations": []}


def normalize_path(p: str, repo_root: str) -> str:
    p = p.strip()
    if p.startswith(repo_root):
        p = p[len(repo_root):].lstrip("/")
    if p.startswith("./"):
        p = p[2:]
    p = re.sub(r'^bench-repos/[^/]+/', '', p)
    repo_name = Path(repo_root).name
    strip_prefixes = {repo_name}
    for sep in ('-', '_'):
        strip_prefixes.update(repo_name.split(sep))
    m = re.match(r'^([^/]+)/', p)
    if m and m.group(1) in strip_prefixes:
        p = p[len(m.group(1)) + 1:]
    return p


def score_files(declared: list[str], gt: list[str], repo_root: str) -> tuple[int, bool]:
    norm_d = {normalize_path(f, repo_root) for f in declared}
    norm_g = {normalize_path(f, repo_root) for f in gt}
    hits = len(norm_d & norm_g)
    return hits, hits >= max(1, len(norm_g) // 2)


def score_symbols(declared: list[str], gt: list[str]) -> tuple[int, bool]:
    """Case-insensitive symbol name matching."""
    d = {s.lower().strip() for s in declared}
    g = {s.lower().strip() for s in gt}
    hits = len(d & g)
    return hits, hits >= max(1, len(g) // 2)


def score_locations(declared_locs: list[dict], gt_locs: list[dict], repo_root: str, tolerance: int = 5) -> bool:
    """Check if declared locations are within ±tolerance lines of GT."""
    if not gt_locs:
        return False
    matched = 0
    for gt in gt_locs:
        gt_file = normalize_path(gt.get("file", ""), repo_root)
        gt_name = gt.get("name", "").lower()
        gt_line = gt.get("line", 0)
        for d in declared_locs:
            d_file = normalize_path(d.get("file", ""), repo_root)
            d_name = d.get("name", "").lower()
            d_line = d.get("line", 0)
            if (d_file == gt_file or gt_file.endswith(d_file) or d_file.endswith(gt_file)) \
               and d_name == gt_name \
               and abs(d_line - gt_line) <= tolerance:
                matched += 1
                break
    return matched >= max(1, len(gt_locs) // 2)


def search_recall(guardian_symbols: list[dict], gt_symbols: list[str]) -> bool:
    """Did guardian_search return any GT symbol in its symbols[] array?"""
    if not gt_symbols or not guardian_symbols:
        return False
    gt_lower = {s.lower().strip() for s in gt_symbols}
    for s in guardian_symbols:
        name = s.get("name", "").lower().replace(" ", "_").replace(" ", "")
        # also try underscore-joined version of split name
        if name in gt_lower or name.replace("_", "") in {g.replace("_", "") for g in gt_lower}:
            return True
    return False


# ── Core episode runner ────────────────────────────────────────────────────────

async def run_episode(
    task: dict,
    condition: str,
    model: str,
    repo_root: str,
    specs_abs_dir: str,
    timeout: int = 180,
) -> EpisodeResult:
    t0 = time.monotonic()
    level = task.get("level", 1)
    result = EpisodeResult(
        task_id=task["id"],
        level=level,
        condition=condition,
        model=model,
        gt_files=task.get("ground_truth_files", []),
        gt_symbols=task.get("ground_truth_symbols", []),
        gt_locations=task.get("ground_truth_locations", []),
    )

    prompt = TASK_PROMPT.format(description=task.get("description", task.get("query", "")))

    cmd = [str(CLAUDE_BIN), "-p", prompt,
           "--output-format", "stream-json",
           "--verbose",
           "--dangerously-skip-permissions",
           "--no-session-persistence",
           "--model", model,
           "--add-dir", repo_root]

    tmp_mcp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    if condition == "guardian":
        json.dump(make_mcp_config(specs_abs_dir), tmp_mcp)
        tmp_mcp.close()
        cmd += [
            "--mcp-config", tmp_mcp.name,
            "--strict-mcp-config",
            "--system-prompt", GUARDIAN_SYSTEM,
            "--allowedTools", "mcp__guardian__guardian_search,mcp__guardian__guardian_orient,Read,Glob,Grep",
        ]
    else:
        json.dump({"mcpServers": {}}, tmp_mcp)
        tmp_mcp.close()
        cmd += [
            "--mcp-config", tmp_mcp.name,
            "--strict-mcp-config",
            "--system-prompt", BASELINE_SYSTEM,
        ]

    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            result.error = f"timeout after {timeout}s"
            result.duration_sec = time.monotonic() - t0
            return result

        lines = stdout.decode(errors="replace").splitlines()
        parsed = parse_stream_json(lines)

        result.tool_calls            = parsed["tool_calls"]
        result.guardian_search_calls = parsed["guardian_search_calls"]
        result.read_calls            = parsed["read_calls"]
        result.tokens_in             = parsed["tokens_in"]
        result.tokens_out            = parsed["tokens_out"]
        result.guardian_symbols_returned = parsed["guardian_symbols"]

        answer = extract_answer(parsed["text"])
        result.declared_files     = answer["files"]
        result.declared_symbols   = answer["symbols"]
        result.declared_locations = answer["locations"]

        result.files_hit, result.files_correct = score_files(
            result.declared_files, result.gt_files, repo_root)

        if result.gt_symbols:
            result.symbols_hit, result.symbols_correct = score_symbols(
                result.declared_symbols, result.gt_symbols)
            result.search_symbol_recall = search_recall(
                result.guardian_symbols_returned, result.gt_symbols)

        if result.gt_locations:
            result.location_hit = score_locations(
                result.declared_locations, result.gt_locations, repo_root)

        if proc.returncode != 0 and not answer["files"]:
            result.error = stderr.decode(errors="replace")[:300]

    except Exception as e:
        result.error = str(e)
    finally:
        try:
            os.unlink(tmp_mcp.name)
        except Exception:
            pass

    result.duration_sec = time.monotonic() - t0
    return result


# ── Batch runner ───────────────────────────────────────────────────────────────

def resolve_repo_root(task: dict, guardian_root: Path) -> tuple[str, str]:
    specs_dir = task.get("specs_dir", ".specs")
    if specs_dir == ".specs":
        repo_root = str(guardian_root)
    else:
        specs_abs = (guardian_root / specs_dir).resolve()
        repo_root = str(specs_abs.parent)
    specs_abs = str((Path(repo_root) / ".specs").resolve())
    return repo_root, specs_abs


async def run_batch(
    tasks: list[dict],
    condition: str,
    model: str,
    workers: int,
    out_path: Path,
    verbose: bool,
    timeout: int = 300,
) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    done_ids: set[str] = set()
    if out_path.exists():
        for line in open(out_path):
            try:
                done_ids.add(json.loads(line)["task_id"])
            except Exception:
                pass

    pending = [t for t in tasks if t["id"] not in done_ids]
    print(f"[{condition}] {len(pending)} tasks to run ({len(done_ids)} done), workers={workers}")

    write_lock = asyncio.Lock()
    sem = asyncio.Semaphore(workers)
    completed = [0]

    async def run_one(task: dict):
        async with sem:
            repo_root, specs_abs = resolve_repo_root(task, ROOT)
            result = await run_episode(task, condition, model, repo_root, specs_abs, timeout=timeout)
            async with write_lock:
                with open(out_path, "a") as f:
                    f.write(json.dumps(asdict(result)) + "\n")
                completed[0] += 1
                total = len(done_ids) + completed[0]

                # Compute running accuracy across all levels
                all_results = [json.loads(l) for l in open(out_path) if l.strip()]
                f_ok = sum(1 for r in all_results if r.get("files_correct"))
                s_ok = sum(1 for r in all_results if r.get("symbols_correct"))
                s_n  = sum(1 for r in all_results if r.get("gt_symbols"))
                l_ok = sum(1 for r in all_results if r.get("location_hit"))
                l_n  = sum(1 for r in all_results if r.get("gt_locations"))
                sr   = sum(1 for r in all_results if r.get("search_symbol_recall"))

                status = "✓" if result.files_correct else "✗"
                sym_flag = ""
                if result.gt_symbols:
                    sym_flag = f" sym={'✓' if result.symbols_correct else '✗'}"
                    if condition == "guardian":
                        sym_flag += f"(recall={'✓' if result.search_symbol_recall else '✗'})"
                loc_flag = f" loc={'✓' if result.location_hit else '✗'}" if result.gt_locations else ""
                gsc = f" gs={result.guardian_search_calls}" if condition == "guardian" else ""

                print(
                    f"[{condition}] L{result.level} {status}{sym_flag}{loc_flag} {result.task_id} | "
                    f"reads={result.read_calls}{gsc} | {result.duration_sec:.0f}s | "
                    f"files={f_ok}/{total}"
                    + (f" syms={s_ok}/{s_n}" if s_n else "")
                    + (f" locs={l_ok}/{l_n}" if l_n else "")
                    + (f" search_recall={sr}/{s_n}" if s_n and condition == "guardian" else "")
                    + (f" | ERR: {result.error[:60]}" if result.error else "")
                )
                if verbose:
                    if result.declared_files:
                        print(f"         files:   {result.declared_files}")
                    if result.declared_symbols:
                        print(f"         symbols: {result.declared_symbols}")
                    if result.gt_symbols:
                        print(f"         gt_syms: {result.gt_symbols}")

    await asyncio.gather(*[run_one(t) for t in pending])


# ── CLI ────────────────────────────────────────────────────────────────────────

def load_tasks(path: Path, smoke: int = 0) -> list[dict]:
    tasks = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                tasks.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    if smoke:
        # take a balanced sample across levels
        by_level: dict[int, list] = {}
        for t in tasks:
            lv = t.get("level", 1)
            by_level.setdefault(lv, []).append(t)
        result = []
        per_level = max(1, smoke // len(by_level))
        for lv in sorted(by_level):
            result.extend(by_level[lv][:per_level])
        return result[:smoke]
    return tasks


def print_summary(out_path: Path, condition: str) -> None:
    if not out_path.exists():
        return
    results = [json.loads(l) for l in open(out_path) if l.strip()]
    if not results:
        return

    n = len(results)
    f_ok  = sum(1 for r in results if r.get("files_correct"))
    s_n   = sum(1 for r in results if r.get("gt_symbols"))
    s_ok  = sum(1 for r in results if r.get("symbols_correct"))
    l_n   = sum(1 for r in results if r.get("gt_locations"))
    l_ok  = sum(1 for r in results if r.get("location_hit"))
    sr_ok = sum(1 for r in results if r.get("search_symbol_recall"))
    toks  = sum(r.get("tokens_in", 0) for r in results) / n
    reads = sum(r.get("read_calls", 0) for r in results) / n

    print(f"\n{'='*60}")
    print(f"Summary: {condition}  ({n} tasks, all have files+symbols+locations GT)")
    print(f"{'='*60}")
    print(f"  files:          {f_ok}/{n} = {f_ok*100//n}%")
    print(f"  symbols:        {s_ok}/{s_n} = {s_ok*100//s_n}%" if s_n else "")
    print(f"  locations:      {l_ok}/{l_n} = {l_ok*100//l_n}%" if l_n else "")
    if condition == "guardian" and s_n:
        print(f"  search_recall:  {sr_ok}/{s_n} = {sr_ok*100//s_n}%  ← guardian_search engine quality")
    print(f"  avg tokens_in:  {toks:.0f}")
    print(f"  avg reads:      {reads:.1f}")

    # Breakdown by difficulty tag (L1=file edge cases, L2=abstract queries, L3=exact line precision)
    by_level: dict[int, list] = {}
    for r in results:
        by_level.setdefault(r.get("level", 1), []).append(r)
    level_labels = {1: "L1 file-edge-cases", 2: "L2 abstract-query", 3: "L3 line-precision"}
    print(f"\n  Breakdown by difficulty tag:")
    for lv in sorted(by_level):
        rs = by_level[lv]
        rf = sum(1 for r in rs if r.get("files_correct"))
        rs_n = sum(1 for r in rs if r.get("gt_symbols"))
        rs_ok = sum(1 for r in rs if r.get("symbols_correct"))
        rl_n = sum(1 for r in rs if r.get("gt_locations"))
        rl_ok = sum(1 for r in rs if r.get("location_hit"))
        label = level_labels.get(lv, f"L{lv}")
        sym_str = f"  sym={rs_ok}/{rs_n}" if rs_n else ""
        loc_str = f"  loc={rl_ok}/{rl_n}" if rl_n else ""
        print(f"    {label} (n={len(rs)}):  files={rf}/{len(rs)}{sym_str}{loc_str}")


def main():
    parser = argparse.ArgumentParser(description="Deep benchmark harness (Level 1/2/3)")
    parser.add_argument("--condition", choices=["guardian", "baseline", "both"], default="guardian")
    parser.add_argument("--tasks", default="tests/benchmark/deep-tasks.jsonl")
    parser.add_argument("--model", default="claude-haiku-4-5-20251001")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--out-dir", default="experiments/results")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--smoke", type=int, default=0,
                        help="Run N tasks as smoke test (balanced across levels)")
    args = parser.parse_args()

    tasks_path = ROOT / args.tasks
    tasks = load_tasks(tasks_path, smoke=args.smoke)
    print(f"Loaded {len(tasks)} tasks from {tasks_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    conditions = ["guardian", "baseline"] if args.condition == "both" else [args.condition]

    for cond in conditions:
        suffix = "claude" if args.model.startswith("claude") else args.model
        out_path = out_dir / f"deep_{cond}_{suffix}.jsonl"
        if args.reset and out_path.exists():
            out_path.unlink()
        print(f"\n{'='*60}")
        print(f"Running: {cond} | model={args.model} | workers={args.workers}")
        print(f"Output:  {out_path}")
        print(f"{'='*60}")
        asyncio.run(run_batch(tasks, cond, args.model, args.workers, out_path, args.verbose, args.timeout))
        print_summary(out_path, cond)

    print("\nDone.")


if __name__ == "__main__":
    main()
