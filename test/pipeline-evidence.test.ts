import {CCM_EXAMPLE} from "./support/collected-example";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineEvidenceView } from "../components/binder/PipelineEvidenceView";
import { ControlFocus } from "../components/binder/ControlFocus";
import { findRepoRoot, getPackageState, ingestOscalPackage } from "../lib/aegis";
import { sa1Document } from "../lib/aegis/sa1-demo";
import { statementCoverage } from "../lib/aegis/map-view";
import {  controlsForArtifact, summaryForSession, gitlabArtifactUrl, parseCcmSummary, pipelineMappingForControl, pipelineArtifactNames } from "../lib/aegis/pipeline-evidence";

function sourceSummary() {
  return {
    data: {
      schema: "ccm.application-evidence.v1",
      subject: { pipelineId: CCM_EXAMPLE.pipelineId, pipelineUrl: CCM_EXAMPLE.pipelineUrl, commitSha: CCM_EXAMPLE.commitSha, image: CCM_EXAMPLE.image, createdAt: CCM_EXAMPLE.createdAt },
      releaseSha256: CCM_EXAMPLE.releaseSha256, policyVerdict: "pass", signatureStatus: "verified", signatureScope: CCM_EXAMPLE.signatureScope,
      deploymentVerdict: "observed", approval: { ...CCM_EXAMPLE.approval },
      runtime: { checkedAt: CCM_EXAMPLE.runtime.checkedAt, functionalProbe: "pass", mTLS: CCM_EXAMPLE.runtime.mTLS, observations: [{ ready: true, meshSidecarPresent: false }, { ready: true, meshSidecarPresent: false }] },
      checks: CCM_EXAMPLE.checks, controlFamilies: CCM_EXAMPLE.families.map(({ family, controls, coverage, evidence }) => ({ family, controls, coverage, evidence })),
      findingCount: 33, evidenceGaps: CCM_EXAMPLE.gaps,
    },
    provenance: { pipelineId: CCM_EXAMPLE.pipelineId, jobId: CCM_EXAMPLE.artifactJobId },
  };
}

test("CCM summary maps to a read-only evidence view without losing findings or gaps", () => {
  const record = parseCcmSummary(sourceSummary());
  assert.equal(record.checks.length, 8);
  assert.equal(record.families.length, 8);
  assert.equal(record.findingCount, 33);
  assert.equal(record.gaps.length, 5);
  assert.equal(record.runtime.meshSidecarCount, 0);
  assert.equal(record.approval.releaseSha256, record.releaseSha256);
  assert.match(gitlabArtifactUrl(record, "sbom.cdx.json") ?? "", /\/artifacts\/file\/evidence\/sbom\.cdx\.json$/);
  assert.equal(gitlabArtifactUrl(record, "../secret"), null);
});

test("CCM adapter rejects mismatched provenance and unapproved artifact hosts", () => {
  const badApproval = sourceSummary();
  badApproval.data.approval.releaseSha256 = "wrong";
  assert.throws(() => parseCcmSummary(badApproval), /Approval does not match/);
  const badHost = sourceSummary();
  badHost.data.subject.pipelineUrl = "https://example.com/path/-/pipelines/1";
  assert.throws(() => parseCcmSummary(badHost), /GitLab pipeline URL/);
  const badProvenance = sourceSummary();
  badProvenance.provenance.pipelineId = "999";
  assert.throws(() => parseCcmSummary(badProvenance), /provenance do not match/);
});

