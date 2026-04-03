/**
 * Feature Spec Schema — Zod schema for feature spec YAML files.
 *
 * Analogous to the compression block in the book workflow:
 * a structured, machine-readable spec for a single feature/ticket/PR that
 * declares exactly which endpoints, models, and patterns are involved.
 *
 * Example feature spec file (feature-specs/auth-refresh.yaml):
 *
 *   feature: "JWT Refresh Token"
 *   description: "Add refresh token rotation to the auth flow"
 *   affected_endpoints:
 *     - POST /api/auth/refresh
 *     - POST /api/auth/logout
 *   affected_models:
 *     - RefreshToken
 *     - Session
 *   pattern: P2
 *   tradeoff: "Security vs. UX: shorter-lived tokens mean more frequent refreshes"
 *   failure_risk: "Token replay if refresh not rotated on use"
 *   maps_to: "AuthService.rotate_refresh_token()"
 *   sprint: 8
 */

import { z } from "zod";

export const FeatureSpecSchema = z.object({
  /** Short name of the feature — used as the context packet filename */
  feature: z.string().min(1),

  /** One or two sentence description of what this feature does */
  description: z.string().default(""),

  /**
   * Endpoints this feature adds or modifies.
   * Format: "METHOD /path" e.g. "POST /api/auth/refresh"
   */
  affected_endpoints: z.array(z.string()).default([]),

  /**
   * ORM models this feature reads from or writes to.
   */
  affected_models: z.array(z.string()).default([]),

  /**
   * Pattern ID(s) this feature uses (from the pattern registry).
   * Single string or array: "P1" or ["P1", "P2"]
   */
  pattern: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .default([]),

  /**
   * Architectural tradeoff involved (free text or AT-code if using DNCF series).
   */
  tradeoff: z.string().default(""),

  /**
   * Failure risk / failure mode to watch for.
   */
  failure_risk: z.string().default(""),

  /**
   * Primary service method or function this feature maps to.
   * e.g. "AuthService.rotate_refresh_token()"
   */
  maps_to: z.string().default(""),

  /**
   * Sprint or version when this feature was / will be implemented.
   * Used to build feature arc timelines.
   */
  sprint: z.union([z.number(), z.string()]).optional(),

  /**
   * Optional tags for grouping features (e.g. "auth", "billing", "core").
   */
  tags: z.array(z.string()).default([]),
});

export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;

/**
 * Parse and validate a raw YAML-loaded object as a FeatureSpec.
 * Throws a ZodError on invalid input.
 */
export function parseFeatureSpec(raw: unknown): FeatureSpec {
  return FeatureSpecSchema.parse(raw);
}

/**
 * Safe parse — returns { success, data } without throwing.
 */
export function safeParseFeatureSpec(
  raw: unknown
): { success: true; data: FeatureSpec } | { success: false; error: string } {
  const result = FeatureSpecSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
