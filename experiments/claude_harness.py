"""
Claude Code CLI benchmark harness.

Runs guardian vs baseline using the real `claude` CLI — the most realistic
test of guardian MCP performance in an actual IDE environment.

Guardian condition:  claude + guardian MCP server (guardian_search tool)
Baseline condition:  claude + file tools only (Read, Glob, Grep)

Usage:
  python experiments/claude_harness.py --condition guardian --tasks tests/benchmark/multi-codebase-tasks.jsonl
  python experiments/claude_harness.py --condition baseline --tasks tests/benchmark/multi-codebase-tasks.jsonl
  python experiments/claude_harness.py --condition both --workers 4

The harness:
  1. Generates a per-task MCP config pointing at the repo's .specs dir
  2. Spawns `claude -p` as a subprocess in the repo directory
  3. Parses stream-json output to count tool calls and extract declared files
  4. Scores against ground truth and writes JSONL results
"""

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
RESULTS_DIR = ROOT / "experiments/results"
GUARDIAN_CLI = ROOT / "dist/cli.js"

CLAUDE_BIN = Path(os.environ.get(
    "CLAUDE_BIN",
    Path.home() / ".local/bin/claude"
))

# ── Prompt templates ──────────────────────────────────────────────────────────

GUARDIAN_SYSTEM = """You are a code navigation expert. You have access to guardian_search —
a pre-built semantic index of this codebase. Always use guardian_search FIRST before reading files.
It returns relevant files with their symbols, imports, and reverse-dependencies."""

BASELINE_SYSTEM = """You are a code navigation expert. Use Glob, Grep, and Read to explore
the codebase and find relevant files."""

TASK_PROMPT = """Find the source files most relevant to this task:

Task: {description}

Instructions:
1. Search or explore the codebase to identify relevant files
2. Read 1-3 key files to confirm relevance
3. Output your final answer as valid JSON on its own line:
   {{"files": ["path/to/file1.py", "path/to/file2.ts"]}}

Use repo-relative paths only. Only include files directly relevant to the task."""


# ── MCP config ────────────────────────────────────────────────────────────────

def make_mcp_config(specs_abs_dir: str) -> dict:
    """Generate a guardian MCP server config for a specific repo."""
    return {
        "mcpServers": {
            "guardian": {
                "type": "stdio",
                "command": "node",
                "args": [str(GUARDIAN_CLI), "mcp-serve", "--specs", specs_abs_dir],
            }
        }
    }


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class EpisodeResult:
    task_id: str
    condition: str
    model: str
    gt_files: list[str]
    declared_files: list[str] = field(default_factory=list)
    files_hit: int = 0
    declared_correctly: bool = False
    tool_calls: int = 0
    guardian_search_calls: int = 0
    read_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    duration_sec: float = 0.0
    error: str = ""


# ── Stream-JSON parser ────────────────────────────────────────────────────────

def parse_stream_json(lines: list[str]) -> dict:
    """
    Parse claude --output-format stream-json output.
    Returns: {tool_calls, guardian_search_calls, read_calls, tokens_in, tokens_out, declared_files, text}
    """
    tool_calls = 0
    guardian_search_calls = 0
    read_calls = 0
    tokens_in = 0
    tokens_out = 0
    all_text: list[str] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        t = obj.get("type", "")

        # assistant message with tool uses
        if t == "assistant":
            msg = obj.get("message", {})
            for block in msg.get("content", []):
                if block.get("type") == "tool_use":
                    tool_calls += 1
                    name = block.get("name", "")
                    if "guardian" in name:
                        guardian_search_calls += 1
                    elif name in ("Read", "Bash", "Grep", "Glob"):
                        read_calls += 1
                elif block.get("type") == "text":
                    all_text.append(block.get("text", ""))

        # usage stats
        if t == "result":
            usage = obj.get("usage", {})
            tokens_in  += usage.get("input_tokens", 0)
            tokens_out += usage.get("output_tokens", 0)
            # final text result
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
    }


