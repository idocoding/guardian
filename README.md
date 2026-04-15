# Guardian

[![npm version](https://img.shields.io/npm/v/@toolbaux/guardian.svg)](https://www.npmjs.com/package/@toolbaux/guardian)
[![license](https://img.shields.io/npm/l/@toolbaux/guardian.svg)](./LICENSE)

> **Beta Release** — Guardian is under active development. Core features (extract, context, drift, MCP server) are stable and used daily across multiple projects, but you may encounter minor issues with edge cases in framework detection or config handling. Bug reports and feedback welcome via [GitHub Issues](https://github.com/idocoding/guardian/issues).

Architectural intelligence for codebases. One command turns your repo into compact, machine-readable context that AI coding tools can reason about without hallucinating.

```bash
npm install -g @toolbaux/guardian
guardian init
```

## The Problem

AI coding tools hallucinate when they don't understand your architecture. They guess at imports, invent schemas that don't exist, and edit high-coupling files without understanding the blast radius.

**Without Guardian** — Cursor generates this:

```python
from app.schemas import UpdateCaseRequest  # ← doesn't exist
from app.models import User               # ← it's actually UserProfile
from shared.utils import validate          # ← wrong module, it's in shared.policy
```

**With Guardian** — the AI reads your architecture context and generates:

```python
from shared.policy.persona import ChildProfile        # ✓ exact import path
from service_conversation.engine import ConversationEngine  # ✓ correct module
from shared.content.retriever import ContentRetriever  # ✓ verified by AST
```

Guardian extracts exact boundaries, coupling hotspots, model-to-endpoint relationships, page routes, and data flows from your source code using Tree-Sitter AST parsing. No LLM involved in extraction — deterministic, reproducible, fast.

## How It Works

```
Developer writes code
    ↓ (save)
VSCode extension (5s debounce)
    ↓
guardian extract → .specs/ + guardian.db (BM25 search index)
guardian generate --ai-context → reads from guardian.db, writes CLAUDE.md
Status bar: "✓ Guardian: stable · 35 ep · 8 pg"
    ↓ (git commit)
Pre-commit hook: extract + context → auto-staged
    ↓
Claude Code reads CLAUDE.md at session start
Claude Code calls MCP tools (guardian_search, guardian_grep, guardian_glob…)
    ↓ fresh, indexed context on every query
```

After `guardian init`, your project gets:
- `.specs/` directory with architecture snapshots + `guardian.db` (SQLite search index)
- `CLAUDE.md` with auto-injected context (refreshed on every save and commit)
- Pre-commit hook that keeps context fresh automatically
- `.mcp.json` wiring Claude Code and Cursor to Guardian's MCP server
- `guardian.config.json` with a unique `project_id` and auto-detected roots
- MCP-first hook: Claude Code is nudged to call `guardian_search` before reading source files

## Claude Code / Cursor Integration

Guardian auto-injects architecture context into `CLAUDE.md` so your AI tool reads it at session start:

```markdown
# my-project

<!-- guardian:auto-context -->
## Codebase Map
**Backend:** 16 schemas · 35 endpoints · 9 modules
**Frontend:** 10 components · 8 pages

### High-Coupling Files
- shared/policy/__init__.py (score 1.00)
- service-conversation/engine.py (score 0.40)

### Key Model → Endpoint Map
- ChildProfile (1 endpoints) → POST /sessions/start
- StartSessionResponse (1 endpoints) → POST /sessions/start
<!-- /guardian:auto-context -->
```

The block between markers is replaced on every save (VSCode extension) and every commit (pre-commit hook). Your manual content outside the markers is never touched.

## MCP Server — AI Tools Connect Directly

Guardian includes an MCP server that Claude Code and Cursor connect to automatically. The VSCode extension sets this up on first activation — no manual config needed.

**8 compact tools available to AI:**

| Tool | Tokens | Purpose |
|------|--------|---------|
| `guardian_orient` | ~100 | Project summary at session start |
| `guardian_context` | ~50-80 | File or endpoint dependencies before editing |
| `guardian_impact` | ~30 | What breaks if you change a file |
| `guardian_search` | ~70 | Find endpoints, models, modules, and functions by keyword |
| `guardian_model` | ~90 | Full field details (only when needed) |
| `guardian_metrics` | ~50 | Session usage stats |
| `guardian_grep` | ~40 | Semantic grep — search symbols and literals across the codebase |
| `guardian_glob` | ~30 | Semantic file discovery — find files by pattern with module context |

All responses are compact JSON — no pretty-printing, no verbose keys. Repeated calls are cached (30s TTL). Usage metrics tracked per session.

**Setup:** `guardian init` and the VSCode extension auto-create `.mcp.json` at your project root. If you need to create it manually:

```json
{
  "mcpServers": {
    "guardian": {
      "command": "guardian",
      "args": ["mcp-serve", "--specs", ".specs"]
    }
  }
}
```

> **Note:** After `.mcp.json` is created or modified, you must **restart your Claude Code / Cursor session** (or reload the VSCode window) for the MCP server to connect. MCP config is only read at session start.

### MCP-First Hook

`guardian init` also installs a Claude Code hook that encourages AI tools to call Guardian before reading source files directly. The hook is session-scoped — once any `guardian_*` tool is called, file reads are unblocked for the rest of the session. No repeated interruptions.

The block message tells Claude exactly what to call:
```
Call one of these first:
  guardian_search("your query")  — find files/symbols/endpoints by keyword
  guardian_grep("pattern")       — semantic grep (replaces Grep tool)
  guardian_glob("src/auth/**")   — semantic file discovery (replaces Glob tool)
  guardian_orient()              — get codebase overview
```

## VSCode Extension

Install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=toolbaux.toolbaux-guardian):

Search "ToolBaux Guardian" in Extensions, or:
```
Cmd+Shift+P → "Extensions: Install from VSIX"
```

**What it does automatically:**
- Creates `.specs/`, config, and pre-commit hook on first activation
- Configures MCP server for Claude Code and Cursor (`.mcp.json`)
- Extracts architecture on every file save (5s debounce)
- Shows drift status in status bar: `✓ Guardian: stable · 35 ep · 8 pg`

**Commands** (Cmd+Shift+P):
- Guardian: Initialize Project
- Guardian: Generate AI Context
- Guardian: Drift Check
- Guardian: Generate Constraints

## Key Commands

```bash
# One-time setup — config, .specs/, guardian.db, pre-commit hook, .mcp.json, CLAUDE.md
guardian init

# Extract architecture + build search index (guardian.db built automatically)
guardian extract

# Extract without DB (CI environments that don't need search)
guardian extract --backend file

# Search your codebase by concept (uses guardian.db when available)
guardian search --query "session"
guardian search --query "auth" --types functions,endpoints

# Inject fresh context into CLAUDE.md
guardian context --output CLAUDE.md

# Compute architectural drift
guardian drift

# Generate HTML docs (open in browser, no server needed)
guardian doc-html
```

## Framework Support

**Frontend:** Expo Router, Next.js, React Router — auto-detected from `package.json`
**Backend:** FastAPI, Django, Express, Spring Boot, Gin, ASP.NET Core

All extraction uses Tree-Sitter AST parsing — deterministic, no LLM involved.

## LLM Usage — Opt-In Only

> **Important:** Guardian's core commands (`extract`, `generate`, `context`, `drift`, `search`, `init`) **never call an LLM**. All extraction is deterministic AST parsing — no API keys needed, no background AI calls, no cost.

Two commands **optionally** use an LLM, and **only when you explicitly configure it**:

| Command | What the LLM does | Runs automatically? |
|---------|-------------------|-------------------|
| `guardian doc-generate` | Adds narrative summaries to product docs | **No** — manual command only |
| `guardian guard --task "..."` | Generates a code patch from a task description | **No** — manual command only |

**If you never set API keys, no LLM is ever called.** These commands degrade gracefully — `doc-generate` produces docs without narrative sections, and `guard` prints context instead of generating patches.

### Configuring LLM (optional)

```bash
# Option 1: Cloud LLM (OpenAI-compatible endpoint)
export GUARDIAN_LLM_ENDPOINT="https://api.openai.com/v1"
export GUARDIAN_LLM_API_KEY="sk-..."
export GUARDIAN_LLM_MODEL="gpt-4o"         # optional, defaults to gpt-4o

# Option 2: Local Ollama (no API key needed, auto-detected)
# Just have Ollama running on localhost:11434
export GUARDIAN_OLLAMA_HOST="http://localhost:11434"  # optional, this is the default
export GUARDIAN_OLLAMA_MODEL="llama3.2"                # optional, this is the default

# Option 3: Shell command (for guardian guard)
# Set in guardian.config.json:
# { "llm": { "command": "ollama", "args": ["run", "llama3"] } }
```

**No pre-commit hook, VSCode extension, or automated workflow ever triggers LLM calls.** The hook only runs `extract` + `context` (pure AST).

## What Guardian Generates

**Workflow sequence diagrams** — Mermaid diagrams for your most complex endpoints, showing the full call chain from client through handler to services and data stores.

**System architecture diagram** — Full system view: frontend → backend services → data stores → external APIs, with actual endpoint paths per service.

**Model role badges** — Each data model gets an inferred role: API Request, API Response, Configuration, Safety Policy, Entity Profile, Content Entity.

**Subsystem diagrams with real names** — Backend modules show `ConversationEngine`, `ContentRetriever`, `SessionStateMachine` instead of generic file counts.

---

## Full Reference

<details>
<summary><strong>Installation</strong></summary>

```bash
# Install from npm
npm install -g @toolbaux/guardian

# Or from source
git clone https://github.com/idocoding/guardian
cd guardian
npm install && npm run build && npm link
```

</details>

<details>
<summary><strong>All Commands (18)</strong></summary>

### Project Setup

```bash
guardian init                          # config, .specs dir, pre-commit hook, CLAUDE.md
guardian extract                       # full architecture + UX snapshots + guardian.db (default: sqlite)
guardian extract --backend file        # file-only mode, skips guardian.db
guardian generate --ai-context         # compact ~3K token AI context only
```

### Search & Context

```bash
guardian search --query "session"                        # search models, endpoints, components, functions
guardian search --query "auth" --types models,endpoints  # filter by type
guardian search --query "validate token" --types functions  # function-level search (uses guardian.db)
guardian context --focus "auth"                          # focused AI context block
guardian context --output CLAUDE.md                      # inject between auto-context markers
guardian summary                                         # executive summary
```

### Architectural Metrics

```bash
guardian drift                         # compute D_t, K_t, delta, entropy, cycles
guardian drift --baseline              # save baseline for future comparison
guardian verify-drift --baseline drift.baseline.json  # CI gate
guardian constraints                   # duplicates, cycles, similar endpoints
guardian analyze-depth --query "session"            # structural complexity
guardian analyze-depth --query "payment" --ci       # exit 1 on HIGH complexity
guardian diff --baseline old.yaml --current new.yaml
```

### Documentation

```bash
guardian doc-generate                  # LLM-powered product document
guardian doc-generate --update-baseline
guardian doc-html                      # HTML viewer (open in browser)
guardian discrepancy                   # code vs baseline drift report
```

### Simulation & LLM Guardrails

```bash
guardian simulate --patch changes.patch
guardian guard --task "add payment endpoint"
guardian guard --task "refactor auth" --print-context
guardian feature-context --spec feature-specs/billing.yaml
```

</details>

<details>
<summary><strong>Configuration</strong></summary>

`guardian.config.json` at project root (auto-created by `guardian init`). Backend and frontend roots are auto-detected at runtime — only set them if auto-detection picks the wrong directory:

```json
{
  "project_id": "auto-generated-uuid",
  "project": {
    "description": "Short product description for generated docs",
    "backendRoot": "./backend",
    "frontendRoot": "./frontend"
  },
  "ignore": {
    "directories": ["bench-repos", "fixtures", "vendor"],
    "paths": ["src/generated"]
  },
  "frontend": {
    "routeDirs": ["app"],
    "aliases": { "@": "./frontend" }
  },
  "python": {
    "absoluteImportRoots": ["backend"]
  },
  "drift": {
    "layers": {
      "core": ["shared"],
      "top": ["service-conversation"],
      "isolated": ["service-auth", "service-content"]
    }
  },
  "llm": {
    "command": "ollama",
    "args": ["run", "llama3"]
  }
}
```

> **Tip:** Use `ignore.directories` to exclude directories that Guardian indexes but aren't part of your project (e.g. benchmark repos, vendor directories, generated code). Guardian scans all source files under the project root by design — configure ignores to keep the search index clean.

</details>

<details>
<summary><strong>Output Structure</strong></summary>

```
.specs/
├── guardian.db                      ← SQLite search index (BM25 + function call graph)
├── machine/
│   ├── architecture-context.md      ← AI context (~3K tokens)
│   ├── architecture.snapshot.yaml   ← full architecture snapshot
│   ├── ux.snapshot.yaml             ← frontend components + pages
│   ├── codebase-intelligence.json   ← unified registry
│   ├── function-intelligence.json   ← function call graph + literal index
│   ├── structural-intelligence.json ← depth/complexity per module
│   ├── drift.heatmap.json           ← file-level change frequency
│   └── docs/                        ← generated markdown docs
├── human/
│   ├── product-document.md          ← LLM-powered product doc
│   └── docs/                        ← HTML viewer (open index.html)
```

</details>

<details>
<summary><strong>Key Metrics</strong></summary>

| Metric | Meaning |
|--------|---------|
| **D_t** | Coupling delta (lower = less entangled) |
| **K_t** | Architectural complexity |
| **Delta** | Overall drift score |
| **Coupling score** | Per-module dependency pressure (0-1) |
| **Shape fingerprint** | Change = structural refactor |

</details>

<details>
<summary><strong>GitHub Action</strong></summary>

```yaml
- name: Install Guardian
  run: npm install -g @toolbaux/guardian

- name: Extract & check
  run: |
    guardian extract --output .specs
    guardian generate --ai-context --output .specs
    guardian drift
```

See [`.github/workflows/guardian.yml`](./.github/workflows/guardian.yml).

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
npm install
npm run dev -- extract .          # run from source
npm run build                     # compile to dist/
npm run typecheck                 # type check only
npm test                          # run tests
```

</details>

---

Built by [ToolBaux](https://github.com/idocoding). If Guardian helps you ship with confidence, [star the repo](https://github.com/idocoding/guardian).
