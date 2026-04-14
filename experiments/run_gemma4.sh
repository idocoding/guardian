#!/bin/bash
# Run experiment with gemma4:latest + fixed system prompt
# Run after qwen2.5:3b run completes

cd /Users/harishkumar/KagazKala/toolbaux_guardian

mkdir -p experiments/results/gemma4

# Baseline condition
python3 experiments/run_experiment.py \
  --condition baseline \
  --model gemma4:latest \
  --tasks tests/benchmark/multi-codebase-tasks.jsonl \
  --output experiments/results/gemma4/baseline.jsonl \
  > experiments/results/gemma4/run_baseline.log 2>&1

# Guardian condition (with fixed system prompt — verify before declare)
python3 experiments/run_experiment.py \
  --condition guardian \
  --model gemma4:latest \
  --tasks tests/benchmark/multi-codebase-tasks.jsonl \
  --output experiments/results/gemma4/guardian.jsonl \
  > experiments/results/gemma4/run_guardian.log 2>&1

echo "gemma4 run complete"
