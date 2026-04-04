const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function activate(context) {
  const output = vscode.window.createOutputChannel("Guardian");
  const diagnostics = vscode.languages.createDiagnosticCollection("Guardian");
  const diagnosticState = {
    drift: new Map(),
    duplicates: new Map(),
    similar: new Map()
  };
  let debounceTimer = null;
  let running = false;

  async function withRunLock(label, fn) {
    if (running) {
      output.appendLine(`[Guardian] ${label} skipped (already running).`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  }

  async function runDriftCheck() {
    await withRunLock("Drift check", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      const {
        workspaceRoot,
        cfg,
        backendAbs,
        frontendAbs,
        commandPath,
        configAbs,
        showOutputOnRun
      } = context;
      const outputAbs = resolvePath(cfg.get("output", "specs-out/drift.report.json"), workspaceRoot);
      const appendHistory = cfg.get("appendHistory", true);
      const historyPathSetting = cfg.get("historyPath", "");
      const writeBaseline = cfg.get("writeBaseline", false);
      const baselinePathSetting = cfg.get("baselinePath", "");
      const historyAbs = historyPathSetting ? resolvePath(historyPathSetting, workspaceRoot) : null;
      const baselineAbs = baselinePathSetting ? resolvePath(baselinePathSetting, workspaceRoot) : null;

      const code = await executeDrift({
        workspaceRoot,
        backendAbs,
        frontendAbs,
        configAbs,
        outputAbs,
        historyAbs,
        baselineAbs,
        appendHistory,
        writeBaseline,
        commandPath,
        showOutputOnRun,
        output
      });
      if (code !== 0) {
        vscode.window.showErrorMessage(`Guardian: Drift check failed (exit ${code}).`);
        return;
      }

      const report = readJsonSafe(outputAbs);
      if (!report) {
        vscode.window.showInformationMessage("Guardian: Drift check completed.");
        return;
      }

      const status = String(report.status || "unknown");
      const delta = typeof report.delta === "number" ? report.delta : null;
      const message = delta === null
        ? `Guardian drift status: ${status}`
        : `Guardian drift status: ${status} (delta ${delta.toFixed(4)})`;

      if (status === "stable") {
        vscode.window.showInformationMessage(message);
      } else if (status === "critical") {
        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showErrorMessage(message);
      }

      const anchor = pickDiagnosticAnchor(workspaceRoot, backendAbs, frontendAbs);
      updateDriftDiagnostics({
        report,
        anchor,
        state: diagnosticState,
        diagnostics
      });
    });
  }

  async function runGenerateAiContext() {
    await withRunLock("Generate AI Context", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      
      const { workspaceRoot, cfg, backendAbs, frontendAbs, commandPath, configAbs, showOutputOnRun } = context;
      
      vscode.window.showInformationMessage("Guardian: Generating ultra-lean AI Context wedge...");

      const args = [
        "generate",
        workspaceRoot,
        "--ai-context"
      ];
      if (configAbs) {
        args.push("--config", configAbs);
      }

      const code = await runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output);
      if (code !== 0) {
        vscode.window.showErrorMessage(`Guardian: Generation failed (exit ${code}). Check Output channel.`);
        return;
      }
      
      // Guardian CLI defaults generation to `<workspaceRoot>/specs-out/machine/architecture-context.md`
      const generatedFilePath = path.join(workspaceRoot, "specs-out", "machine", "architecture-context.md");
      if (fs.existsSync(generatedFilePath)) {
        vscode.window.showInformationMessage("Guardian: AI Context wedge securely generated!");
        const doc = await vscode.workspace.openTextDocument(generatedFilePath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showErrorMessage(`Guardian: Expected context file not found at ${generatedFilePath}`);
      }
    });
  }

  async function runConstraints() {
    await withRunLock("Constraints", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      const { backendAbs, workspaceRoot } = context;
      const { outputAbs, code } = await executeConstraints(context, output);
      if (code !== 0) {
        vscode.window.showErrorMessage(`Guardian: Constraints failed (exit ${code}).`);
        return;
      }
      vscode.window.showInformationMessage(`Guardian: Constraints written to ${outputAbs}`);

      updateConstraintsDiagnostics({
        constraintsPath: outputAbs,
        backendAbs,
        workspaceRoot,
        state: diagnosticState,
        diagnostics
      });
    });
  }

  async function copyConstraintsPrompt() {
    await withRunLock("Copy constraints prompt", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      const { workspaceRoot, cfg, backendAbs, frontendAbs, commandPath, configAbs, showOutputOnRun } =
        context;
      const outputAbs = resolvePath(
        cfg.get("constraintsOutput", "specs-out/constraints.json"),
        workspaceRoot
      );

      if (!fs.existsSync(outputAbs)) {
        const args = [
          "constraints",
          "--backend-root",
          backendAbs,
          "--frontend-root",
          frontendAbs,
          "--output",
          outputAbs
        ];
        if (configAbs) {
          args.push("--config", configAbs);
        }
        const code = await runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output);
        if (code !== 0) {
          vscode.window.showErrorMessage(`Guardian: Constraints failed (exit ${code}).`);
          return;
        }
        updateConstraintsDiagnostics({
          constraintsPath: outputAbs,
          backendAbs,
          workspaceRoot,
          state: diagnosticState,
          diagnostics
        });
      }

      const payload = readJsonSafe(outputAbs);
      const prompt = payload?.prompt;
      if (!prompt) {
        vscode.window.showErrorMessage("Guardian: No prompt found in constraints file.");
        return;
      }
      await vscode.env.clipboard.writeText(String(prompt));
      vscode.window.showInformationMessage("Guardian: Constraints prompt copied to clipboard.");
    });
  }

  async function runSimulation(patchPath) {
    await withRunLock("Simulation", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      const { outputAbs, code } = await executeSimulation(context, patchPath, output);
      if (code !== 0) {
        vscode.window.showErrorMessage(`Guardian: Simulation failed (exit ${code}).`);
        return;
      }

      const report = readJsonSafe(outputAbs);
      if (!report) {
        vscode.window.showInformationMessage("Guardian: Simulation completed.");
        return;
      }

      const decision = String(report.decision || "unknown");
      const reasons = Array.isArray(report.reasons) ? report.reasons.join(", ") : "";
      const message = reasons
        ? `Guardian simulation: ${decision} (${reasons})`
        : `Guardian simulation: ${decision}`;

      if (decision === "accept") {
        vscode.window.showInformationMessage(message);
      } else if (decision === "warn") {
        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showErrorMessage(message);
      }
    });
  }

  async function guardPatch() {
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Select Patch",
      filters: { Patch: ["patch", "diff"] }
    });
    if (!selection || selection.length === 0) {
      return;
    }
    const patchPath = selection[0].fsPath;
    await runSimulation(patchPath);
  }

  async function runGuarded() {
    await withRunLock("Guarded run", async () => {
      const context = getWorkspaceContext();
      if (!context) {
        return;
      }
      const constraintsResult = await executeConstraints(context, output);
      if (constraintsResult.code !== 0) {
        vscode.window.showErrorMessage(
          `Guardian: Constraints failed (exit ${constraintsResult.code}).`
        );
        return;
      }
      updateConstraintsDiagnostics({
        constraintsPath: constraintsResult.outputAbs,
        backendAbs: context.backendAbs,
        workspaceRoot: context.workspaceRoot,
        state: diagnosticState,
        diagnostics
      });

      const simulationResult = await executeSimulation(context, null, output);
      if (simulationResult.code !== 0) {
        vscode.window.showErrorMessage(
          `Guardian: Simulation failed (exit ${simulationResult.code}).`
        );
        return;
      }
      vscode.window.showInformationMessage("Guardian: Guarded run completed.");
    });
  }

  function scheduleDriftCheck() {
    const cfg = vscode.workspace.getConfiguration("guardian");
    const delay = cfg.get("debounceMs", 750);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runDriftCheck();
    }, delay);
  }

  // ── Status Bar ────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "guardian.driftCheck";
  statusBar.text = "$(shield) Guardian";
  statusBar.tooltip = "Click to run drift check";
  statusBar.show();

  function updateStatusBar(status, endpoints, pages) {
    const icon = status === "stable" ? "$(check)" : status === "critical" ? "$(warning)" : "$(shield)";
    const counts = [];
    if (endpoints) counts.push(`${endpoints} ep`);
    if (pages) counts.push(`${pages} pg`);
    const countStr = counts.length > 0 ? ` · ${counts.join(" · ")}` : "";
    statusBar.text = `${icon} Guardian: ${status}${countStr}`;
    statusBar.tooltip = `Architecture: ${status}. Click to refresh.`;
    statusBar.backgroundColor = status === "critical"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  }

  // Load initial status from cached report
  {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const specsDir = path.join(workspaceFolder.uri.fsPath, ".specs", "machine");
      const reportPath = path.join(specsDir, "drift.report.json");
      const intelPath = path.join(specsDir, "codebase-intelligence.json");
      const report = readJsonSafe(reportPath);
      const intel = readJsonSafe(intelPath);
      if (report) {
        updateStatusBar(
          report.status || "unknown",
          intel?.meta?.counts?.endpoints,
          intel?.meta?.counts?.pages
        );
      }
    }
  }

  // ── Auto-Init + MCP Setup ──────────────────────────────────────────────────
  {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const root = workspaceFolder.uri.fsPath;
      const specsExists = fs.existsSync(path.join(root, ".specs", "machine", "codebase-intelligence.json"));

      if (!specsExists) {
        const commandPath = resolveCommandPath("", root);
        output.appendLine("[Guardian] No .specs/ found — running auto-init...");

        runSpecguard(commandPath, ["init", root], root, false, output).then((code) => {
          if (code === 0) {
            output.appendLine("[Guardian] Auto-init complete.");
            vscode.window.showInformationMessage("Guardian: Project initialized! Architecture context will auto-update on save.");
            const intelPath = path.join(root, ".specs", "machine", "codebase-intelligence.json");
            const intel = readJsonSafe(intelPath);
            if (intel) {
              updateStatusBar("stable", intel.meta?.counts?.endpoints, intel.meta?.counts?.pages);
            }
            // Set up MCP after init
            configureMcp(root, output);
          } else {
            output.appendLine("[Guardian] Auto-init failed. Run 'guardian init' manually.");
          }
        });
      } else {
        // Specs exist — just ensure MCP is configured
        configureMcp(root, output);
      }
    }
  }

  function configureMcp(root, output) {
    const commandPath = resolveCommandPath("", root);

    // Claude Code: .claude/settings.json (project-level)
    const claudeDir = path.join(root, ".claude");
    const claudeSettings = path.join(claudeDir, "settings.json");
    try {
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      let settings = {};
      if (fs.existsSync(claudeSettings)) {
        settings = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
      }
      if (!settings.mcpServers) settings.mcpServers = {};
      if (!settings.mcpServers.guardian) {
        settings.mcpServers.guardian = {
          command: commandPath,
          args: ["mcp-serve", "--specs", path.join(root, ".specs")]
        };
        fs.writeFileSync(claudeSettings, JSON.stringify(settings, null, 2) + "\n", "utf8");
        output.appendLine("[Guardian] MCP configured for Claude Code (.claude/settings.json)");
      }
    } catch (err) {
      output.appendLine("[Guardian] Could not configure Claude Code MCP: " + err.message);
    }

    // Cursor: .cursor/mcp.json
    const cursorDir = path.join(root, ".cursor");
    const cursorMcp = path.join(cursorDir, "mcp.json");
    try {
      if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
      let mcpConfig = {};
      if (fs.existsSync(cursorMcp)) {
        mcpConfig = JSON.parse(fs.readFileSync(cursorMcp, "utf8"));
      }
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      if (!mcpConfig.mcpServers.guardian) {
        mcpConfig.mcpServers.guardian = {
          command: commandPath,
          args: ["mcp-serve", "--specs", path.join(root, ".specs")]
        };
        fs.writeFileSync(cursorMcp, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
        output.appendLine("[Guardian] MCP configured for Cursor (.cursor/mcp.json)");
      }
    } catch (err) {
      output.appendLine("[Guardian] Could not configure Cursor MCP: " + err.message);
    }
  }

  // ── Background Extract on Save ────────────────────────────────────────────
  let extractTimer = null;
  const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".go", ".java", ".cs"]);

  function scheduleBackgroundExtract(document) {
    const ext = path.extname(document.fileName);
    if (!CODE_EXTENSIONS.has(ext)) return;

    // Don't re-extract for files in .specs/ or node_modules
    const rel = vscode.workspace.asRelativePath(document.fileName);
    if (rel.startsWith(".specs") || rel.includes("node_modules")) return;

    if (extractTimer) clearTimeout(extractTimer);
    extractTimer = setTimeout(async () => {
      extractTimer = null;
      await runBackgroundExtract();
    }, 5000); // 5s debounce
  }

  async function runBackgroundExtract() {
    const ctx = getWorkspaceContext();
    if (!ctx) return;
    const { workspaceRoot, commandPath, configAbs, showOutputOnRun } = ctx;

    output.appendLine("[Guardian] Background extract triggered...");

    // Run extract + generate in sequence
    const specsOutput = path.join(workspaceRoot, ".specs");
    const extractArgs = ["extract", "--output", specsOutput];
    if (configAbs) extractArgs.push("--config", configAbs);
    const extractCode = await runSpecguard(commandPath, extractArgs, workspaceRoot, false, output);

    if (extractCode === 0) {
      const genArgs = ["generate", "--ai-context", "--output", specsOutput];
      if (configAbs) genArgs.push("--config", configAbs);
      await runSpecguard(commandPath, genArgs, workspaceRoot, false, output);

      // Inject into CLAUDE.md
      const claudeMd = path.join(workspaceRoot, "CLAUDE.md");
      if (fs.existsSync(claudeMd)) {
        const contextArgs = ["context", "--input", specsOutput, "--output", claudeMd];
        await runSpecguard(commandPath, contextArgs, workspaceRoot, false, output);
      }

      // Update status bar from fresh intel
      const intelPath = path.join(specsOutput, "machine", "codebase-intelligence.json");
      const intel = readJsonSafe(intelPath);
      if (intel) {
        updateStatusBar("stable", intel.meta?.counts?.endpoints, intel.meta?.counts?.pages);
      }

      output.appendLine("[Guardian] Background extract complete.");
    }
  }

  // ── Init Command ──────────────────────────────────────────────────────────
  async function runInitCommand() {
    const ctx = getWorkspaceContext();
    if (!ctx) return;
    const { workspaceRoot, commandPath, showOutputOnRun } = ctx;
    const args = ["init", workspaceRoot];
    output.show(true);
    const code = await runSpecguard(commandPath, args, workspaceRoot, true, output);
    if (code === 0) {
      vscode.window.showInformationMessage("Guardian: Project initialized! Context will auto-update on save.");
      // Refresh status bar
      await runBackgroundExtract();
    } else {
      vscode.window.showErrorMessage(`Guardian: Init failed (exit ${code}). Check Output channel.`);
    }
  }

  // ── Register Commands ─────────────────────────────────────────────────────
  const generateCommand = vscode.commands.registerCommand("guardian.generateAiContext", runGenerateAiContext);
  const command = vscode.commands.registerCommand("guardian.driftCheck", runDriftCheck);
  const constraintsCommand = vscode.commands.registerCommand("guardian.generateConstraints", runConstraints);
  const promptCommand = vscode.commands.registerCommand("guardian.copyConstraintsPrompt", copyConstraintsPrompt);
  const simulateCommand = vscode.commands.registerCommand("guardian.simulateDrift", () => runSimulation(null));
  const guardCommand = vscode.commands.registerCommand("guardian.guardPatch", guardPatch);
  const guardedRunCommand = vscode.commands.registerCommand("guardian.guardedRun", runGuarded);
  const initCommand = vscode.commands.registerCommand("guardian.init", runInitCommand);
  context.subscriptions.push(
    generateCommand,
    command,
    constraintsCommand,
    promptCommand,
    simulateCommand,
    guardCommand,
    guardedRunCommand,
    initCommand,
    diagnostics,
    output,
    statusBar
  );

  // ── Save Listeners ────────────────────────────────────────────────────────
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    const cfg = vscode.workspace.getConfiguration("guardian");

    // Background extract (always active for code files)
    if (cfg.get("autoExtract", true)) {
      scheduleBackgroundExtract(document);
    }

    // Drift check on save (opt-in)
    if (cfg.get("runOnSave", false)) {
      scheduleDriftCheck();
    }
  });
  context.subscriptions.push(saveListener);
}

