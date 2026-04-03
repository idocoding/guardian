/**
 * HTML Doc Renderer — generates a multi-page Javadoc-style HTML viewer.
 *
 * Output: Record<filename, html> — one file per section, shared nav sidebar.
 *
 * Pages:
 *   index.html          Overview (stats + stakeholder metrics)
 *   architecture.html   System Architecture (inter-module diagram + hld.md)
 *   api-surface.html    API Surface (all domains)
 *   data-models.html    Data Models (ER diagrams + full schemas)
 *   quality.html        Quality Signals + Pattern Registry
 *   tasks.html          Background Tasks (conditional)
 *   timeline.html       Feature Timeline (conditional)
 *   frontend.html       Frontend Pages (conditional)
 *   discrepancies.html  Discrepancies (conditional)
 */

import type { CodebaseIntelligence } from "./codebase-intel.js";
import type { FeatureArcs } from "./feature-arcs.js";
import type { DiscrepancyReport } from "./discrepancies.js";
import type { ExistingDocs } from "./docs-loader.js";
import type { UxSnapshot } from "./types.js";
import { parseIntegrationDomains } from "./docs-loader.js";

export type HtmlDocOptions = {
  intel: CodebaseIntelligence;
  featureArcs?: FeatureArcs | null;
  discrepancies?: DiscrepancyReport | null;
  existingDocs?: ExistingDocs | null;
  uxSnapshot?: UxSnapshot | null;
  /** Product context from README (first section) */
  productContext?: string | null;
};

type PageDef = {
  file: string;
  label: string;
  badge?: string;
  anchors?: Array<{ id: string; label: string }>;
};

const COLLAPSE_THRESHOLD = 15;

// ── Entry point ───────────────────────────────────────────────────────────

export function renderHtmlDoc(options: HtmlDocOptions): Record<string, string> {
  const { intel, featureArcs, discrepancies, existingDocs, uxSnapshot, productContext } = options;

  const integrationDomains = existingDocs?.integrationByDomain
    ? parseIntegrationDomains(existingDocs.integrationByDomain)
    : null;

  const domainNames = integrationDomains
    ? Array.from(integrationDomains.keys()).sort()
    : Array.from(groupEndpointsByDomain(intel).keys()).sort();

  const modelGroups = groupModelsByModule(intel);
  const groupNames = Array.from(modelGroups.keys()).sort();

  const hasArcs = !!(featureArcs && Object.keys(featureArcs.arcs).length > 0);
  const hasTasks = intel.background_tasks.length > 0;
  const hasPages = intel.frontend_pages.length > 0;
  const hasDiscrepancies = !!discrepancies;

  // ── Page definitions (drives sidebar nav) ────────────────────────────────
  const pages: PageDef[] = [
    { file: "index.html", label: `${intel.meta.project} Overview` },
    { file: "architecture.html", label: "System Architecture" },
    {
      file: "api-surface.html",
      label: "API Endpoints",
      badge: String(intel.meta.counts.endpoints),
      anchors: domainNames.map((d) => ({ id: mkId(d), label: d })),
    },
    {
      file: "data-models.html",
      label: "Data Models & Schemas",
      badge: String(intel.meta.counts.models),
      anchors: groupNames.map((g) => ({ id: mkId(`${g}-group`), label: g })),
    },
    {
      file: "quality.html",
      label: "Code Quality",
      badge: String(intel.pattern_registry.patterns.filter((p) => p.occurrences > 0).length),
    },
  ];

  if (hasTasks) {
    const unique = deduplicateTasks(intel.background_tasks);
    pages.push({ file: "tasks.html", label: "Background Tasks", badge: String(unique.length) });
  }
  if (hasArcs && featureArcs) {
    pages.push({
      file: "timeline.html",
      label: "Feature Timeline",
      badge: String(Object.keys(featureArcs.arcs).length),
    });
  }
  if (hasPages) {
    pages.push({ file: "frontend.html", label: "Frontend Pages", badge: String(intel.frontend_pages.length) });
  }
  if (hasDiscrepancies) {
    pages.push({
      file: "discrepancies.html",
      label: "Discrepancies",
      badge: discrepancies!.summary.total_issues > 0 ? String(discrepancies!.summary.total_issues) : undefined,
    });
  }

  const project = intel.meta.project;

  // ── Build all pages ───────────────────────────────────────────────────────
  const files: Record<string, string> = {};

  files["index.html"] = buildPage(project, pages, "index.html",
    `${project} Overview`, renderOverviewPage(intel, existingDocs ?? {}, productContext ?? null, uxSnapshot ?? null));

  files["architecture.html"] = buildPage(project, pages, "architecture.html",
    "System Architecture", renderArchitecturePage(intel, existingDocs ?? {}));

  files["api-surface.html"] = buildPage(project, pages, "api-surface.html",
    "API Surface", renderApiSurfacePage(intel, integrationDomains, domainNames));

  files["data-models.html"] = buildPage(project, pages, "data-models.html",
    "Data Models", renderDataModelsPage(intel, modelGroups, groupNames));

  files["quality.html"] = buildPage(project, pages, "quality.html",
    "Quality & Patterns", renderQualityPage(intel, existingDocs ?? {}));

  if (hasTasks) {
    files["tasks.html"] = buildPage(project, pages, "tasks.html",
      "Background Tasks", renderTasksPage(intel));
  }

  if (hasArcs && featureArcs) {
    files["timeline.html"] = buildPage(project, pages, "timeline.html",
      "Feature Timeline", renderTimelinePage(featureArcs));
  }

  if (hasPages) {
    files["frontend.html"] = buildPage(project, pages, "frontend.html",
      "Frontend Pages", renderFrontendPage(intel, uxSnapshot ?? null));
  }

  if (hasDiscrepancies && discrepancies) {
    files["discrepancies.html"] = buildPage(project, pages, "discrepancies.html",
      "Discrepancies", renderDiscrepanciesPage(discrepancies));
  }

  return files;
}

// ── Page shell ────────────────────────────────────────────────────────────

