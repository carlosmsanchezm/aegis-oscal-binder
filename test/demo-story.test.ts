import {referenceProposals as proposePlans} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {CCM_EXAMPLE, controlsForArtifact, pipelineArtifactNames} from "../lib/aegis/pipeline-evidence";
import {binderSummary} from "../lib/aegis/binder-summary";
import {moderateControls} from "../lib/aegis/moderate-baseline";
import {proposeArtifactMappings, mappingDecision, restoreMappingDecision, applyAcceptedArtifactMappings} from "../lib/aegis/artifact-mapping";
import {applyDecision, decisionFromProposal, importProposalDecisions, plainPlan} from "../lib/aegis/plan-proposal";
import {buildBinderDocuments, validateBinderDocuments} from "../lib/aegis/baseline-binder";
import {rankEffortNext} from "../lib/aegis/effort-ranking";
import {rollupControlResults, type ControlRollupRow} from "../lib/aegis/control-rollup";
import {RollupMap} from "../components/binder/RollupMap";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {connectedReleases} from "../lib/aegis/connected-evidence";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {verifyBundle} from "../lib/server/builder-store";
import before from "../lib/reference/online-boutique-before.json";
import after from "../lib/reference/online-boutique-after.json";
const ids=moderateControls().map(c=>c.id);
const at="2026-10-08T22:00:00.000Z";
const connectionId="11111111-1111-4111-8111-111111111111";
function boutique() {return connectedReleases({id: connectionId, name:"Renamed system", createdAt:at, revokedAt:null, history:[before,after].map(c=>summarizeBuilderBundle(verifyBundle({schema:"aegis.evidence-bundle.v1",...c,connectionId,receivedAt:at,event:parseEvidenceEvent(JSON.parse(c.rawEvent)),integrity:"verified",authentication:"browser-owner"})))},"http://localhost",Date.parse(at));}

test("both evidence inventories propose across relevant catalog families and list every pipeline check",()=>{
 const rows=binderSummary(CCM_EXAMPLE,ids);
 assert.equal(rows.length,pipelineArtifactNames(CCM_EXAMPLE).length);
 assert.equal(rows.flatMap(r=>r.checks).length,8);
 for(const check of CCM_EXAMPLE.checks) {const row=rows.find(r=>r.name===check.artifact)!; assert.ok(row.linked.length || row.proposed.length);assert.ok(row.proposed.every(id=>!row.linked.includes(id)), "producer-declared links must not be relabeled as pending proposals");assert.equal(row.capturedAt,CCM_EXAMPLE.createdAt);}
 const next=binderSummary(boutique()[1],ids);
 assert.ok(new Set(next.flatMap(r=>r.proposed.map(id=>id.split("-")[0]))).size>1);
 assert.ok(next.some(row=>row.type==="RBAC"));
});

test("the default map hides every untouched control and family for either evidence shape",()=>{
 for(const history of [[CCM_EXAMPLE],boutique()]) {
  const pkg=applyReleaseRollup(moderateRollupShell(process.cwd()),history);
  const html=renderToStaticMarkup(React.createElement(RollupMap,{pkg,history,record:history.at(-1)!,onRecordChange:()=>{},packageControlIds:[]}));
  const controls=[...html.matchAll(/data-control-id="([^"]+)"/g)].map(m=>m[1]);
  assert.ok(controls.length>0);
  assert.ok(controls.every(id=>pkg.controls.find(c=>c.id===id)?.rollupState==="recorded" || Boolean(pkg.controls.find(c=>c.id===id)?.proposedEvidence?.length)));
  for(const family of pkg.map.families.filter(f=>!pkg.controls.some(c=>c.family===f.id&&(c.rollupState==="recorded" || Boolean(c.proposedEvidence?.length))))) assert.ok(!html.includes(`data-family-box="${family.id}"`));
  assert.match(html,/Show untouched controls/);
  const expanded=renderToStaticMarkup(React.createElement(RollupMap,{pkg,history,record:history.at(-1)!,onRecordChange:()=>{},packageControlIds:[],allFamilies:true}));
  assert.ok([...expanded.matchAll(/data-family-box="([^"]+)"/g)].length>[...html.matchAll(/data-family-box="([^"]+)"/g)].length);
 }
});

