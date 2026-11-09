import assert from "node:assert/strict";
import { test } from "node:test";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { illustrativeScopedAssessment, newPlan } from "../lib/aegis/remediation";
import { buildPlanOfAction, validatePlanOfAction } from "../lib/aegis/poam";
import { buildAssessmentResults, validateAssessmentResults } from "../lib/aegis/assessment-results";
import { planOfActionFacts } from "../lib/aegis/poam-facts";

function draft() {
  const item = CCM_EXAMPLE.reviewItems![0];
  return newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope!), "DRAFT-integrity", "2026-10-03T12:00:00Z");
}
function exportsOf(plan: ReturnType<typeof draft>) {
  const poam = buildPlanOfAction(plan);
  const ar = buildAssessmentResults(plan);
  assert.equal(validatePlanOfAction(poam).ok, true);
  assert.equal(validateAssessmentResults(ar).ok, true);
  // OSCAL builders intentionally expose generic document objects.
  return [poam["plan-of-action-and-milestones"], (ar["assessment-results"] as any).results[0]] as any[];
}

test("UIDs, tickets, commits and free-text pipeline numbers never manufacture release links", () => {
  const plan = draft();
  for (const action of ["Set runAsUser and runAsGroup to 100001 and retest.", "Corrective release 2908682168", "Resolve SEC-123456", "Commit 123456789012"]) {
    plan.action = action;
    assert.deepEqual(planOfActionFacts(plan).correctiveRelease, {identity:"",href:null});
    for (const body of exportsOf(plan)) {
      assert.equal(JSON.stringify(body.risks[0].remediations).includes('"corrective-release"'), false);
      assert.equal(JSON.stringify(body.risks[0].remediations).includes('/pipelines/100001'), false);
    }
  }
  plan.releaseRef = "SEC-123456";
  assert.deepEqual(planOfActionFacts(plan).correctiveRelease, {identity:"SEC-123456",href:null});
  plan.releaseUrl = "https://gitlab.com/another/team/project/-/pipelines/2908682168";
  assert.deepEqual(planOfActionFacts(plan).correctiveRelease, {identity:"2908682168",href:plan.releaseUrl});
  for (const body of exportsOf(plan)) {
    const correction = body.risks[0].remediations[0];
    assert.equal(correction.props.find((p:any)=>p.name==="corrective-release").value, "2908682168");
    assert.equal(correction.links[0].href, plan.releaseUrl);
  }
  plan.releaseUrl = plan.source.pipelineUrl;
  assert.equal(planOfActionFacts(plan).correctiveRelease.href, null);
});

test("planned or reference-only checks remain requirements, not performed-test evidence", () => {
  const plan = draft();
  for (const evidence of ["", plan.source.artifacts[0].href]) {
    plan.tests[0].evidence = evidence;
    for (const body of exportsOf(plan)) {
      assert.equal(Object.hasOwn(body.observations[0], "relevant-evidence"), false);
      assert.equal(body.observations[0].methods.includes("TEST"), false);
      assert.equal(body.risks[0].remediations[0].props.filter((p:any)=>p.name==="required-verification").length, plan.tests.length);
    }
  }
  plan.tests[0].result = "Rescan completed: KSV-0020 and KSV-0021 absent.";
  plan.tests[0].date = "2026-10-03";
  plan.tests[0].reviewer = "Recorded test operator";
  plan.tests[0].artifactSha256 = "c".repeat(64);
  plan.tests[0].verdict = "pass";
  for (const body of exportsOf(plan)) {
    assert.equal(body.observations[0].methods.includes("TEST"), true);
    assert.equal(body.observations[0]["relevant-evidence"].length, 1);
    assert.equal(body.observations[0]["relevant-evidence"][0].href, plan.tests[0].evidence);
  }
  for (const missing of ["reviewer","date"] as const) {
    const incomplete = structuredClone(plan);
    incomplete.tests[0][missing] = "";
    for (const body of exportsOf(incomplete)) assert.equal(Object.hasOwn(body.observations[0],"relevant-evidence"),false);
  }
  plan.tests[0].evidence = "";
  for (const body of exportsOf(plan)) {
    assert.equal(body.observations[0]["relevant-evidence"].length, 1);
    assert.match(body.observations[0]["relevant-evidence"][0].remarks, /no resolvable evidence link/);
  }
});

test("internal POAM system binding is stable per scoped workload, not a draft or agency ID", () => {
  const plan = draft();
  const doc = buildPlanOfAction(plan);
  const body = doc["plan-of-action-and-milestones"] as any;
  const system = body["system-id"];
  assert.equal(system["identifier-type"], "urn:aegis:system-id:internal");
  const revised = structuredClone(plan);
  revised.id = "DRAFT-another";
  revised.source.pipelineId = "3000000000";
  revised.source.pipelineUrl = revised.source.pipelineUrl.replace("2894050908","3000000000");
  revised.asset = "Edited display description";
  assert.deepEqual((buildPlanOfAction(revised)["plan-of-action-and-milestones"] as any)["system-id"], system);
  revised.assessment.scope!.asset = "Different scoped workload";
  assert.notEqual((buildPlanOfAction(revised)["plan-of-action-and-milestones"] as any)["system-id"].id, system.id);
  revised.assessment.scope!.asset = plan.assessment.scope!.asset;
  revised.source.pipelineUrl = revised.source.pipelineUrl.replace("podinfo-gsa-evidence-0928","another-project");
  assert.notEqual((buildPlanOfAction(revised)["plan-of-action-and-milestones"] as any)["system-id"].id, system.id);
  delete body["system-id"];
  assert.equal(validatePlanOfAction(doc).ok, false);
  body["import-ssp"] = {href:"https://example.com/internal-ssp.json"};
  assert.equal(validatePlanOfAction(doc).ok, true);
});
