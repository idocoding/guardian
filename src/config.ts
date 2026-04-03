import fs from "node:fs/promises";
import path from "node:path";

export type SpecGuardConfig = {
  project?: {
    root?: string;
    backendRoot?: string;
    frontendRoot?: string;
    /** Additional roots to scan (merged with backendRoot/frontendRoot) */
    roots?: string[];
    discovery?: {
      enabled?: boolean;
    };
    /** Short product description injected into generated docs and AI context */
    description?: string;
    /** Path to README for product context extraction (default: auto-detected) */
    readmePath?: string;
  };
  ignore?: {
    directories?: string[];
    paths?: string[];
  };
  python?: {
    absoluteImportRoots?: string[];
  };
  frontend?: {
    routeDirs?: string[];
    aliases?: Record<string, string>;
    tsconfigPath?: string;
  };
  drift?: {
    graphLevel?: "module" | "function" | "auto";
    scales?: Array<"function" | "file" | "module" | "domain">;
    weights?: {
      entropy?: number;
      crossLayer?: number;
      cycles?: number;
      modularity?: number;
    };
    layers?: Record<string, string[]>;
    domains?: Record<string, string[]>;
    capacity?: {
      layers?: Record<string, number>;
      total?: number;
      warningRatio?: number;
      criticalRatio?: number;
    };
    growth?: {
      maxEdgesPerHour?: number;
      maxEdgesPerDay?: number;
      maxEdgeGrowthRatio?: number;
    };
    baselinePath?: string;
    historyPath?: string;
    criticalDelta?: number;
  };
  guard?: {
    mode?: "soft" | "hard";
  };
  llm?: {
    command?: string;
    args?: string[];
    timeoutMs?: number;
    promptTemplate?: string;
  };
  output?: {
    specsDir?: string;
  };
  docs?: {
    mode?: "lean" | "full";
    internalDir?: string;
  };
};

/** Single source of truth for the default specs output directory */
export const DEFAULT_SPECS_DIR = ".specs";

const DEFAULT_CONFIG: Required<SpecGuardConfig> = {
  project: {
    root: "",
    backendRoot: "",
    frontendRoot: "",
    roots: [],
    discovery: {
      enabled: true
    },
    description: "",
    readmePath: ""
  },
  ignore: {
    directories: [
      ".git",
      "node_modules",
      "dist",
      "build",
      ".next",
      ".venv",
      "venv",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      "coverage",
      "htmlcov",
      "logs",
      "log",
      "tmp",
      "cache",
      ".specs",
      "ghost-out",
      "ios",
      "android",
      ".expo",
      ".turbo",
      "web-build"
    ],
    paths: []
  },
  python: {
    absoluteImportRoots: []
  },
  frontend: {
    routeDirs: ["src/routes", "src/pages", "routes", "pages"],
    aliases: {},
    tsconfigPath: ""
  },
  drift: {
    graphLevel: "module",
    scales: ["module", "file", "function"],
    weights: {
      entropy: 0.4,
      crossLayer: 0.3,
      cycles: 0.2,
      modularity: 0.1
    },
    layers: {},
    domains: {},
    capacity: {
      layers: {},
      total: 0,
      warningRatio: 0.85,
      criticalRatio: 1.0
    },
    growth: {
      maxEdgesPerHour: 0,
      maxEdgesPerDay: 0,
      maxEdgeGrowthRatio: 0
    },
    baselinePath: "",
    historyPath: "",
    criticalDelta: 0.25
  },
  guard: {
    mode: "soft"
  },
  llm: {
    command: "",
    args: [],
    timeoutMs: 120000,
    promptTemplate: ""
  },
  output: {
    specsDir: DEFAULT_SPECS_DIR
  },
  docs: {
    mode: "lean",
    internalDir: "internal"
  }
};

export async function loadSpecGuardConfig(options: {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
}): Promise<SpecGuardConfig> {
  const configPath = await resolveConfigPath(options);
  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  let parsed: SpecGuardConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    parsed = normalizeConfig(JSON.parse(raw), path.dirname(configPath));
  } catch (error) {
    throw new Error(`Failed to read config at ${configPath}: ${String(error)}`);
  }

  return mergeConfig(DEFAULT_CONFIG, parsed);
}