test("a person accepts precisely one new control mapping with reviewer and time, with immutable source",()=>{
 const proposal=proposeArtifactMappings(CCM_EXAMPLE,ids).find(p=>p.artifact==="sbom.cdx.json")!;
 const newControl=proposal.candidates.find(c=>!CCM_EXAMPLE.families.some(f=>f.controls.includes(c.controlId)))!.controlId;
 const decision=mappingDecision(CCM_EXAMPLE,proposal,"accepted",at,[newControl],"Demo reviewer");
 assert.equal(restoreMappingDecision(decision,CCM_EXAMPLE,ids)?.reviewer,"Demo reviewer");
 const mapped=applyAcceptedArtifactMappings(CCM_EXAMPLE,[decision]);
 const linked=(record: typeof CCM_EXAMPLE)=>new Set(record.families.flatMap(f=>f.controls)).size;
 assert.equal(linked(mapped as typeof CCM_EXAMPLE),linked(CCM_EXAMPLE)+1);
 assert.equal(controlsForArtifact(mapped,proposal.artifact).length,controlsForArtifact(CCM_EXAMPLE,proposal.artifact).length+1);
 assert.equal(decision.decidedAt,at);
 assert.equal(restoreMappingDecision({...decision,controls:["NON-CATALOG"]},CCM_EXAMPLE,ids),null);
});

test("each scoped failed check has one draft and expired passing measurements cannot close",()=>{
 const history=boutique(), drafts=proposePlans(history);
 for(const records of [[CCM_EXAMPLE],history]) {
  const plans=proposePlans(records);
  for(const release of records) for(const item of release.reviewItems??[]) for(const controlId of item.scope.controls.filter(id=>ids.includes(id))) assert.equal(plans.filter(p=>p.sourceReleaseId===release.pipelineId&&p.finding===item.description&&p.controlId===controlId).length,1);
 }
 const expired=drafts[0];
 assert.equal(expired.readyToClose,false);
 const forged=applyDecision(expired,decisionFromProposal(expired,{acceptance:"accepted",closureConfirmed:true,closure:{name:"Reviewer",reason:"Test reason",at}}));
 assert.equal(forged.closureConfirmed,false);
 assert.notEqual(plainPlan(forged).status,"Closure proposed");
 const fresh=proposePlans([CCM_EXAMPLE]).find(p=>p.readyToClose)!;
 assert.equal(plainPlan(fresh).status,"Closure proposed");
 assert.equal(applyDecision(fresh,decisionFromProposal(fresh,{closureConfirmed:true})).closureConfirmed,false);
});

test("closed plain fields round trip through schema-valid OSCAL without losing multiline prose or completion",()=>{
 const original=proposePlans([CCM_EXAMPLE]).find(p=>p.readyToClose)!;
 const decision=decisionFromProposal(original,{acceptance:"accepted",riskStatement:"Reviewed risk.\nSecond paragraph.",action:"Fix and verify.\nKeep the evidence.",owner:"Test owner",milestone:{description:"Every measured check passes",target:"2026-10-20"},closureConfirmed:true,closure:{name:"Test closer",reason:"All checks reviewed",at}});
 const closed=applyDecision(original,decision);
 assert.equal(plainPlan(closed).status,"Closed");
 const documents=buildBinderDocuments([CCM_EXAMPLE],null,new Date(at),[closed]);
 assert.deepEqual(validateBinderDocuments(documents),[]);
 const body=documents.poam["plan-of-action-and-milestones"] as any;
 assert.equal(body.risks[0].status,"closed");
 assert.ok(body["poam-items"][0].props.some((p:any)=>p.name==="completion-date"&&p.value===at));
 const [restored]=importProposalDecisions(JSON.parse(JSON.stringify(documents.poam)));
 assert.deepEqual(restored.plain,plainPlan(closed));
 assert.deepEqual(restored.closure,decision.closure);
 assert.deepEqual(plainPlan(applyDecision(original,restored)),plainPlan(closed));
});

test("ranking sorts risk before cheapest existing evidence and is stable under input permutation",()=>{
 const rows=rollupControlResults([CCM_EXAMPLE]);
 const source={rows,relationships:[],postureLabel:"Selected catalog",riskRatings:{"AC-1":4,"CM-6":2}};
 const first=rankEffortNext(source), reversed=rankEffortNext({...source,rows:[...rows].reverse()});
 assert.equal(first[0].controlId,"AC-1");
 assert.deepEqual(first,reversed);
 const high=first.filter(r=>r.risk===0);
 assert.ok(high[0].score>=high.at(-1)!.score);
 assert.ok(first.every(row=>row.costReason.trim()));
});


