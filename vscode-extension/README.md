# Guardian VSCode Extension

> **Beta Release** — This extension is under active development. Core features work but you may encounter minor issues. Bug reports welcome via [GitHub Issues](https://github.com/idocoding/guardian/issues).

Architectural intelligence inside your editor. Auto-extracts architecture context on save, shows drift status in the status bar, and keeps CLAUDE.md fresh for AI coding tools.

## Prerequisites

This extension requires the **Guardian CLI** (`@toolbaux/guardian`) to be installed:

```bash
npm install -g @toolbaux/guardian
```

The extension invokes the CLI for all extraction, drift, and context operations. Without it, no commands will work.

## Features

- **Status Bar** — Shows `✓ Guardian: stable · 35 ep · 8 pg`. Click to run drift check. Turns amber on critical drift.
- **Background Auto-Extract** — On file save, extracts architecture snapshots and injects context into CLAUDE.md (5s debounce, code files only).
- **Command Palette** — 8 commands for init, drift, constraints, simulation.
- **Diagnostics** — Surfaces duplicate functions and drift warnings as VS Code diagnostics.

## Installation

**Symlink (development):**
```bash
ln -sf /path/to/guardian/vscode-extension ~/.vscode/extensions/guardian-vscode
# Cmd+Shift+P → "Reload Window"
```

**Package as .vsix:**
```bash
cd guardian/vscode-extension
npx vsce package --allow-missing-repository
# Cmd+Shift+P → "Extensions: Install from VSIX" → pick the .vsix
```

Requires `@toolbaux/guardian` CLI — see [Prerequisites](#prerequisites) above.

## Commands

| Command | Description |
|---------|-------------|
| Guardian: Initialize Project | Creates .specs/, config, pre-commit hook, CLAUDE.md |
| Guardian: Generate AI Context | Generates architecture-context.md |
| Guardian: Drift Check | Computes drift metrics |
| Guardian: Generate Constraints | Finds duplicates, cycles, similar endpoints |
| Guardian: Copy Constraints Prompt | Copies LLM guardrail prompt to clipboard |
| Guardian: Simulate Drift | Simulates drift without a patch |
| Guardian: Guard Patch (Simulate) | Picks a .patch file and simulates impact |
| Guardian: Guarded Run | Constraints + simulation in one step |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `guardian.autoExtract` | `true` | Auto-run extract + context injection on save |
| `guardian.runOnSave` | `false` | Also run drift check on save |
| `guardian.backendRoot` | `""` | Backend root override (auto-detected if empty) |
| `guardian.frontendRoot` | `""` | Frontend root override (auto-detected if empty) |
| `guardian.configPath` | `""` | Path to guardian.config.json |
| `guardian.commandPath` | `""` | Custom path to guardian CLI |
| `guardian.debounceMs` | `750` | Debounce for drift-on-save |
| `guardian.showOutputOnRun` | `false` | Show output panel on run |

## How It Works

```
File saved (.py, .ts, .tsx, .js, etc.)
    ↓ (5s debounce)
guardian extract → .specs/
guardian generate --ai-context → .specs/
guardian context → CLAUDE.md
    ↓
Status bar updated with endpoint count, page count, drift status
```

View logs: **Output** panel (`Cmd+Shift+U`) → select **"Guardian"** from dropdown.
