import { catalogSummary, catalogChoices, pinForCatalog } from "./catalogs";
import { compareControlId, orderFamiliesPresent } from "./control-order";
import { loadRev5Index, packageMapFor, unavailableMap } from "./map-graph";
import { completenessFields } from "./completeness";
import { isResolvedModerateProfile, markResolvedBlanks } from "./profile-resolution";
import {
  CLI_EXPORT,
  CLI_NOTE,
  CLI_VALIDATE,
  D6_ID,
  D6_TEXT,
} from "./constants";
import { evidenceFileStatus, roleTitle } from "./evidence";
import { oscalControlId } from "./fixture";
import { hashControls, oscalArtifactFilename, padId } from "./hash";
import type {
  ControlRecord,
  ControlView,
  Ctx,
  FamilyView,
  MissingField,
  PackageState,
  PersistedState,
} from "./types";

function renderView(
  record: PersistedState["renders"]["word"],
  gate: PackageState["gate"]["status"],
  green: boolean,
  validatorStatus: PackageState["pipeline"]["validator"]["status"],
  irHash: string | null,
): { status: "locked" | "ready" | "rendered"; stale: boolean; lockedReason: string | null } {
  const stale = Boolean(record && irHash && record.irHash !== irHash);
  if (gate !== "PASS") {
    return {
      status: "locked",
      stale,
      lockedReason: gate === "FAIL" ? "Needs completeness PASS and validator GREEN" : "Locked · no package loaded",
    };
  }
  if (validatorStatus === "RED") {
    return { status: "locked", stale, lockedReason: "Locked until validator GREEN" };
  }
  if (record) return { status: "rendered", stale, lockedReason: null };
  if (green) return { status: "ready", stale: false, lockedReason: null };
  return { status: "locked", stale: false, lockedReason: "Locked until validator GREEN" };
}

