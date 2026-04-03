/**
 * Docs Loader — loads and parses sections from existing guardian doc files.
 *
 * Reads from specs-out/machine/docs/:
 *   hld.md         → systemDiagram, couplingHeatmap, backendSubsystems, apiDomainMap
 *   summary.md     → qualitySignals, systemScale
 *   stakeholder.md → stakeholderMetrics
 *   integration.md → integrationByDomain (full content, already domain-grouped)
 */

import fs from "node:fs/promises";
import path from "node:path";

export type ExistingDocs = {
  systemDiagram?: string;       // hld.md § System Block Diagram
  couplingHeatmap?: string;     // hld.md § Structural Coupling Heatmap (Top Functions)
  driftSummary?: string;        // hld.md § Drift Summary
  backendSubsystems?: string;   // hld.md § Backend Subsystems
  apiDomainMap?: string;        // hld.md § API Domain Map
  qualitySignals?: string;      // summary.md § Quality & Drift Signals
  systemScale?: string;         // summary.md § System Scale (Current State)
  stakeholderMetrics?: string;  // stakeholder.md (metrics table + health snapshot)
  integrationByDomain?: string; // integration.md full content
};

/**
 * Load and parse existing docs from the machine docs directory.
 * All fields are optional — missing files are silently skipped.
 */
export async function loadExistingDocs(machineDocsDir: string): Promise<ExistingDocs> {
  const [hld, summary, stakeholder, integration] = await Promise.all([
    readIfExists(path.join(machineDocsDir, "hld.md")),
    readIfExists(path.join(machineDocsDir, "summary.md")),
    readIfExists(path.join(machineDocsDir, "stakeholder.md")),
    readIfExists(path.join(machineDocsDir, "integration.md")),
  ]);

  return {
    systemDiagram: hld ? extractSection(hld, "System Block Diagram") : undefined,
    couplingHeatmap: hld ? extractSection(hld, "Structural Coupling Heatmap (Top Functions)") : undefined,
    driftSummary: hld ? extractSection(hld, "Drift Summary") : undefined,
    backendSubsystems: hld ? extractSection(hld, "Backend Subsystems") : undefined,
    apiDomainMap: hld ? extractSection(hld, "API Domain Map") : undefined,
    qualitySignals: summary ? extractSection(summary, "Quality & Drift Signals") : undefined,
    systemScale: summary ? extractSection(summary, "System Scale (Current State)") : undefined,
    stakeholderMetrics: stakeholder ? extractStakeholderMetrics(stakeholder) : undefined,
    integrationByDomain: integration ?? undefined,
  };
}

/**
 * Extract a named `## Heading` section from markdown.
 * Returns content from just after the heading until the next `## ` heading (or EOF).
 * Returns undefined if the heading is not found.
 */
export function extractSection(markdown: string, heading: string): string | undefined {
  const headingLine = `## ${heading}`;
  const idx = markdown.indexOf(headingLine);
  if (idx === -1) return undefined;

  const contentStart = idx + headingLine.length;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  const raw = nextHeading === -1
    ? markdown.slice(contentStart)
    : markdown.slice(contentStart, nextHeading);

  return raw.trim() || undefined;
}

/**
 * Extract the metrics table and health snapshot from stakeholder.md.
 * Returns from the first `|` table up through the health snapshot section.
 */
function extractStakeholderMetrics(stakeholder: string): string | undefined {
  // Extract from first table line to end of "## Health Snapshot" section
  const tableStart = stakeholder.indexOf("\n| ");
  if (tableStart === -1) return undefined;

  // Find end of health snapshot section (next ## after it, or EOF)
  const healthIdx = stakeholder.indexOf("## Health Snapshot");
  if (healthIdx === -1) {
    // Just return the metrics table
    const tableEnd = stakeholder.indexOf("\n## ", tableStart + 1);
    return tableEnd === -1
      ? stakeholder.slice(tableStart).trim()
      : stakeholder.slice(tableStart, tableEnd).trim();
  }

  const afterHealth = stakeholder.indexOf("\n## ", healthIdx + 1);
  const end = afterHealth === -1 ? stakeholder.length : afterHealth;
  return stakeholder.slice(tableStart, end).trim();
}

/**
 * Parse integration.md into a map of domain → markdown table string.
 * Domains are `## /domain-prefix` headings.
 */
export function parseIntegrationDomains(
  integration: string
): Map<string, { heading: string; content: string }> {
  const domains = new Map<string, { heading: string; content: string }>();

  // Split on "## " headings
  const sections = integration.split(/\n(?=## )/);
  for (const section of sections) {
    const headingMatch = section.match(/^## (.+)/);
    if (!headingMatch) continue;
    const heading = headingMatch[1].trim();
    // Normalise: "/api/auth" → "auth", "/" → "root", "/api/{project_id}" → "{project_id}"
    const domain = normaliseIntegrationHeading(heading);
    const content = section.slice(headingMatch[0].length).trim();
    if (content) {
      domains.set(domain, { heading, content });
    }
  }

  return domains;
}

function normaliseIntegrationHeading(heading: string): string {
  // "/api/auth" → "auth"
  // "/api/{project_id}" → "{project_id}"
  // "/" → "root"
  const stripped = heading.replace(/^\/api\//, "").replace(/^\//, "") || "root";
  return stripped;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
