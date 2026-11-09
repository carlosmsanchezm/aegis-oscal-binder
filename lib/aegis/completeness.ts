import { isResolvedModerateProfile } from "./profile-resolution";
import { profileControlCounts } from "./profile-counts";
import type { ControlView, PackageState, PersistedState } from "./types";

/**
 * Statement part rule.
 * A part is one direct catalog statement item, such as `cm-6_smt.a`.
 * It is complete only with implementation text and at least one valid evidence item linked to that part.
 * Neither recorded means blank. One of them means partial.
 * The control rule is unchanged: implementation, a role, and at least one valid evidence item.
 * Part status does not flip the control gate. A role is not required on a part.
 */
export const STATEMENT_PART_RULE =
  "A statement part is a direct catalog statement item. It is complete with implementation text and at least one valid evidence item linked to that part. Neither is blank. One of them is partial. The control is complete only with an implementation, a role, and at least one valid evidence item. Part status does not change that control result.";

const UNLOADED_REASON = "No package is loaded.";
const UNRESOLVED_REASON = "Profile base and enhancement counts are read from the FedRAMP Rev 5 Moderate profile after that profile is resolved.";

type ControlReason = NonNullable<PackageState["gate"]["controlReasons"]>[number];
type PartReason = NonNullable<PackageState["gate"]["parts"]>[number];
type FamilyCount = NonNullable<PackageState["gate"]["families"]>[number];

function controlStatus(control: ControlView): ControlReason["status"] {
  if (control.complete) return "complete";
  if (control.blank) return "blank";
  const recorded = Boolean(control.implementation.trim()) || control.responsibleRoleIds.length > 0 || control.evidence.length > 0;
  return recorded ? "partial" : "incomplete";
}

function controlReasons(control: ControlView): ControlReason["reasons"] {
  const reasons: ControlReason["reasons"] = [];
  if (control.missing.includes("implementation")) reasons.push("missing implementation");
  if (control.missing.includes("responsibleRole")) reasons.push("missing role");
  if (control.missing.includes("evidence")) reasons.push("missing evidence");
  return reasons;
}

function partReasons(control: ControlView): PartReason[] {
  const byUuid = new Map(control.evidence.map((item) => [item.uuid, item]));
  const parts: PartReason[] = [];
  for (const item of control.itemStatements) {
    if (!/_smt\./i.test(item.statementId)) continue;
    const valid = item.evidenceUuids.filter((uuid) => byUuid.get(uuid)?.valid).length;
    const hasText = item.description.trim().length > 0;
    const reasons: PartReason["reasons"] = [];
    if (!hasText) reasons.push("missing implementation");
    if (valid < 1) reasons.push("missing evidence");
    const status: PartReason["status"] = reasons.length === 0 ? "complete" : !hasText && valid < 1 ? "blank" : "partial";
    parts.push({ controlId: control.id, statementId: item.statementId, status, reasons });
  }
  return parts;
}

export function completenessFields(
  state: PersistedState,
  controls: ControlView[],
  root: string,
): Pick<PackageState["gate"], "partial" | "profile" | "families" | "controlReasons" | "parts" | "nextIncompleteControlIds"> {
  if (!state.loaded) {
    return {
      partial: 0,
      profile: { resolved: false, total: null, base: null, enhancements: null, reason: UNLOADED_REASON },
      families: [],
      controlReasons: [],
      parts: [],
      nextIncompleteControlIds: [],
    };
  }
  const resolved = isResolvedModerateProfile(state);
  const counts = resolved ? profileControlCounts(root) : null;
  const rows: ControlReason[] = controls.map((control) => ({
    id: control.id,
    status: controlStatus(control),
    reasons: controlReasons(control),
  }));
  const familyIds: string[] = [];
  for (const control of controls) {
    if (!familyIds.includes(control.family)) familyIds.push(control.family);
  }
  const families: FamilyCount[] = familyIds.map((id) => {
    const members = controls.filter((control) => control.family === id);
    const memberRows = rows.filter((row) => members.some((control) => control.id === row.id));
    return {
      id,
      total: members.length,
      complete: memberRows.filter((row) => row.status === "complete").length,
      incomplete: memberRows.filter((row) => row.status !== "complete").length,
      blank: memberRows.filter((row) => row.status === "blank").length,
      partial: memberRows.filter((row) => row.status === "partial").length,
      base: resolved ? members.filter((control) => !control.id.includes(".")).length : null,
      enhancements: resolved ? members.filter((control) => control.id.includes(".")).length : null,
    };
  });
  return {
    partial: rows.filter((row) => row.status === "partial").length,
    profile: counts
      ? { resolved: true, total: counts.total, base: counts.base, enhancements: counts.enhancements, reason: null }
      : { resolved: false, total: null, base: null, enhancements: null, reason: UNRESOLVED_REASON },
    families,
    controlReasons: rows,
    parts: controls.flatMap(partReasons),
    nextIncompleteControlIds: controls.filter((control) => !control.complete).map((control) => control.id),
  };
}