function normalizeConfig(input: SpecGuardConfig, configDir?: string): SpecGuardConfig {
  const normalized: SpecGuardConfig = { ...input };

  if (input.project) {
    const project = { ...input.project } as Record<string, unknown>;
    if (!project.backendRoot && typeof project.backend_root !== "undefined") {
      project.backendRoot = project.backend_root as string;
    }
    delete project.backend_root;
    if (!project.frontendRoot && typeof project.frontend_root !== "undefined") {
      project.frontendRoot = project.frontend_root as string;
    }
    delete project.frontend_root;
    if (project.discovery && typeof project.discovery === "object") {
      const discovery = { ...(project.discovery as Record<string, unknown>) };
      if (
        typeof discovery.enabled === "undefined" &&
        typeof discovery.auto_detect !== "undefined"
      ) {
        discovery.enabled = discovery.auto_detect;
      }
      delete discovery.auto_detect;
      project.discovery = discovery;
    }

    const resolveMaybe = (value: unknown): string | undefined => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }
      return configDir ? path.resolve(configDir, value) : value;
    };

    project.root = resolveMaybe(project.root) ?? "";
    project.backendRoot = resolveMaybe(project.backendRoot) ?? "";
    project.frontendRoot = resolveMaybe(project.frontendRoot) ?? "";
    if (Array.isArray(project.roots) && configDir) {
      project.roots = (project.roots as string[])
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .map(r => path.resolve(configDir, r));
    }
    normalized.project = project as SpecGuardConfig["project"];
  }

  if (input.python) {
    const python = { ...input.python } as Record<string, unknown>;
    if (!python.absoluteImportRoots && typeof python.absolute_import_roots !== "undefined") {
      python.absoluteImportRoots = python.absolute_import_roots as string[];
    }
    delete python.absolute_import_roots;
    normalized.python = python as SpecGuardConfig["python"];
  }

  if (input.frontend) {
    const frontend = { ...input.frontend } as Record<string, unknown>;
    if (!frontend.routeDirs && typeof frontend.route_dirs !== "undefined") {
      frontend.routeDirs = frontend.route_dirs as string[];
    }
    delete frontend.route_dirs;
    if (!frontend.tsconfigPath && typeof frontend.tsconfig_path !== "undefined") {
      frontend.tsconfigPath = frontend.tsconfig_path as string;
    }
    delete frontend.tsconfig_path;
    normalized.frontend = frontend as SpecGuardConfig["frontend"];
  }

  if (input.drift) {
    const drift = { ...input.drift } as Record<string, unknown>;
    if (!drift.graphLevel && typeof drift.graph_level !== "undefined") {
      drift.graphLevel = drift.graph_level as string;
    }
    delete drift.graph_level;
    if (!drift.scales && typeof drift.scale_levels !== "undefined") {
      drift.scales = drift.scale_levels as NonNullable<SpecGuardConfig["drift"]>["scales"];
    }
    delete drift.scale_levels;
    if (!drift.baselinePath && typeof drift.baseline_path !== "undefined") {
      drift.baselinePath = drift.baseline_path as string;
    }
    delete drift.baseline_path;
    if (!drift.historyPath && typeof drift.history_path !== "undefined") {
      drift.historyPath = drift.history_path as string;
    }
    delete drift.history_path;
    if (!drift.domains && typeof drift.domain_map !== "undefined") {
      drift.domains = drift.domain_map as Record<string, string[]>;
    }
    delete drift.domain_map;
    if (drift.capacity && typeof drift.capacity === "object") {
      const capacity = { ...(drift.capacity as Record<string, unknown>) };
      if (!capacity.warningRatio && typeof capacity.warning_ratio !== "undefined") {
        capacity.warningRatio = capacity.warning_ratio;
      }
      delete capacity.warning_ratio;
      if (!capacity.criticalRatio && typeof capacity.critical_ratio !== "undefined") {
        capacity.criticalRatio = capacity.critical_ratio;
      }
      delete capacity.critical_ratio;
      if (!capacity.total && typeof capacity.total_edges !== "undefined") {
        capacity.total = capacity.total_edges;
      }
      delete capacity.total_edges;
      drift.capacity = capacity;
    }
    if (drift.growth && typeof drift.growth === "object") {
      const growth = { ...(drift.growth as Record<string, unknown>) };
      if (!growth.maxEdgesPerHour && typeof growth.max_edges_per_hour !== "undefined") {
        growth.maxEdgesPerHour = growth.max_edges_per_hour;
      }
      delete growth.max_edges_per_hour;
      if (!growth.maxEdgesPerDay && typeof growth.max_edges_per_day !== "undefined") {
        growth.maxEdgesPerDay = growth.max_edges_per_day;
      }
      delete growth.max_edges_per_day;
      if (!growth.maxEdgeGrowthRatio && typeof growth.max_edge_growth_ratio !== "undefined") {
        growth.maxEdgeGrowthRatio = growth.max_edge_growth_ratio;
      }
      delete growth.max_edge_growth_ratio;
      drift.growth = growth;
    }
    if (!drift.criticalDelta && typeof drift.critical_delta !== "undefined") {
      drift.criticalDelta = drift.critical_delta as number;
    }
    delete drift.critical_delta;
    if (drift.weights && typeof drift.weights === "object") {
      const weights = { ...(drift.weights as Record<string, unknown>) };
      if (!weights.crossLayer && typeof weights.cross_layer !== "undefined") {
        weights.crossLayer = weights.cross_layer;
      }
      delete weights.cross_layer;
      drift.weights = weights;
    }
    normalized.drift = drift as SpecGuardConfig["drift"];
  }

  if (input.guard) {
    const guard = { ...input.guard } as Record<string, unknown>;
    if (!guard.mode && typeof guard.guard_mode !== "undefined") {
      guard.mode = guard.guard_mode as string;
    }
    delete guard.guard_mode;
    normalized.guard = guard as SpecGuardConfig["guard"];
  }

  if (input.llm) {
    const llm = { ...input.llm } as Record<string, unknown>;
    if (!llm.timeoutMs && typeof llm.timeout_ms !== "undefined") {
      llm.timeoutMs = llm.timeout_ms as number;
    }
    delete llm.timeout_ms;
    if (!llm.promptTemplate && typeof llm.prompt_template !== "undefined") {
      llm.promptTemplate = llm.prompt_template as string;
    }
    delete llm.prompt_template;
    if (!llm.args && typeof llm.arguments !== "undefined") {
      llm.args = llm.arguments as string[];
    }
    delete llm.arguments;
    normalized.llm = llm as SpecGuardConfig["llm"];
  }

  if (input.docs) {
    const docs = { ...input.docs } as Record<string, unknown>;
    if (!docs.mode && typeof docs.docs_mode !== "undefined") {
      docs.mode = docs.docs_mode as string;
    }
    delete docs.docs_mode;
    if (!docs.internalDir && typeof docs.internal_dir !== "undefined") {
      docs.internalDir = docs.internal_dir as string;
    }
    delete docs.internal_dir;
    normalized.docs = docs as SpecGuardConfig["docs"];
  }

  return normalized;
}

