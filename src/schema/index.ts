import type { ArchitectureSnapshot, UxSnapshot } from "../extract/types.js";
import { architectureSnapshotSchema } from "./architecture.js";
import { uxSnapshotSchema } from "./ux.js";

export function validateArchitectureSnapshot(snapshot: ArchitectureSnapshot): void {
  architectureSnapshotSchema.parse(snapshot);
}

export function validateUxSnapshot(snapshot: UxSnapshot): void {
  uxSnapshotSchema.parse(snapshot);
}
