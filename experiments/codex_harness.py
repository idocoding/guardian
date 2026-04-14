"""
Codex CLI benchmark harness.

Runs guardian vs baseline using the real `codex exec` CLI in non-interactive
mode, while isolating each run inside a temporary Codex home so the baseline
condition cannot accidentally inherit the user's global Guardian MCP setup.

Guardian condition:  codex + guardian MCP server
Baseline condition:  codex + default shell/file exploration only

Usage:
  python experiments/codex_harness.py --condition guardian
  python experiments/codex_harness.py --condition baseline
  python experiments/codex_harness.py --condition both --workers 2
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).parent.parent
RESULTS_DIR = ROOT / "experiments/results"
GUARDIAN_CLI = ROOT / "dist/cli.js"
CODEX_BIN = Path(os.environ.get("CODEX_BIN", shutil.which("codex") or "codex"))
AUTH_JSON = Path.home() / ".codex" / "auth.json"

GUARDIAN_PROMPT = """You are a code navigation expert.

You have access to Guardian MCP tools for this repository. Always use
`guardian_search` or `guardian_orient` before broad manual exploration.

Task: {description}

Instructions:
1. Use Guardian first to identify the most relevant files
2. Read 1-3 key files to confirm relevance
3. Return only valid JSON matching the required schema

Use repo-relative paths only. Only include files directly relevant to the task.
"""

BASELINE_PROMPT = """You are a code navigation expert.

You do not have Guardian. Use shell-based code exploration to identify the
most relevant files for the task.

Task: {description}

Instructions:
1. Explore or search the codebase to identify relevant files
2. Read 1-3 key files to confirm relevance
3. Return only valid JSON matching the required schema
4. Do not use generated architecture/spec artifacts such as `.specs`,
   `specs-out`, or benchmark result files as shortcuts

