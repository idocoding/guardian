# Guardian

Architectural intelligence for codebases. One command turns your repo into compact, machine-readable context that AI coding tools can reason about without hallucinating.

## Quick Start

```bash
# Initialize a project (creates .specs/, config, pre-commit hook, CLAUDE.md context)
guardian init

# Or run extraction manually
guardian extract
guardian generate --ai-context
```

After `guardian init`, your project gets:
- `.specs/` directory with architecture snapshots
- `CLAUDE.md` with auto-injected architecture context (between `<!-- guardian:auto-context -->` markers)
- Pre-commit hook that keeps context fresh on every commit
- `guardian.config.json` with auto-detected backend/frontend roots

## What Guardian Solves

**Without Guardian:** AI invents fake schemas, imports wrong components, edits high-coupling files blindly, guesses at endpoint paths.

**With Guardian:** AI gets a deterministic map of your repo — exact boundaries, coupling hotspots, model-to-endpoint relationships, page routes, and data flows — in ~3,000 tokens.

## Installation

```bash
# From source
git clone <repo>
cd guardian
npm install && npm run build
npm link   # makes `guardian` available globally

# Or install from npm
npm install -g @toolbaux/guardian

# Initialize a project
cd /path/to/your/project
guardian init
```

### VSCode Extension

The extension adds a status bar indicator, background auto-extract on save, and command palette integration.

**Install via symlink (development):**
```bash
ln -sf /path/to/guardian/vscode-extension ~/.vscode/extensions/guardian-vscode
# Reload VSCode: Cmd+Shift+P → "Reload Window"
```

**Install via .vsix (packaged):**
```bash
cd guardian/vscode-extension
npx vsce package --allow-missing-repository
# In VSCode: Cmd+Shift+P → "Extensions: Install from VSIX" → select the .vsix file
```

**What the extension provides:**
- Status bar: `✓ Guardian: stable · 35 ep · 8 pg` — click to run drift check
- Background extract on file save (5s debounce, code files only)
- Auto-injects fresh context into CLAUDE.md on each save
- Command palette: 8 commands (see below)

**Extension settings:**
| Setting | Default | Description |
|---------|---------|-------------|
| `guardian.autoExtract` | `true` | Auto-run extract + context on file save |
| `guardian.runOnSave` | `false` | Also run drift check on save (heavier) |
| `guardian.backendRoot` | `"backend"` | Backend root relative to workspace |
| `guardian.frontendRoot` | `"frontend"` | Frontend root relative to workspace |
| `guardian.configPath` | `""` | Path to guardian.config.json |
| `guardian.debounceMs` | `750` | Debounce for drift-on-save |

## All Commands (18)

### Project Setup

```bash
# Initialize project: config, .specs dir, pre-commit hook, CLAUDE.md
guardian init

# Full extraction: architecture + UX snapshots + codebase intelligence + docs
guardian extract

# AI context file only (compact ~3K token summary)
guardian generate --ai-context

# Build codebase-intelligence.json from existing snapshots
guardian intel
```

### Search & Context

```bash
# Search all artifacts by keyword (models, endpoints, components, modules, tasks)
guardian search --query "session"
guardian search --query "auth" --types models,endpoints

# Render focused AI context block (stdout or append to file)
guardian context --focus "auth"
guardian context --output CLAUDE.md          # injects between auto-context markers
guardian context --focus "session" --output CLAUDE.md

# Executive summary from existing snapshots
guardian summary
```

### Architectural Metrics

```bash
# Compute drift metrics (D_t, K_t, delta, entropy, cycles)
guardian drift
guardian drift --baseline              # save baseline for future comparison

# Verify drift stays within threshold (for CI gates)
guardian verify-drift --baseline specs-out/machine/drift.baseline.json

# Generate constraints JSON (duplicates, cycles, similar endpoints)
guardian constraints

# Structural complexity analysis for a feature area
guardian analyze-depth --query "session"
guardian analyze-depth --query "payment" --ci  # exit 1 on HIGH complexity

# Diff between two snapshots
guardian diff --baseline old.yaml --current new.yaml
```

### Documentation

```bash
# LLM-powered product document (uses Ollama or Anthropic)
guardian doc-generate
guardian doc-generate --update-baseline    # freeze for discrepancy tracking

# HTML Javadoc-style viewer (no server needed, open in browser)
guardian doc-html

# Discrepancy report: code vs baseline (JSON + Markdown)
guardian discrepancy
```

### Simulation & LLM Guardrails

```bash
# Simulate drift impact of a patch before merging
guardian simulate --patch changes.patch

# LLM-guided code generation with drift guardrails
guardian guard --task "add payment endpoint"
guardian guard --task "refactor auth" --print-context  # print without calling LLM

# Generate filtered context packet for implementing a single feature
guardian feature-context --spec feature-specs/billing.yaml
```

### VSCode Commands (Command Palette)

| Command | Description |
|---------|-------------|
| `Guardian: Initialize Project` | Run `guardian init` on workspace |
| `Guardian: Generate AI Context` | Generate architecture-context.md |
| `Guardian: Drift Check` | Compute drift metrics |
| `Guardian: Generate Constraints` | Find duplicates, cycles, similar endpoints |
| `Guardian: Copy Constraints Prompt` | Copy LLM guardrail prompt to clipboard |
| `Guardian: Simulate Drift` | Simulate drift without a patch |
| `Guardian: Guard Patch (Simulate)` | Pick a .patch file and simulate its impact |
| `Guardian: Guarded Run` | Constraints + simulation in one step |

## Output Structure

