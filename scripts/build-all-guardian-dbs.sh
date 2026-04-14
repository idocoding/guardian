#!/usr/bin/env bash
# Build guardian.db (SQLite FTS5 index) for all bench repos and fixture repos.
# Run BEFORE the benchmark:
#   npm run build && bash scripts/build-all-guardian-dbs.sh
set -euo pipefail

GUARDIAN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$GUARDIAN_ROOT/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: $CLI not found — run 'npm run build' first"
  exit 1
fi

ok=0
fail=0

run_extract() {
  local repo_dir="$1"
  local label="$2"
  if [[ ! -d "$repo_dir" ]]; then
    echo "  SKIP $label — directory not found"
    return
  fi
  echo -n "  $label ... "
  if (cd "$repo_dir" && node "$CLI" extract --backend sqlite --output .specs 2>&1 | tail -1); then
    ok=$((ok + 1))
  else
    echo "  WARN: extract failed for $label"
    fail=$((fail + 1))
  fi
}

echo "=== Building guardian.db for all repos ==="
echo ""

echo "── bench-repos ──────────────────────────────────────────────"
for REPO in "$GUARDIAN_ROOT"/bench-repos/*/; do
  REPO_NAME="$(basename "$REPO")"
  run_extract "$REPO" "bench-repos/$REPO_NAME"
done

echo ""
echo "── fixtures-specguard ───────────────────────────────────────"
FIXTURES="$GUARDIAN_ROOT/../VSCode/fixtures-specguard"
if [[ -d "$FIXTURES" ]]; then
  for REPO in "$FIXTURES"/*/; do
    REPO_NAME="$(basename "$REPO")"
    run_extract "$REPO" "fixtures-specguard/$REPO_NAME"
  done
else
  echo "  SKIP — $FIXTURES not found"
fi

echo ""
echo "── VSCode project repos ─────────────────────────────────────"
VSCODE="$GUARDIAN_ROOT/../VSCode"
for PROJECT in yowi_app ghostwriter "toolbaux/mrcp_med"; do
  if [[ -d "$VSCODE/$PROJECT" ]]; then
    run_extract "$VSCODE/$PROJECT" "$PROJECT"
  fi
done

echo ""
echo "=== Done: $ok succeeded, $fail failed ==="
echo "Verify with: guardian search --query <term> --backend sqlite"