def extract_declared_files(text: str) -> list[str]:
    """
    Extract file list from claude's final JSON answer.
    Looks for: {"files": [...]} anywhere in the text.
    """
    # Try to find JSON block with files key
    for match in re.finditer(r'\{[^{}]*"files"\s*:\s*\[[^\]]*\][^{}]*\}', text, re.DOTALL):
        try:
            obj = json.loads(match.group())
            files = obj.get("files", [])
            if isinstance(files, list):
                return [str(f) for f in files if f]
        except json.JSONDecodeError:
            pass

    # Fallback: look for a bare JSON array after "files":
    match = re.search(r'"files"\s*:\s*(\[[^\]]+\])', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    return []


def normalize_path(p: str, repo_root: str) -> str:
    """Strip absolute/relative repo prefix so paths are repo-relative."""
    p = p.strip()
    # Strip absolute path prefix
    if p.startswith(repo_root):
        p = p[len(repo_root):].lstrip("/")
    # Strip leading ./
    if p.startswith("./"):
        p = p[2:]
    # Strip bench-repos/<name>/ prefix (e.g. "bench-repos/flask-full/src/..." → "src/...")
    p = re.sub(r'^bench-repos/[^/]+/', '', p)
    # Strip leading repo-name segment(s).
    # e.g. "go-realworld/articles/models.go"     → "articles/models.go"
    #      "csharp-realworld/src/Conduit/..."     → "src/Conduit/..."
    #      "django/django/core/cache/..."         → "django/core/cache/..."  (strip once)
    # We strip at most ONE occurrence, so "django/core/..." stays "django/core/...".
    repo_name = Path(repo_root).name
    strip_prefixes = {repo_name}
    for sep in ('-', '_'):
        strip_prefixes.update(repo_name.split(sep))
    m = re.match(r'^([^/]+)/', p)
    if m and m.group(1) in strip_prefixes:
        p = p[len(m.group(1)) + 1:]
    return p


def score(declared: list[str], gt: list[str], repo_root: str) -> tuple[int, bool]:
    """Return (files_hit, declared_correctly)."""
    norm_declared = {normalize_path(f, repo_root) for f in declared}
    norm_gt = {normalize_path(f, repo_root) for f in gt}  # normalize GT too for consistent comparison
    hits = len(norm_declared & norm_gt)
    correct = hits >= max(1, len(norm_gt) // 2)  # majority match
    return hits, correct


# ── Core episode runner ───────────────────────────────────────────────────────

async def run_episode(
    task: dict,
    condition: str,
    model: str,
    repo_root: str,
    specs_abs_dir: str,
    timeout: int = 180,
) -> EpisodeResult:
    t0 = time.monotonic()
    result = EpisodeResult(
        task_id=task["id"],
        condition=condition,
        model=model,
        gt_files=task.get("ground_truth_files", []),
    )

    # Build prompt
    prompt = TASK_PROMPT.format(
        description=task.get("description", ""),
    )

    # Build claude command
    cmd = [str(CLAUDE_BIN), "-p", prompt,
           "--output-format", "stream-json",
           "--verbose",
           "--dangerously-skip-permissions",
           "--no-session-persistence",
           "--model", model,
           "--add-dir", repo_root]  # ensure claude has access to repo even if outside default workspace

    if condition == "guardian":
        # Write temp MCP config
        mcp_cfg = make_mcp_config(specs_abs_dir)
        tmp_mcp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(mcp_cfg, tmp_mcp)
        tmp_mcp.close()

        cmd += [
            "--mcp-config", tmp_mcp.name,
            "--strict-mcp-config",  # don't inherit user's other MCP servers
            "--system-prompt", GUARDIAN_SYSTEM,
            "--allowedTools", "mcp__guardian__guardian_search,mcp__guardian__guardian_orient,Read,Glob,Grep",
        ]
    else:
        # Write empty MCP config so --strict-mcp-config blocks any globally configured MCP servers
        tmp_mcp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump({"mcpServers": {}}, tmp_mcp)
        tmp_mcp.close()
        cmd += [
            "--mcp-config", tmp_mcp.name,
            "--strict-mcp-config",  # blocks any globally configured MCP servers
            "--system-prompt", BASELINE_SYSTEM,
            # no tool restrictions — default file tools (Read, Glob, Grep, Bash) are fine
        ]

    # Run in repo directory — unset CLAUDECODE so nested session check is bypassed
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=repo_root,
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

        result.tool_calls           = parsed["tool_calls"]
        result.guardian_search_calls = parsed["guardian_search_calls"]
        result.read_calls           = parsed["read_calls"]
        result.tokens_in            = parsed["tokens_in"]
        result.tokens_out           = parsed["tokens_out"]

        declared = extract_declared_files(parsed["text"])
        result.declared_files = declared
        result.files_hit, result.declared_correctly = score(declared, result.gt_files, repo_root)

        if proc.returncode != 0 and not declared:
            err = stderr.decode(errors="replace")[:300]
            result.error = err

    except Exception as e:
        result.error = str(e)
    finally:
        try:
            os.unlink(tmp_mcp.name)
        except Exception:
            pass

    result.duration_sec = time.monotonic() - t0
    return result


# ── Batch runner ──────────────────────────────────────────────────────────────

def resolve_repo_root(task: dict, guardian_root: Path) -> tuple[str, str]:
    """Returns (repo_root_abs, specs_abs_dir)."""
    specs_dir = task.get("specs_dir", ".specs")
    if specs_dir == ".specs":
        repo_root = str(guardian_root)
    else:
        # specs_dir is relative to guardian_root, e.g. "../VSCode/yowi_app/.specs"
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

    # Resume: skip already-done tasks
    done_ids: set[str] = set()
    if out_path.exists():
        with open(out_path) as f:
            for line in f:
                try:
                    done_ids.add(json.loads(line)["task_id"])
                except Exception:
                    pass
    pending = [t for t in tasks if t["id"] not in done_ids]
    print(f"[{condition}] {len(pending)} tasks to run ({len(done_ids)} already done), workers={workers}")

    write_lock = asyncio.Lock()
    sem = asyncio.Semaphore(workers)
    completed = [0]
    hits = [0]

    async def run_one(task: dict):
        async with sem:
            repo_root, specs_abs = resolve_repo_root(task, ROOT)
            result = await run_episode(task, condition, model, repo_root, specs_abs, timeout=timeout)

            async with write_lock:
                with open(out_path, "a") as f:
                    f.write(json.dumps(asdict(result)) + "\n")
                completed[0] += 1
                if result.declared_correctly:
                    hits[0] += 1
                total_so_far = len(done_ids) + completed[0]
                total_hits = sum(
                    1 for line in open(out_path)
                    if line.strip() and json.loads(line).get("declared_correctly")
                )
                pct = 100 * total_hits // total_so_far if total_so_far else 0
                status = "✓" if result.declared_correctly else "✗"
                gsc = f" guardian_search={result.guardian_search_calls}" if condition == "guardian" else ""
                print(
                    f"[{condition}] {status} {result.task_id} | "
                    f"reads={result.read_calls}{gsc} | "
                    f"{result.duration_sec:.0f}s | "
                    f"acc={total_hits}/{total_so_far} ({pct}%)"
                    + (f" | ERR: {result.error[:60]}" if result.error else "")
                )
                if verbose and result.declared_files:
                    print(f"         declared: {result.declared_files}")
                    print(f"         expected: {result.gt_files}")

    await asyncio.gather(*[run_one(t) for t in pending])


# ── CLI ───────────────────────────────────────────────────────────────────────

def load_tasks(path: Path) -> list[dict]:
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
    return tasks


def main():
    parser = argparse.ArgumentParser(description="Claude Code benchmark harness for guardian")
    parser.add_argument("--condition", choices=["guardian", "baseline", "both"], default="guardian")
    parser.add_argument("--tasks", default="tests/benchmark/multi-codebase-tasks.jsonl")
    parser.add_argument("--model", default="claude-haiku-4-5-20251001",
                        help="Claude model (default: haiku for speed/cost)")
    parser.add_argument("--workers", type=int, default=4,
                        help="Parallel tasks (default: 4)")
    parser.add_argument("--timeout", type=int, default=300,
                        help="Per-task timeout in seconds (default: 300)")
    parser.add_argument("--out-dir", default="experiments/results")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--reset", action="store_true",
                        help="Clear existing results before running")
    args = parser.parse_args()

    tasks_path = ROOT / args.tasks
    tasks = load_tasks(tasks_path)
    print(f"Loaded {len(tasks)} tasks from {tasks_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    conditions = ["guardian", "baseline"] if args.condition == "both" else [args.condition]

    for cond in conditions:
        suffix = "claude" if args.model.startswith("claude") else args.model.split(":")[0]
        out_path = out_dir / f"{cond}_{suffix}.jsonl"
        if args.reset and out_path.exists():
            out_path.unlink()
            print(f"Reset {out_path}")
        print(f"\n{'='*60}")
        print(f"Running: {cond} | model={args.model} | workers={args.workers}")
        print(f"Output:  {out_path}")
        print(f"{'='*60}")
        asyncio.run(run_batch(tasks, cond, args.model, args.workers, out_path, args.verbose, timeout=args.timeout))

    print("\nDone.")


if __name__ == "__main__":
    main()
