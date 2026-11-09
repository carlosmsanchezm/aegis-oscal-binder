import type { BaselineControl, ChangesReport, NamedDelta, PackageState, PersistedState } from "./types";

function artifactState(hash: string | null | undefined, current: string | null): "Stale" | "Current" | "Not rendered" {
  if (!hash || !current) return "Not rendered";
  return hash === current ? "Current" : "Stale";
}

function affectsForEvidence(
  state: PersistedState,
  currentHash: string | null,
  detail: { oscal: string; word: string; excel: string },
): NamedDelta["affects"] {
  return [
    {
      artifact: "package-oscal.xml",
      status: artifactState(state.exports.at(-1)?.irHash, currentHash),
      detail: detail.oscal,
    },
    {
      artifact: "Word render",
      status: artifactState(state.renders.word?.irHash, currentHash),
      detail: detail.word,
    },
    {
      artifact: "Excel render",
      status: artifactState(state.renders.excel?.irHash, currentHash),
      detail: detail.excel,
    },
  ];
}

export function getChanges(state: PersistedState, pkg: PackageState): ChangesReport {
  const currentHash = pkg.irHash;
  if (!state.baseline) {
    return {
      baseline: null,
      current: { irHash: currentHash, gate: pkg.gate.status, controlCount: pkg.inScopeCount },
      summary: { changed: 0, unchanged: pkg.inScopeCount, total: pkg.inScopeCount },
      deltas: [],
      next: ["Update baseline is explicit. Nothing has been set, so there is no named delta yet."],
      note: "No baseline set. Update baseline is explicit and has not been clicked.",
    };
  }

  const deltas: NamedDelta[] = [];
  const currentById = new Map(state.controls.map((control) => [control.id, control]));
  const changedIds = new Set<string>();

  for (const before of state.baseline.controls) {
    const after = currentById.get(before.id);
    if (!after) continue;
    if (before.implementation !== after.implementation) {
      changedIds.add(before.id);
      deltas.push({
        kind: "Modified",
        field: "implementation",
        label: "Implementation · Modified",
        controlId: before.id,
        controlTitle: before.title,
        before: before.implementation,
        after: after.implementation,
        affects: affectsForEvidence(state, currentHash, {
          oscal: `implemented-requirement ${before.id.toLowerCase()} · description`,
          word: `SSP table ${before.id} · Implementation`,
          excel: `Controls sheet · ${before.id}`,
        }),
      });
    }
    if (before.responsibleRoleId !== after.responsibleRoleId) {
      changedIds.add(before.id);
      deltas.push({
        kind: "Modified",
        field: "responsibleRole",
        label: "Responsible role · Modified",
        controlId: before.id,
        controlTitle: before.title,
        before: before.responsibleRoleId,
        after: after.responsibleRoleId,
        affects: affectsForEvidence(state, currentHash, {
          oscal: `implemented-requirement ${before.id.toLowerCase()} · responsible-role/@role-id`,
          word: `SSP table ${before.id} · Responsible role`,
          excel: `Controls sheet · ${before.id}`,
        }),
      });
    }
    deltas.push(...diffEvidence(state, currentHash, before, after, changedIds));
  }

  const total = state.baseline.controls.length;
  return {
    baseline: {
      id: state.baseline.id,
      setAt: state.baseline.setAt,
      exportId: state.baseline.exportId,
      irHash: state.baseline.irHash,
    },
    current: { irHash: currentHash, gate: pkg.gate.status, controlCount: pkg.inScopeCount },
    summary: { changed: changedIds.size, unchanged: total - changedIds.size, total },
    deltas,
    next: [
      "1 · Re export — exports the current IR. Baseline stays where it is.",
      "2 · Validator — runs on the re export. Must be GREEN.",
      "3 · Update baseline — explicit click only. Sets the checklist comparison point. Not automatic.",
    ],
    note: "Named delta versus the explicit baseline. Re export does not move the baseline.",
  };
}

function diffEvidence(
  state: PersistedState,
  currentHash: string | null,
  before: BaselineControl,
  after: PersistedState["controls"][number],
  changedIds: Set<string>,
): NamedDelta[] {
  const deltas: NamedDelta[] = [];
  const afterById = new Map(after.evidence.map((item) => [item.id, item]));
  const beforeById = new Map(before.evidence.map((item) => [item.id, item]));

  for (const prior of before.evidence) {
    const next = afterById.get(prior.id);
    if (!next) {
      changedIds.add(before.id);
      deltas.push({
        kind: "Removed",
        field: "evidence",
        label: "Evidence · Removed",
        controlId: before.id,
        controlTitle: before.title,
        evidenceId: prior.id,
        evidenceTitle: prior.title,
        before: prior.href,
        affects: affectsForEvidence(state, currentHash, {
          oscal: `back-matter resource ${prior.id}`,
          word: `Evidence table · ${before.id}`,
          excel: `Evidence sheet · ${prior.id}`,
        }),
      });
      continue;
    }
    if (prior.href !== next.href || prior.title !== next.title || prior.type !== next.type) {
      changedIds.add(before.id);
      deltas.push({
        kind: "Modified",
        field: "evidence",
        label: "Evidence · Modified",
        controlId: before.id,
        controlTitle: before.title,
        evidenceId: prior.id,
        evidenceTitle: next.title,
        before: prior.href,
        after: next.href,
        affects: affectsForEvidence(state, currentHash, {
          oscal: `back-matter resource ${prior.id}`,
          word: `Evidence table · ${before.id}`,
          excel: `Evidence sheet · ${prior.id}`,
        }),
      });
    }
  }

  for (const next of after.evidence) {
    if (beforeById.has(next.id)) continue;
    changedIds.add(before.id);
    deltas.push({
      kind: "Added",
      field: "evidence",
      label: "Evidence · Added",
      controlId: before.id,
      controlTitle: before.title,
      evidenceId: next.id,
      evidenceTitle: next.title,
      after: next.href,
      affects: affectsForEvidence(state, currentHash, {
        oscal: `back-matter resource ${next.id}`,
        word: `Evidence table · ${before.id}`,
        excel: `Evidence sheet · ${next.id}`,
      }),
    });
  }
  return deltas;
}