function buildPage(
  project: string,
  pages: PageDef[],
  currentFile: string,
  title: string,
  body: string
): string {
  const nav = buildNav(pages, currentFile);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(title)} — ${e(project)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="layout">
  <nav id="sidebar">
    <div id="sidebar-header">
      <a href="index.html" id="project-name">${e(project)}</a>
      <input id="search-box" type="text" placeholder="Filter..." autocomplete="off" />
    </div>
    <div id="nav-tree">${nav}</div>
  </nav>
  <main id="content">
    <h1 class="page-title">${e(title)}</h1>
    ${body}
  </main>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>${JS}</script>
</body>
</html>`;
}

// ── Sidebar nav ───────────────────────────────────────────────────────────

function buildNav(pages: PageDef[], currentFile: string): string {
  return pages.map((page) => {
    const isActive = page.file === currentFile;
    const badge = page.badge ? `<span class="nav-badge">${e(page.badge)}</span>` : "";
    const activeClass = isActive ? " active" : "";

    if (!page.anchors || page.anchors.length === 0) {
      return `<a class="nav-top-link${activeClass}" href="${page.file}">${e(page.label)}${badge}</a>`;
    }

    const childrenHtml = page.anchors.map((a) =>
      `<a class="nav-item" href="${page.file}#${a.id}">${e(a.label)}</a>`
    ).join("");

    return `<div class="nav-group${isActive ? " open" : ""}">
  <div class="nav-group-header" onclick="toggleNav(this)">
    <span class="chevron">▼</span>
    <a class="nav-group-link${activeClass}" href="${page.file}">${e(page.label)}${badge}</a>
  </div>
  <div class="nav-children">${childrenHtml}</div>
</div>`;
  }).join("\n");
}

// ── Page renderers ────────────────────────────────────────────────────────

function renderOverviewPage(intel: CodebaseIntelligence, docs: Partial<ExistingDocs>, productContext: string | null, uxSnapshot: UxSnapshot | null): string {
  const parts: string[] = [];

  // Product description from README
  if (productContext) {
    parts.push(`<section class="product-context"><div class="product-description">${renderMd(productContext)}</div></section>`);
  }

  // Stats grid
  const stats = [
    { label: "Endpoints", value: intel.meta.counts.endpoints },
    { label: "Models", value: intel.meta.counts.models },
    { label: "Pages", value: intel.meta.counts.pages },
    { label: "Components", value: uxSnapshot?.components?.length ?? 0 },
    { label: "Tasks", value: intel.meta.counts.tasks },
    { label: "Modules", value: intel.meta.counts.modules },
  ];
  parts.push(`<div class="stats-grid">
${stats.map((s) => `<div class="stat-card"><div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div></div>`).join("")}
</div>`);

  // Backend modules summary
  const backendModules = intel.service_map
    .filter((m) => m.type === "backend" && m.file_count > 0)
    .sort((a, b) => b.endpoint_count - a.endpoint_count);
  if (backendModules.length > 0) {
    const moduleRows = backendModules.map((m) => {
      const deps = m.imports.length > 0 ? m.imports.join(", ") : "—";
      return `<tr><td><strong>${e(m.id)}</strong></td><td>${m.endpoint_count}</td><td>${m.file_count}</td><td>${e(deps)}</td></tr>`;
    }).join("");
    parts.push(`<section><h2>Backend Modules</h2>
<table><thead><tr><th>Module</th><th>Endpoints</th><th>Files</th><th>Dependencies</th></tr></thead>
<tbody>${moduleRows}</tbody></table></section>`);
  }

  // Frontend pages summary
  if (intel.frontend_pages.length > 0) {
    const pageRows = intel.frontend_pages.map((p) => {
      const components = p.direct_components?.length ?? 0;
      const apis = p.api_calls?.length ?? 0;
      const apiList = apis > 0 ? p.api_calls.slice(0, 3).join(", ") + (apis > 3 ? ` +${apis - 3}` : "") : "—";
      return `<tr><td><code>${e(p.path)}</code></td><td>${e(p.component ?? "")}</td><td>${components}</td><td>${apiList}</td></tr>`;
    }).join("");
    parts.push(`<section><h2>Frontend Pages</h2>
<table><thead><tr><th>Route</th><th>Component</th><th>Children</th><th>API Calls</th></tr></thead>
<tbody>${pageRows}</tbody></table></section>`);
  }

  // Stakeholder metrics
  if (docs.stakeholderMetrics) {
    parts.push(`<section><h2>Health</h2>${renderMd(docs.stakeholderMetrics)}</section>`);
  }

  // System scale
  if (docs.systemScale) {
    parts.push(`<section><h2>System Scale</h2>${renderMd(docs.systemScale)}</section>`);
  }

  return parts.join("\n");
}

function renderArchitecturePage(intel: CodebaseIntelligence, docs: Partial<ExistingDocs>): string {
  const parts: string[] = [];

  // ── 1. Per-module, per-domain service interaction diagrams ────────────────
  const { modules: interactionModules, serviceUseCount } = buildModuleInteractionData(intel);
  const sharedServices = new Set(
    Array.from(serviceUseCount.entries()).filter(([, n]) => n > 1).map(([s]) => s)
  );

  if (interactionModules.size > 0) {
    const moduleSections = Array.from(interactionModules.entries()).map(([mod, { domains }]) => {
      const totalDomains = domains.size;
      const totalSvcs = new Set(Array.from(domains.values()).flatMap((d) => d.services)).size;
      const domainParts = Array.from(domains.entries()).map(([domain, { services, epCount }]) => {
        const diagram = buildDomainDiagram(domain, services, sharedServices);
        return `<details class="domain-diagram">
<summary><strong>${e(domain)}</strong> <span class="badge">${epCount} ep</span> <span class="badge-svc">${services.length} services</span></summary>
<div class="details-body">${lightbox(`<div class="mermaid">\n${diagram}\n</div>`)}</div>
</details>`;
      }).join("\n");
      return `<div class="module-block" id="mod-${mkId(mod)}">
<h3>${e(mod)} <span class="muted">${totalDomains} domains · ${totalSvcs} unique services</span></h3>
${domainParts}
</div>`;
    }).join("\n");

    parts.push(`<section id="module-interaction">
<h2>Module Interaction</h2>
<p class="muted">Per-domain service dependencies grouped by backend module. Click a domain to expand its diagram.</p>
${moduleSections}
</section>`);
  }

  // ── 1b. Key Workflow Diagrams (sequence diagrams from endpoint traces) ──────
  {
    const workflows = buildWorkflowDiagrams(intel);
    if (workflows.length > 0) {
      const workflowHtml = workflows.map((w) =>
        `<details class="domain-diagram"${w.important ? " open" : ""}>
<summary><strong>${e(w.title)}</strong> <span class="badge">${w.method} ${w.path}</span></summary>
<div class="details-body">${lightbox(`<div class="mermaid">\n${w.diagram}\n</div>`)}</div>
</details>`
      ).join("\n");

      parts.push(`<section id="workflows">
<h2>Key Workflows</h2>
<p class="muted">Sequence diagrams showing how data flows through the system for key operations.</p>
${workflowHtml}
</section>`);
    }
  }

  // ── 1c. Cross-Service Communication Diagram ────────────────────────────────
  {
    const crossServiceDiagram = buildCrossServiceDiagram(intel);
    if (crossServiceDiagram) {
      parts.push(`<section id="cross-service">
<h2>Service Communication Map</h2>
<p class="muted">How services call each other. Derived from service call patterns and proxy endpoints.</p>
${lightbox(`<div class="mermaid">\n${crossServiceDiagram}\n</div>`)}
</section>`);
    }
  }

  // ── 1d. Full System Architecture Diagram ────────────────────────────────────
  {
    const systemDiagram = buildFullSystemDiagram(intel);
    if (systemDiagram) {
      parts.push(`<section id="system-diagram">
<h2>System Architecture</h2>
<p class="muted">Full system view: services, data stores, and external dependencies.</p>
${lightbox(`<div class="mermaid">\n${systemDiagram}\n</div>`)}
</section>`);
    }
  }

  // ── 3. Backend subsystems (may include per-module diagrams) ────────────────
  if (docs.backendSubsystems) {
    parts.push(`<section id="backend-subsystems">
<h2>Backend Subsystems</h2>
${lightbox(renderMd(docs.backendSubsystems))}
</section>`);
  }

  // ── 4. Coupling heatmap ────────────────────────────────────────────────────
  if (docs.couplingHeatmap) {
    parts.push(`<section id="coupling">
<h2>Structural Coupling Heatmap</h2>
${renderMd(docs.couplingHeatmap)}
</section>`);
  }

  // ── 5. Drift summary ───────────────────────────────────────────────────────
  if (docs.driftSummary) {
    parts.push(`<section id="drift">
<h2>Drift Summary</h2>
${renderMd(docs.driftSummary)}
</section>`);
  }

  // ── 6. Module table fallback ───────────────────────────────────────────────
  const backendModules = intel.service_map.filter((m) => m.type === "backend");
  const rows = backendModules.sort((a, b) => b.endpoint_count - a.endpoint_count)
    .map((m) => `<tr><td><code>${e(m.id)}</code></td><td>${e(m.layer)}</td><td>${m.file_count}</td><td>${m.endpoint_count}</td></tr>`)
    .join("");
  parts.push(`<section id="modules">
<h2>Modules</h2>
${table(["Module", "Layer", "Files", "Endpoints"], rows)}
</section>`);

  return parts.join("\n");
}

function renderApiSurfacePage(
  intel: CodebaseIntelligence,
  integrationDomains: Map<string, { heading: string; content: string }> | null,
  domainNames: string[]
): string {
  const quickIndex = `<div class="quick-index">${domainNames.map((d) =>
    `<a href="#${mkId(d)}">${e(d)}</a>`
  ).join("")}</div>`;

  const sections: string[] = [quickIndex];

  if (integrationDomains && integrationDomains.size > 0) {
    for (const domain of domainNames) {
      const entry = integrationDomains.get(domain);
      if (!entry) continue;
      const rowCount = Math.max(0, (entry.content.match(/^\|/gm) ?? []).length - 2);
      const inner = renderMd(entry.content);
      const open = rowCount <= COLLAPSE_THRESHOLD;
      sections.push(`<section id="${mkId(domain)}" class="domain-section">
<h2>${e(domain)} <span class="badge">${rowCount}</span></h2>
<details${open ? " open" : ""}><summary>Show endpoints</summary><div class="details-body">${inner}</div></details>
</section>`);
    }
  } else {
    const grouped = groupEndpointsByDomain(intel);
    for (const domain of domainNames) {
      const endpoints = grouped.get(domain) ?? [];
      const rows = endpoints.map(([, ep]) => {
        const pats = ep.patterns.length > 0 ? ep.patterns.join(", ") : "—";
        return `<tr><td><code>${e(ep.method)}</code></td><td><code>${e(ep.path)}</code></td><td><code>${e(ep.handler)}</code></td><td>${e(pats)}</td></tr>`;
      }).join("");
      const open = endpoints.length <= COLLAPSE_THRESHOLD;
      sections.push(`<section id="${mkId(domain)}" class="domain-section">
<h2>${e(domain)} <span class="badge">${endpoints.length}</span></h2>
<details${open ? " open" : ""}><summary>Show endpoints</summary><div class="details-body">${table(["Method", "Path", "Handler", "Patterns"], rows)}</div></details>
</section>`);
    }
  }

  return sections.join("\n");
}

function renderDataModelsPage(
  intel: CodebaseIntelligence,
  modelGroups: Map<string, Array<[string, CodebaseIntelligence["model_registry"][string]]>>,
  groupNames: string[]
): string {
  const quickIndex = `<div class="quick-index">${groupNames.map((g) =>
    `<a href="#${mkId(`${g}-group`)}">${e(g)}</a>`
  ).join("")}</div>`;

  const sections: string[] = [quickIndex];

  for (const group of groupNames) {
    const models = modelGroups.get(group) ?? [];
    const groupId = mkId(`${group}-group`);

    // Split by framework — ORM models (SQLAlchemy/Django) vs schema models (Pydantic)
    const ormModels = models.filter(([, m]) => m.framework !== "pydantic");
    const schemaModels = models.filter(([, m]) => m.framework === "pydantic");

    // ER diagram for ORM models only
    const erDiagram = buildErDiagram(ormModels);
    const diagramHtml = erDiagram
      ? `<div class="subsection">${lightbox(`<div class="mermaid">\n${erDiagram}\n</div>`)}</div>`
      : "";

    const renderModelBlock = (label: string, list: typeof models) => {
      if (list.length === 0) return "";
      const schemas = list.map(([name, m]) => {
        const schema = renderModelSchema(name, m);
        const role = inferModelRole(name, m, intel);
        const roleHtml = role ? `<span class="model-role">${e(role)}</span>` : "";
        return `<details>
<summary><strong>${e(name)}</strong> ${roleHtml}<small class="muted">${m.fields.length} fields${m.relationships.length > 0 ? ` · ${m.relationships.length} rels` : ""}</small></summary>
<div class="details-body">${schema}</div>
</details>`;
      }).join("\n");
      return `<div class="model-layer">
<h3>${label} <span class="badge">${list.length}</span></h3>
${schemas}
</div>`;
    };

    sections.push(`<section id="${groupId}">
<h2>${e(group)} <span class="badge">${models.length} models</span></h2>
${diagramHtml}
${renderModelBlock("ORM Models (database tables)", ormModels)}
${renderModelBlock("Schema Models (request / response)", schemaModels)}
</section>`);
  }

  return sections.join("\n");
}

function renderQualityPage(intel: CodebaseIntelligence, docs: Partial<ExistingDocs>): string {
  const parts: string[] = [];

  // Quality signals
  parts.push(`<section id="quality-signals"><h2>Quality Signals</h2>${
    docs.qualitySignals
      ? renderMd(docs.qualitySignals)
      : `<p class="muted">Run <code>specguard extract</code> to populate quality signals.</p>`
  }</section>`);

  // Pattern registry
  const active = intel.pattern_registry.patterns.filter((p) => p.occurrences > 0);
  const rows = active.map((p) => {
    const example = p.example_endpoints[0] ? `<code>${e(p.example_endpoints[0])}</code>` : "—";
    return `<tr><td>${e(p.id)}</td><td><strong>${e(p.name)}</strong></td><td>${p.occurrences}</td><td>${e(p.description)}</td><td>${example}</td></tr>`;
  }).join("");
  parts.push(`<section id="pattern-registry">
<h2>Pattern Registry <span class="badge">${active.length} active</span></h2>
${table(["ID", "Pattern", "Occurrences", "Description", "Example"], rows)}
</section>`);

  return parts.join("\n");
}

function renderTasksPage(intel: CodebaseIntelligence): string {
  const unique = deduplicateTasks(intel.background_tasks);

  // Build trigger map: task name → endpoint keys that call it
  const triggerMap = buildTaskTriggerMap(intel);

  const cards = unique.map((task) => {
    const triggers = triggerMap.get(task.name) ?? [];
    const triggerHtml = triggers.length > 0
      ? `<div class="trigger-list"><strong>Called from:</strong><ul>${
          triggers.map((t) => `<li><code>${e(t)}</code></li>`).join("")
        }</ul></div>`
      : `<p class="muted">No direct endpoint triggers found in service_calls.</p>`;

    const sources = task.sources;
    const redundancyNote = sources.length > 1
      ? `<p class="note-reuse">♻ Reused across ${sources.length} files — same function, different workflows (not redundant).</p>`
      : sources.length === 0 ? "" : `<p class="muted">Source: <code>${e(sources[0])}</code></p>`;

    return `<div class="task-card" id="${mkId(task.name)}">
  <div class="task-header">
    <code class="task-name">${e(task.name)}</code>
    <span class="badge">${e(task.kind)}</span>
    ${sources.length > 1 ? `<span class="badge warn">${sources.length} call sites</span>` : ""}
  </div>
  ${redundancyNote}
  ${sources.length > 1 ? `<div class="source-list"><strong>Source files:</strong><ul>${sources.map((s) => `<li><code>${e(s)}</code></li>`).join("")}</ul></div>` : ""}
  ${triggerHtml}
</div>`;
  }).join("\n");

  return `<div class="task-grid">${cards}</div>`;
}

function renderTimelinePage(featureArcs: FeatureArcs): string {
  const parts: string[] = [];
  for (const [tag, arc] of Object.entries(featureArcs.arcs)) {
    const sprintRows = Object.entries(arc.sprints).map(([sprint, snap]) => {
      const eps = snap.endpoints.length > 0
        ? snap.endpoints.map((ep) => `<code>${e(ep)}</code>`).join(", ") : "—";
      const mods = snap.models.length > 0
        ? snap.models.map((m) => `<code>${e(m)}</code>`).join(", ") : "—";
      return `<tr><td>${e(sprint)}</td><td>${snap.features.map(e).join(", ")}</td><td>${eps}</td><td>${mods}</td></tr>`;
    }).join("");
    parts.push(`<section id="${mkId(`arc-${tag}`)}">
<h2>${e(tag)} <span class="badge">${arc.total_endpoints} endpoints · ${arc.total_models} models</span></h2>
${table(["Sprint", "Features", "Endpoints", "Models"], sprintRows)}
</section>`);
  }
  return parts.join("\n");
}

function renderFrontendPage(intel: CodebaseIntelligence, ux: UxSnapshot | null): string {
  return intel.frontend_pages.map((page) => {
    // ── Component interaction diagram from UX snapshot ─────────────────────
    let componentDiagram = "";
    if (ux?.component_graph) {
      const diagram = buildComponentDiagram(page.component, ux);
      if (diagram) {
        componentDiagram = `<div class="subsection">
<h3>Component Tree</h3>
${lightbox(`<div class="mermaid">\n${diagram}\n</div>`)}
</div>`;
      }
    }

    // ── API calls grouped by domain ────────────────────────────────────────
    const byDomain = new Map<string, string[]>();
    for (const call of page.api_calls) {
      const normalised = call.replace(/^[A-Z]+ /, "").replace(/^\$\{[^}]+\}\//, "/").replace(/^\$\{[^}]+\}/, "").replace(/^\//, "");
      const parts = normalised.split("/");
      const skip = new Set(["api", "v1", "v2", ""]);
      const domain = parts.find((p) => !skip.has(p) && !p.startsWith("{") && !p.startsWith("$")) ?? "other";
      const list = byDomain.get(domain) ?? [];
      list.push(call);
      byDomain.set(domain, list);
    }

    const domainHtml = Array.from(byDomain.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([domain, calls]) => {
      const rows = calls.map((c) => `<tr><td><code>${e(c)}</code></td></tr>`).join("");
      return `<details open><summary><strong>${e(domain)}</strong> <span class="badge">${calls.length}</span></summary>
<div class="details-body">${table(["Endpoint"], rows)}</div></details>`;
    }).join("\n");

    return `<section id="${mkId(page.path)}">
<h2><code>${e(page.path)}</code> <span class="muted">${e(page.component)}</span></h2>
<p><strong>${page.api_calls.length} API calls</strong> across ${byDomain.size} domain(s)</p>
${componentDiagram}
${domainHtml}
</section>`;
  }).join("\n");
}

function buildComponentDiagram(rootComponent: string, ux: UxSnapshot): string {
  // Find the root node by component name
  const rootNode = ux.components.find((c) => c.name === rootComponent || c.id.endsWith(`#${rootComponent}`));
  if (!rootNode) return "";

  // BFS from root through component_graph edges (max depth 4, max nodes 30)
  const edges = ux.component_graph ?? [];
  const visited = new Set<string>([rootNode.id]);
  const queue = [rootNode.id];
  const usedEdges: Array<{ from: string; to: string }> = [];

  while (queue.length > 0 && visited.size < 20) {
    const current = queue.shift()!;
    const children = edges.filter((e) => e.from === current);
    for (const edge of children) {
      if (!visited.has(edge.to) && visited.size < 20) {
        visited.add(edge.to);
        queue.push(edge.to);
        usedEdges.push(edge);
      }
    }
  }

  if (usedEdges.length === 0) return "";

  // Build name lookup
  const idToName = new Map(ux.components.map((c) => [c.id, c.name]));
  const getName = (id: string) => idToName.get(id) ?? id.split("#").pop() ?? id;

  const lines = ["flowchart TD"];
  const nodeIds = new Set<string>();

  for (const edge of usedEdges) {
    const fromName = safeLabel(getName(edge.from));
    const toName = safeLabel(getName(edge.to));
    const fromId = safeMermaidId(edge.from);
    const toId = safeMermaidId(edge.to);
    if (!nodeIds.has(fromId)) { lines.push(`  ${fromId}["${fromName}"]`); nodeIds.add(fromId); }
    if (!nodeIds.has(toId)) { lines.push(`  ${toId}["${toName}"]`); nodeIds.add(toId); }
    lines.push(`  ${fromId} --> ${toId}`);
  }

  return lines.join("\n");
}

