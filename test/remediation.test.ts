import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { applyReceivedVerification } from "../lib/aegis/remediation";
import { resetReviewDecisions, updatePlanAssessment } from "../lib/aegis/remediation";
import { normalizePipelineEvent, parseStoredPipelineEvidence } from "../lib/aegis/pipeline-inbound";
import { applyRetestPacket, assessmentProblems, closureProblems, confirmed, emptyAssessment, engineeringProblems, exportDraft, illustrativeAssessment, illustrativeScopedAssessment, illustrativeProgress, isDate, milestoneProblems, newPlan, readinessProblems, restoreAssessment, restorePlan, revisePlan, safeReferenceUrl, validationProblems } from "../lib/aegis/remediation";

const gap = CCM_EXAMPLE.gaps.find((g) => /network.policy/i.test(g))!;
const draft = () => newPlan(CCM_EXAMPLE, gap, illustrativeAssessment(), "DRAFT-test", "2026-10-02T12:00:00Z");
function validated() {
  const p = illustrativeProgress(draft(), true);
  p.validation = "demonstrated"; p.validationRecorded = true;
  return p;
}
test("review reset preserves recorded work, provenance and tests, and refuses external closure", () => {
  const p = validated(); p.readyForReview = true;
  const reset = resetReviewDecisions(p, "2026-10-05T12:00:00Z");
  assert.equal(reset.engineeringComplete, false);
  assert.equal(reset.validationRecorded, false);
  assert.equal(reset.validation, "undetermined");
  assert.equal(reset.readyForReview, false);
  for (const key of ["source", "assessment", "milestones", "tests", "releaseRef", "releaseUrl", "receivedVerification"] as const) assert.deepEqual(reset[key], p[key]);
  assert.equal(p.engineeringComplete, true);
  assert.equal(reset.history.length, p.history.length + 1);
  assert.throws(() => resetReviewDecisions({ ...p, closure: { ...p.closure, recorded: true } }, "now"));
});
test("same-scope saved assessment refreshes open draft without losing work and invalidates decisions", () => {
  const p = validated(); p.readyForReview = true;
  const assessment = { ...p.assessment, note: "Reviewed selected criterion", reviewer: "Internal security reviewer" };
  const next = updatePlanAssessment(p, assessment, "2026-10-05T12:00:00Z");
  assert.deepEqual(next.assessment, assessment);
  assert.deepEqual(next.tests, p.tests);
  assert.deepEqual(next.milestones, p.milestones);
  assert.equal(next.validationRecorded, false); assert.equal(next.engineeringComplete, false); assert.equal(next.readyForReview, false);
  assert.equal(updatePlanAssessment(p, p.assessment, "now"), p);
  assert.equal(updatePlanAssessment(p, { ...assessment, scope: { ...assessment.scope!, controls: ["CM-6"] } }, "now"), p);
  const closed = { ...p, closure: { ...p.closure, recorded: true } };
  assert.equal(updatePlanAssessment(closed, assessment, "now"), closed);
});
test("an observation is not a confirmed deficiency; reviewer, date, requirement and supporting rationale are required", () => {
  assert.equal(confirmed(emptyAssessment()), false);
  const a = { ...emptyAssessment(), disposition: "confirmed" as const };
  assert.equal(assessmentProblems(a).length, 6);
  assert.throws(() => newPlan(CCM_EXAMPLE, gap, a, "id", "now"));
  assert.equal(confirmed(illustrativeAssessment()), true);
  assert.equal(confirmed({ ...illustrativeAssessment(), date: "2026-02-30" }), false);
  assert.equal(isDate("2026-99-99"), false);
});
test("new draft carries source provenance at control level without changing recorded evidence or closing other scope", () => {
  const original = JSON.stringify(CCM_EXAMPLE);
  const p = draft();
  assert.deepEqual(p.source.artifacts.map((a) => a.name), ["runtime.json", "configuration.json"]);
  assert.match(p.source.artifacts[0].href, /16815627409/);
  assert.equal(p.control, "SC-7"); assert.equal(p.engineeringComplete, false); assert.equal(p.validationRecorded, false);
  assert.match(exportDraft(p).limitations.remainingScope, /mTLS/);
  assert.equal(JSON.stringify(CCM_EXAMPLE), original);
});
test("milestone delay requires valid revised date and justification", () => {
  const p = illustrativeProgress(draft());
  assert.deepEqual(milestoneProblems(p), []);
  p.milestones[1].reason = "";
  assert.match(milestoneProblems(p).join(" "), /justification/);
  p.milestones[1].revised = "2026-10-10";
  assert.match(milestoneProblems(p).join(" "), /not earlier/);
});
test("ticket completion or pipeline pass never auto records validation or closure", () => {
  const p = illustrativeProgress(draft(), true);
  assert.equal(p.engineeringComplete, true); assert.equal(p.validationRecorded, false); assert.equal(p.readyForReview, false); assert.equal(p.closure.recorded, false);
  assert.deepEqual(engineeringProblems(p), []);
  assert.match(readinessProblems(p).join(" "), /positive ISSE/);
});
test("positive verification needs complete evidence; negative verification can record a partial failed test", () => {
  const p = validated();
  assert.deepEqual(validationProblems(p), []);
  p.tests[2].evidence = "";
  assert.match(validationProblems(p).join(" "), /Every required test/);
  p.validation = "not-demonstrated";
  assert.deepEqual(validationProblems(p), []);
  assert.notDeepEqual(readinessProblems(p), []);
});
test("editing corrective work or test evidence invalidates dependent decisions", () => {
  const p = validated(); p.readyForReview = true; p.closure.recorded = true;
  const edit = revisePlan(p, { action: "A different corrective change" });
  assert.equal(edit.engineeringComplete, false); assert.equal(edit.validationRecorded, false); assert.equal(edit.readyForReview, false); assert.equal(edit.closure.recorded, false);
  const testEdit = revisePlan(p, { tests: p.tests.map((t) => ({ ...t, result: "Different result" })) });
  assert.equal(testEdit.engineeringComplete, true); assert.equal(testEdit.validationRecorded, false);
  assert.equal(revisePlan(p, { action: p.action }).validationRecorded, true);
});
test("internal readiness does not require or imply agency submission; closure capture requires external refs", () => {
  const p = validated();
  assert.deepEqual(readinessProblems(p), []);
  assert.notDeepEqual(closureProblems(p), []);
  p.readyForReview = true; p.repository = "Agency-designated test repository"; p.officialId = "ILLUSTRATIVE-POAM-3"; p.protectionDisposition = "Keep protection";
  p.closure = { reference: "Illustrative external decision", approver: "Example approver", date: "2026-11-06", officialId: p.officialId, recorded: false };
  assert.deepEqual(closureProblems(p), []);
  p.closure.officialId = "different-item";
  assert.match(closureProblems(p).join(" "), /linked official/);
});
test("bounded stored drafts remain scoped to this release and reject corruption", () => {
  assert.equal(restorePlan(draft(), CCM_EXAMPLE)?.id, "DRAFT-test");
  assert.equal(restorePlan({ ...draft(), tests: undefined }, CCM_EXAMPLE), null);
  assert.equal(restorePlan({ ...draft(), assessment: { ...illustrativeAssessment(), date: "" } }, CCM_EXAMPLE), null);
  assert.equal(restorePlan(draft(), { ...CCM_EXAMPLE, commitSha: "other" }), null);
  const spoof = draft(); spoof.engineeringComplete = true; spoof.validationRecorded = true; spoof.readyForReview = true; spoof.closure.recorded = true;
  const restored = restorePlan(spoof, CCM_EXAMPLE)!;
  assert.equal(restored.engineeringComplete, false); assert.equal(restored.validationRecorded, false); assert.equal(restored.closure.recorded, false);
});
test("illustrative progress cannot be inserted into an actual assessment", () => {
  const p = draft(); p.assessment.illustrative = false;
  assert.throws(() => illustrativeProgress(p));
  assert.equal(safeReferenceUrl("javascript:alert(1)"), null);
  assert.equal(safeReferenceUrl("https://user:password@example.org"), null);
  assert.equal(safeReferenceUrl("https://example.org/test"), "https://example.org/test");
});

