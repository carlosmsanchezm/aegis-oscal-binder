import { createHash } from "node:crypto";
import type { ControlRecord } from "./types";

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashControls(controls: ControlRecord[]): string {
  const canonical = controls.map((control) => ({
    id: control.id,
    implementation: control.implementation,
    responsibleRoleId: control.responsibleRoleIds && control.responsibleRoleIds.length > 0
      ? control.responsibleRoleIds.join(",")
      : control.responsibleRoleId,
    evidence: control.evidence.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      href: item.href,
    })),
    parts: (control.itemStatements ?? [])
      .filter((item) => /_smt\./i.test(item.statementId))
      .map((item) => ({
        statementId: item.statementId,
        description: item.description,
        evidenceUuids: [...item.evidenceUuids],
      })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function padId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** Stable download name. The same id is the UI label and the file name. */
export function oscalArtifactFilename(exportId: string): string {
  return `${exportId}-package-oscal.xml`;
}