test("an agent may edit plain JSON prose but cannot self-approve closure",()=>{
 const draft=proposePlans([CCM_EXAMPLE]).find(p=>p.readyToClose)!;
 const proposed=decisionFromProposal(draft);
 proposed.plain={...proposed.plain!,whyItMatters:"Agent-written rationale",whatWeWillDo:"Agent-written action",whoOwnsIt:"Proposed owner",doneWhen:"Measured outcome",dueBy:"2026-10-20",status:"Closed"};
 const restored=importProposalDecisions({"plan-of-action-and-milestones":{"poam-items":[{props:[{name:"plain-plan-record",ns:"urn:aegis:remediation:v1",remarks:JSON.stringify(proposed)}]}]}})[0];
 assert.equal(restored.riskStatement,"Agent-written rationale");assert.equal(restored.action,"Agent-written action");assert.equal(restored.owner,"Proposed owner");
 assert.equal(applyDecision(draft,restored).closureConfirmed,false);
});

test("collapsed detail UUIDs agree with the OSCAL exporter",async()=>{
 const {planIdentifiers}=await import("../lib/aegis/plan-identifiers");
 const draft=proposePlans([CCM_EXAMPLE])[0], accepted=applyDecision(draft,decisionFromProposal(draft,{acceptance:"accepted"}));
 const ids=await planIdentifiers(accepted), body=buildBinderDocuments([CCM_EXAMPLE],null,new Date(at),[accepted]).poam["plan-of-action-and-milestones"] as any;
 assert.equal(body.risks[0].uuid,ids.risk);
 assert.equal(body["poam-items"][0]["related-observations"][0]["observation-uuid"],ids.observation);
});


test("expired or unknown measurements never rank as cheap passing retests",()=>{
 const rows=rollupControlResults([CCM_EXAMPLE]);
 const row=rows.find(row=>row.result?.finding)!;
 const fresh={...row,result:{...row.result!,checks:[{description:"Measured correction",result:"Passed",date:"2026-10-08",reviewer:"Recorded producer",href:"https://example.com/retest",verdict:"pass" as const,evidenceState:"pass" as const}]}};
 const stale={...fresh,result:{...fresh.result,checks:fresh.result.checks.map(check=>({...check,evidenceState:"stale" as const}))}};
 const unknown={...fresh,result:{...fresh.result,checks:fresh.result.checks.map(check=>({...check,verdict:undefined}))}};
 const rank=(row:ControlRollupRow)=>rankEffortNext({rows:[row],relationships:[],postureLabel:"Selected catalog"})[0];
 assert.ok(rank(fresh).score>rank(stale).score);
 assert.ok(rank(fresh).score>rank(unknown).score);
 assert.match(rank(stale).costReason,/expired/);
});


test("results-first projection preserves authored layers and removes bundles to hidden families",async()=>{
 const {resultsMapPackage}=await import("../lib/aegis/results-map");
 const {getPackageState,emptyPersisted,loadFixture}=await import("../lib/aegis");
 const ctx={root:process.cwd(),now:()=>new Date(at)};
 const subset=getPackageState(loadFixture(emptyPersisted(),"gold",ctx),ctx);
 const pkg=applyReleaseRollup(moderateRollupShell(process.cwd()),[CCM_EXAMPLE]);
 const projected=resultsMapPackage(pkg,subset,true,false);
 assert.ok(projected.map.families.length<pkg.map.families.length);
 for(const bundle of projected.map.bundles) for(const id of [bundle.left,bundle.right]) assert.ok(projected.map.families.some(f=>f.id===id));
 for(const control of projected.controls) {
  const authored=subset.controls.find(c=>c.id===control.id);
  if(authored) {assert.deepEqual(control.evidence,authored.evidence);assert.deepEqual(control.responsibleRoleIds,authored.responsibleRoleIds);}
  else {assert.deepEqual(control.evidence,[]);assert.equal(control.validEvidenceCount,0);}
 }
 const restored=resultsMapPackage(pkg,subset,false,false);
 assert.deepEqual(restored.controls,projected.controls);
 assert.deepEqual(restored.map.families,projected.map.families);
 const html=renderToStaticMarkup(React.createElement(RollupMap,{pkg,basePkg:subset,history:[CCM_EXAMPLE],record:CCM_EXAMPLE,onRecordChange:()=>{},packageControlIds:subset.controls.map(c=>c.id)}));
 assert.doesNotMatch(html,/<button[^>]*disabled=""[^>]*>SSP evidence/);
});
