import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { runConstraints } from "./constraints.js";
import { runSimulate } from "./simulate.js";
import { buildSnapshots } from "../extract/index.js";
import { renderContextBlock } from "../extract/context-block.js";
import { logResolvedProjectPaths, resolveProjectPaths } from "../project-discovery.js";
import { DEFAULT_SPECS_DIR } from "../config.js";

export type GuardOptions = {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  task: string;
  promptOutput?: string;
  patchOutput?: string;
  simulationOutput?: string;
  configPath?: string;
  mode?: "soft" | "hard";
  llmCommand?: string;
  printContext?: boolean;
};

export async function runGuard(options: GuardOptions): Promise<void> {
  const resolved = await resolveProjectPaths({
    projectRoot: options.projectRoot,
    backendRoot: options.backendRoot,
    frontendRoot: options.frontendRoot,
    configPath: options.configPath
  });
  const config = resolved.config;
  logResolvedProjectPaths(resolved);

  const constraintsPath = path.resolve("specs-out/machine/constraints.json");
  await runConstraints({
    projectRoot: resolved.workspaceRoot,
    backendRoot: resolved.backendRoot,
    frontendRoot: resolved.frontendRoot,
    output: constraintsPath,
    configPath: options.configPath
  });

  const constraints = await loadConstraints(constraintsPath);
  const basePrompt =
    constraints && typeof constraints["prompt"] === "string" ? (constraints["prompt"] as string) : "";

  if (options.printContext) {
    const { architecture, ux } = await buildSnapshots({
      projectRoot: resolved.workspaceRoot,
      backendRoot: resolved.backendRoot,
      frontendRoot: resolved.frontendRoot,
      output: DEFAULT_SPECS_DIR,
      includeFileGraph: true,
      configPath: options.configPath
    });
    const context = renderGuardContext({
      task: options.task,
      constraintPrompt: basePrompt,
      contextBlock: renderContextBlock(architecture, ux, {
        focusQuery: options.task,
        maxLines: 140
      })
    });
    console.log(context);
    return;
  }

  const prompt = buildGuardPrompt(
    basePrompt,
    options.task,
    config.llm?.promptTemplate
  );

  const promptPath = path.resolve(options.promptOutput ?? "specs-out/machine/guard.prompt.txt");
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, prompt);
  console.log(`Wrote ${promptPath}`);

  const llmCommand = options.llmCommand || config.llm?.command;
  if (!llmCommand) {
    console.log("No LLM command configured. Provide llm.command in config or --llm-command.");
    return;
  }

  const { command, args } = resolveCommand(llmCommand, config.llm?.args ?? []);
  const patch = await runLlmCommand(command, args, prompt, config.llm?.timeoutMs ?? 120000);
  if (!patch.trim()) {
    throw new Error("LLM command returned empty output.");
  }

  const patchPath = path.resolve(options.patchOutput ?? "specs-out/machine/guard.patch");
  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, patch);
  console.log(`Wrote ${patchPath}`);

  const simulationPath = path.resolve(
    options.simulationOutput ?? "specs-out/machine/drift.simulation.json"
  );
  await runSimulate({
    projectRoot: resolved.workspaceRoot,
    backendRoot: resolved.backendRoot,
    frontendRoot: resolved.frontendRoot,
    output: simulationPath,
    configPath: options.configPath,
    patch: patchPath,
    mode: options.mode ?? config.guard?.mode ?? "soft"
  });
}

function renderGuardContext(params: {
  task: string;
  constraintPrompt: string;
  contextBlock: string;
}): string {
  const lines: string[] = [];
  lines.push("<!-- guardian:guard-context -->");
  lines.push("## Requested Task");
  lines.push(params.task.trim() || "(not provided)");
  lines.push("");
  lines.push("## Constraint Summary");
  const constraints = extractConstraintLines(params.constraintPrompt);
  if (constraints.length > 0) {
    lines.push(...constraints);
  } else {
    lines.push("- No explicit constraint summary available.");
  }
  lines.push("");
  lines.push(params.contextBlock.trim());
  lines.push("<!-- /guardian:guard-context -->");
  return lines.join("\n");
}

function extractConstraintLines(prompt: string): string[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const explicit = lines.filter((line) => line.startsWith("- "));
  if (explicit.length > 0) {
    return explicit;
  }
  return lines.slice(0, 6).map((line) => `- ${line}`);
}

async function loadConstraints(constraintsPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(constraintsPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildGuardPrompt(basePrompt: string, task: string, template?: string): string {
  const trimmedTask = task?.trim() ?? "";
  const defaultPrompt = [
    basePrompt.trim(),
    "",
    "User Task:",
    trimmedTask || "(not provided)",
    "",
    "Return a unified diff patch only."
  ]
    .filter(Boolean)
    .join("\n");

  if (!template || template.trim().length === 0) {
    return defaultPrompt;
  }

  const withConstraints = template.includes("{{constraints}}")
    ? template.replace(/{{constraints}}/g, basePrompt.trim())
    : `${template.trim()}\n\n${basePrompt.trim()}`;

  return withConstraints.includes("{{task}}")
    ? withConstraints.replace(/{{task}}/g, trimmedTask)
    : `${withConstraints.trim()}\n\nUser Task:\n${trimmedTask || "(not provided)"}\n`;
}

function resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (args.length > 0) {
    return { command, args };
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { command, args };
  }
  return { command: parts[0], args: parts.slice(1) };
}

function runLlmCommand(
  command: string,
  args: string[],
  prompt: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("LLM command timed out."));
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`LLM command failed (${code}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