```
.specs/                              (or specs-out/)
├── machine/
│   ├── architecture-context.md      ← AI context (~3K tokens, injected into CLAUDE.md)
│   ├── architecture.snapshot.yaml   ← full architecture snapshot
│   ├── ux.snapshot.yaml             ← frontend components + pages
│   ├── codebase-intelligence.json   ← unified registry for all downstream commands
│   ├── structural-intelligence.json ← per-module complexity analysis
│   ├── drift.heatmap.json           ← coupling scores per module
│   ├── drift.report.json            ← drift metrics
│   ├── constraints.json             ← duplicates, cycles, similar endpoints
│   ├── discrepancies.json           ← code vs baseline diff
│   └── docs/                        ← generated markdown docs
│       ├── summary.md               ← product overview with quality signals
│       ├── hld.md                   ← system diagrams, coupling heatmap, subsystems
│       ├── integration.md           ← all API endpoints grouped by domain
│       ├── data.md                  ← data models and schemas
│       ├── ux.md                    ← pages, components, interaction maps
│       ├── diff.md                  ← changelog between snapshots
│       ├── runtime.md               ← Docker services, background tasks
│       ├── infra.md                 ← manifests, scripts, Makefiles
│       ├── tests.md                 ← behavioral test specs
│       ├── stakeholder.md           ← one-page executive view
│       └── index.md                 ← table of contents
├── human/
│   ├── product-document.md          ← LLM-powered comprehensive product doc
│   ├── discrepancies.md             ← human-readable drift report
│   ├── start-here.md                ← onboarding guide
│   ├── system-overview.md           ← boundaries, risk zones
│   ├── backend-overview.md          ← modules by layer
│   ├── frontend-overview.md         ← page/component inventory
│   ├── data-and-flows.md            ← models and cross-stack contracts
│   ├── change-guide.md              ← what changed, what's risky
│   └── docs/                        ← HTML viewer (open index.html in browser)
│       ├── index.html               ← overview with product context from README
│       ├── architecture.html        ← system diagram, workflow sequences, coupling
│       ├── api-surface.html         ← all endpoints by domain
│       ├── data-models.html         ← models with role badges
│       ├── quality.html             ← patterns, duplicates, orphans
│       ├── frontend.html            ← pages with component trees
│       ├── tasks.html               ← background tasks
│       └── discrepancies.html       ← code vs spec drift
```

## Configuration

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
    },
    "domains": {
      "session": ["service-conversation", "shared"],
      "auth": ["service-auth"]
    }
  },
  "llm": {
    "command": "ollama",
    "args": ["run", "llama3"]
  },
  "docs": {
    "mode": "full"
  },
  "ignore": {
    "directories": ["venv", "node_modules", "__pycache__"],
    "paths": ["backend/alembic/versions"]
  }
}
```

## Claude Code Integration

Guardian auto-injects architecture context into `CLAUDE.md` so Claude Code reads it at session start:

```markdown
# my-project

## Guardian Architecture Context

<!-- guardian:auto-context -->
## Codebase Map
**Backend:** 16 schemas · 35 endpoints · 9 modules
**Frontend:** 10 components · 8 pages

### High-Coupling Files
- shared/policy/__init__.py (score 1.00)
- service-conversation/engine.py (score 0.40)
...
<!-- /guardian:auto-context -->
```

The block between `<!-- guardian:auto-context -->` markers is replaced on every save (via VSCode extension) and every commit (via pre-commit hook). Your manual content in CLAUDE.md outside the markers is never touched.

## Key Architectural Outputs

### Workflow Sequence Diagrams
Auto-generated Mermaid sequence diagrams for your most complex endpoints, showing the full call chain from client through handler to services and data stores.

### System Architecture Diagram
Full system view: frontend → backend services → data stores → external APIs, with actual endpoint paths shown per service.

### Service Communication Map
Cross-service dependency flowchart showing which modules import from which, proxy patterns, and external API calls.

### Model Role Badges
Each data model gets an inferred role badge: API Request, API Response, Configuration, Safety Policy, Entity Profile, Content Entity, etc.

### Subsystem Diagrams with Entity Names
Backend module diagrams show actual class names (e.g., `ConversationEngine`, `ContentRetriever`, `SessionStateMachine`) instead of generic file counts.

## Framework Support

### Frontend Frameworks
- **Expo Router** — auto-detected from `package.json`. Every `.tsx` in `app/` is a page (except `_layout`, `_error`). Route derived from filename.
- **Next.js** — `page.tsx` convention in `app/` directory.
- **React Router** — route definitions parsed from JSX `<Route>` elements and `createBrowserRouter()`.

### Backend Frameworks
- **Python**: FastAPI, Django, Pydantic, SQLAlchemy
- **TypeScript/JavaScript**: Express, React, Next.js
- **Java**: Spring Boot (`@RestController`, JPA)
- **Go**: Gin routing, struct models
- **C#**: ASP.NET Core HTTP endpoints, POCO schemas

All extraction uses Tree-Sitter AST parsing — deterministic, no LLM involved.

## Key Metrics

| Metric | Meaning |
|--------|---------|
| **D_t** | Coupling delta (lower = less entangled) |
| **K_t** | Architectural complexity |
| **Delta** | Overall drift score |
| **Coupling score** | Per-module dependency pressure (0-1) |
| **Shape fingerprint** | Change = structural refactor. Same shape + different fingerprint = additive change |

## Automation Flow

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
Claude Code reads CLAUDE.md → fresh architecture context
```

## GitHub Action

```yaml
uses: ./
with:
  project-root: .
  output: specs-out
```

See [`.github/workflows/guardian-example.yml`](./.github/workflows/guardian-example.yml).

## Development

```bash
npm install
npm run dev -- extract .          # run from source
npm run build                     # compile to dist/
npm run start -- extract .        # run compiled
npm run typecheck                 # type check only
npm test                          # run tests
```
