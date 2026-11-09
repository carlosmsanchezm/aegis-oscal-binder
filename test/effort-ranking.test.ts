import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupControlResults } from "../lib/aegis/control-rollup";
import { rankEffortNext } from "../lib/aegis/effort-ranking";
import { moderateRollupShell } from "../lib/aegis/rollup-shell";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { receivedRetest } from "./support/received-retest";
import { illustrativeScopedAssessment, newPlan } from "../lib/aegis/remediation";

const posture = "FedRAMP Rev5 Moderate";

function inputs() {
  return {
    rows: rollupControlResults(mergeStoredReleases([{ ...receivedRetest(), reviewItems: [] }])),
    relationships: moderateRollupShell(process.cwd()).map.edges,
    postureLabel: posture,
  };
}

test("ranking puts scoped findings first and explains cheap evidence-adjacent blanks", () => {
  const ranked = rankEffortNext(inputs());
  assert.equal(ranked[0].controlId, "CM-6");
  assert.equal(ranked[0].kind, "open-finding");
  assert.match(ranked[0].riskReason, /risk signal, not an approval decision/);
  assert.deepEqual(ranked[0].artifactNames, ["configuration.json", "identity-verification.json", "manifests.yaml", "runtime.json"]);

  const topBlanks = ranked.filter(item => item.kind === "blank").slice(0, 4);
  assert.equal(topBlanks.length, 4);
  assert.ok(topBlanks.every(item => !item.controlId.includes(".")));
  assert.ok(topBlanks.every(item => item.relatedControlIds.length > 0 && item.artifactNames.length > 0));
  assert.ok(topBlanks.every(item => item.relevanceReason.includes("inspection lead, not a mapping")));
  assert.ok(topBlanks.every(item => item.riskReason.includes("Blank does not mean noncompliant")));
});

test("ranking is deterministic and a stored retest reopens an unbound recorded closure", () => {
  const item = CCM_EXAMPLE.reviewItems![0];
  const closed = newPlan(
    CCM_EXAMPLE,
    item.description,
    illustrativeScopedAssessment(item.scope!),
    "DRAFT-ranking",
    "2026-10-03T12:00:00.000Z",
  );
  closed.closure.recorded = true;

  const source = inputs();
  const first = rankEffortNext(source);
  const reversed = rankEffortNext({
    ...source,
    rows: [...source.rows].reverse(),
    relationships: [...source.relationships].reverse(),
  });
  assert.deepEqual(first.map(item => item.id), reversed.map(item => item.id));
  const reopened = rankEffortNext({ ...source, plans: [closed] }).find(item => item.id === "finding:CM-6");
  assert.ok(reopened);
  assert.equal(reopened.planStatus, "open");
});


test("new measured retests reopen legacy closure and progress without transferring old decisions", async () => {
  const { receivedRetest } = await import("./support/received-retest");
  const { applyReceivedVerification } = await import("../lib/aegis/remediation");
  const item = CCM_EXAMPLE.reviewItems![0];
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope!), "DRAFT-binding", "2026-10-03T12:00:00.000Z");
  plan.closure.recorded = true;
  plan.engineeringComplete = true;
  plan.validationRecorded = true;
  plan.readyForReview = true;
  const source = { ...inputs(), rows: rollupControlResults(mergeStoredReleases([{ ...receivedRetest(), reviewItems: [] }])) };
  const current = rankEffortNext({...source, plans:[plan]}).find(x => x.id === "finding:CM-6");
  assert.ok(current);
  assert.equal(current.planStatus, "open");
  const bound = applyReceivedVerification(plan, CCM_EXAMPLE, receivedRetest());
  bound.closure.recorded = true;
  assert.equal(rankEffortNext({...source, plans:[bound]}).some(x => x.id === "finding:CM-6"), false);
  bound.receivedVerification!.releaseSha256 = "cd".repeat(32);
  assert.equal(rankEffortNext({...source, plans:[bound]}).find(x => x.id === "finding:CM-6")?.planStatus, "open");
});

test("another source, asset or selected artifacts cannot close or boost the current finding", () => {
  const item = CCM_EXAMPLE.reviewItems![0];
  const plan = newPlan(CCM_EXAMPLE,item.description,illustrativeScopedAssessment(item.scope!),"DRAFT-scope","2026-10-03T12:00:00.000Z");
  plan.closure.recorded = true;
  for (const patch of [ {source:{...plan.source,commit:"00".repeat(20)}}, {asset:"another asset"}, {source:{...plan.source,artifacts:[]}} ]) {
    assert.equal(rankEffortNext({...inputs(),plans:[{...plan,...patch}]}).find(x=>x.id === "finding:CM-6")?.planStatus,"none");
  }
});


test("closing the earlier UID/GID plan never hides the remaining KSV-0125 recommendation", async () => {
  const { applyReceivedVerification } = await import("../lib/aegis/remediation");
  const item = CCM_EXAMPLE.reviewItems![0];
  const old = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope!), "DRAFT-prior", "2026-10-03T12:00:00.000Z");
  const bound = applyReceivedVerification(old, CCM_EXAMPLE, receivedRetest());
  bound.closure.recorded = true;
  const ranked = rankEffortNext({ ...inputs(), rows: rollupControlResults(mergeStoredReleases()), plans: [bound] });
  assert.equal(ranked[0].controlId, "CM-6");
  assert.equal(ranked[0].kind, "open-finding");
  assert.equal(ranked[0].planStatus, "none");
  assert.deepEqual(ranked[0].artifactNames, ["configuration.json", "configuration.raw.json"]);
});
