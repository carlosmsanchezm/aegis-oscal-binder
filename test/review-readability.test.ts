import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import test from "node:test";
import {AssessmentDrawer} from "../components/binder/RemediationWorkspace";
import {PlanOfActionView} from "../components/binder/PlanOfAction";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {illustrativeScopedAssessment,newPlan,latestReviewPlan} from "../lib/aegis/remediation";

const item=CCM_EXAMPLE.reviewItems![0];
const assessment=illustrativeScopedAssessment(item.scope);
const renderAssessment=(onOpenSavedDraft?:()=>void)=>renderToStaticMarkup(createElement(AssessmentDrawer,{record:CCM_EXAMPLE,reviewItem:item.description,initial:assessment,onClose:()=>{},onSave:()=>{},onPrepare:()=>{},onOpenSavedDraft}));

test("reopening selects the latest matching saved draft without mutating records or crossing releases",()=>{
  const old=newPlan(CCM_EXAMPLE,item.description,assessment,"older","2026-10-02T08:00:00Z");
  const prepared=newPlan(CCM_EXAMPLE,item.description,assessment,"prepared","2026-10-03T08:00:00Z");
  prepared.history.push({at:"2026-10-05T08:00:00Z",action:"Saved engineering progress"});
  const other=structuredClone(prepared);other.id="wrong-release";other.source.releaseSha256="different";
  const list=[old,prepared,other],before=JSON.stringify(list);
  assert.equal(latestReviewPlan(list,CCM_EXAMPLE,item.description)?.id,"prepared");
  assert.equal(latestReviewPlan(list,CCM_EXAMPLE,"another item"),undefined);
  assert.equal(JSON.stringify(list),before);
});

test("assessment offers a direct saved-draft route without disguising draft generation",()=>{
  assert.match(renderAssessment(),/Prepare draft POA&amp;M/);
  const saved=renderAssessment(()=>{});
  assert.match(saved,/Open saved POA&amp;M/);
  assert.doesNotMatch(saved,/Prepare draft POA&amp;M/);
  assert.match(saved,/Unsaved assessment edits are not applied/);
  assert.match(saved,/<summary>Record context<\/summary>/);
  assert.doesNotMatch(saved,/Network enforcement · outside scope/);
});

test("concise report removes presentation badges without changing exported provenance",()=>{
  const plan=newPlan(CCM_EXAMPLE,item.description,assessment,"DRAFT-readability","2026-10-05T08:00:00Z");
  const before=JSON.stringify(plan);
  const html=renderToStaticMarkup(createElement(PlanOfActionView,{plan,onClose:()=>{},onSave:()=>{}}));
  assert.doesNotMatch(html,/<small class="rem-example">Illustrative<\/small>/);
  assert.doesNotMatch(html,/Outside this item:/);
  assert.match(html,/Open/);
  assert.equal(JSON.stringify(plan),before);
  assert.equal(plan.assessment.illustrative,true);
});