function renderDiscrepanciesPage(discrepancies: DiscrepancyReport): string {
  if (discrepancies.summary.total_issues === 0) {
    return `<p class="ok">✓ No discrepancies. Code and specs are in sync.</p>`;
  }

  const parts: string[] = [];
  const crit = discrepancies.summary.has_critical;
  parts.push(`<p class="${crit ? "critical" : "warn"}">${crit ? "⚠ " : ""}${discrepancies.summary.total_issues} issue(s) detected.</p>`);

  if (discrepancies.new_endpoints.length > 0) {
    const rows = discrepancies.new_endpoints.map((ep) => `<tr><td><code>${e(ep)}</code></td></tr>`).join("");
    parts.push(`<section><h2>New Endpoints (${discrepancies.new_endpoints.length})</h2>${table(["Endpoint"], rows)}</section>`);
  }
  if (discrepancies.removed_endpoints.length > 0) {
    const rows = discrepancies.removed_endpoints.map((ep) => `<tr><td><code>${e(ep)}</code></td></tr>`).join("");
    parts.push(`<section><h2>⚠ Removed Endpoints (${discrepancies.removed_endpoints.length})</h2>${table(["Endpoint"], rows)}</section>`);
  }
  if (discrepancies.drifted_models.length > 0) {
    const rows = discrepancies.drifted_models.map((d) =>
      `<tr><td><code>${e(d.name)}</code></td><td>${d.baseline_field_count}</td><td>${d.current_field_count}</td></tr>`
    ).join("");
    parts.push(`<section><h2>Drifted Models (${discrepancies.drifted_models.length})</h2>${table(["Model", "Before", "After"], rows)}</section>`);
  }
  if (discrepancies.orphan_specs.length > 0) {
    const rows = discrepancies.orphan_specs.map((s) =>
      `<tr><td><code>${e(s.spec_file)}</code></td><td>${s.missing_endpoints.map(e).join(", ")}</td></tr>`
    ).join("");
    parts.push(`<section><h2>⚠ Orphan Specs (${discrepancies.orphan_specs.length})</h2>${table(["Spec File", "Missing Endpoints"], rows)}</section>`);
  }

  return parts.join("\n");
}

