import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBinderDocuments, validateBinderDocuments } from "../lib/aegis/baseline-binder";
import { evidenceForRelease, rollupControlResults } from "../lib/aegis/control-rollup";
import { resolveContextDocument } from "../lib/aegis/assessment-context";
import { validateAssessmentResults } from "../lib/aegis/assessment-results";
import { CCM_EXAMPLE, type PipelineEvidence } from "../lib/aegis/pipeline-evidence";
import { applyReceivedVerification, illustrativeScopedAssessment, newPlan } from "../lib/aegis/remediation";
import { receivedRetest } from "./support/received-retest";

const now = new Date("2026-10-04T12:00:00Z");
function draft(original = CCM_EXAMPLE) {
  const item = original.reviewItems![0];
  return newPlan(original,item.description,illustrativeScopedAssessment(item.scope!),"DRAFT-integrity",now.toISOString());
}
function body(doc: ReturnType<typeof buildBinderDocuments>) { return (doc.assessmentResults as any)["assessment-results"].results[0]; }
function decoded(doc: ReturnType<typeof buildBinderDocuments>) {
  const ar = doc.assessmentResults["assessment-results"] as any;
  const ap = resolveContextDocument(ar,ar["import-ap"].href,"assessment-plan");
  const ssp = resolveContextDocument(ap["assessment-plan"],ap["assessment-plan"]["import-ssp"].href,"system-security-plan");
  return { ap:ap["assessment-plan"], ssp:ssp["system-security-plan"] };
}
test("the shipped Podinfo receipt is included and a received copy of the same release replaces it",()=>{
  const original = mergeStoredReleases();
  assert.equal(original.some(r=>r.pipelineId==="2894050908"),true);
  assert.equal(original.some(r=>r.pipelineId==="2908682168"),true);
  const received = receivedRetest();
  assert.equal(mergeStoredReleases([received])[1].findingCount, received.findingCount);
  assert.equal(mergeStoredReleases([received])[1].reviewItems![0].id, "configuration-KSV-0125");
  const row = rollupControlResults(mergeStoredReleases([{...received, reviewItems: []}])).find(r=>r.id==="CM-6")!;
  assert.equal(row.result!.checks.length,3);
  assert.equal(received.checks.length,8);
  assert.equal(received.artifacts!.length,29);
  assert.equal(row.result!.checks[1].artifactSha256,received.verification!.tests[1].artifactSha256);
  assert.match(row.result!.checks[1].href,/16910084348.*identity-verification.json/);
  const receivedOriginal={...structuredClone(CCM_EXAMPLE),source:"Inbound pipeline event" as const,findingCount:999};
  assert.equal(mergeStoredReleases([receivedOriginal])[0],receivedOriginal);
});
test("new names without evidence leave prior evidence intact and baseline gaps blank",()=>{
  const newer:PipelineEvidence = {...structuredClone(CCM_EXAMPLE),pipelineId:"999",pipelineUrl:CCM_EXAMPLE.pipelineUrl.replace(/\d+$/,"999"),createdAt:now.toISOString(),families:[{family:"CM",controls:["CM-6","CM-1"],coverage:"Named only",evidence:[]}],reviewItems:[],artifacts:[],checks:[]};
  assert.equal(evidenceForRelease(newer).size,0);
  const rows = rollupControlResults([CCM_EXAMPLE,newer]);
  assert.equal(rows.find(r=>r.id==="CM-6")!.result!.releaseId,CCM_EXAMPLE.pipelineId);
  assert.equal(rows.find(r=>r.id==="CM-1")!.result,null);
  newer.families[0].evidence=["missing.json"];
  assert.equal(evidenceForRelease(newer).size,0);
});
test("project scope prevents numeric CI ID collisions and cross-project evidence",()=>{
  const other={...structuredClone(CCM_EXAMPLE),pipelineUrl:"https://gitlab.com/other/project/-/pipelines/2894050908",createdAt:now.toISOString(),families:[{family:"AC",controls:["AC-1"],coverage:"Other system",evidence:["configuration.json"]}],reviewItems:[]};
  assert.equal(mergeStoredReleases([other]).includes(other),false);
  assert.equal(mergeStoredReleases([other],other.pipelineUrl)[0],other);
  assert.equal(rollupControlResults([CCM_EXAMPLE,other]).find(r=>r.id==="AC-1")!.result,null);
  const doc=buildBinderDocuments([other],null,now);
  assert.deepEqual(validateAssessmentResults(doc.assessmentResults),{ok:true});
  assert.doesNotMatch(JSON.stringify(doc),/podinfo-gsa-evidence|2894050908.*podinfo/);
});
test("bad source hash, test scope, or inventory cannot establish a retest result",()=>{
  for (const mutate of [
    (r:PipelineEvidence)=>{r.verification!.sourceReleaseSha256="ff".repeat(32);},
    (r:PipelineEvidence)=>{r.verification!.tests.pop();},
    (r:PipelineEvidence)=>{r.artifacts=r.artifacts!.filter(a=>a!=="identity-verification.json");},
    (r:PipelineEvidence)=>{r.source="CCM release summary";},
  ]) {
    const r=receivedRetest(); mutate(r);
    assert.equal(evidenceForRelease(r,[CCM_EXAMPLE]).size,0);
  }
});
test("shared subject resolves, native implementation is not invented, and hashes survive all exports",()=>{
  const doc=buildBinderDocuments(mergeStoredReleases([receivedRetest()]),draft(),now);
  assert.deepEqual(validateBinderDocuments(doc),[]);
  const {ap,ssp}=decoded(doc);
  assert.equal(ap["assessment-subjects"][0]["include-subjects"][0]["subject-uuid"],ssp["system-implementation"].components[0].uuid);
  assert.equal(ssp["control-implementation"]["implemented-requirements"].some((r:any)=>r.statements),false);
  for (const model of [doc.assessmentResults,doc.poam]) {
    const encoded=JSON.stringify(model);
    for (const t of receivedRetest().verification!.tests) assert.ok(encoded.includes(t.artifactSha256));
  }
  const result=body(doc);
  const observation=result.observations.find((o:any)=>o.props.some((p:any)=>p.name==="control-id"&&p.value==="CM-6"));
  assert.ok(observation.props.some((p:any)=>p.name==="assessment-reviewer"));
  assert.equal(result.risks[0].status,"open");
});
test("each reviewed control has its own objective; unassessed observations do not create POAM items",()=>{
  const original=structuredClone(CCM_EXAMPLE);
  const second={...structuredClone(original.reviewItems![0]),id:"second",description:"Other review question",scope:{...original.reviewItems![0].scope!,title:"Other scope",controls:["SC-7"]}};
  original.reviewItems!.push(second);
  const doc=buildBinderDocuments([original],draft(original),now);
  assert.deepEqual(validateBinderDocuments(doc),[]);
  const result=body(doc);
  assert.equal(result.findings.length,1);
  const objectives=decoded(doc).ap["local-definitions"]["objectives-and-methods"];
  assert.equal(new Set(objectives.map((o:any)=>o.parts[0].id)).size,objectives.length);
  assert.equal((doc.poam as any)["plan-of-action-and-milestones"]["poam-items"].length,1);
  const noDecision=buildBinderDocuments([original],null,now);
  assert.equal((noDecision.poam as any)["plan-of-action-and-milestones"]["poam-items"],undefined);
});
test("positive scoped decision does not transfer to a newer or failing retest",()=>{
  const retest=receivedRetest();
  const plan=applyReceivedVerification(draft(),CCM_EXAMPLE,retest);
  Object.assign(plan,{engineeringComplete:true,validation:"demonstrated",validationRecorded:true,validator:"Named ISSE",validationDate:"2026-10-04",validationNote:"Examined and tested scoped criterion"});
  const approved=buildBinderDocuments(mergeStoredReleases([retest]),plan,now);
  assert.equal(body(approved).findings[0].target.status.state,"satisfied");
  const changed=receivedRetest();
  changed.pipelineId="999"; changed.pipelineUrl=changed.pipelineUrl.replace(/\d+$/,"999"); changed.commitSha="ff".repeat(20); changed.createdAt=now.toISOString(); changed.releaseSha256="bb".repeat(32);
  changed.verification!.tests[0].verdict="fail";
  const stale=buildBinderDocuments(mergeStoredReleases([retest,changed]),plan,now);
  assert.equal(body(stale).findings[0].target.status.state,"not-satisfied");
  assert.equal(body(stale).risks[0].status,"open");
  assert.deepEqual(validateBinderDocuments(stale),[]);
  const different=draft(); different.asset="Different asset";
  const foreign=buildBinderDocuments(mergeStoredReleases([retest]),different,now);
  assert.equal(body(foreign).findings,undefined);
  assert.equal((foreign.poam as any)["plan-of-action-and-milestones"]["poam-items"],undefined);
});
test("blank baseline context is valid and no POAM item is invented without a confirmed draft",()=>{
  const doc=buildBinderDocuments([],null,now);
  assert.equal(doc.rows.length,323);
  assert.equal(doc.rows.some(r=>r.result),false);
  assert.deepEqual(validateAssessmentResults(doc.assessmentResults),{ok:true});
  assert.equal((doc.poam as any)["plan-of-action-and-milestones"]["poam-items"],undefined);
  assert.equal(body(doc).observations,undefined);
});
test("validator catches dangling component and implementation statement references",()=>{
  const doc=buildBinderDocuments([CCM_EXAMPLE],draft(),now);
  const ar=doc.assessmentResults as any;
  const ap=decoded(doc).ap;
  ap["assessment-subjects"][0]["include-subjects"][0]["subject-uuid"]="00000000-0000-4000-8000-000000000000";
  ar["assessment-results"]["back-matter"].resources[0].base64.value=Buffer.from(JSON.stringify({"assessment-plan":ap})).toString("base64");
  const verdict=validateAssessmentResults(ar);
  assert.equal(verdict.ok,false);
  if(!verdict.ok) assert.match(verdict.errors.join(" "),/subject must resolve/);
});

