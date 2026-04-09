#!/usr/bin/env node

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

import { Command } from "commander";
import { runExtract } from "./commands/extract.js";
import { runDrift } from "./commands/drift.js";
import { runConstraints } from "./commands/constraints.js";
import { runSimulate } from "./commands/simulate.js";
import { runGuard } from "./commands/guard.js";
import { runDiff } from "./commands/diff.js";
import { runSummary } from "./commands/summary.js";
import { runSearch } from "./commands/search.js";
import { runContext } from "./commands/context.js";
import { runGenerate } from "./commands/generate.js";
import { runVerifyDrift } from "./commands/verify-drift.js";
import { runAnalyzeDepth } from "./commands/analyze-depth.js";
import { runIntel } from "./commands/intel.js";
import { runFeatureContext } from "./commands/feature-context.js";
import { runDocGenerate } from "./commands/doc-generate.js";
import { runDiscrepancy } from "./commands/discrepancy.js";
import { runDocHtml } from "./commands/doc-html.js";
import { runInit } from "./commands/init.js";
import { runMcpServe } from "./commands/mcp-serve.js";
import { DEFAULT_SPECS_DIR } from "./config.js";

const program = new Command();

program
  .name("guardian")
  .description("Guardian — Architectural intelligence for codebases (by Toolbaux)")
  .version(version);

program
  .command("generate")
  .description("Generate compact AI-ready architecture context")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--config <path>", "Path to guardian.config.json")
  .option("--output <path>", "Output directory", DEFAULT_SPECS_DIR)
  .option("--focus <text>", "Focus the generated AI context on a feature area")
  .option("--max-lines <count>", "Maximum lines for the generated context")
  .option("--ai-context", "Generate architecture-context.md for AI tools", false)
  .action(async (projectRoot, options) => {
    await runGenerate({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      configPath: options.config,
      output: options.output,
      focus: options.focus,
      maxLines: options.maxLines,
      aiContext: options.aiContext ?? false
    });
  });

program
  .command("extract")
  .description("Generate architecture and UX snapshots")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--output <path>", "Output directory", DEFAULT_SPECS_DIR)
  .option("--include-file-graph", "Include file-level dependency graph", false)
  .option("--config <path>", "Path to guardian.config.json")
  .option("--docs-mode <mode>", "Docs mode (lean|full)")
  .action(async (projectRoot, options) => {
    await runExtract({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: options.output ?? DEFAULT_SPECS_DIR,
      includeFileGraph: options.includeFileGraph ?? false,
      configPath: options.config,
      docsMode: options.docsMode
    });
  });

program
  .command("diff")
  .description("Generate changelog diff between a baseline snapshot and current snapshot")
  .requiredOption("--baseline <path>", "Path to baseline architecture.snapshot.yaml")
  .requiredOption("--current <path>", "Path to current architecture.snapshot.yaml")
  .option("--output <path>", "Output diff path", "specs-out/machine/docs/diff.md")
  .action(async (options) => {
    await runDiff({
      baselinePath: options.baseline,
      currentPath: options.current,
      output: options.output ?? "specs-out/docs/diff.md"
    });
  });

program
  .command("drift")
  .description("Compute architectural drift metrics")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--output <path>", "Output report path", "specs-out/machine/drift.report.json")
  .option("--baseline [path]", "Write baseline drift file")
  .option("--history [path]", "Append drift history entry")
  .option("--config <path>", "Path to guardian.config.json")
  .action(async (projectRoot, options) => {
    await runDrift({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: options.output ?? "specs-out/drift.report.json",
      configPath: options.config,
      baseline: options.baseline,
      history: options.history
    });
  });

program
  .command("verify-drift")
  .description("Verify architectural drift against a baseline and strict thresholds for CI/CD")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--config <path>", "Path to guardian.config.json")
  .option("--baseline <path>", "Path to baseline payload")
  .option("--strict-threshold <val>", "Maximum allowed delta shift (default 0.15)")
  .action(async (projectRoot, options) => {
    await runVerifyDrift({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      configPath: options.config,
      baseline: options.baseline,
      strictThreshold: options.strictThreshold
    });
  });