function mergeConfig(base: SpecGuardConfig, override: SpecGuardConfig): SpecGuardConfig {
  return {
    project: {
      root: override.project?.root ?? base.project?.root ?? "",
      backendRoot: override.project?.backendRoot ?? base.project?.backendRoot ?? "",
      frontendRoot: override.project?.frontendRoot ?? base.project?.frontendRoot ?? "",
      roots: mergeArrays(base.project?.roots, override.project?.roots),
      discovery: {
        enabled:
          override.project?.discovery?.enabled ??
          base.project?.discovery?.enabled ??
          true
      },
      description: override.project?.description ?? base.project?.description ?? "",
      readmePath: override.project?.readmePath ?? base.project?.readmePath ?? ""
    },
    ignore: {
      directories: mergeArrays(base.ignore?.directories, override.ignore?.directories),
      paths: mergeArrays(base.ignore?.paths, override.ignore?.paths)
    },
    python: {
      absoluteImportRoots: mergeArrays(
        base.python?.absoluteImportRoots,
        override.python?.absoluteImportRoots
      )
    },
    frontend: {
      routeDirs: mergeArrays(base.frontend?.routeDirs, override.frontend?.routeDirs),
      aliases: {
        ...(base.frontend?.aliases ?? {}),
        ...(override.frontend?.aliases ?? {})
      },
      tsconfigPath: override.frontend?.tsconfigPath || base.frontend?.tsconfigPath || ""
    },
    drift: {
      graphLevel: override.drift?.graphLevel || base.drift?.graphLevel || "module",
      scales: mergeArrays(
        base.drift?.scales as string[] | undefined,
        override.drift?.scales as string[] | undefined
      ) as Array<"function" | "file" | "module" | "domain">,
      weights: {
        entropy: override.drift?.weights?.entropy ?? base.drift?.weights?.entropy ?? 0.4,
        crossLayer: override.drift?.weights?.crossLayer ?? base.drift?.weights?.crossLayer ?? 0.3,
        cycles: override.drift?.weights?.cycles ?? base.drift?.weights?.cycles ?? 0.2,
        modularity: override.drift?.weights?.modularity ?? base.drift?.weights?.modularity ?? 0.1
      },
      layers: {
        ...(base.drift?.layers ?? {}),
        ...(override.drift?.layers ?? {})
      },
      domains: {
        ...(base.drift?.domains ?? {}),
        ...(override.drift?.domains ?? {})
      },
      capacity: {
        layers: {
          ...(base.drift?.capacity?.layers ?? {}),
          ...(override.drift?.capacity?.layers ?? {})
        },
        total: override.drift?.capacity?.total ?? base.drift?.capacity?.total ?? 0,
        warningRatio:
          override.drift?.capacity?.warningRatio ??
          base.drift?.capacity?.warningRatio ??
          0.85,
        criticalRatio:
          override.drift?.capacity?.criticalRatio ??
          base.drift?.capacity?.criticalRatio ??
          1.0
      },
      growth: {
        maxEdgesPerHour:
          override.drift?.growth?.maxEdgesPerHour ??
          base.drift?.growth?.maxEdgesPerHour ??
          0,
        maxEdgesPerDay:
          override.drift?.growth?.maxEdgesPerDay ??
          base.drift?.growth?.maxEdgesPerDay ??
          0,
        maxEdgeGrowthRatio:
          override.drift?.growth?.maxEdgeGrowthRatio ??
          base.drift?.growth?.maxEdgeGrowthRatio ??
          0
      },
      baselinePath: override.drift?.baselinePath || base.drift?.baselinePath || "",
      historyPath: override.drift?.historyPath || base.drift?.historyPath || "",
      criticalDelta: override.drift?.criticalDelta ?? base.drift?.criticalDelta ?? 0.25
    },
    guard: {
      mode: override.guard?.mode || base.guard?.mode || "soft"
    },
    llm: {
      command: override.llm?.command ?? base.llm?.command ?? "",
      args: mergeArrays(base.llm?.args, override.llm?.args),
      timeoutMs: override.llm?.timeoutMs ?? base.llm?.timeoutMs ?? 120000,
      promptTemplate: override.llm?.promptTemplate ?? base.llm?.promptTemplate ?? ""
    },
    output: {
      specsDir: override.output?.specsDir ?? base.output?.specsDir ?? DEFAULT_SPECS_DIR
    },
    docs: {
      mode: override.docs?.mode ?? base.docs?.mode ?? "lean",
      internalDir: override.docs?.internalDir ?? base.docs?.internalDir ?? "internal"
    }
  };
}

