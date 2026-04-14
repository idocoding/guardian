"""
Results analysis — compares baseline vs guardian conditions.

Usage:
  python experiments/analyze.py
  python experiments/analyze.py --output experiments/results/analysis.md
"""

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent.parent
RESULTS_DIR = ROOT / "experiments/results"


def load_results(path: Path) -> dict[str, dict]:
    """Load JSONL results keyed by task_id."""
    results = {}
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                results[r["task_id"]] = r
            except Exception:
                pass
    return results


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    return (s[n // 2] + s[(n - 1) // 2]) / 2


def wilcoxon_sign(diffs: list[float]) -> float:
    """Approximate Wilcoxon signed-rank p-value (two-tailed).
    Returns a rough estimate — use scipy for publication quality."""
    nonzero = [d for d in diffs if d != 0]
    if len(nonzero) < 6:
        return float("nan")
    ranks = sorted(range(len(nonzero)), key=lambda i: abs(nonzero[i]))
    W_plus = sum(r + 1 for r, d in zip(ranks, [nonzero[i] for i in ranks]) if d > 0)
    n = len(nonzero)
    mean_W = n * (n + 1) / 4
    std_W = math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
    z = (W_plus - mean_W) / std_W if std_W > 0 else 0
    # Two-tailed approximate p from z
    p = 2 * (1 - _norm_cdf(abs(z)))
    return round(p, 4)


def _norm_cdf(x: float) -> float:
    """Approximate normal CDF using Horner's method."""
    t = 1.0 / (1.0 + 0.2316419 * abs(x))
    d = 0.3989423 * math.exp(-x * x / 2)
    p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
    return 1 - p if x > 0 else p


def analyze(baseline: dict, guardian: dict, output_path: Path | None = None):
    # Only compare tasks present in both
    common = sorted(set(baseline) & set(guardian))
    print(f"Common tasks: {len(common)} (baseline={len(baseline)}, guardian={len(guardian)})")

    metrics = {
        "declared_correctly": [],
        "files_hit_rate": [],
        "turns": [],
        "tool_calls": [],
        "tokens_in": [],
        "first_hit_turn": [],
    }

    rows = []
    for tid in common:
        b = baseline[tid]
        g = guardian[tid]

        b_correct = int(b["declared_correctly"])
        g_correct = int(g["declared_correctly"])
        b_file_rate = b["files_hit"] / max(1, len(b["gt_files"]))
        g_file_rate = g["files_hit"] / max(1, len(g["gt_files"]))

        metrics["declared_correctly"].append((b_correct, g_correct))
        metrics["files_hit_rate"].append((b_file_rate, g_file_rate))
        metrics["turns"].append((b["turns"], g["turns"]))
        metrics["tool_calls"].append((b["tool_calls"], g["tool_calls"]))
        metrics["tokens_in"].append((b["tokens_in"], g["tokens_in"]))
        metrics["first_hit_turn"].append((b["first_hit_turn"], g["first_hit_turn"]))

        rows.append({
            "id": tid,
            "lang": b.get("language", b.get("task_id", "?")).split("-")[0],
            "b_correct": b_correct,
            "g_correct": g_correct,
            "b_turns": b["turns"],
            "g_turns": g["turns"],
            "b_tok": b["tokens_in"],
            "g_tok": g["tokens_in"],
            "b_files": round(b_file_rate, 2),
            "g_files": round(g_file_rate, 2),
        })

    def summarize(pairs, label, fmt=".2f", lower_better=False):
        bs = [p[0] for p in pairs]
        gs = [p[1] for p in pairs]
        diffs = [g - b for b, g in pairs]
        b_mean = mean(bs)
        g_mean = mean(gs)
        delta = g_mean - b_mean
        pct = (delta / b_mean * 100) if b_mean != 0 else float("nan")
        p = wilcoxon_sign(diffs)
        arrow = "↑" if delta > 0 else "↓"
        if lower_better:
            arrow = "↓" if delta < 0 else "↑"
        return {
            "metric": label,
            "baseline": round(b_mean, 3),
            "guardian": round(g_mean, 3),
            "delta": round(delta, 3),
            "pct_change": round(pct, 1),
            "arrow": arrow,
            "p_value": p,
        }

    summaries = [
        summarize(metrics["declared_correctly"], "Declaration accuracy (%)  ", fmt=".1%"),
        summarize(metrics["files_hit_rate"],      "File hit rate (%)          ", fmt=".1%"),
        summarize(metrics["turns"],               "Mean turns                 ", lower_better=True),
        summarize(metrics["tool_calls"],          "Mean tool calls            ", lower_better=True),
        summarize(metrics["tokens_in"],           "Mean input tokens          ", lower_better=True),
    ]

    lines = []
    lines.append("# Guardian vs Baseline — Agent-in-Loop Results\n")
    lines.append(f"Model: {guardian[common[0]]['model']}  |  Tasks: {len(common)}\n")
    lines.append("\n## Summary Table\n")
    lines.append("| Metric | Baseline | Guardian | Δ | % Change | p-value |")
    lines.append("|--------|----------|----------|---|----------|---------|")
    for s in summaries:
        sig = "**" if isinstance(s["p_value"], float) and s["p_value"] < 0.05 else ""
        lines.append(
            f"| {s['metric']}| {s['baseline']} | {s['guardian']} | "
            f"{s['arrow']} {abs(s['delta']):.3f} | {s['pct_change']:+.1f}% | {sig}{s['p_value']}{sig} |"
        )

    # Token efficiency breakdown
    tok_saved = [b - g for b, g in metrics["tokens_in"]]
    lines.append(f"\n## Token Efficiency\n")
    lines.append(f"- Mean tokens saved per task: **{mean(tok_saved):,.0f}**")
    lines.append(f"- Median tokens saved: **{median(tok_saved):,.0f}**")
    lines.append(f"- Total tokens saved across {len(common)} tasks: **{sum(tok_saved):,.0f}**")
    lines.append(f"- Max saved: {max(tok_saved):,.0f} | Min saved: {min(tok_saved):,.0f}")

    # Per-task table
    lines.append("\n## Per-Task Results\n")
    lines.append("| Task | Lang | B✓ | G✓ | B turns | G turns | B tokens | G tokens | B files% | G files% |")
    lines.append("|------|------|----|----|---------|---------|----------|----------|----------|----------|")
    for r in rows:
        b_ok = "✓" if r["b_correct"] else "✗"
        g_ok = "✓" if r["g_correct"] else "✗"
        lines.append(
            f"| {r['id']} | {r['lang']} | {b_ok} | {g_ok} | "
            f"{r['b_turns']} | {r['g_turns']} | {r['b_tok']} | {r['g_tok']} | "
            f"{r['b_files']} | {r['g_files']} |"
        )

    report = "\n".join(lines)
    print("\n" + report)

    if output_path:
        output_path.write_text(report)
        print(f"\nReport written to {output_path}")

    return summaries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default=str(RESULTS_DIR / "baseline.jsonl"))
    parser.add_argument("--guardian", default=str(RESULTS_DIR / "guardian.jsonl"))
    parser.add_argument("--output", default=str(RESULTS_DIR / "analysis.md"))
    args = parser.parse_args()

    b_path = Path(args.baseline)
    g_path = Path(args.guardian)

    if not b_path.exists():
        print(f"Baseline results not found: {b_path}")
        print("Run: python experiments/run_experiment.py --condition baseline")
        return
    if not g_path.exists():
        print(f"Guardian results not found: {g_path}")
        print("Run: python experiments/run_experiment.py --condition guardian")
        return

    baseline = load_results(b_path)
    guardian = load_results(g_path)
    analyze(baseline, guardian, Path(args.output))


if __name__ == "__main__":
    main()
