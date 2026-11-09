import { readFileSync } from "node:fs";
import path from "node:path";
import { BOUNDARY_ID, CATALOG_PIN, WORKSPACE_NAME } from "./constants";
import type { ControlRecord, EvidenceRecord, Role } from "./types";

export type GoldFixture = {
  workspaceName: string;
  boundaryId: string;
  catalogPin: string;
  catalogReadOnly: true;
  roles: Role[];
  controls: ControlRecord[];
};

let cached: GoldFixture | null = null;
let cachedRoot: string | null = null;

export function readGoldFixture(root: string): GoldFixture {
  if (cached && cachedRoot === root) return cached;
  const file = path.join(root, "fixtures", "gold", "fixture.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as GoldFixture;
  if (parsed.boundaryId !== BOUNDARY_ID) {
    throw new Error(`Gold fixture boundary id must be ${BOUNDARY_ID}`);
  }
  if (parsed.catalogPin !== CATALOG_PIN) {
    throw new Error(`Gold fixture catalog pin must be ${CATALOG_PIN}`);
  }
  if (parsed.workspaceName !== WORKSPACE_NAME) {
    throw new Error(`Gold fixture workspace name must be ${WORKSPACE_NAME}`);
  }
  if (parsed.catalogReadOnly !== true) {
    throw new Error("Gold fixture catalog pin is read only");
  }
  if (parsed.controls.length !== 12) {
    throw new Error(`Gold fixture must contain 12 controls, found ${parsed.controls.length}`);
  }
  cached = parsed;
  cachedRoot = root;
  return parsed;
}

export function oscalControlId(controlId: string): string {
  return controlId.toLowerCase();
}

export function cloneControls(controls: ControlRecord[]): ControlRecord[] {
  return structuredClone(controls);
}

export function cloneEvidence(evidence: EvidenceRecord[]): EvidenceRecord[] {
  return structuredClone(evidence);
}