program
  .command("constraints")
  .description("Generate LLM constraint summary")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--output <path>", "Output constraints path", "specs-out/machine/constraints.json")
  .option("--config <path>", "Path to guardian.config.json")
  .action(async (projectRoot, options) => {
    await runConstraints({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: options.output ?? "specs-out/constraints.json",
      configPath: options.config
    });
  });

program
  .command("simulate")
  .description("Simulate drift for a candidate workspace")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--output <path>", "Output simulation report", "specs-out/machine/drift.simulation.json")
  .option("--baseline <path>", "Baseline drift/baseline file")
  .option("--baseline-summary <path>", "Baseline architecture summary path")
  .option("--patch <path>", "Patch file to apply for simulation")
  .option("--mode <mode>", "Simulation mode (soft|hard)")
  .option("--config <path>", "Path to guardian.config.json")
  .action(async (projectRoot, options) => {
    await runSimulate({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: options.output ?? "specs-out/drift.simulation.json",
      baseline: options.baseline,
      baselineSummary: options.baselineSummary,
      configPath: options.config,
      patch: options.patch,
      mode: options.mode
    });
  });

program
  .command("guard")
  .description("Generate LLM prompt, optional patch, and simulate drift")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .requiredOption("--task <text>", "Task description for the LLM")
  .option("--prompt-out <path>", "Prompt output path", "specs-out/machine/guard.prompt.txt")
  .option("--patch-out <path>", "Patch output path", "specs-out/machine/guard.patch")
  .option("--simulation-out <path>", "Simulation report output", "specs-out/machine/drift.simulation.json")
  .option("--mode <mode>", "Simulation mode (soft|hard)")
  .option("--llm-command <cmd>", "Override LLM command from config")
  .option("--print-context", "Print an IDE-ready context block instead of calling an LLM", false)
  .option("--config <path>", "Path to guardian.config.json")
  .action(async (projectRoot, options) => {
    await runGuard({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      task: options.task,
      promptOutput: options.promptOut,
      patchOutput: options.patchOut,
      simulationOutput: options.simulationOut,
      mode: options.mode,
      llmCommand: options.llmCommand,
      printContext: options.printContext ?? false,
      configPath: options.config
    });
  });

program
  .command("summary")
  .description("Generate a plain-language project summary from existing snapshots")
  .option("--input <path>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--output <path>", "Summary output path")
  .action(async (options) => {
    await runSummary({
      input: options.input ?? DEFAULT_SPECS_DIR,
      output: options.output
    });
  });

