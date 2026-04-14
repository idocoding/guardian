"""
Batch experiment runner.

Usage:
  python experiments/run_experiment.py --condition guardian
  python experiments/run_experiment.py --condition baseline
  python experiments/run_experiment.py --condition both   # runs both sequentially
  python experiments/run_experiment.py --condition both --workers 4  # parallel tasks

Writes per-task JSONL to experiments/results/<condition>.jsonl
"""

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Ensure project root is on path
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from experiments.agent_harness import run_episode

TASKS_FILE = ROOT / "tests/benchmark/multi-codebase-tasks.jsonl"
RESULTS_DIR = ROOT / "experiments/results"

def resolve_repo_root(specs_dir: str, guardian_root: Path) -> str:
    if specs_dir == ".specs":
        return str(guardian_root)
    repo = (guardian_root / specs_dir).parent.resolve()
    return str(repo)


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


def run_condition(condition: str, tasks: list[dict], model: str, verbose: bool, workers: int):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RESULTS_DIR / f"{condition}.jsonl"

    # Load already-completed task IDs to allow resuming
    done_ids = set()
    write_lock = threading.Lock()
    if out_path.exists():
        with open(out_path) as f:
            for line in f:
                try:
                    done_ids.add(json.loads(line)["task_id"])
                except Exception:
                    pass

    pending = [t for t in tasks if t["id"] not in done_ids]
    total = len(tasks)
    completed_count = len(done_ids)

    print(f"\n{'='*60}")
    print(f"Condition: {condition.upper()} | Model: {model} | Workers: {workers}")
    print(f"Tasks: {len(pending)} remaining (of {total} total)")
    print(f"Output: {out_path}")
    print(f"{'='*60}\n")

    if not pending:
        print("Done. Results written to", out_path)
        return

    def run_task(task: dict) -> tuple[dict, any]:
        specs_dir_rel = task.get("specs_dir", ".specs")
        specs_dir_abs = str((ROOT / specs_dir_rel).resolve())
        repo_root = resolve_repo_root(specs_dir_rel, ROOT)
        if "bench-repos" in specs_dir_rel:
            repo_root = str((ROOT / specs_dir_rel).parent.resolve())

        result = run_episode(
            task=task,
            condition=condition,
            model=model,
            repo_root=repo_root,
            specs_dir=specs_dir_abs,
            max_turns=15,
            verbose=verbose,
        )
        return task, result

    counter_lock = threading.Lock()
    counter = [completed_count]

    with open(out_path, "a") as out_f:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(run_task, task): task for task in pending}
            for future in as_completed(futures):
                task, result = future.result()
                with counter_lock:
                    counter[0] += 1
                    n = counter[0]
                correct = "✓" if result.declared_correctly else "✗"
                print(f"  [{n}/{total}] {task['id']} ({task.get('language','?')}) {correct} | hits={result.files_hit}/{len(result.gt_files)} | turns={result.turns} | tok_in={result.tokens_in}")
                with write_lock:
                    out_f.write(json.dumps(result.to_dict()) + "\n")
                    out_f.flush()

    print(f"\nDone. Results written to {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Run Guardian agent-in-loop experiment")
    parser.add_argument("--condition", choices=["baseline", "guardian", "both"], default="both")
    parser.add_argument("--model", default="gemma4:latest", help="Ollama model name")
    parser.add_argument("--tasks", default=str(TASKS_FILE), help="Path to tasks JSONL")
    parser.add_argument("--verbose", action="store_true", help="Print tool calls")
    parser.add_argument("--dry-run", action="store_true", help="Print tasks without running")
    parser.add_argument("--workers", type=int, default=1, help="Parallel task workers (requires Ollama OLLAMA_NUM_PARALLEL)")
    args = parser.parse_args()

    tasks = load_tasks(Path(args.tasks))
    print(f"Loaded {len(tasks)} tasks from {args.tasks}")

    if args.dry_run:
        for t in tasks:
            print(f"  {t['id']} | {t.get('language')} | {t.get('specs_dir')}")
        return

    conditions = ["baseline", "guardian"] if args.condition == "both" else [args.condition]
    for cond in conditions:
        run_condition(cond, tasks, args.model, args.verbose, args.workers)


if __name__ == "__main__":
    main()
