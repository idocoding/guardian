"""Quick smoke test — runs 1 task under both conditions and prints result."""
import sys
from pathlib import Path
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from experiments.agent_harness import run_episode

TASK = {
    "id": "go-articles-001",
    "description": "Find article CRUD and favorite handling in Go realworld",
    "query": "article create favorite router model",
    "ground_truth_files": ["articles/routers.go", "articles/models.go"],
    "ground_truth_symbols": ["ArticleCreate", "GetArticleUserModel", "isFavoriteBy"],
    "specs_dir": "../VSCode/fixtures-specguard/go-realworld/.specs",
    "language": "go",
}

REPO_ROOT = str((ROOT / "../VSCode/fixtures-specguard/go-realworld").resolve())
SPECS_DIR = str((ROOT / "../VSCode/fixtures-specguard/go-realworld/.specs").resolve())

for condition in ["baseline", "guardian"]:
    print(f"\n{'='*50}\nCondition: {condition.upper()}\n{'='*50}")
    r = run_episode(
        task=TASK,
        condition=condition,
        model="gemma4:latest",
        repo_root=REPO_ROOT,
        specs_dir=SPECS_DIR,
        max_turns=15,
        verbose=True,
    )
    print(f"\nResult:")
    print(f"  Declared correctly: {r.declared_correctly}")
    print(f"  Files hit:    {r.files_hit}/{len(r.gt_files)} {r.declared_files}")
    print(f"  Symbols hit:  {r.symbols_hit}/{len(r.gt_symbols)}")
    print(f"  Turns:        {r.turns}")
    print(f"  Tool calls:   {r.tool_calls}")
    print(f"  Tokens in:    {r.tokens_in}")
    print(f"  First hit:    turn {r.first_hit_turn}")
    print(f"  Duration:     {r.duration_sec}s")