function mergeArrays(base: string[] | undefined, override: string[] | undefined): string[] {
  const result = new Set<string>();
  for (const entry of base ?? []) {
    result.add(entry);
  }
  for (const entry of override ?? []) {
    result.add(entry);
  }
  return Array.from(result);
}

async function resolveConfigPath(options: {
  projectRoot?: string;
  backendRoot?: string;
  frontendRoot?: string;
  configPath?: string;
}): Promise<string | null> {
  if (options.configPath) {
    const resolved = path.resolve(options.configPath);
    const stat = await safeStat(resolved);
    if (stat?.isDirectory()) {
      for (const name of ["guardian.config.json", "specguard.config.json"]) {
        const candidate = path.join(resolved, name);
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
      throw new Error(`guardian.config.json not found in ${resolved}`);
    }
    if (stat?.isFile()) {
      return resolved;
    }
    throw new Error(`Config path not found: ${resolved}`);
  }

  const roots = uniquePaths(
    [
      options.projectRoot,
      options.backendRoot,
      options.frontendRoot
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  );
  const commonRoot = roots.length > 0 ? findCommonRoot(roots) : process.cwd();

  // Check guardian.config.json first, fall back to specguard.config.json
  const guardianCandidate = path.join(commonRoot, "guardian.config.json");
  if (await fileExists(guardianCandidate)) {
    return guardianCandidate;
  }
  const specguardCandidate = path.join(commonRoot, "specguard.config.json");
  if (await fileExists(specguardCandidate)) {
    return specguardCandidate;
  }

  return null;
}

function findCommonRoot(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd();
  }

  const splitPaths = paths.map((p) => path.resolve(p).split(path.sep));
  const minLength = Math.min(...splitPaths.map((parts) => parts.length));
  const shared: string[] = [];

  for (let i = 0; i < minLength; i += 1) {
    const segment = splitPaths[0][i];
    if (splitPaths.every((parts) => parts[i] === segment)) {
      shared.push(segment);
    } else {
      break;
    }
  }

  if (shared.length === 0) {
    return path.parse(paths[0]).root;
  }

  return shared.join(path.sep);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}