Use repo-relative paths only. Only include files directly relevant to the task.
"""


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


def resolve_repo_root(task: dict, guardian_root: Path) -> tuple[str, str]:
    specs_dir = task.get("specs_dir", ".specs")
    if specs_dir == ".specs":
        repo_root = str(guardian_root)
    else:
        specs_abs = (guardian_root / specs_dir).resolve()
        repo_root = str(specs_abs.parent)
    specs_abs = str((Path(repo_root) / ".specs").resolve())
    return repo_root, specs_abs


def normalize_path(p: str, repo_root: str) -> str:
    p = p.strip()
    if p.startswith(repo_root):
        p = p[len(repo_root):].lstrip("/")
    if p.startswith("./"):
        p = p[2:]
    p = re.sub(r"^bench-repos/[^/]+/", "", p)
    repo_name = Path(repo_root).name
    strip_prefixes = {repo_name}
    for sep in ("-", "_"):
        strip_prefixes.update(repo_name.split(sep))
    m = re.match(r"^([^/]+)/", p)
    if m and m.group(1) in strip_prefixes:
        p = p[len(m.group(1)) + 1 :]
    return p


def score(declared: list[str], gt: list[str], repo_root: str) -> tuple[int, bool]:
    norm_declared = {normalize_path(f, repo_root) for f in declared}
    norm_gt = {normalize_path(f, repo_root) for f in gt}
    hits = len(norm_declared & norm_gt)
    correct = hits >= max(1, len(norm_gt) // 2)
    return hits, correct


def extract_declared_files(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []

    try:
        obj = json.loads(text)
        files = obj.get("files", [])
        if isinstance(files, list):
            return [str(f) for f in files if f]
    except json.JSONDecodeError:
        pass

    for match in re.finditer(r'\{[^{}]*"files"\s*:\s*\[[^\]]*\][^{}]*\}', text, re.DOTALL):
        try:
            obj = json.loads(match.group())
            files = obj.get("files", [])
            if isinstance(files, list):
                return [str(f) for f in files if f]
        except json.JSONDecodeError:
            pass

    return []


def is_read_like_tool(name: str, args: dict) -> bool:
    if name in ("shell_command", "exec_command"):
        command = str(args.get("command") or args.get("cmd") or "").strip()
        first = command.split()[0] if command else ""
        return first in {
            "ls",
            "find",
            "rg",
            "grep",
            "sed",
            "cat",
            "head",
            "tail",
            "awk",
            "git",
        }
    return False


def parse_codex_json(lines: list[str]) -> dict:
    tool_calls = 0
    guardian_search_calls = 0
    read_calls = 0
    tokens_in = 0
    tokens_out = 0
    assistant_text: list[str] = []

    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue

        item_type = obj.get("type")

        if item_type == "item.completed":
            item = obj.get("item", {})
            item_kind = item.get("type", "")
            if item_kind in ("command_execution", "mcp_tool_call"):
                tool_calls += 1

            if item_kind == "command_execution":
                read_calls += 1

            if item_kind == "mcp_tool_call":
                tool_name = item.get("tool", "")
                if tool_name == "guardian_search":
                    guardian_search_calls += 1

            if item_kind == "agent_message":
                text = item.get("text", "")
                if text:
                    assistant_text.append(text)

        elif item_type == "turn.completed":
            usage = obj.get("usage", {})
            tokens_in = int(usage.get("input_tokens", 0))
            tokens_out = int(usage.get("output_tokens", 0))

    return {
        "tool_calls": tool_calls,
        "guardian_search_calls": guardian_search_calls,
        "read_calls": read_calls,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "text": "\n".join(assistant_text),
    }


def write_output_schema(path: Path) -> None:
    schema = {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "items": {"type": "string"},
            }
        },
        "required": ["files"],
        "additionalProperties": False,
    }
    path.write_text(json.dumps(schema), encoding="utf-8")


def write_codex_config(path: Path, condition: str, specs_abs_dir: str) -> None:
    lines = [
        'model = "gpt-5.4"',
        'model_reasoning_effort = "low"',
        "",
    ]
    if condition == "guardian":
        args = [
            str(GUARDIAN_CLI),
            "mcp-serve",
            "--specs",
            specs_abs_dir,
            "--quiet",
        ]
        lines.extend(
            [
                "[mcp_servers.guardian]",
                'command = "node"',
                f"args = {json.dumps(args)}",
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def build_temp_codex_home(condition: str, specs_abs_dir: str) -> tuple[tempfile.TemporaryDirectory, Path]:
    tmp = tempfile.TemporaryDirectory(prefix=f"codex-bench-{condition}-")
    home = Path(tmp.name)
    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)

    if AUTH_JSON.exists():
        shutil.copy2(AUTH_JSON, codex_dir / "auth.json")

    write_codex_config(codex_dir / "config.toml", condition, specs_abs_dir)
    return tmp, home


def build_baseline_workspace(repo_root: str, temp_root: Path) -> str:
    workspace = temp_root / "baseline-workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    for child in Path(repo_root).iterdir():
        if child.name in {".specs", "specs-out"}:
            continue
        target = workspace / child.name
        try:
            target.symlink_to(child, target_is_directory=child.is_dir())
        except FileExistsError:
            pass
    return str(workspace)


async def run_episode(
    task: dict,
    condition: str,
    model: str,
    repo_root: str,
    specs_abs_dir: str,
    timeout: int = 300,
    debug_dir: Path | None = None,
) -> EpisodeResult:
    t0 = time.monotonic()
    result = EpisodeResult(
        task_id=task["id"],
        condition=condition,
        model=model,
        gt_files=task.get("ground_truth_files", []),
    )

    prompt_template = GUARDIAN_PROMPT if condition == "guardian" else BASELINE_PROMPT
    prompt = prompt_template.format(description=task.get("description", ""))

    tmp_home, fake_home = build_temp_codex_home(condition, specs_abs_dir)
    temp_root = Path(tmp_home.name)
    workspace_root = repo_root if condition == "guardian" else build_baseline_workspace(repo_root, temp_root)
    schema_path = temp_root / "output-schema.json"
    output_path = temp_root / "last-message.json"
    write_output_schema(schema_path)

    cmd = [
        str(CODEX_BIN),
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        workspace_root,
        "--output-schema",
        str(schema_path),
        "-o",
        str(output_path),
        "-m",
        model,
        prompt,
    ]

    env = os.environ.copy()
    env["HOME"] = str(fake_home)
    env["CODEX_HOME"] = str(fake_home / ".codex")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workspace_root,
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

        stdout_lines = stdout.decode(errors="replace").splitlines()
        if debug_dir is not None:
            debug_dir.mkdir(parents=True, exist_ok=True)
            stem = f"{task['id']}__{condition}"
            (debug_dir / f"{stem}.stdout.jsonl").write_bytes(stdout)
            (debug_dir / f"{stem}.stderr.txt").write_bytes(stderr)
        parsed = parse_codex_json(stdout_lines)

        result.tool_calls = parsed["tool_calls"]
        result.guardian_search_calls = parsed["guardian_search_calls"]
        result.read_calls = parsed["read_calls"]
        result.tokens_in = parsed["tokens_in"]
        result.tokens_out = parsed["tokens_out"]

        final_text = ""
        if output_path.exists():
            final_text = output_path.read_text(encoding="utf-8", errors="replace")
        if not final_text:
            final_text = parsed["text"]

        declared = extract_declared_files(final_text)
        result.declared_files = declared
        result.files_hit, result.declared_correctly = score(declared, result.gt_files, repo_root)

        if proc.returncode != 0 and not declared:
            stderr_text = stderr.decode(errors="replace").strip()
            if stderr_text:
                result.error = stderr_text[:600]
            elif not parsed["text"]:
                non_json = [line for line in stdout_lines if not line.startswith("{")]
                result.error = "\n".join(non_json[:8])[:600]

    except Exception as e:
        result.error = str(e)
    finally:
        tmp_home.cleanup()

    result.duration_sec = time.monotonic() - t0
    return result


async def run_batch(
    tasks: list[dict],
    condition: str,
    model: str,
    workers: int,
    out_path: Path,
    verbose: bool,
    timeout: int,
    debug_dir: Path | None,
) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

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

    sem = asyncio.Semaphore(workers)
    write_lock = asyncio.Lock()

    async def run_one(task: dict) -> None:
        async with sem:
            repo_root, specs_abs = resolve_repo_root(task, ROOT)
            episode = await run_episode(
                task=task,
                condition=condition,
                model=model,
                repo_root=repo_root,
                specs_abs_dir=specs_abs,
                timeout=timeout,
                debug_dir=debug_dir,
            )

            async with write_lock:
                with open(out_path, "a") as f:
                    f.write(json.dumps(asdict(episode)) + "\n")

                status = "✓" if episode.declared_correctly else "✗"
                gsc = f" guardian_search={episode.guardian_search_calls}" if condition == "guardian" else ""
                print(
                    f"[{condition}] {status} {episode.task_id} | "
                    f"reads={episode.read_calls}{gsc} | "
                    f"tok_in={episode.tokens_in} | "
                    f"{episode.duration_sec:.0f}s"
                    + (f" | ERR: {episode.error[:80]}" if episode.error else "")
                )
                if verbose and episode.declared_files:
                    print(f"         declared: {episode.declared_files}")
                    print(f"         expected: {episode.gt_files}")

    await asyncio.gather(*[run_one(task) for task in pending])


def main() -> None:
    parser = argparse.ArgumentParser(description="Codex benchmark harness for Guardian")
    parser.add_argument("--condition", choices=["guardian", "baseline", "both"], default="guardian")
    parser.add_argument("--tasks", default="tests/benchmark/multi-codebase-tasks.jsonl")
    parser.add_argument("--model", default="gpt-5.4", help="Codex model name")
    parser.add_argument("--workers", type=int, default=1, help="Parallel task workers")
    parser.add_argument("--timeout", type=int, default=300, help="Per-task timeout in seconds")
    parser.add_argument("--out-dir", default="experiments/results")
    parser.add_argument("--limit", type=int, default=0, help="Optional task limit for smoke runs")
    parser.add_argument("--debug-json-dir", default="", help="Optional directory to save raw Codex stdout/stderr per task")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    tasks_path = ROOT / args.tasks
    tasks = load_tasks(tasks_path)
    if args.limit > 0:
        tasks = tasks[: args.limit]
    print(f"Loaded {len(tasks)} tasks from {tasks_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    conditions = ["guardian", "baseline"] if args.condition == "both" else [args.condition]
    debug_dir = Path(args.debug_json_dir) if args.debug_json_dir else None
    for cond in conditions:
        suffix = "codex" if args.model.startswith("gpt-") else re.sub(r"[^A-Za-z0-9._-]+", "_", args.model)
        out_path = out_dir / f"{cond}_{suffix}.jsonl"
        if args.reset and out_path.exists():
            out_path.unlink()
            print(f"Reset {out_path}")
        print(f"\n{'=' * 60}")
        print(f"Running: {cond} | model={args.model} | workers={args.workers}")
        print(f"Output:  {out_path}")
        print(f"{'=' * 60}")
        asyncio.run(run_batch(tasks, cond, args.model, args.workers, out_path, args.verbose, args.timeout, debug_dir))

    print("\nDone.")


if __name__ == "__main__":
    main()