const identityPlan=()=>newPlan(CCM_EXAMPLE,CCM_EXAMPLE.reviewItems![0].description,illustrativeScopedAssessment(CCM_EXAMPLE.reviewItems![0].scope),"identity-case","2026-10-03T12:00:00Z");

function receivedCorrection() {
  const commit = "01".repeat(20), hash = "ab".repeat(32);
  return normalizePipelineEvent({ schema: "aegis.pipeline-event.v1", pipeline: { id: "99", url: CCM_EXAMPLE.pipelineUrl.replace("2894050908", "99"), commit, createdAt: "2026-10-03T05:00:00Z" }, artifactRef: "123", image: "registry.test/test@sha256:" + hash, releaseSha256: hash, policyVerdict: "pass", signatureStatus: "reported", signatureScope: "unit test", deploymentVerdict: "observed", approval: { actor: "test engineer", approvedAt: "2026-10-03T05:00:00Z", commit, releaseSha256: hash, mode: "vendor-test", independentReview: false }, runtime: { checkedAt: "2026-10-03T05:00:00Z", functionalProbe: "pass", podCount: 2, readyCount: 2, meshSidecarCount: 0, mTLS: "not established" }, checks: [], families: [], findingCount: 1, gaps: [], artifacts: ["configuration.json", "identity-verification.json", "runtime.json"], verification: {
    sourcePipelineUrl: CCM_EXAMPLE.pipelineUrl, sourceCommit: CCM_EXAMPLE.commitSha, sourceReleaseSha256: CCM_EXAMPLE.releaseSha256,
    tests: CCM_EXAMPLE.reviewItems![0].scope.verification.map((description, i) => ({ description, artifact: ["configuration.json", "identity-verification.json", "runtime.json"][i], artifactSha256: hash, result: `Measured test ${i+1} passed`, verdict: "pass", date: "2026-10-03" }))
  } });
}
test("received measurements bind to the original hash and exact scope without recording decisions", () => {
  const correction = receivedCorrection(), plan = applyReceivedVerification(identityPlan(), CCM_EXAMPLE, correction);
  assert.equal(parseStoredPipelineEvidence(correction).verification?.tests.length, 3);
  assert.equal(plan.receivedVerification?.releaseSha256, correction.releaseSha256);
  assert.equal(plan.tests[1].artifactSha256, "ab".repeat(32));
  assert.match(plan.tests[1].evidence, /123\/artifacts\/file\/evidence\/identity-verification/);
  assert.equal(plan.engineeringComplete, false); assert.equal(plan.validationRecorded, false); assert.equal(plan.readyForReview, false); assert.equal(plan.closure.recorded, false);
  assert.throws(() => applyReceivedVerification(identityPlan(), CCM_EXAMPLE, { ...correction, verification: { ...correction.verification!, sourceReleaseSha256: "cc".repeat(32) } }), /original release hash/);
  assert.throws(() => applyReceivedVerification(identityPlan(), CCM_EXAMPLE, { ...correction, verification: { ...correction.verification!, tests: correction.verification!.tests.slice(0, 2) } }), /scope/);
  assert.throws(() => parseStoredPipelineEvidence({ ...correction, artifacts: [] }), /outside/);
});
test("a failed measured test blocks positive validation and evidence edits remove received provenance", () => {
  const correction = receivedCorrection(); correction.verification!.tests[0].verdict = "fail";
  const plan = applyReceivedVerification(identityPlan(), CCM_EXAMPLE, correction);
  plan.validation = "demonstrated";
  assert.match(validationProblems(plan).join(" "), /measured test failed/);
  assert.equal(revisePlan(plan, { tests: plan.tests.map(t => ({ ...t, result: "edited" })) }).receivedVerification, undefined);
});
const packet=()=>({schema:"binder.retest-evidence.v1",sourcePipelineUrl:CCM_EXAMPLE.pipelineUrl,sourceCommit:CCM_EXAMPLE.commitSha,remediation:{pipelineId:"123",url:"https://gitlab.com/vendor/test/-/pipelines/123",commit:"a".repeat(40)},owner:"Fixture engineer",action:"Correct UID/GID",risk:"Fixture rationale",resources:"Fixture resources",protection:"Existing hardening remains",milestones:[{id:"m1",description:"Fixture correction and retest",target:"2026-10-03",revised:"",reason:"",status:"Done"}],tests:identityPlan().tests.map(t=>({description:t.description,evidence:"https://gitlab.com/vendor/test/-/jobs/456/artifacts/file/evidence/test.json",result:"Fixture result",reviewer:"Fixture collector",date:"2026-10-03",illustrative:false}))});
test("scope drives asset, controls, artifacts and verification; no network scenario is inferred",()=>{
 const p=identityPlan();assert.equal(p.control,"CM-6");assert.equal(p.asset,"Podinfo application container");assert.match(p.tests[0].description,/KSV-0020/);assert.deepEqual(p.source.artifacts.map(a=>a.name),["configuration.json","manifests.yaml"]);
 const a=illustrativeScopedAssessment({...CCM_EXAMPLE.reviewItems![0].scope,title:"Different service",asset:"Another system",framework:"Customer-selected framework",baseline:"Customer requirement reference",controls:["SI-2"],artifacts:["image.json"],verification:["Verify the selected corrective change"]});
 const alternate=newPlan(CCM_EXAMPLE,CCM_EXAMPLE.reviewItems![0].description,a,"different","now");assert.equal(alternate.control,"SI-2");assert.equal(alternate.tests.length,1);assert.throws(()=>illustrativeProgress(alternate));
 assert.throws(()=>newPlan(CCM_EXAMPLE,CCM_EXAMPLE.reviewItems![0].description,{...a,scope:{...a.scope!,artifacts:["invented.json"]}},"id","now"),/does not belong/);
});
test("restoring drafts cannot drop a required test, replace a source link or accept malformed assessments",()=>{
 const p=identityPlan();assert.ok(restorePlan(p,CCM_EXAMPLE));assert.equal(restorePlan({...p,tests:p.tests.slice(1)},CCM_EXAMPLE),null);
 assert.equal(restorePlan({...p,source:{...p.source,artifacts:[{name:"configuration.json",href:"https://example.org/fake"}]}},CCM_EXAMPLE),null);
 assert.equal(restoreAssessment({disposition:"confirmed",scope:{}}),null);
 assert.equal(restoreAssessment({...emptyAssessment(),disposition:"invalid"}),null);
});
test("engineering retest import is source-bound, complete and invalidates decisions without granting validation",()=>{
 const before=identityPlan();before.engineeringComplete=true;before.validationRecorded=true;before.readyForReview=true;before.closure.recorded=true;
 const imported=applyRetestPacket(before,packet());assert.ok(imported.tests.every(t=>!t.illustrative && t.evidence));assert.equal(imported.engineeringComplete,false);assert.equal(imported.validationRecorded,false);assert.equal(imported.readyForReview,false);assert.equal(imported.closure.recorded,false);assert.equal(imported.assessment.illustrative,true);
 assert.deepEqual(engineeringProblems(imported),[]);assert.match(imported.history.at(-1)!.action,/signatures are not verified/);
 assert.throws(()=>applyRetestPacket(before,{...packet(),sourceCommit:"other"}),/original release/);
 assert.throws(()=>applyRetestPacket(before,{...packet(),tests:packet().tests.slice(1)}),/every scoped/);
 assert.throws(()=>applyRetestPacket(before,{...packet(),tests:packet().tests.map(t=>({...t,description:"wrong test"}))}),/mismatched/);
 assert.throws(()=>applyRetestPacket(before,{...packet(),remediation:{...packet().remediation,commit:CCM_EXAMPLE.commitSha}}),/distinct/);
});

test("curated recorded correction binds to the original release and retains automated-test disclosure",()=>{
 const v=JSON.parse(readFileSync(new URL("../public/samples/remediation/podinfo-identity-retest.json",import.meta.url),"utf8"));
 const p=applyRetestPacket(identityPlan(),v);assert.equal(p.releaseReviewMode,"vendor-test");assert.equal(p.releaseIllustrative,false);assert.equal(p.assessment.illustrative,true);assert.equal(p.validationRecorded,false);assert.ok(p.tests.every(t=>!t.illustrative));assert.match(p.tests[1].evidence,/16910084348.*identity-verification.json/);
 assert.ok(restorePlan(p,CCM_EXAMPLE));
});