export function roleIdsOf(control: { responsibleRoleId: string; responsibleRoleIds?: string[] }): string[] {
  const listed = (control.responsibleRoleIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (listed.length > 0) return listed;
  return control.responsibleRoleId.trim() ? [control.responsibleRoleId.trim()] : [];
}

export function projectControl(control: ControlRecord, roles: PersistedState["roles"], ctx: Ctx): ControlView {
  const evidence = control.evidence.map((item) => {
    const status = evidenceFileStatus(item, ctx);
    return { ...item, ...status };
  });
  const validEvidenceCount = evidence.filter((item) => item.valid).length;
  const missing: MissingField[] = [];
  if (!control.implementation.trim()) missing.push("implementation");
  const roleIds = roleIdsOf(control);
  if (roleIds.length === 0) missing.push("responsibleRole");
  if (validEvidenceCount < 1) missing.push("evidence");
  return {
    ...(control.providerCoverage?{providerCoverage:control.providerCoverage}:{}),
    ...(control.implementedBy?{implementedBy:control.implementedBy}:{}),
    id: control.id,
    oscalId: oscalControlId(control.id),
    title: control.title,
    family: control.family,
    implementation: control.implementation,
    responsibleRoleId: roleIds[0] ?? "",
    responsibleRole: roleTitle(roles, roleIds[0] ?? ""),
    responsibleRoleIds: roleIds,
    roleLabels: roleIds.map((id) => roleTitle(roles, id)).filter(Boolean),
    itemStatements: control.itemStatements ?? [],
    evidence,
    validEvidenceCount,
    missing,
    complete: missing.length === 0,
  };
}

export function familyRollup(controls: ControlView[], catalogOrder: readonly string[] = []): FamilyView[] {
  const present = [...new Set(controls.map((control) => control.family))];
  const ids = orderFamiliesPresent(present, catalogOrder);
  return ids.map((id) => {
    const members = controls.filter((control) => control.family === id);
    const open = members.filter((control) => !control.complete).length;
    return {
      id,
      total: members.length,
      open,
      label: open === 0 ? "ok" : `${open}/${members.length} open`,
    };
  });
}

/** Unloaded selection shows the pin for the chosen catalog, even if the stored pin drifted. */
function displayedPin(state: PersistedState): string | null {
  if (state.catalogId === "fedramp-rev5" || state.catalogId === "fedramp-20x") {
    if (!state.loaded || !state.catalogPin) return pinForCatalog(state.catalogId);
  }
  return state.catalogPin;
}

export function getPackageState(state: PersistedState, ctx: Ctx): PackageState {
  const projected = state.loaded ? state.controls.map((control) => projectControl(control, state.roles, ctx)) : [];
  const profileResolved = state.loaded && isResolvedModerateProfile(state);
  const controls = profileResolved ? markResolvedBlanks(projected) : projected;
  const catalogOrder = state.loaded && state.catalogId === "fedramp-rev5"
    ? [...loadRev5Index(ctx.root).families.keys()]
    : [];
  const incomplete = controls.filter((control) => !control.complete).sort((a, b) => compareControlId(a.id, b.id));
  const blankCount = controls.filter((control) => control.blank).length;
  const completeCount = controls.filter((control) => control.complete).length;
  const total = controls.length;
  const gateBase: PackageState["gate"] = !state.loaded
    ? {
        status: "EMPTY",
        incomplete: 0,
        complete: 0,
        total: 0,
        label: "no package loaded",
        failClosed: true,
        incompleteControlIds: [],
      }
    : incomplete.length === 0
      ? {
          status: "PASS",
          incomplete: 0,
          complete: completeCount,
          total,
          label: `${total} of ${total} complete · gate open`,
          failClosed: true,
          incompleteControlIds: [],
        }
      : {
          status: "FAIL",
          incomplete: incomplete.length,
          complete: completeCount,
          total,
          label: `${incomplete.length} of ${total} incomplete`,
          failClosed: true,
          incompleteControlIds: incomplete.map((control) => control.id),
          ...(blankCount > 0 ? { blank: blankCount } : {}),
        };
  const gate: PackageState["gate"] = { ...gateBase, ...completenessFields(state, controls, ctx.root) };

  const irHash = state.loaded ? hashControls(state.controls) : null;
  const lastExport = state.exports.at(-1) ?? null;
  const exportMatches = Boolean(lastExport && irHash && lastExport.irHash === irHash);
  const validation = state.lastValidation;
  const validationCurrent = Boolean(validation && irHash && validation.irHash === irHash);
  const green = Boolean(validationCurrent && validation?.status === "GREEN" && validation.scenario === "current");
  const validatorStatus: PackageState["pipeline"]["validator"]["status"] = !validationCurrent
    ? "NOT_RUN"
    : validation!.status;

  const nextFilename = oscalArtifactFilename(padId("exp", state.counters.export + 1));
  const oscalStatus: PackageState["pipeline"]["oscal"]["status"] = !state.loaded
    ? "locked"
    : lastExport && exportMatches
      ? "written"
      : "ready";
  const oscalFilename = lastExport && exportMatches ? lastExport.filename : nextFilename;

  const wordView = renderView(state.renders.word, gate.status, green, validatorStatus, irHash);
  const excelView = renderView(state.renders.excel, gate.status, green, validatorStatus, irHash);
  const wordStale = wordView.stale;
  const excelStale = excelView.stale;

  const baselineEnabled = Boolean(green && gate.status === "PASS");
  const parity =
    state.parity && irHash && state.parity.irHash === irHash && !wordStale && !excelStale ? state.parity : null;

  return {
    loaded: state.loaded,
    workspaceName: state.workspaceName,
    boundaryId: state.boundaryId,
    catalogPin: displayedPin(state),
    catalogReadOnly: true,
    catalog: catalogSummary(ctx.root, state.catalogId, state.loaded),
    catalogChoices: catalogChoices(ctx.root),
    ingestKind: state.loaded ? state.ingestKind : null,
    sourceFilename: state.loaded ? state.sourceFilename : null,
    sourceProfileHref: state.loaded ? state.sourceProfileHref : null,
    disclaimer: { id: D6_ID, text: D6_TEXT },
    roles: state.roles,
    controls,
    families: familyRollup(controls, catalogOrder),
    map: state.loaded
      ? packageMapFor(ctx.root, state.catalogId, controls)
      : unavailableMap(
          state.catalogId === "fedramp-20x"
            ? "FedRAMP 20x stub has no NIST Rev5 related-control edges. Edges are not invented for placeholder controls."
            : "Load a FedRAMP Rev5 package to read catalog related links.",
        ),
    inScopeCount: total,
    irHash,
    gate,
    pipeline: {
      oscal: {
        status: oscalStatus,
        filename: oscalFilename,
        exportId: lastExport && exportMatches ? lastExport.id : null,
        writtenAt: lastExport && exportMatches ? lastExport.at : null,
        stale: Boolean(lastExport && irHash && lastExport.irHash !== irHash),
        lockedReason: oscalStatus === "locked" ? "Load an OSCAL package or the demo sample package first." : null,
      },
      validator: {
        status: validatorStatus,
        errorCount: validationCurrent ? validation!.errors.length : 0,
        errors: validationCurrent ? validation!.errors : [],
        at: validationCurrent ? validation!.at : null,
        scenario: validationCurrent ? validation!.scenario : null,
        exportId: validationCurrent ? validation!.exportId : null,
      },
      word: {
        status: wordView.status,
        filename: "package.docx",
        renderedAt: state.renders.word?.at ?? null,
        stale: wordView.stale,
        lockedReason: wordView.lockedReason,
      },
      excel: {
        status: excelView.status,
        filename: "package.xlsx",
        renderedAt: state.renders.excel?.at ?? null,
        stale: excelView.stale,
        lockedReason: excelView.lockedReason,
      },
      baseline: {
        id: state.baseline?.id ?? null,
        setAt: state.baseline?.setAt ?? null,
        exportId: state.baseline?.exportId ?? null,
        enabled: baselineEnabled,
        reason: baselineEnabled
          ? "Enabled because the validator is GREEN. Sets the checklist comparison point. Not automatic."
          : "Disabled · needs validator GREEN",
      },
      parity,
    },
    blockedAttempts: state.blockedAttempts,
    cli: {
      note: CLI_NOTE,
      validate: CLI_VALIDATE,
      export: CLI_EXPORT,
    },
    future: {
      liveConnections: 0,
      note: "Future / stub — not built, not wired, not in the demo loop.",
    },
  };
}
