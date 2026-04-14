"""
Agent Harness — Guardian vs Baseline navigation experiment.

Runs a single LLM agent (gemma4 via ollama) on a navigation task under
one of two conditions:
  - baseline: list_dir + read_file only
  - guardian: + guardian_search + guardian_orient

The agent is asked to find the files/symbols implementing a described feature,
then call declare_answer(). We measure accuracy vs ground truth and efficiency.
"""

import json
import os
import subprocess
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import re

import requests  # pip install requests

OLLAMA_URL = "http://localhost:11434/api/chat"
READ_TRUNCATE = 3000   # chars — keeps tokens manageable for large files
MAX_DIR_ENTRIES = 60   # cap list_dir to avoid flooding context


# ── Tool definitions ──────────────────────────────────────────────────────────

TOOLS_BASELINE = [
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and subdirectories in a directory. Use to explore the codebase.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative or absolute directory path"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a source file. Contents are truncated at 3000 characters.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative or absolute file path"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "declare_answer",
            "description": "Declare your final answer: the files and symbols that implement the described feature. Call this when confident.",
            "parameters": {
                "type": "object",
                "properties": {
                    "files": {"type": "array", "items": {"type": "string"}, "description": "List of file paths"},
                    "symbols": {"type": "array", "items": {"type": "string"}, "description": "List of function/class names"}
                },
                "required": ["files", "symbols"]
            }
        }
    }
]

TOOLS_GUARDIAN = TOOLS_BASELINE + [
    {
        "type": "function",
        "function": {
            "name": "guardian_orient",
            "description": "Get a compressed architectural overview of this codebase: modules, dependencies, key files. Call this first to orient yourself.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "guardian_search",
            "description": "Search the codebase index for files, endpoints, models, and symbols matching a query. Much faster than manual exploration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query, e.g. 'chat session authentication'"}
                },
                "required": ["query"]
            }
        }
    }
]

SYSTEM_BASELINE = """You are a code navigation agent. Find which files and symbols implement a described feature.

Tools: list_dir(path), read_file(path), declare_answer(files, symbols)

Rules:
- EVERY response MUST be a tool call — never respond with text alone
- Explore from repo root → find relevant dirs → read likely files → declare
- Call declare_answer() as soon as you have found the right files"""

SYSTEM_GUARDIAN = """You are a code navigation agent. Find which files and symbols implement a described feature.

Tools: read_file(path), list_dir(path), declare_answer(files, symbols)

You will receive architectural context and search results at the start. Use them to go directly to the right files.

Rules:
- EVERY response MUST be a tool call — never respond with text alone
- Read the top candidate files from the search results to verify they contain the feature
- Call declare_answer(files, symbols) once you have confirmed the right files
- If top candidates don't match, use list_dir() to explore further"""


# ── Tool dispatch ─────────────────────────────────────────────────────────────

def dispatch_tool(name: str, args: dict, repo_root: str, specs_dir: str) -> str:
    """Execute a tool call and return the result as a string."""

    if name == "list_dir":
        path = args.get("path", ".")
        abs_path = path if os.path.isabs(path) else os.path.join(repo_root, path)
        try:
            entries = sorted(os.listdir(abs_path))[:MAX_DIR_ENTRIES]
            lines = []
            for e in entries:
                full = os.path.join(abs_path, e)
                marker = "/" if os.path.isdir(full) else ""
                lines.append(f"  {e}{marker}")
            return "\n".join(lines) or "(empty directory)"
        except Exception as e:
            return f"Error: {e}"

    elif name == "read_file":
        path = args.get("path", "")
        abs_path = path if os.path.isabs(path) else os.path.join(repo_root, path)
        try:
            content = Path(abs_path).read_text(encoding="utf-8", errors="replace")
            if len(content) > READ_TRUNCATE:
                content = content[:READ_TRUNCATE] + f"\n... [truncated at {READ_TRUNCATE} chars]"
            return content
        except Exception as e:
            return f"Error reading file: {e}"

    elif name == "guardian_orient":
        try:
            result = subprocess.run(
                ["node", "dist/cli.js", "search", "--orient", "--input", specs_dir],
                capture_output=True, text=True, timeout=15,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            )
            out = result.stdout.strip()
            return out or "(no results)"
        except Exception as e:
            return f"Error: {e}"

    elif name == "guardian_search":
        query = args.get("query", "")
        try:
            result = subprocess.run(
                ["node", "dist/cli.js", "search", "--query", query, "--format", "json", "--input", specs_dir],
                capture_output=True, text=True, timeout=15,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            )
            out = result.stdout.strip()
            if len(out) > 3000:
                out = out[:3000] + "\n... [truncated]"
            return out or "(no results)"
        except Exception as e:
            return f"Error: {e}"

    elif name == "declare_answer":
        # Handled by the caller — return a confirmation
        return "Answer declared."

    return f"Unknown tool: {name}"


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class EpisodeResult:
    task_id: str
    condition: str
    model: str
    # Ground truth
    gt_files: list[str]
    gt_symbols: list[str]
    # Agent declaration
    declared_files: list[str] = field(default_factory=list)
    declared_symbols: list[str] = field(default_factory=list)
    # Accuracy
    files_hit: int = 0
    symbols_hit: int = 0
    declared_correctly: bool = False   # ≥1 correct file declared
    # Efficiency
    turns: int = 0
    tool_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    first_hit_turn: int = -1  # turn at which first correct file appeared in tool calls
    # Meta
    error: str = ""
    duration_sec: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ── Core agent loop ───────────────────────────────────────────────────────────

