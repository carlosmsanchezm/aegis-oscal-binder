import { roleIdsOf } from "./derive";
import { AegisError } from "./errors";
import { ingestOscalPackage } from "./ingest";
import { buildPackageSsp, carriedThroughFrom, unmodeledCarryReasons } from "./ssp-export";
import type { Ctx, PersistedState } from "./types";

export type RoundTripPath = { path: string; reason: string };
export type RoundTripChange = { path: string; before: unknown; after: unknown };

export type RoundTripResult = {
  status: "identical" | "differs";
  compared: { elements: number; values: number };
  lost: Array<{ path: string }>;
  changed: RoundTripChange[];
  carriedThrough: RoundTripPath[];
  namedInAdvance: RoundTripPath[];
  source: { filename: string | null; profileHref: string | null };
};

type Projection = ReturnType<typeof projectState>;

export function namedInAdvance(): RoundTripPath[] {
  return [
    { path: "/system-security-plan/metadata/last-modified", reason: "Export sets last-modified to the export time." },
    { path: "/system-security-plan/uuid", reason: "Export uses a stable uuid derived from the boundary id." },
    { path: "/system-security-plan/metadata/version", reason: "Export writes version 0.1.0." },
    { path: "/system-security-plan/metadata/oscal-version", reason: "Export writes the vendored OSCAL version." },
    { path: "/system-security-plan/metadata/remarks", reason: "Export writes the package remark." },
    { path: "/system-security-plan/import-profile/remarks", reason: "Export writes a remark that the vendored profile was resolved." },
    { path: "JSON object key order", reason: "Object key order is not compared." },
    {
      path: "/system-security-plan/control-implementation/implemented-requirements",
      reason: "Resolving the Moderate profile adds uncovered controls that were absent from the source file. After the first import they are part of the package, and the unedited export includes them.",
    },
    { path: "source filename", reason: "A second import records the export filename. The comparison uses the control record." },
    ...unmodeledCarryReasons(),
    {
      path: "/control-implementation/implemented-requirements/by-components/implementation-status",
      reason: "implementation-status is not a binder field. It is copied onto the JSON export when the source requirement has it.",
    },
    {
      path: "/control-implementation/implemented-requirements/by-components/export",
      reason: "Common control provider and inheritance entries are not binder fields. They are copied onto the JSON export when the source has them.",
    },
    {
      path: "/control-implementation/implemented-requirements/set-parameters",
      reason: "Parameter settings on a source requirement are copied onto the JSON export and are not edited by the binder.",
    },
  ];
}

function projectState(state: PersistedState) {
  return {
    workspaceName: state.workspaceName,
    boundaryId: state.boundaryId,
    catalogPin: state.catalogPin,
    catalogId: state.catalogId,
    controls: state.controls.map((control) => ({
      id: control.id,
      implementation: control.implementation,
      roles: roleIdsOf(control),
      evidence: [...control.evidence]
        .map((item) => ({ id: item.id, title: item.title, type: item.type, href: item.href, uuid: item.uuid, sha256: item.sha256 ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      parts: [...(control.itemStatements ?? [])]
        .filter((item) => /_smt\./i.test(item.statementId))
        .map((item) => ({
          statementId: item.statementId,
          description: item.description,
          evidenceUuids: [...item.evidenceUuids].sort(),
        }))
        .sort((a, b) => a.statementId.localeCompare(b.statementId)),
    })),
  };
}

function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countLeaves(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + countLeaves(item), 0);
  return 1;
}

function walk(before: unknown, after: unknown, path: string, lost: Array<{ path: string }>, changed: RoundTripChange[]): void {
  if (Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const next = `${path}/${index}`;
      if (index >= before.length) changed.push({ path: next, before: null, after: after[index] });
      else if (index >= after.length) lost.push({ path: next });
      else walk(before[index], after[index], next, lost, changed);
    }
    return;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const next = `${path}/${key}`;
      if (!(key in left)) changed.push({ path: next, before: null, after: right[key] });
      else if (!(key in right)) lost.push({ path: next });
      else walk(left[key], right[key], next, lost, changed);
    }
    return;
  }
  changed.push({ path, before, after });
}

export function compareProjections(before: Projection, after: Projection): Pick<RoundTripResult, "status" | "compared" | "lost" | "changed"> {
  const lost: Array<{ path: string }> = [];
  const changed: RoundTripChange[] = [];
  walk(before, after, "", lost, changed);
  return {
    status: lost.length === 0 && changed.length === 0 ? "identical" : "differs",
    compared: { elements: before.controls.length, values: countLeaves(before) },
    lost,
    changed,
  };
}

/**
 * Export the loaded package as JSON and import that JSON again.
 * The loaded package is not replaced.
 */
export function roundTripPackage(state: PersistedState, ctx: Ctx, document?: unknown): RoundTripResult {
  if (!state.loaded || !state.catalogId) {
    throw new AegisError("NO_FIXTURE", "Load an OSCAL package or the demo sample package first.", 400);
  }
  const exported = document ?? buildPackageSsp(state, ctx.now ? ctx.now() : new Date());
  let again: PersistedState;
  try {
    again = ingestOscalPackage({
      text: JSON.stringify(exported),
      filename: state.sourceFilename ?? "round-trip.json",
      catalogId: state.catalogId,
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reimport failed.";
    return {
      status: "differs",
      compared: { elements: state.controls.length, values: countLeaves(projectState(state)) },
      lost: [{ path: "/reimport" }],
      changed: [{ path: "/reimport", before: null, after: message }],
      carriedThrough: carriedThroughFrom(state.sourceSsp),
      namedInAdvance: namedInAdvance(),
      source: { filename: state.sourceFilename, profileHref: state.sourceProfileHref },
    };
  }
  const compared = compareProjections(projectState(state), projectState(again));
  return {
    ...compared,
    carriedThrough: carriedThroughFrom(state.sourceSsp),
    namedInAdvance: namedInAdvance(),
    source: { filename: state.sourceFilename, profileHref: state.sourceProfileHref },
  };
}