// ── Architecture diagram generators ──────────────────────────────────────

type ModuleInteractionData = {
  /** module id → domains within that module */
  modules: Map<string, {
    domains: Map<string, {
      services: string[];
      epCount: number;
    }>;
  }>;
  /** service name → how many domains use it (for shared-service callout) */
  serviceUseCount: Map<string, number>;
};

/**
 * Build structured per-module, per-domain service interaction data from live service_call data.
 * Groups: backend_module → api_domain → service_classes.
 */
function buildModuleInteractionData(intel: CodebaseIntelligence): ModuleInteractionData {
  const IGNORE = new Set([
    "HTTPException", "str", "int", "bool", "dict", "list", "UUID", "Optional",
    "datetime", "db", "session", "response", "request", "None", "True", "False",
    "type", "cls", "self", "super", "object",
  ]);

  // module → domain → { services, epCount }
  const result = new Map<string, { domains: Map<string, { services: Set<string>; epCount: number }> }>();
  const serviceUseCount = new Map<string, number>();

  for (const ep of Object.values(intel.api_registry)) {
    const mod = ep.module || "other";
    const domain = extractDomain(ep.path);

    if (!result.has(mod)) result.set(mod, { domains: new Map() });
    const modEntry = result.get(mod)!;
    if (!modEntry.domains.has(domain)) modEntry.domains.set(domain, { services: new Set(), epCount: 0 });
    const domEntry = modEntry.domains.get(domain)!;
    domEntry.epCount += 1;

    for (const call of ep.service_calls) {
      const classMatch = call.match(/^([A-Z][a-zA-Z]{3,})\./);
      const svc = classMatch?.[1] ?? (/^[A-Z][a-zA-Z]{4,}$/.test(call) ? call : null);
      if (svc && !IGNORE.has(svc)) {
        domEntry.services.add(svc);
        serviceUseCount.set(svc, (serviceUseCount.get(svc) ?? 0) + 1);
      }
    }
  }

  // Convert inner Sets to sorted arrays, drop domains with no service calls
  const modules = new Map<string, { domains: Map<string, { services: string[]; epCount: number }> }>();
  for (const [mod, { domains }] of Array.from(result.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const cleanDomains = new Map<string, { services: string[]; epCount: number }>();
    for (const [domain, { services, epCount }] of Array.from(domains.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (services.size > 0) cleanDomains.set(domain, { services: Array.from(services).sort(), epCount });
    }
    if (cleanDomains.size > 0) modules.set(mod, { domains: cleanDomains });
  }

  return { modules, serviceUseCount };
}

// ── Full System Architecture Diagram ─────────────────────────────────────

function buildFullSystemDiagram(intel: CodebaseIntelligence): string | null {
  const modules = intel.service_map.filter((m) => m.type === "backend" && m.file_count > 0);
  if (modules.length < 2) return null;

  const lines: string[] = ["flowchart TB"];

  // Frontend layer
  if (intel.frontend_pages.length > 0) {
    lines.push(`  subgraph FE["Frontend"]`);
    lines.push(`    direction LR`);
    const pageNames = intel.frontend_pages.slice(0, 6).map((p) => p.path).join(", ");
    const extra = intel.frontend_pages.length > 6 ? ` +${intel.frontend_pages.length - 6}` : "";
    lines.push(`    Pages["${safeLabel(pageNames + extra)}"]`);
    lines.push(`  end`);
  }

  // Backend services
  lines.push(`  subgraph BE["Backend Services"]`);
  lines.push(`    direction TB`);
  for (const mod of modules) {
    // Get the key classes/endpoints for this module
    const endpoints = Object.values(intel.api_registry).filter((ep) => ep.module === mod.id);
    const epPaths = endpoints.slice(0, 3).map((ep) => `${ep.method} ${ep.path}`);
    const label = epPaths.length > 0
      ? `${mod.id}\\n${epPaths.join("\\n")}${endpoints.length > 3 ? `\\n+${endpoints.length - 3} more` : ""}`
      : mod.id;
    lines.push(`    ${safeMermaidId(mod.id)}["${safeLabel(label)}"]`);
  }
  lines.push(`  end`);

  // Data stores (from runtime services)
  const runtimeServices = intel.background_tasks.length > 0 ? ["Postgres", "Redis"] : ["Postgres"];
  // Check if any service references redis/postgres/minio in service calls
  const allServiceCalls = Object.values(intel.api_registry).flatMap((ep) => ep.service_calls).join(" ");
  const dataStores: string[] = [];
  if (allServiceCalls.includes("db_pool") || allServiceCalls.includes("conn.")) dataStores.push("Postgres");
  if (allServiceCalls.includes("redis")) dataStores.push("Redis");

  if (dataStores.length > 0) {
    lines.push(`  subgraph Data["Data Stores"]`);
    lines.push(`    direction LR`);
    for (const ds of dataStores) {
      lines.push(`    ${safeMermaidId(ds)}[("${safeLabel(ds)}")]`);
    }
    lines.push(`  end`);
  }

  // External services
  const hasProxy = Object.values(intel.api_registry).some((ep) =>
    ep.service_calls.some((s) => s.includes("_proxy_to_") || s.includes("httpx"))
  );
  if (hasProxy) {
    lines.push(`  External[("External APIs\\nLLM / TTS")]`);
  }

  // Edges: Frontend → Backend
  if (intel.frontend_pages.length > 0) {
    // Find which backend services the frontend calls
    const calledModules = new Set<string>();
    for (const page of intel.frontend_pages) {
      for (const call of page.api_calls) {
        // Match API call path to endpoint module
        const matchedEp = Object.values(intel.api_registry).find((ep) =>
          call.includes(ep.path.split("{")[0].replace(/\/$/, ""))
        );
        if (matchedEp) calledModules.add(matchedEp.module);
      }
    }
    // If no match, connect to all modules with endpoints
    if (calledModules.size === 0) {
      for (const mod of modules.filter((m) => m.endpoint_count > 0)) {
        calledModules.add(mod.id);
      }
    }
    for (const modId of calledModules) {
      lines.push(`  Pages --> ${safeMermaidId(modId)}`);
    }
  }

  // Edges: Backend → Backend (from imports)
  for (const mod of modules) {
    for (const imp of mod.imports) {
      if (modules.some((m) => m.id === imp)) {
        lines.push(`  ${safeMermaidId(mod.id)} --> ${safeMermaidId(imp)}`);
      }
    }
  }

  // Edges: Backend → Data stores
  for (const mod of modules) {
    const modEndpoints = Object.values(intel.api_registry).filter((ep) => ep.module === mod.id);
    const modServiceCalls = modEndpoints.flatMap((ep) => ep.service_calls).join(" ");
    if (modServiceCalls.includes("db_pool") || modServiceCalls.includes("conn.")) {
      if (dataStores.includes("Postgres")) {
        lines.push(`  ${safeMermaidId(mod.id)} --> ${safeMermaidId("Postgres")}`);
      }
    }
  }

  // Edges: Proxy → External
  if (hasProxy) {
    const proxyMod = modules.find((m) =>
      Object.values(intel.api_registry).some((ep) =>
        ep.module === m.id && ep.service_calls.some((s) => s.includes("_proxy_to_"))
      )
    );
    if (proxyMod) {
      lines.push(`  ${safeMermaidId(proxyMod.id)} --> External`);
    }
  }

  return lines.join("\n");
}

// ── Model Role Inference ─────────────────────────────────────────────────

type ModelRegistryValue = CodebaseIntelligence["model_registry"][string];

function inferModelRole(
  name: string,
  model: ModelRegistryValue,
  intel: CodebaseIntelligence
): string {
  const nameLower = name.toLowerCase();
  const fieldNames = model.fields.map((f) => f.toLowerCase());

  // Request/Response patterns
  if (nameLower.includes("request")) return "API Request";
  if (nameLower.includes("response")) return "API Response";

  // Auth patterns
  if (nameLower.includes("login") || nameLower.includes("signup") || nameLower.includes("auth")) return "Authentication";

  // CRUD patterns
  if (nameLower.includes("create")) return "Create Input";
  if (nameLower.includes("update")) return "Update Input";

  // Config/Policy patterns
  if (nameLower.includes("config") || nameLower.includes("rules") || nameLower.includes("settings")) return "Configuration";
  if (nameLower.includes("safety") || nameLower.includes("guardrail")) return "Safety Policy";
  if (nameLower.includes("persona") || nameLower.includes("profile")) return "Entity Profile";

  // Content/Domain patterns
  if (nameLower.includes("schema") || nameLower.includes("topic")) return "Domain Schema";
  if (nameLower.includes("content") || nameLower.includes("unit")) return "Content Entity";

  // Check endpoint usage
  const usedByEndpoints: string[] = [];
  for (const [key, ep] of Object.entries(intel.api_registry)) {
    if (ep.request_schema === name) usedByEndpoints.push(`${ep.method} ${ep.path} (request)`);
    if (ep.response_schema === name) usedByEndpoints.push(`${ep.method} ${ep.path} (response)`);
  }
  if (usedByEndpoints.length > 0) {
    const firstUsage = usedByEndpoints[0];
    if (firstUsage.includes("request")) return "API Request";
    if (firstUsage.includes("response")) return "API Response";
  }

  // Session/state patterns
  if (fieldNames.includes("session_id") || nameLower.includes("session")) return "Session State";

  // Default: check if it's an ORM model
  if (model.framework !== "pydantic") return "Database Entity";

  return "";
}

// ── Cross-Service Communication Diagram ──────────────────────────────────

function buildCrossServiceDiagram(intel: CodebaseIntelligence): string | null {
  // Detect service-to-service calls from:
  // 1. Proxy endpoints (service_calls contain _proxy_to_*)
  // 2. Class instantiation across modules (ConversationEngine using ContentRetriever)
  // 3. HTTP client calls (httpx, fetch to other service URLs)

  const modules = intel.service_map.filter((m) => m.type === "backend" && m.file_count > 0);
  if (modules.length < 2) return null;

  const edges: Array<{ from: string; to: string; label: string }> = [];
  const nodeSet = new Set<string>();

  // Detect from dependency imports
  for (const mod of modules) {
    if (mod.imports.length > 0) {
      nodeSet.add(mod.id);
      for (const imp of mod.imports) {
        const target = modules.find((m) => m.id === imp);
        if (target) {
          nodeSet.add(target.id);
          edges.push({ from: mod.id, to: target.id, label: "imports" });
        }
      }
    }
  }

  // Detect proxy patterns from service calls
  for (const ep of Object.values(intel.api_registry)) {
    const mod = ep.module;
    for (const svc of ep.service_calls) {
      if (svc.includes("_proxy_to_") || svc.includes("httpx") || svc.includes("AsyncClient")) {
        nodeSet.add(mod);
        const target = svc.includes("openai") ? "LLM Provider" : "External API";
        nodeSet.add(target);
        if (!edges.some((e) => e.from === mod && e.to === target)) {
          edges.push({ from: mod, to: target, label: "proxy" });
        }
      }
    }
  }

  // Detect cross-module class usage from service calls
  const classToModule = new Map<string, string>();
  for (const model of Object.values(intel.model_registry)) {
    const modelMod = modules.find((m) => model.file.startsWith(m.path));
    if (modelMod) classToModule.set(model.name, modelMod.id);
  }

  for (const ep of Object.values(intel.api_registry)) {
    for (const svc of ep.service_calls) {
      const className = svc.split(".")[0];
      const targetMod = classToModule.get(className);
      if (targetMod && targetMod !== ep.module) {
        nodeSet.add(ep.module);
        nodeSet.add(targetMod);
        if (!edges.some((e) => e.from === ep.module && e.to === targetMod && e.label === className)) {
          edges.push({ from: ep.module, to: targetMod, label: className });
        }
      }
    }
  }

  // Add runtime services (Database, Redis, etc.)
  for (const rt of intel.background_tasks) {
    nodeSet.add("Background Tasks");
  }

  if (edges.length === 0) return null;

  const lines: string[] = ["flowchart TB"];

  // Classify nodes
  const backendNodes = Array.from(nodeSet).filter((n) => modules.some((m) => m.id === n));
  const externalNodes = Array.from(nodeSet).filter((n) => !modules.some((m) => m.id === n));

  if (backendNodes.length > 0) {
    lines.push(`  subgraph Backend["Backend Services"]`);
    for (const node of backendNodes) {
      lines.push(`    ${safeMermaidId(node)}["${safeLabel(node)}"]`);
    }
    lines.push("  end");
  }

  if (externalNodes.length > 0) {
    for (const node of externalNodes) {
      lines.push(`  ${safeMermaidId(node)}[("${safeLabel(node)}")]`);
    }
  }

  for (const edge of edges) {
    lines.push(`  ${safeMermaidId(edge.from)} -->|${safeLabel(edge.label)}| ${safeMermaidId(edge.to)}`);
  }

  return lines.join("\n");
}

// ── Workflow Diagram Builder ──────────────────────────────────────────────

type WorkflowDiagram = {
  title: string;
  method: string;
  path: string;
  diagram: string;
  important: boolean;
};

/** Service call categories for cleaner diagram labels */
const SERVICE_CATEGORIES: Record<string, string> = {
  "db_pool.execute": "Database",
  "db_pool.fetch": "Database",
  "db_pool.fetchrow": "Database",
  "conn.fetch": "Database",
  "conn.fetchrow": "Database",
  "conn.execute": "Database",
  "conn.close": "Database",
};

function categorizeService(svc: string): { actor: string; action: string } {
  // Direct category match
  if (SERVICE_CATEGORIES[svc]) {
    return { actor: SERVICE_CATEGORIES[svc], action: svc.split(".").pop() ?? svc };
  }
  // Class method pattern: ClassName.method or instance.method
  const dotParts = svc.split(".");
  if (dotParts.length >= 2) {
    return { actor: dotParts[0], action: dotParts.slice(1).join(".") };
  }
  // Function call
  return { actor: "Service", action: svc };
}

function buildWorkflowDiagrams(intel: CodebaseIntelligence): WorkflowDiagram[] {
  const workflows: WorkflowDiagram[] = [];

  // Pick the most interesting endpoints (non-health, have service calls, sorted by complexity)
  const candidates = Object.values(intel.api_registry)
    .filter((ep) => ep.path !== "/health" && ep.service_calls.length > 2)
    .sort((a, b) => b.service_calls.length - a.service_calls.length)
    .slice(0, 8);

  for (const ep of candidates) {
    const lines: string[] = ["sequenceDiagram"];

    // Determine participants from service calls
    const actors = new Map<string, string>();  // actor_id → display_name
    actors.set("Client", "Client");
    actors.set("Handler", ep.handler || ep.path);

    // Categorize all service calls
    const steps: Array<{ actor: string; action: string }> = [];
    const skipActions = new Set(["str", "dict", "len", "int", "float", "join", "getattr", "max", "lower", "open"]);

    for (const svc of ep.service_calls) {
      if (skipActions.has(svc) || svc.startsWith("params.") || svc.startsWith("updates.")) continue;
      const { actor, action } = categorizeService(svc);
      if (!actors.has(actor)) {
        actors.set(actor, actor);
      }
      steps.push({ actor, action });
    }

    if (steps.length < 2) continue;

    // Render participants
    for (const [id, name] of actors) {
      lines.push(`  participant ${safeMermaidId(id)} as ${safeLabel(name)}`);
    }

    // Client → Handler
    const reqLabel = ep.request_schema ? `${ep.method} ${ep.path}<br/>${ep.request_schema}` : `${ep.method} ${ep.path}`;
    lines.push(`  ${safeMermaidId("Client")}->>+${safeMermaidId("Handler")}: ${safeLabel(reqLabel)}`);

    // Handler → services (deduplicate sequential same-actor calls)
    let lastActor = "Handler";
    const seenActors = new Set<string>();
    for (const step of steps) {
      const actorId = safeMermaidId(step.actor);
      const handlerId = safeMermaidId("Handler");
      if (step.actor === "Handler") continue;
      if (!seenActors.has(step.actor)) {
        lines.push(`  ${handlerId}->>${actorId}: ${safeLabel(step.action)}`);
        lines.push(`  ${actorId}-->>${handlerId}: result`);
        seenActors.add(step.actor);
      }
    }

    // Handler → Client (response)
    const respLabel = ep.response_schema || "response";
    lines.push(`  ${safeMermaidId("Handler")}-->>-${safeMermaidId("Client")}: ${safeLabel(respLabel)}`);

    // Determine importance (POST endpoints with many services are key flows)
    const important = ep.method === "POST" && seenActors.size >= 3;

    // Build a readable title
    const pathParts = ep.path.split("/").filter(Boolean);
    const title = pathParts.length > 0
      ? pathParts.map((p) => p.replace(/[{}]/g, "").replace(/_/g, " ")).join(" → ")
      : ep.path;

    workflows.push({
      title: title.charAt(0).toUpperCase() + title.slice(1),
      method: ep.method,
      path: ep.path,
      diagram: lines.join("\n"),
      important,
    });
  }

  return workflows;
}

/**
 * Build a single Mermaid flowchart for one API domain showing its service dependencies.
 * Star topology: domain node → each service node. Clean, small, no subgraphs.
 */
function buildDomainDiagram(domain: string, services: string[], sharedServices: Set<string>): string {
  const domId = safeMermaidId("api_" + domain);
  const lines = ["flowchart LR"];
  lines.push(`  ${domId}["${safeLabel(domain)}"]:::api`);
  for (const svc of services.slice(0, 15)) {
    const svcId = safeMermaidId(svc);
    const label = sharedServices.has(svc) ? `${safeLabel(svc)} (shared)` : safeLabel(svc);
    lines.push(`  ${svcId}["${label}"]:::svc`);
    lines.push(`  ${domId} --> ${svcId}`);
  }
  lines.push("  classDef api fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a");
  lines.push("  classDef svc fill:#f0fdf4,stroke:#22c55e,color:#14532d");
  return lines.join("\n");
}

// ── Model schema renderers ────────────────────────────────────────────────

function renderModelSchema(
  name: string,
  model: CodebaseIntelligence["model_registry"][string]
): string {
  if (model.field_details.length === 0) {
    const rows = model.fields.map((f) =>
      `<tr><td><code>${e(f)}</code></td><td>—</td><td>—</td></tr>`
    ).join("");
    return table(["Field", "Type", "Nullable"], rows);
  }

  const rows = model.field_details.map((f) => {
    const pk = f.primary_key ? `<span class="badge-pk">PK</span>` : "";
    const fk = f.foreign_key ? `<span class="badge-fk" title="${e(f.foreign_key ?? "")}">FK→${e((f.foreign_key ?? "").split(".")[0] ?? "")}</span>` : "";
    const nullable = f.nullable === true ? "✓" : f.nullable === false ? "✗" : "—";
    const enumRef = f.enum ? ` <span class="badge-enum">${e(f.enum)}</span>` : "";
    return `<tr><td><code>${e(f.name)}</code> ${pk}${fk}</td><td>${e(f.type ?? "—")}${enumRef}</td><td class="center">${nullable}</td></tr>`;
  }).join("");

  const relRow = model.relationships.length > 0
    ? `<tr class="rel-row"><td colspan="3"><em>→ ${model.relationships.map(e).join(", ")}</em></td></tr>`
    : "";

  return table(["Field", "Type", "Nullable"], rows + relRow);
}

function buildErDiagram(
  models: Array<[string, CodebaseIntelligence["model_registry"][string]]>
): string {
  const sqlModels = models.filter(([, m]) =>
    m.framework === "sqlalchemy" && m.field_details.some((f) => f.primary_key || f.foreign_key)
  );
  if (sqlModels.length < 2) return "";

  const modelNames = new Set(sqlModels.map(([name]) => name));

  // Build relationship list first — only include models connected by FK edges
  const relList: Array<[string, string]> = [];
  const drawn = new Set<string>();
  for (const [name, m] of sqlModels) {
    for (const f of m.field_details) {
      if (!f.foreign_key) continue;
      const targetTable = (f.foreign_key.split(".")[0] ?? "").replace(/_/g, "");
      const targetModel = sqlModels.find(([tName]) =>
        tName.toLowerCase() === targetTable ||
        tName.toLowerCase() === targetTable.replace(/s$/, "") ||
        targetTable.startsWith(tName.toLowerCase())
      )?.[0];
      if (targetModel && modelNames.has(targetModel) && targetModel !== name) {
        const key = `${targetModel}→${name}`;
        if (!drawn.has(key)) { relList.push([targetModel, name]); drawn.add(key); }
      }
    }
  }

  // Only include models that participate in at least one relationship, cap at 20
  const connectedNames = new Set(relList.flatMap(([a, b]) => [a, b]));
  const connectedModels = sqlModels.filter(([name]) => connectedNames.has(name)).slice(0, 20);
  if (connectedModels.length < 2) return "";

  // Re-filter relList to only include pairs where both models survived the cap
  const cappedNames = new Set(connectedModels.map(([n]) => n));
  const cappedRels = relList.filter(([a, b]) => cappedNames.has(a) && cappedNames.has(b));

  const lines: string[] = ["erDiagram"];

  for (const [name, m] of connectedModels) {
    const safeName = safeMermaidId(name);
    const keyFields = m.field_details.filter((f) => f.primary_key || f.foreign_key);
    const typeFields = m.field_details.filter((f) => !f.primary_key && !f.foreign_key && f.type).slice(0, 3);
    const allFields = [...keyFields, ...typeFields].slice(0, 6);
    const fieldLines = allFields.map((f) => {
      const tag = f.primary_key ? " PK" : f.foreign_key ? " FK" : "";
      const rawType = (f.type ?? "string").split("[")[0].split("(")[0];
      const typeName = rawType.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "string";
      const fieldName = (f.name || "field").replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "field";
      return `    ${typeName} ${fieldName}${tag}`;
    });
    lines.push(`  ${safeName} {`);
    lines.push(...fieldLines);
    lines.push(`  }`);
  }

  for (const [from, to] of cappedRels) {
    lines.push(`  ${safeMermaidId(from)} ||--o{ ${safeMermaidId(to)} : has`);
  }

  return lines.join("\n");
}

// ── Task helpers ──────────────────────────────────────────────────────────

type DeduplicatedTask = {
  name: string;
  kind: string;
  queue: string | null;
  sources: string[];
};

function deduplicateTasks(
  tasks: CodebaseIntelligence["background_tasks"]
): DeduplicatedTask[] {
  const byName = new Map<string, DeduplicatedTask>();
  for (const t of tasks) {
    const existing = byName.get(t.name);
    if (existing) {
      if (!existing.sources.includes(t.file)) existing.sources.push(t.file);
    } else {
      byName.set(t.name, { name: t.name, kind: t.kind, queue: t.queue ?? null, sources: [t.file] });
    }
  }
  return Array.from(byName.values());
}

function buildTaskTriggerMap(intel: CodebaseIntelligence): Map<string, string[]> {
  const taskNames = new Set(intel.background_tasks.map((t) => t.name));
  const triggerMap = new Map<string, string[]>();

  for (const [epKey, ep] of Object.entries(intel.api_registry)) {
    for (const call of ep.service_calls) {
      // Match: "service.run_import_task" or "run_import_task"
      for (const taskName of taskNames) {
        const bare = taskName.replace(/^[^.]+\./, "");
        if (call === taskName || call === bare || call.endsWith(`.${bare}`)) {
          const list = triggerMap.get(taskName) ?? [];
          if (!list.includes(epKey)) list.push(epKey);
          triggerMap.set(taskName, list);
        }
      }
    }
  }

  return triggerMap;
}

// ── Markdown → HTML ───────────────────────────────────────────────────────

function renderMd(markdown: string): string {
  const segments = extractMermaidBlocks(markdown);
  return segments.map(({ before, diagram, after }) => [
    before ? mdBlocksToHtml(before) : "",
    diagram ? lightbox(`<div class="mermaid">\n${diagram}\n</div>`) : "",
    after ? mdBlocksToHtml(after) : "",
  ].join("")).join("");
}

function mdBlocksToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let tableLines: string[] = [];
  let paraLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) return;
    out.push(mdTableToHtml(tableLines));
    tableLines = [];
  };
  const flushPara = () => {
    const text = paraLines.join(" ").trim();
    if (text) out.push(`<p>${inlineMd(text)}</p>`);
    paraLines = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("|")) {
      flushPara(); tableLines.push(line);
    } else if (line.trim() === "" && tableLines.length > 0) {
      flushTable();
    } else if (line.trim() === "") {
      flushPara();
    } else if (line.startsWith("### ")) {
      flushTable(); flushPara(); out.push(`<h4>${inlineMd(line.slice(4))}</h4>`);
    } else if (line.startsWith("## ")) {
      flushTable(); flushPara(); out.push(`<h3>${inlineMd(line.slice(3))}</h3>`);
    } else if (line.startsWith("# ")) {
      flushTable(); flushPara(); out.push(`<h3>${inlineMd(line.slice(2))}</h3>`);
    } else if (line.match(/^[-*] /)) {
      flushTable(); flushPara(); out.push(`<li>${inlineMd(line.slice(2))}</li>`);
    } else {
      flushTable(); paraLines.push(line);
    }
  }
  flushTable(); flushPara();
  return out.join("\n");
}