test("pipeline example surfaces real source links and limitations without ATO claims", () => {
  const markup = renderToStaticMarkup(createElement(PipelineEvidenceView));
  assert.match(markup, /#2894050908/);
  assert.match(markup, /Issues in this release <span[^>]*>33<\/span>/);
  assert.match(markup, /Sidecars 0\/2/);
  assert.match(markup, /Evidence links show coverage only/);
  assert.match(markup, /No FedRAMP authorization or agency ATO/);
  assert.match(markup, /GitLab pipeline/);
  assert.match(markup, /Import CCM summary JSON/);
  assert.match(markup, /Pipeline policy findings/);
  assert.match(markup, /Release inspector/);
  assert.match(markup, /Open proposed plan CM-6/);
});

test("shared release context round trips and traces all configuration mappings", () => {
  const restored = parseCcmSummary(summaryForSession(CCM_EXAMPLE));
  assert.deepEqual(restored, CCM_EXAMPLE);
  assert.deepEqual(controlsForArtifact(restored, "configuration.json").sort(), ["AC-5", "AC-6", "CM-3", "CM-6", "SC-7", "SC-8"].sort());
  assert.deepEqual(controlsForArtifact(restored, "unknown.json"), []);
});

test("Level 2 distinguishes pipeline mapping from saved SSP evidence and exposes other families", () => {
  const ctx = { root: findRepoRoot(), now: () => new Date("2026-09-30T12:00:00Z") };
  const pkg = getPackageState(ingestOscalPackage({ text: sa1Document(), filename: "internal-planning-ssp.json", catalogId: "fedramp-rev5" }, ctx), ctx);
  const control = pkg.controls.find((item) => item.id === "AC-6");
  assert.ok(control);
  assert.deepEqual(statementCoverage(control, pkg.map.statements[control.id].items).map((item) => item.state), ["addressed"]);
  const sc7 = pkg.controls.find((item) => item.id === "SC-7")!;
  assert.deepEqual(statementCoverage(sc7, pkg.map.statements[sc7.id].items).map((item) => item.state), ["linked", "linked", "linked"]);
  assert.equal(pipelineMappingForControl(CCM_EXAMPLE, "AC-6")?.family, "AC");
  assert.equal(pipelineMappingForControl(CCM_EXAMPLE, "AU-2"), null);
  const markup = renderToStaticMarkup(createElement(ControlFocus, { pkg, control, pipelineEvidence: CCM_EXAMPLE, selectedItemId: null, onSelectItem() {}, onLeaveFocus() {}, onOpenMappedControl() {} }));
  assert.match(markup, /Pipeline context/);
  assert.match(markup, /approval\.json/);
  assert.match(markup, /Other mapped families \(7\)/);
  assert.match(markup, /separate from this SSP/);
  assert.match(markup, /EV-AC6-01/);
  assert.match(markup, /does not change completeness/);
});

test("complete artifact inventory preserves unmapped raw JSON files and safe source links", () => {
  assert.equal(CCM_EXAMPLE.artifacts!.length, 28);
  assert.equal(pipelineArtifactNames(CCM_EXAMPLE).length, 28 + CCM_EXAMPLE.collectedArtifacts!.length);
  assert.ok(pipelineArtifactNames(CCM_EXAMPLE).includes("summary.sigstore.json"));
  assert.deepEqual(controlsForArtifact(CCM_EXAMPLE, "configuration.raw.json"), []);
  assert.match(gitlabArtifactUrl(CCM_EXAMPLE, "security-patch.diff")!, /security-patch\.diff$/);
  const summary = sourceSummary();
  const extra = { ...summary, data:{ ...summary.data, artifacts:{ "new-check.json":"reported hash" }, runtimeArtifacts:{ "runtime.json":"reported hash" } } };
  const parsed = parseCcmSummary(extra);
  assert.ok(pipelineArtifactNames(parsed).includes("new-check.json"));
  assert.deepEqual(parsed.artifacts, ["new-check.json", "runtime.json"]);
  assert.deepEqual(controlsForArtifact(parsed, "new-check.json"), []);
  assert.throws(() => parseCcmSummary({ ...extra, data:{...extra.data, artifacts:["../secret.json"]} }), /artifact inventory/);
});

test("structured observations round trip and automated test receipts never read as independent review",()=>{
 const record={...CCM_EXAMPLE,approval:{...CCM_EXAMPLE.approval,mode:"vendor-test" as const}};
 const restored=parseCcmSummary(summaryForSession(record));assert.deepEqual(restored.reviewItems,record.reviewItems);assert.equal(restored.approval.mode,"vendor-test");
  assert.match(renderToStaticMarkup(createElement(PipelineEvidenceView as ComponentType<{record:typeof restored}>,{record:restored})),/Automated vendor test · no independent review/);
 const invalid={...record,reviewItems:[{...record.reviewItems![0],scope:{...record.reviewItems![0].scope,artifacts:["invented.json"]}}]};
 assert.throws(()=>parseCcmSummary(summaryForSession(invalid)),/review artifact/);
});

test("an imported receipt without a review mode does not imply independent approval",()=>{
 const record={...CCM_EXAMPLE,approval:{...CCM_EXAMPLE.approval,mode:undefined}};
 const markup=renderToStaticMarkup(createElement(PipelineEvidenceView as ComponentType<{record:typeof record}>,{record}));
 assert.match(markup,/Deployment receipt · review mode not supplied/);
 assert.doesNotMatch(markup,/>Independent review</);
});