def run_episode(
    task: dict,
    condition: str,
    model: str,
    repo_root: str,
    specs_dir: str,
    max_turns: int = 15,
    verbose: bool = False
) -> EpisodeResult:
    """Run a single agent episode on one task under one condition."""

    task_id = task["id"]
    gt_files = task.get("ground_truth_files", [])
    gt_symbols = task.get("ground_truth_symbols", [])
    description = task.get("description", task.get("query", ""))

    result = EpisodeResult(
        task_id=task_id,
        condition=condition,
        model=model,
        gt_files=gt_files,
        gt_symbols=gt_symbols,
    )

    tools = TOOLS_GUARDIAN if condition == "guardian" else TOOLS_BASELINE
    system = SYSTEM_GUARDIAN if condition == "guardian" else SYSTEM_BASELINE

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": (
            f"Task: {description}\n\n"
            f"Repo root: {repo_root}\n"
            f"Find the files and symbols implementing this. Call declare_answer() when done."
        )}
    ]

    # Guardian pre-fill: inject orient + search as upfront context (not fake tool calls).
    # Injecting as a user message avoids confusing models about their tool-call history.
    if condition == "guardian":
        query = task.get("query", description)
        orient_result = dispatch_tool("guardian_orient", {}, repo_root, specs_dir)
        search_result = dispatch_tool("guardian_search", {"query": query}, repo_root, specs_dir)
        messages.append({
            "role": "user",
            "content": (
                f"GUARDIAN CONTEXT (pre-indexed):\n\n"
                f"Architecture:\n{orient_result}\n\n"
                f"Search results for \"{query}\":\n{search_result}\n\n"
                f"These are the most likely files. Call read_file() on the top 2-3 candidates to verify, "
                f"then call declare_answer() with the files you confirmed. "
                f"Declare what you found even if incomplete — partial answers are accepted. "
                f"Start now — call read_file() on the first candidate."
            )
        })
        if verbose:
            print(f"  [pre] guardian_orient() → {len(orient_result)} chars")
            print(f"  [pre] guardian_search({query!r}) → {len(search_result)} chars")

    start = time.time()
    declared = False
    read_file_calls = 0  # track for declaration gating

    for turn in range(max_turns):
        result.turns = turn + 1

        # Call LLM
        try:
            resp = requests.post(OLLAMA_URL, json={
                "model": model,
                "messages": messages,
                "tools": tools,
                "stream": False,
                "options": {"num_predict": 1024, "temperature": 0.1, "think": False}
            }, timeout=120)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            result.error = str(e)
            break

        msg = data.get("message", {})
        # Track tokens
        result.tokens_in += data.get("prompt_eval_count", 0)
        result.tokens_out += data.get("eval_count", 0)

        # Check for tool calls
        tool_calls = msg.get("tool_calls") or []

        # qwen3-coder sometimes emits XML-style calls in content instead of tool_calls:
        #   <function=read_file>\n<parameter=path>\nsome/file.py\n</parameter>
        # Parse and convert these so the loop can dispatch them normally.
        if not tool_calls:
            content = msg.get("content", "") or ""
            xml_calls = re.findall(
                r"<function=(\w+)>(.*?)</function>|<function=(\w+)>\s*<parameter=(\w+)>\s*(.*?)\s*</parameter>",
                content, re.DOTALL
            )
            # Simpler pattern that covers the observed format
            for m in re.finditer(r"<function=(\w+)>([\s\S]*?)(?:</function>|$)", content):
                fn_name = m.group(1)
                body = m.group(2)
                args: dict = {}
                for pm in re.finditer(r"<parameter=(\w+)>\s*([\s\S]*?)\s*</parameter>", body):
                    args[pm.group(1)] = pm.group(2).strip()
                if fn_name and args:
                    tool_calls.append({"function": {"name": fn_name, "arguments": args}})
            if tool_calls and verbose:
                print(f"  [xml-parse] recovered {len(tool_calls)} call(s) from content")

        if verbose and turn == 0:
            print(f"  [dbg turn1] raw tool_calls={msg.get('tool_calls')} content={repr(msg.get('content','')[:60])}")
        if not tool_calls:
            # No tool call — model gave a text response.
            # Do NOT add the text response to history — it poisons subsequent turns
            # by making the model think chat-mode is acceptable. Just nudge directly.
            if read_file_calls == 0 and condition == "guardian":
                nudge = "Call read_file() on the first candidate file from the search results above. Do not explain — just call the tool now."
            elif read_file_calls == 0:
                nudge = "Call list_dir() or read_file() to explore the codebase. Do not explain — just call a tool now."
            elif read_file_calls >= 2:
                nudge = f"You have read {read_file_calls} files. Call declare_answer() NOW with what you found — partial answers are accepted. Do not keep exploring."
            else:
                nudge = f"You have read {read_file_calls} file(s). Call read_file() on another candidate or call declare_answer() with what you found so far."
            messages.append({"role": "user", "content": nudge})
            continue

        # Model made tool calls — add the assistant message to history
        messages.append(msg)

        # Dispatch each tool call
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}

            result.tool_calls += 1

            if verbose:
                print(f"  [{turn+1}] {name}({json.dumps(args)[:80]})")

            if name == "declare_answer":
                def _coerce_list(v):
                    """XML args come as JSON strings; normalize to list."""
                    if isinstance(v, list):
                        return v
                    if isinstance(v, str):
                        try:
                            parsed = json.loads(v)
                            return parsed if isinstance(parsed, list) else [v]
                        except Exception:
                            return [v] if v else []
                    return []
                result.declared_files = _coerce_list(args.get("files", []))
                result.declared_symbols = _coerce_list(args.get("symbols", []))
                declared = True

                # Score
                gt_files_norm = [os.path.basename(f).lower() for f in gt_files]
                decl_norm = [os.path.basename(f).lower() for f in result.declared_files]
                result.files_hit = sum(1 for g in gt_files_norm if g in decl_norm)
                result.symbols_hit = sum(
                    1 for g in gt_symbols
                    if any(g.lower() in s.lower() for s in result.declared_symbols)
                )
                result.declared_correctly = result.files_hit >= 1
                break
            else:
                if name == "read_file":
                    read_file_calls += 1
                tool_result = dispatch_tool(name, args, repo_root, specs_dir)

                # Track first_hit_turn: did this tool result surface a GT file?
                if result.first_hit_turn == -1:
                    gt_basenames = [os.path.basename(f).lower() for f in gt_files]
                    if any(b in tool_result.lower() for b in gt_basenames):
                        result.first_hit_turn = turn + 1

                # Append deadline pressure on the last 3 turns so the model declares rather than looping
                if turn >= max_turns - 3 and read_file_calls >= 1:
                    tool_result += "\n\n[SYSTEM] You are running low on turns. Call declare_answer() NOW with the best files you have found. Partial answers are accepted — do not keep exploring."
                messages.append({
                    "role": "tool",
                    "content": tool_result
                })

        if declared:
            break

    result.duration_sec = round(time.time() - start, 2)
    return result