function deactivate() {}

function getWorkspaceContext() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Guardian: Open a workspace folder to run Guardian.");
    return null;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const cfg = vscode.workspace.getConfiguration("guardian");
  const backendRoot = cfg.get("backendRoot", "backend");
  const frontendRoot = cfg.get("frontendRoot", "frontend");
  const configPathSetting = cfg.get("configPath", "");
  const commandPathSetting = cfg.get("commandPath", "");
  const showOutputOnRun = cfg.get("showOutputOnRun", false);

  const backendAbs = resolvePath(backendRoot, workspaceRoot);
  const frontendAbs = resolvePath(frontendRoot, workspaceRoot);
  const configAbs = configPathSetting ? resolvePath(configPathSetting, workspaceRoot) : null;

  if (!backendAbs || !fs.existsSync(backendAbs)) {
    vscode.window.showErrorMessage(`Guardian: Backend root not found at ${backendAbs}`);
    return null;
  }
  if (!frontendAbs || !fs.existsSync(frontendAbs)) {
    vscode.window.showErrorMessage(`Guardian: Frontend root not found at ${frontendAbs}`);
    return null;
  }

  const commandPath = resolveCommandPath(commandPathSetting, workspaceRoot);

  return {
    workspaceRoot,
    cfg,
    backendAbs,
    frontendAbs,
    configAbs,
    commandPath,
    showOutputOnRun
  };
}

function runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output) {
  return new Promise((resolve) => {
    output.appendLine(`[Guardian] Running: ${commandPath} ${args.join(" ")}`);
    if (showOutputOnRun) {
      output.show(true);
    }

    const child = spawn(commandPath, args, {
      cwd: workspaceRoot,
      shell: true,
      env: process.env
    });

    child.stdout.on("data", (data) => output.append(data.toString()));
    child.stderr.on("data", (data) => output.append(data.toString()));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function resolveCommandPath(configuredPath, workspaceRoot) {
  if (configuredPath && configuredPath.trim().length > 0) {
    return configuredPath;
  }

  const localBin = path.join(
    workspaceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "guardian.cmd" : "guardian"
  );

  if (fs.existsSync(localBin)) {
    return localBin;
  }

  return "guardian";
}

function resolvePath(targetPath, workspaceRoot) {
  if (!targetPath) {
    return "";
  }
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(workspaceRoot, targetPath);
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function executeDrift(params) {
  const {
    workspaceRoot,
    backendAbs,
    frontendAbs,
    configAbs,
    outputAbs,
    historyAbs,
    baselineAbs,
    appendHistory,
    writeBaseline,
    commandPath,
    showOutputOnRun,
    output
  } = params;

  const args = [
    "drift",
    "--backend-root",
    backendAbs,
    "--frontend-root",
    frontendAbs,
    "--output",
    outputAbs
  ];

  if (configAbs) {
    args.push("--config", configAbs);
  }
  if (writeBaseline) {
    args.push("--baseline");
    if (baselineAbs) {
      args.push(baselineAbs);
    }
  }
  if (appendHistory) {
    args.push("--history");
    if (historyAbs) {
      args.push(historyAbs);
    }
  }

  const code = await runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output);
  return code;
}

async function executeConstraints(context, output) {
  const { workspaceRoot, cfg, backendAbs, frontendAbs, commandPath, configAbs, showOutputOnRun } =
    context;
  const outputAbs = resolvePath(
    cfg.get("constraintsOutput", "specs-out/constraints.json"),
    workspaceRoot
  );

  const args = [
    "constraints",
    "--backend-root",
    backendAbs,
    "--frontend-root",
    frontendAbs,
    "--output",
    outputAbs
  ];
  if (configAbs) {
    args.push("--config", configAbs);
  }

  const code = await runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output);
  return { outputAbs, code };
}

async function executeSimulation(context, patchPath, output) {
  const { workspaceRoot, cfg, backendAbs, frontendAbs, commandPath, configAbs, showOutputOnRun } =
    context;
  const outputAbs = resolvePath(
    cfg.get("simulationOutput", "specs-out/drift.simulation.json"),
    workspaceRoot
  );
  const baselinePathSetting = cfg.get("baselinePath", "");
  const baselineSummaryPathSetting = cfg.get("baselineSummaryPath", "");
  const mode = cfg.get("simulationMode", "soft");

  const args = [
    "simulate",
    "--backend-root",
    backendAbs,
    "--frontend-root",
    frontendAbs,
    "--output",
    outputAbs,
    "--mode",
    mode
  ];
  if (configAbs) {
    args.push("--config", configAbs);
  }
  if (baselinePathSetting) {
    args.push("--baseline", resolvePath(baselinePathSetting, workspaceRoot));
  }
  if (baselineSummaryPathSetting) {
    args.push("--baseline-summary", resolvePath(baselineSummaryPathSetting, workspaceRoot));
  }
  if (patchPath) {
    args.push("--patch", patchPath);
  }

  const code = await runSpecguard(commandPath, args, workspaceRoot, showOutputOnRun, output);
  return { outputAbs, code };
}

function pickDiagnosticAnchor(workspaceRoot, backendAbs, frontendAbs) {
  const candidates = [
    path.join(workspaceRoot, "guardian.config.json"),
    path.join(workspaceRoot, "package.json"),
    path.join(workspaceRoot, "README.md"),
    path.join(workspaceRoot, "pyproject.toml"),
    path.join(workspaceRoot, "requirements.txt"),
    path.join(backendAbs, "__init__.py"),
    path.join(frontendAbs, "package.json")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function updateDriftDiagnostics(params) {
  const { report, anchor, state, diagnostics } = params;
  state.drift.clear();
  if (!report || !anchor) {
    refreshDiagnostics(state, diagnostics);
    return;
  }

  const status = String(report.status || "unknown");
  const delta = typeof report.delta === "number" ? report.delta : null;
  const alerts = Array.isArray(report.alerts) ? report.alerts.join(", ") : "";
  const message = delta === null
    ? `Guardian drift status: ${status}`
    : `Guardian drift status: ${status} (delta ${delta.toFixed(4)})${alerts ? ` [${alerts}]` : ""}`;

  let severity = vscode.DiagnosticSeverity.Information;
  if (status === "critical") {
    severity = vscode.DiagnosticSeverity.Warning;
  } else if (status === "drift") {
    severity = vscode.DiagnosticSeverity.Error;
  }

  const range = new vscode.Range(0, 0, 0, 1);
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  state.drift.set(anchor, [diagnostic]);
  refreshDiagnostics(state, diagnostics);
}

function updateConstraintsDiagnostics(params) {
  const { constraintsPath, backendAbs, workspaceRoot, state, diagnostics } = params;
  state.duplicates.clear();
  state.similar.clear();

  const payload = readJsonSafe(constraintsPath);
  if (!payload) {
    refreshDiagnostics(state, diagnostics);
    return;
  }

  const duplicateGroups = Array.isArray(payload.duplicate_functions)
    ? payload.duplicate_functions
    : [];
  const similarGroups = Array.isArray(payload.similar_functions)
    ? payload.similar_functions
    : [];

  const maxDiagnostics = 200;
  let count = 0;

  for (const group of duplicateGroups) {
    if (!group || !Array.isArray(group.functions)) {
      continue;
    }
    for (const fn of group.functions) {
      if (count >= maxDiagnostics) {
        break;
      }
      const resolved = resolveSourcePath(fn?.file, backendAbs, workspaceRoot);
      if (!resolved) {
        continue;
      }
      const message = `Duplicate function (${(group.hash || "").slice(0, 8)}) ${fn.name || "unknown"} size ${group.size ?? "?"}`;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        message,
        vscode.DiagnosticSeverity.Warning
      );
      const list = state.duplicates.get(resolved) ?? [];
      list.push(diagnostic);
      state.duplicates.set(resolved, list);
      count += 1;
    }
  }

  for (const group of similarGroups) {
    if (!group || !Array.isArray(group.functions) || group.functions.length < 2) {
      continue;
    }
    const [a, b] = group.functions;
    const aPath = resolveSourcePath(a?.file, backendAbs, workspaceRoot);
    const bPath = resolveSourcePath(b?.file, backendAbs, workspaceRoot);
    const similarity = typeof group.similarity === "number" ? group.similarity.toFixed(2) : "?";

    if (aPath) {
      const message = `Similar function to ${b?.name || "unknown"} (${similarity})`;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        message,
        vscode.DiagnosticSeverity.Information
      );
      const list = state.similar.get(aPath) ?? [];
      list.push(diagnostic);
      state.similar.set(aPath, list);
    }
    if (bPath) {
      const message = `Similar function to ${a?.name || "unknown"} (${similarity})`;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        message,
        vscode.DiagnosticSeverity.Information
      );
      const list = state.similar.get(bPath) ?? [];
      list.push(diagnostic);
      state.similar.set(bPath, list);
    }
  }

  refreshDiagnostics(state, diagnostics);
}

function resolveSourcePath(filePath, backendAbs, workspaceRoot) {
  if (!filePath || typeof filePath !== "string") {
    return null;
  }
  if (path.isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  const backendCandidate = path.resolve(backendAbs, filePath);
  if (fs.existsSync(backendCandidate)) {
    return backendCandidate;
  }
  const workspaceCandidate = path.resolve(workspaceRoot, filePath);
  if (fs.existsSync(workspaceCandidate)) {
    return workspaceCandidate;
  }
  return null;
}

function refreshDiagnostics(state, diagnostics) {
  diagnostics.clear();
  const combined = new Map();
  for (const map of [state.drift, state.duplicates, state.similar]) {
    for (const [filePath, entries] of map.entries()) {
      const existing = combined.get(filePath) ?? [];
      combined.set(filePath, existing.concat(entries));
    }
  }
  for (const [filePath, entries] of combined.entries()) {
    diagnostics.set(vscode.Uri.file(filePath), entries);
  }
}

module.exports = {
  activate,
  deactivate
};
