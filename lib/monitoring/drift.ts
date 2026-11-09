import { factCandidates } from "../collector/mappings";
import { moderateControls } from "../aegis/moderate-baseline";
import type { CollectedArtifact } from "../collector/types";
import { monitoringCopy } from "./copy";
import type { DriftClass, DriftRow, MonitorOutcome, SubjectKind } from "./types";

const allowed = new Set(moderateControls().map(control => control.id));

export type OutcomeSnap = { id: string; kind: SubjectKind; outcome: Exclude<MonitorOutcome, "absent">; artifacts: string[] };

export function outcomesFromArtifacts(artifacts: CollectedArtifact[]): Map<string, OutcomeSnap> {
  const rows = new Map<string, { id: string; kind: SubjectKind; fail: boolean; artifacts: Set<string> }>();
  const mark = (id: string, kind: SubjectKind, fail: boolean, artifact: string) => {
    const key = `${kind}:${id}`;
    const row = rows.get(key) ?? { id, kind, fail: false, artifacts: new Set<string>() };
    row.fail ||= fail;
    row.artifacts.add(artifact);
    rows.set(key, row);
  };
  for (const artifact of artifacts) {
    for (const fact of artifact.facts) {
      const fail = fact.outcome === "fail";
      for (const candidate of factCandidates({ ...artifact, facts: [fact] }, allowed, "fedramp-rev5")) mark(candidate.controlId, "control", fail, artifact.name);
      if (fact.ksi) mark(fact.ksi, "ksi", fail, artifact.name);
    }
  }
  return new Map([...rows.entries()].map(([key, row]) => [key, { id: row.id, kind: row.kind, outcome: row.fail ? "fail" as const : "pass" as const, artifacts: [...row.artifacts].sort() }]));
}

function classify(previous: MonitorOutcome, outcome: MonitorOutcome): DriftClass {
  if (outcome === "absent") return "removed";
  if (previous === "absent") return outcome === "pass" ? "new-pass" : "new-fail";
  if (previous === outcome) return outcome === "pass" ? "still-pass" : "still-fail";
  return outcome === "pass" ? "new-pass" : "new-fail";
}

/** Compare one source's new outcomes with the previous retained outcomes. */
export function classifyOutcomes(previous: Map<string, OutcomeSnap>, next: Map<string, OutcomeSnap>): DriftRow[] {
  const before = previous;
  const after = next;
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map(key => {
    const left = before.get(key);
    const right = after.get(key);
    const subject = right ?? left!;
    const previousOutcome: MonitorOutcome = left?.outcome ?? "absent";
    const outcome: MonitorOutcome = right?.outcome ?? "absent";
    const drift = classify(previousOutcome, outcome);
    const regression = previousOutcome === "pass" && outcome === "fail";
    return {
      subjectId: subject.id,
      subjectKind: subject.kind,
      drift,
      label: monitoringCopy.classes[drift],
      previous: previousOutcome,
      outcome,
      regression,
      regressionLabel: regression ? monitoringCopy.regressionLabel : "",
      artifactNames: right?.artifacts ?? [],
    };
  });
}

/** Compare two captures for the gate and for fixtures. */
export function classifyDrift(previous: CollectedArtifact[], next: CollectedArtifact[]): DriftRow[] {
  return classifyOutcomes(outcomesFromArtifacts(previous), outcomesFromArtifacts(next));
}