test("manually authored assessment scope works for another project without a Podinfo template",()=>{
  const original:PipelineEvidence={...structuredClone(CCM_EXAMPLE),pipelineId:"111",pipelineUrl:"https://gitlab.com/vendor/other-app/-/pipelines/111",reviewItems:[],gaps:["Review application audit events"]};
  const scope={...structuredClone(CCM_EXAMPLE.reviewItems![0].scope!),title:"Application event logging",asset:"Other application",controls:["AU-12"],artifacts:["runtime.json"],verification:["Verify recorded application audit events"]};
  const plan=newPlan(original,original.gaps[0],illustrativeScopedAssessment(scope),"DRAFT-other",now.toISOString());
  const doc=buildBinderDocuments([original],plan,now);
  assert.deepEqual(validateBinderDocuments(doc),[]);
  assert.equal(body(doc).findings[0].target.status.state,"not-satisfied");
  assert.match(JSON.stringify(doc),/other-app/);
  assert.doesNotMatch(JSON.stringify(doc),/podinfo-gsa-evidence/);
  assert.equal((doc.poam as any)["plan-of-action-and-milestones"]["poam-items"].length,1);
});

test("two confirmed mapped controls retain distinct objective targets",()=>{
  const original=structuredClone(CCM_EXAMPLE);
  original.reviewItems![0].scope.controls=["CM-6","SC-7"];
  const doc=buildBinderDocuments([original],draft(original),now);
  assert.deepEqual(validateBinderDocuments(doc),[]);
  const findings=body(doc).findings;
  assert.equal(findings.length,2);
  assert.equal(new Set(findings.map((f:any)=>f.target["target-id"])).size,2);
});

test("the captured retest reopens a legacy closure in the UI and export until its decisions bind to that receipt", async () => {
  const { resolveDraftDecisions } = await import("../lib/aegis/remediation-rollup");
  const legacy = draft();
  Object.assign(legacy, { engineeringComplete: true, validationRecorded: true, readyForReview: true });
  legacy.closure.recorded = true;
  const releases = mergeStoredReleases();
  const reviewed = resolveDraftDecisions(legacy, releases);
  assert.equal(reviewed.closure.recorded, false);
  assert.equal(reviewed.validationRecorded, false);
  assert.equal(legacy.closure.recorded, true);
  assert.equal((buildBinderDocuments(releases, legacy, now).poam as any)["plan-of-action-and-milestones"].risks[0].status, "open");
  const bound = applyReceivedVerification(legacy, CCM_EXAMPLE, receivedRetest());
  bound.closure.recorded = true;
  assert.equal(resolveDraftDecisions(bound, releases).closure.recorded, true);
});
