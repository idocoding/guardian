"""
Generate benchmark tasks from git history of a repository.

Strategy:
  - Find commits that touch 2-5 source files (meaningful feature additions)
  - Commit message → task description + query keywords
  - Changed files → ground truth files
  - Filter out noise (migrations, tests, docs, configs)

Usage:
  python experiments/generate_tasks.py --repo /path/to/repo --specs-dir .specs --out tasks.jsonl
  python experiments/generate_tasks.py --repo /path/to/repo --specs-dir .specs --out tasks.jsonl --n 20 --lang go

Repos to try (clone first, then run guardian intel):
  git clone https://github.com/gin-gonic/gin bench-repos/gin
  git clone https://github.com/pallets/flask bench-repos/flask
  git clone https://github.com/django/django bench-repos/django
  git clone https://github.com/expressjs/express bench-repos/express
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# File extensions to count as "source" (skip assets, configs, docs)
SOURCE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".cs",
    ".rb", ".rs", ".cpp", ".c", ".h", ".php", ".swift", ".kt",
}
SKIP_PATTERNS = [
    r"test", r"spec", r"migration", r"alembic", r"__pycache__",
    r"\.min\.", r"vendor/", r"node_modules/", r"\.lock$",
    r"setup\.py$", r"requirements", r"package\.json$", r"\.yaml$",
    r"\.yml$", r"\.md$", r"\.txt$", r"\.env", r"dockerfile",
    r"\.gitignore", r"\.github/",
    r"docs_src/", r"examples/", r"tutorial",  # tutorial/example files are not nav targets
]
SKIP_RE = re.compile("|".join(SKIP_PATTERNS), re.IGNORECASE)

# Commit messages that indicate doc/style-only changes — not useful for code navigation
DOC_STYLE_RE = re.compile(
    r"^(docs?|chore|style|ci|build|release|bump|changelog|typo|typos?|"
    r"correct\s+typo|fix\s+typo|update\s+(readme|changelog|docs?|comment)|"
    r"improve\s+(documentation|docs?|comment|readme)|"
    r"add\s+(docstring|comment|copyright|license)|"
    r"grammar|spelling|formatting|whitespace|lint|nit\b)",
    re.IGNORECASE,
)


def is_poor_query(query: str) -> bool:
    """Return True if query has too few unique meaningful words to be a useful navigation task."""
    words = set(query.split())
    stopwords = {"fix", "add", "update", "improve", "change", "remove", "use", "make", "get", "set"}
    meaningful = words - stopwords
    return len(meaningful) < 2


def is_source_file(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    if ext not in SOURCE_EXTS:
        return False
    if SKIP_RE.search(path):
        return False
    return True


def get_commits(repo: str, n: int = 200) -> list[dict]:
    """Get recent commits with their changed files."""
    result = subprocess.run(
        ["git", "log", "--pretty=format:%H|||%s", f"-{n}"],
        cwd=repo, capture_output=True, text=True
    )
    commits = []
    for line in result.stdout.strip().split("\n"):
        if "|||" not in line:
            continue
        sha, msg = line.split("|||", 1)
        sha = sha.strip()
        msg = msg.strip()

        # Get files changed in this commit
        diff = subprocess.run(
            ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", sha],
            cwd=repo, capture_output=True, text=True
        )
        files = [f.strip() for f in diff.stdout.strip().split("\n") if f.strip()]
        source_files = [f for f in files if is_source_file(f)]

        if 2 <= len(source_files) <= 5:
            commits.append({"sha": sha, "message": msg, "files": source_files})

    return commits


def message_to_query(msg: str) -> str:
    """Extract search keywords from a commit message."""
    # Strip common prefixes (feat:, fix:, refactor:, etc.)
    msg = re.sub(r"^(feat|fix|refactor|add|update|improve|chore|docs|test|style|perf|ci)(\([^)]+\))?:\s*", "", msg, flags=re.IGNORECASE)
    # Remove issue refs, PR numbers
    msg = re.sub(r"#\d+", "", msg)
    msg = re.sub(r"\b(and|the|for|with|into|from|when|that|this|also|using|via)\b", "", msg, flags=re.IGNORECASE)
    # Lowercase, strip punctuation, collapse spaces
    msg = re.sub(r"[^\w\s]", " ", msg.lower())
    msg = re.sub(r"\s+", " ", msg).strip()
    # Take first 8 words as query
    words = msg.split()[:8]
    return " ".join(words)


def infer_language(files: list[str]) -> str:
    ext_map = {
        ".py": "python", ".ts": "typescript", ".tsx": "typescript",
        ".js": "javascript", ".jsx": "javascript", ".go": "go",
        ".java": "java", ".cs": "csharp", ".rb": "ruby",
        ".rs": "rust", ".cpp": "cpp", ".c": "c",
    }
    counts: dict[str, int] = {}
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        lang = ext_map.get(ext, "unknown")
        counts[lang] = counts.get(lang, 0) + 1
    return max(counts, key=counts.get) if counts else "unknown"


def generate_tasks(
    repo: str,
    specs_dir: str,
    repo_id: str,
    n: int = 20,
    lang_filter: str | None = None,
) -> list[dict]:
    commits = get_commits(repo, n=200)
    tasks = []
    seen_files: set[frozenset] = set()

    for commit in commits:
        files = commit["files"]
        lang = infer_language(files)

        if lang_filter and lang != lang_filter:
            continue

        # Deduplicate tasks with same file set
        file_key = frozenset(files)
        if file_key in seen_files:
            continue
        seen_files.add(file_key)

        msg = commit["message"]
        # Skip doc/style-only commits — they make poor navigation tasks
        if DOC_STYLE_RE.match(msg):
            continue
        query = message_to_query(msg)
        if not query or len(query) < 5 or is_poor_query(query):
            continue

        task_id = f"{repo_id}-{commit['sha'][:7]}"
        tasks.append({
            "id": task_id,
            "repo": repo_id,
            "description": msg,
            "query": query,
            "ground_truth_files": files,
            "ground_truth_symbols": [],  # symbols require deeper analysis
            "language": lang,
            "source": f"git:{commit['sha'][:7]}",
            "specs_dir": specs_dir,
        })

        if len(tasks) >= n:
            break

    return tasks


def main():
    parser = argparse.ArgumentParser(description="Generate benchmark tasks from git history")
    parser.add_argument("--repo", required=True, help="Path to git repository")
    parser.add_argument("--specs-dir", required=True, help="Relative path to .specs dir (used in task)")
    parser.add_argument("--repo-id", help="Short repo identifier (default: dirname)")
    parser.add_argument("--out", required=True, help="Output JSONL file")
    parser.add_argument("--n", type=int, default=20, help="Number of tasks to generate")
    parser.add_argument("--lang", help="Filter by language (python, go, java, etc.)")
    parser.add_argument("--append", action="store_true", help="Append to existing output file")
    args = parser.parse_args()

    repo_id = args.repo_id or Path(args.repo).name
    tasks = generate_tasks(
        repo=args.repo,
        specs_dir=args.specs_dir,
        repo_id=repo_id,
        n=args.n,
        lang_filter=args.lang,
    )

    mode = "a" if args.append else "w"
    with open(args.out, mode) as f:
        for t in tasks:
            f.write(json.dumps(t) + "\n")

    print(f"Generated {len(tasks)} tasks → {args.out}")
    for t in tasks:
        print(f"  {t['id']} | {t['language']} | files={t['ground_truth_files']}")


if __name__ == "__main__":
    main()
