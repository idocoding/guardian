# Guardian

[![npm version](https://img.shields.io/npm/v/@toolbaux/guardian.svg)](https://www.npmjs.com/package/@toolbaux/guardian)
[![license](https://img.shields.io/npm/l/@toolbaux/guardian.svg)](./LICENSE)

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
guardian extract → .specs/
guardian generate --ai-context → .specs/
guardian context → CLAUDE.md (between markers)
Status bar: "✓ Guardian: stable · 35 ep · 8 pg"
    ↓ (git commit)
Pre-commit hook: extract + context → auto-staged
    ↓
Claude Code / Cursor reads CLAUDE.md → fresh architecture context
```

After `guardian init`, your project gets:
- `.specs/` directory with architecture snapshots
- `CLAUDE.md` with auto-injected context (refreshed on every save and commit)
- Pre-commit hook that keeps context fresh automatically
- `guardian.config.json` with auto-detected backend/frontend roots

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

## Key Commands

```bash
# One-time setup — creates config, .specs/, pre-commit hook, CLAUDE.md
guardian init

# Extract architecture (run after major changes, or let the hook do it)
guardian extract

# Search your codebase by concept
guardian search --query "session"

# Compute architectural drift
guardian drift

# Generate HTML docs (open in browser, no server needed)
guardian doc-html
```

## Framework Support

**Frontend:** Expo Router, Next.js, React Router — auto-detected from `package.json`
**Backend:** FastAPI, Django, Express, Spring Boot, Gin, ASP.NET Core

All extraction uses Tree-Sitter AST parsing — deterministic, no LLM involved.

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
guardian extract                       # full architecture + UX snapshots + docs
guardian generate --ai-context         # compact ~3K token AI context only
guardian intel                         # build codebase-intelligence.json
```

### Search & Context

```bash
guardian search --query "session"                  # search models, endpoints, components
guardian search --query "auth" --types models,endpoints
guardian context --focus "auth"                     # focused AI context block
guardian context --output CLAUDE.md                 # inject between auto-context markers
guardian summary                                   # executive summary
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

`guardian.config.json` at project root (auto-created by `guardian init`):

```json
{
  "project": {
    "backendRoot": "./backend",
    "frontendRoot": "./frontend",
    "description": "Short product description for generated docs"
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

</details>

<details>
<summary><strong>Output Structure</strong></summary>

```
.specs/
├── machine/
│   ├── architecture-context.md      ← AI context (~3K tokens)
│   ├── architecture.snapshot.yaml   ← full architecture snapshot
│   ├── ux.snapshot.yaml             ← frontend components + pages
│   ├── codebase-intelligence.json   ← unified registry
│   ├── drift.report.json            ← drift metrics
│   ├── constraints.json             ← duplicates, cycles
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
