import { roleIdsOf } from "./derive";
import { AegisError } from "./errors";
import { ingestOscalPackage } from "./ingest";
import type { Ctx, ImportBaselineControl, PersistedState } from "./types";

export type CompareRow = { id: string; title: string; detail: string };

export type PackageCompareResult = {
  dryRun: true;
  replaces: false;
  added: CompareRow[];
  removed: CompareRow[];
  changed: Array<CompareRow & { fields: string[] }>;
  binderEdits: Array<{ controlId: string; detail: string; stillInNewFile: boolean }>;
  counts: { added: number; removed: number; changed: number; binderEdits: number };
};

function detailOf(control: { id: string; implementation: string; title?: string }): string {
  const text = control.implementation.trim();
  return text ? text.slice(0, 180) : "No implementation text is recorded.";
}

function snapshotCurrent(state: PersistedState): ImportBaselineControl[] {
  return state.controls.map((control) => ({
    id: control.id,
    implementation: control.implementation,
    responsibleRoleIds: roleIdsOf(control),
    evidence: control.evidence.map((item) => ({ id: item.id, title: item.title, href: item.href })),
    parts: (control.itemStatements ?? [])
      .filter((item) => /_smt\./i.test(item.statementId))
      .map((item) => ({ statementId: item.statementId, description: item.description, evidenceUuids: [...item.evidenceUuids] })),
  }));
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function binderDetail(before: ImportBaselineControl, after: ImportBaselineControl): string | null {
  const fields: string[] = [];
  if (before.implementation !== after.implementation) fields.push("implementation");
  if (!sameList(before.responsibleRoleIds, after.responsibleRoleIds)) fields.push("role");
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) fields.push("evidence");
  if (JSON.stringify(before.parts) !== JSON.stringify(after.parts)) fields.push("statement parts");
  if (fields.length === 0) return null;
  return fields.join(", ");
}

/**
 * Dry run. The current package is not replaced.
 * Compares the loaded package with an uploaded SSP, and lists binder edits since the last import.
 */
export function compareUploadedSsp(state: PersistedState, text: string, filename: string, ctx: Ctx): PackageCompareResult {
  if (!state.loaded || !state.catalogId) {
    throw new AegisError("NO_FIXTURE", "Load an OSCAL package before comparing a newer SSP.", 400);
  }
  const next = ingestOscalPackage({ text, filename, catalogId: state.catalogId }, ctx);
  const currentById = new Map(state.controls.map((control) => [control.id.toUpperCase(), control]));
  const nextById = new Map(next.controls.map((control) => [control.id.toUpperCase(), control]));
  const added: CompareRow[] = [];
  const removed: CompareRow[] = [];
  const changed: PackageCompareResult["changed"] = [];
  for (const control of next.controls) {
    const current = currentById.get(control.id.toUpperCase());
    if (!current) {
      added.push({ id: control.id, title: control.title, detail: "New implemented requirement." });
      continue;
    }
    const fields: string[] = [];
    if (current.implementation !== control.implementation) fields.push("implementation");
    if (!sameList(roleIdsOf(current), roleIdsOf(control))) fields.push("role");
    const currentEvidence = current.evidence.map((item) => `${item.title}\n${item.href}`).sort();
    const nextEvidence = control.evidence.map((item) => `${item.title}\n${item.href}`).sort();
    if (JSON.stringify(currentEvidence) !== JSON.stringify(nextEvidence)) fields.push("evidence");
    const currentParts = (current.itemStatements ?? []).filter((item) => /_smt\./i.test(item.statementId));
    const nextParts = (control.itemStatements ?? []).filter((item) => /_smt\./i.test(item.statementId));
    if (JSON.stringify(currentParts.map((item) => [item.statementId, item.description, [...item.evidenceUuids].sort()]))
      !== JSON.stringify(nextParts.map((item) => [item.statementId, item.description, [...item.evidenceUuids].sort()]))) {
      fields.push("statement parts");
    }
    if (fields.length > 0) changed.push({ id: control.id, title: control.title, detail: fields.join(", "), fields });
  }
  for (const control of state.controls) {
    if (!nextById.has(control.id.toUpperCase())) {
      removed.push({ id: control.id, title: control.title, detail: detailOf(control) });
    }
  }
  const baseline = state.importBaseline ?? snapshotCurrent(state);
  const baselineById = new Map(baseline.map((control) => [control.id.toUpperCase(), control]));
  const currentSnapshot = snapshotCurrent(state);
  const binderEdits: PackageCompareResult["binderEdits"] = [];
  for (const control of currentSnapshot) {
    const before = baselineById.get(control.id.toUpperCase());
    if (!before) continue;
    const detail = binderDetail(before, control);
    if (!detail) continue;
    binderEdits.push({
      controlId: control.id,
      detail,
      stillInNewFile: nextById.has(control.id.toUpperCase()),
    });
  }
  return {
    dryRun: true,
    replaces: false,
    added,
    removed,
    changed,
    binderEdits,
    counts: { added: added.length, removed: removed.length, changed: changed.length, binderEdits: binderEdits.length },
  };
}