program
  .command("search")
  .description("Search existing snapshots for models, endpoints, components, modules, and tasks")
  .option("--input <path>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .requiredOption("--query <text>", "Search query")
  .option("--output <path>", "Write search results to a file")
  .option(
    "--types <items>",
    "Comma-separated filters: models,endpoints,components,modules,tasks"
  )
  .action(async (options) => {
    await runSearch({
      input: options.input ?? DEFAULT_SPECS_DIR,
      query: options.query,
      output: options.output,
      types: options.types ? [options.types] : undefined
    });
  });

program
  .command("context")
  .description("Render an AI-ready context block from existing snapshots")
  .option("--input <path>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--output <path>", "Append the context block to a file")
  .option("--focus <text>", "Focus the context on a feature area")
  .option("--max-lines <count>", "Maximum number of lines to include")
  .action(async (options) => {
    await runContext({
      input: options.input ?? DEFAULT_SPECS_DIR,
      output: options.output,
      focus: options.focus,
      maxLines: options.maxLines
    });
  });

program
  .command("analyze-depth")
  .description("Compute the Structural Intelligence profile for a feature or query")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .requiredOption("--query <text>", "Feature or area to analyze (e.g. 'stripe', 'auth')")
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--config <path>", "Path to guardian.config.json")
  .option("--output <path>", "Write report to a file instead of stdout")
  .option("--format <fmt>", "Output format: yaml or json (default: yaml)")
  .option("--ci", "Exit with code 1 when HIGH complexity is detected with strong confidence", false)
  .action(async (projectRoot, options) => {
    await runAnalyzeDepth({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      configPath: options.config,
      output: options.output,
      format: options.format ?? "yaml",
      ci: options.ci ?? false,
      query: options.query
    });
  });

program
  .command("intel")
  .description("Build codebase-intelligence.json from existing snapshots")
  .option("--specs <dir>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--output <path>", "Output path for codebase-intelligence.json")
  .action(async (options) => {
    await runIntel({
      specs: options.specs,
      output: options.output
    });
  });

program
  .command("feature-context")
  .description("Generate a filtered context packet for implementing a single feature")
  .requiredOption("--spec <file>", "Path to feature spec YAML")
  .option("--specs <dir>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--output <path>", "Output path for feature context JSON")
  .action(async (options) => {
    await runFeatureContext({
      spec: options.spec,
      specs: options.specs,
      output: options.output
    });
  });

program
  .command("doc-generate")
  .description("Generate a human-readable product document from codebase intelligence")
  .option("--specs <dir>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--feature-specs <dir>", "Directory of feature spec YAML files")
  .option("--output <path>", "Output path for product-document.md")
  .option("--update-baseline", "Freeze current state as new baseline for discrepancy tracking", false)
  .action(async (options) => {
    await runDocGenerate({
      specs: options.specs,
      featureSpecs: options.featureSpecs,
      output: options.output,
      updateBaseline: options.updateBaseline ?? false
    });
  });

program
  .command("discrepancy")
  .description("Diff current codebase intelligence against a committed baseline")
  .option("--specs <dir>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--feature-specs <dir>", "Directory of feature spec YAML files")
  .option("--output <path>", "Output path (used when --format is json or md)")
  .option("--format <fmt>", "Output format: json, md, or both (default: both)", "both")
  .action(async (options) => {
    await runDiscrepancy({
      specs: options.specs,
      featureSpecs: options.featureSpecs,
      output: options.output,
      format: options.format ?? "both"
    });
  });

program
  .command("doc-html")
  .description("Generate a self-contained Javadoc-style HTML viewer from codebase intelligence")
  .option("--specs <dir>", "Snapshot output directory", DEFAULT_SPECS_DIR)
  .option("--output <path>", "Output path for index.html")
  .action(async (options) => {
    await runDocHtml({
      specs: options.specs ?? DEFAULT_SPECS_DIR,
      output: options.output,
    });
  });

program
  .command("init")
  .description("Initialize guardian for a project (config, .specs dir, pre-commit hook, CLAUDE.md)")
  .argument("[projectRoot]", "Repo or project root", process.cwd())
  .option("--backend-root <path>", "Path to backend root")
  .option("--frontend-root <path>", "Path to frontend root")
  .option("--output <path>", "Output directory", DEFAULT_SPECS_DIR)
  .option("--skip-hook", "Skip pre-commit hook installation", false)
  .action(async (projectRoot, options) => {
    await runInit({
      projectRoot,
      backendRoot: options.backendRoot,
      frontendRoot: options.frontendRoot,
      output: options.output,
      skipHook: options.skipHook ?? false,
    });
  });

program
  .command("mcp-serve")
  .description("Start Guardian MCP server for Claude Code / Cursor integration")
  .option("--specs <dir>", "Specs directory", ".specs")
  .option("--quiet", "Suppress stderr output (for clients that merge streams)", false)
  .action(async (options) => {
    await runMcpServe({
      specs: options.specs,
      quiet: options.quiet,
    });
  });

program
  .parseAsync()
  .then(() => {
    // Force exit after one-shot commands complete.
    // Tree-sitter native bindings keep a libuv ref alive, preventing natural
    // process exit. mcp-serve is excluded: it sets up readline and returns
    // immediately (before any messages are processed), so calling process.exit()
    // here would kill it before it processes any input. mcp-serve manages its
    // own lifecycle via process.exit(0) inside rl.on("close").
    const subCommand = process.argv[2];
    if (subCommand !== "mcp-serve") {
      process.exit(process.exitCode ?? 0);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