function mdTableToHtml(lines: string[]): string {
  const dataLines = lines.filter((l) => !l.match(/^\|[\s|:-]+\|$/));
  if (dataLines.length === 0) return "";
  const parseRow = (line: string) =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const [header, ...body] = dataLines;
  const ths = parseRow(header).map((c) => `<th>${inlineMd(c)}</th>`).join("");
  const rows = body.map((row) =>
    `<tr>${parseRow(row).map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`
  ).join("\n");
  return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
}

function extractMermaidBlocks(markdown: string): Array<{ before: string; diagram: string; after: string }> {
  const results: Array<{ before: string; diagram: string; after: string }> = [];
  const fenceRe = /```mermaid\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    results.push({ before: markdown.slice(lastIndex, match.index), diagram: match[1].trim(), after: "" });
    lastIndex = match.index + match[0].length;
  }
  if (results.length === 0) return [{ before: markdown, diagram: "", after: "" }];
  results[results.length - 1].after = markdown.slice(lastIndex);
  return results;
}

function inlineMd(text: string): string {
  const trimmed = text.trim();
  // Suppress empty/null values from generated docs
  if (trimmed === "None" || trimmed === "null" || trimmed === "N/A") return '<span class="none">—</span>';
  let s = e(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

// ── HTML helpers ──────────────────────────────────────────────────────────

function e(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mkId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

/** Generate a Mermaid-safe node ID: alphanumeric + underscore, starts with letter. */
function safeMermaidId(text: string): string {
  const safe = text.replace(/[^a-zA-Z0-9]/g, "_");
  return /^[0-9_]/.test(safe) ? `n_${safe}` : safe || "node";
}

/**
 * Sanitize text for use inside a Mermaid node label ["..."].
 * Strips non-ASCII (emoji, symbols), escapes double quotes, removes angle brackets.
 */
function safeLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/[<>[\]]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim() || "node";
}

function table(headers: string[], rows: string): string {
  const ths = headers.map((h) => `<th>${e(h)}</th>`).join("");
  return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** Wrap a diagram in a click-to-expand lightbox. */
function lightbox(inner: string): string {
  return `<div class="diagram-wrapper" onclick="openLightbox(this)" title="Click to expand">
<div class="diagram-expand-hint">🔍 Click to expand</div>
${inner}
</div>`;
}

// ── Grouping helpers ──────────────────────────────────────────────────────

function extractDomain(epPath: string): string {
  const parts = epPath.replace(/^\//, "").split("/");
  const skip = ["api", "v1", "v2"];
  return parts.find((p) => !skip.includes(p) && !p.startsWith("{")) ?? parts[0] ?? "root";
}

function groupEndpointsByDomain(
  intel: CodebaseIntelligence
): Map<string, Array<[string, CodebaseIntelligence["api_registry"][string]]>> {
  const domains = new Map<string, Array<[string, CodebaseIntelligence["api_registry"][string]]>>();
  for (const [key, ep] of Object.entries(intel.api_registry)) {
    const domain = extractDomain(ep.path);
    const entry = domains.get(domain) ?? [];
    entry.push([key, ep]);
    domains.set(domain, entry);
  }
  return domains;
}

function groupModelsByModule(
  intel: CodebaseIntelligence
): Map<string, Array<[string, CodebaseIntelligence["model_registry"][string]]>> {
  const groups = new Map<string, Array<[string, CodebaseIntelligence["model_registry"][string]]>>();
  const fileToModule = new Map<string, string>();
  for (const m of intel.service_map) {
    for (const [, model] of Object.entries(intel.model_registry)) {
      if (model.file.includes(m.path) || m.path.includes((model.file.split("/")[0]) ?? "")) {
        fileToModule.set(model.file, m.id);
      }
    }
  }
  for (const [name, model] of Object.entries(intel.model_registry)) {
    const module = fileToModule.get(model.file) ?? deriveGroup(model.file);
    const entry = groups.get(module) ?? [];
    entry.push([name, model]);
    groups.set(module, entry);
  }
  for (const [key, models] of groups) {
    groups.set(key, models.sort((a, b) => a[0].localeCompare(b[0])));
  }
  return groups;
}

function deriveGroup(file: string): string {
  const parts = file.split("/").filter(Boolean);
  const appIdx = parts.indexOf("app");
  if (appIdx !== -1) return parts[appIdx + 1] ?? parts[appIdx] ?? "other";
  return parts[1] ?? parts[0] ?? "other";
}

// ── CSS ───────────────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;background:#fff;line-height:1.5}
a{color:#1a4cbf;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:#f0f0f2;padding:1px 5px;border-radius:3px;color:#c7254e}
p{margin:8px 0}li{margin:3px 0 3px 18px}
h4{font-size:13px;font-weight:600;margin:16px 0 6px;color:#333}
small{font-size:11px}.muted{color:#777;font-style:italic}

#layout{display:flex;height:100vh;overflow:hidden}

/* Sidebar */
#sidebar{width:240px;min-width:240px;background:#f7f7f8;border-right:1px solid #e0e0e0;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
#sidebar-header{padding:10px 12px;border-bottom:1px solid #e0e0e0;flex-shrink:0}
#project-name{display:block;font-weight:700;font-size:13px;color:#111;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#search-box{width:100%;padding:4px 7px;border:1px solid #ccc;border-radius:4px;font-size:12px;outline:none}
#search-box:focus{border-color:#6b9fff}
#nav-tree{overflow-y:auto;flex:1;padding:6px 0}

.nav-top-link{display:flex;align-items:center;gap:4px;padding:5px 12px;font-size:12px;font-weight:500;color:#444;text-decoration:none;white-space:nowrap}
.nav-top-link:hover{background:#eaeaec;color:#111}
.nav-top-link.active{background:#e0eaff;color:#1a4cbf;font-weight:600}
.nav-badge{background:#e2e2e4;color:#555;border-radius:9px;padding:1px 6px;font-size:10px;font-weight:600;margin-left:auto;flex-shrink:0}
.nav-top-link.active .nav-badge{background:#bfcfff;color:#1a4cbf}

.nav-group{user-select:none}
.nav-group-header{display:flex;align-items:center;gap:4px;padding:5px 12px;cursor:pointer;font-size:11px;color:#555;text-transform:uppercase;font-weight:600;letter-spacing:.04em}
.nav-group-header:hover{background:#eaeaec}
.chevron{font-size:9px;color:#888;transition:transform .15s;flex-shrink:0}
.nav-group:not(.open) .chevron{transform:rotate(-90deg)}
.nav-group:not(.open) .nav-children{display:none}
.nav-group-link{flex:1;font-size:11px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.04em;text-decoration:none}
.nav-group-link.active{color:#1a4cbf}
.nav-children{padding-bottom:2px}
.nav-item{display:block;padding:2px 12px 2px 24px;font-size:12px;color:#444;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-item:hover{background:#e4e4e8;color:#111}

/* Content */
#content{flex:1;overflow-y:auto;padding:28px 40px 60px;}
.page-title{font-size:22px;font-weight:700;margin-bottom:24px;padding-bottom:10px;border-bottom:2px solid #e8e8ea;color:#111}
section{margin-bottom:44px;scroll-margin-top:16px}
section h2{font-size:17px;font-weight:700;margin-bottom:14px;color:#111;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
section h3,section.subsection h3{font-size:14px;font-weight:600;margin:16px 0 8px;color:#333}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
thead th{background:#f2f2f4;text-align:left;padding:6px 10px;font-weight:600;border-bottom:2px solid #ddd;white-space:nowrap}
tbody tr:nth-child(even){background:#fafafa}
tbody td{padding:5px 10px;border-bottom:1px solid #eee;vertical-align:top;word-break:break-word}
tbody tr:hover{background:#f0f4ff}
td.center{text-align:center}
.rel-row td{background:#f8f8fb;color:#555;font-size:12px;border-top:1px dashed #ddd;font-style:italic}

/* Details */
details{border:1px solid #e0e0e0;border-radius:5px;margin:6px 0}
details summary{padding:7px 12px;cursor:pointer;font-size:13px;font-weight:600;list-style:none;user-select:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"▶ ";font-size:9px;color:#999}
details[open] summary::before{content:"▼ "}
details[open] summary{border-bottom:1px solid #e0e0e0}
.details-body{padding:10px}

/* Stats */
.model-role{display:inline-block;background:#e8f4fd;color:#1565c0;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:0 6px;vertical-align:middle}
.product-context{margin-bottom:24px;padding:16px 20px;background:#f8f9fb;border-left:4px solid #1a4cbf;border-radius:0 6px 6px 0}
.product-description{font-size:14px;line-height:1.6;color:#333}
.product-description p:first-child{font-size:15px;font-weight:500;color:#111}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat-card{background:#f7f7f8;border:1px solid #e0e0e0;border-radius:6px;padding:14px;text-align:center}
.stat-value{font-size:28px;font-weight:700}
.stat-label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}

/* Badges */
.badge{display:inline-block;background:#e8eaf6;color:#3949ab;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600}
.badge.warn{background:#fff3e0;color:#e65100}
.badge-pk{display:inline-block;background:#fff3cd;color:#856404;border:1px solid #ffc107;border-radius:3px;padding:0 4px;font-size:10px;font-weight:700;vertical-align:middle;margin-left:3px}
.badge-fk{display:inline-block;background:#cfe2ff;color:#0a3880;border:1px solid #9ec5fe;border-radius:3px;padding:0 4px;font-size:10px;font-weight:700;vertical-align:middle;margin-left:3px}
.badge-enum{display:inline-block;background:#f0e6ff;color:#5a2d82;border:1px solid #c8a7f0;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600;vertical-align:middle;margin-left:3px}

/* Status */
.ok{color:#1b5e20;background:#e8f5e9;padding:8px 12px;border-radius:4px;border:1px solid #a5d6a7}
.warn{color:#e65100;background:#fff3e0;padding:8px 12px;border-radius:4px;border:1px solid #ffcc80}
.critical{color:#c62828;background:#fdecea;padding:8px 12px;border-radius:4px;border:1px solid #ef9a9a}

/* Quick index */
.quick-index{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px;padding:8px;background:#f7f7f8;border-radius:5px;border:1px solid #e0e0e0}
.quick-index a{font-size:12px;color:#444;background:#fff;border:1px solid #ddd;border-radius:3px;padding:2px 7px;text-decoration:none}
.quick-index a:hover{background:#e0eaff;border-color:#6b9fff;color:#1a4cbf}

/* Diagram wrapper — click to open lightbox */
.diagram-wrapper{position:relative;border:1px solid #e0e0e0;border-radius:6px;padding:8px;margin:12px 0;background:#fafafa;cursor:zoom-in;overflow:auto}
.diagram-wrapper .mermaid{pointer-events:none}
.diagram-expand-hint{position:absolute;top:6px;right:8px;font-size:11px;color:#888;background:rgba(255,255,255,.85);padding:2px 6px;border-radius:3px;pointer-events:none;opacity:0;transition:opacity .15s}
.diagram-wrapper:hover .diagram-expand-hint{opacity:1}

/* Lightbox overlay */
#lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center;padding:24px}
#lightbox.open{display:flex}
#lightbox-content{background:#fff;border-radius:8px;padding:20px;max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);overflow:auto;position:relative}
#lightbox-close{position:absolute;top:10px;right:14px;font-size:22px;cursor:pointer;color:#666;line-height:1;background:none;border:none;padding:4px}
#lightbox-close:hover{color:#111}
#lightbox-content .mermaid{min-width:600px}

/* Task cards */
.task-grid{display:grid;gap:14px}
.task-card{border:1px solid #e0e0e0;border-radius:6px;padding:14px}
.task-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.task-name{font-size:13px}
.note-reuse{color:#1b5e20;background:#e8f5e9;padding:6px 10px;border-radius:4px;font-size:12px;margin-bottom:6px}
.source-list,.trigger-list{font-size:12px;color:#555;margin:6px 0}
.source-list ul,.trigger-list ul{margin:4px 0 0 16px}

/* Domain sections */
.domain-section h2{font-size:15px}
.none{color:#bbb}
span.none{font-style:normal}

/* Model schemas */
.model-schemas{margin-top:10px;display:grid;gap:4px}
.subsection{margin-bottom:16px}
.model-layer{margin:16px 0}
.model-layer h3{font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;padding:4px 0;border-bottom:1px solid #eee}
.module-block{margin:24px 0;padding:16px;border:1px solid #e4e4e7;border-radius:8px;background:#fafafa}
.module-block h3{font-size:14px;font-weight:700;color:#111;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e4e4e7}
.domain-diagram{margin:8px 0;border:1px solid #e0e0e0;border-radius:6px;background:#fff}
.domain-diagram summary{padding:8px 12px;cursor:pointer;font-size:13px;list-style:none;display:flex;align-items:center;gap:8px}
.domain-diagram summary::-webkit-details-marker{display:none}
.domain-diagram summary::before{content:"▶";font-size:10px;color:#888;transition:transform .15s;flex-shrink:0}
.domain-diagram[open] summary::before{transform:rotate(90deg)}
.domain-diagram .details-body{padding:8px 12px 12px}
.badge-svc{background:#dcfce7;color:#15803d;border-radius:9px;padding:1px 6px;font-size:10px;font-weight:600}
`;

// ── JavaScript ────────────────────────────────────────────────────────────

const JS = `
document.addEventListener('DOMContentLoaded', () => {
  // Mermaid
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose', maxTextSize: 200000 });
    mermaid.run({ querySelector: '.mermaid' }).catch(() => {});
  }

  // Inject lightbox container
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = '<div id="lightbox-content"><button id="lightbox-close" onclick="closeLightbox()">✕</button><div id="lightbox-body"></div></div>';
  document.body.appendChild(lb);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  // Search
  const box = document.getElementById('search-box');
  if (box) {
    box.addEventListener('input', () => {
      const q = box.value.toLowerCase().trim();
      document.querySelectorAll('.nav-top-link, .nav-group').forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = (!q || text.includes(q)) ? '' : 'none';
      });
    });
  }
});

function toggleNav(header) {
  const group = header.closest('.nav-group');
  if (group) group.classList.toggle('open');
}

function openLightbox(wrapper) {
  const mermaidEl = wrapper.querySelector('.mermaid');
  if (!mermaidEl) return;
  const clone = mermaidEl.cloneNode(true);
  // Re-render mermaid in the clone
  clone.removeAttribute('data-processed');
  const body = document.getElementById('lightbox-body');
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(clone);
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
  if (typeof mermaid !== 'undefined') {
    mermaid.run({ nodes: [clone] }).catch(() => {});
  }
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});
`;
