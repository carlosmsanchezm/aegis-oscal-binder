import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAcceptedArtifactMappings,
  decisionForProposal,
  pipelineReleaseKey,
  proposeArtifactMappings,
  mappingDecision,
  restoreMappingDecision,
} from "../lib/aegis/artifact-mapping";
import { emptyPersisted, loadFixture, recordArtifactMappingDecision, resetPackage } from "../lib/aegis";
import { CCM_EXAMPLE, controlsForArtifact } from "../lib/aegis/pipeline-evidence";

test("unmapped Podinfo artifacts get deterministic candidates from existing mappings", () => {
  const allowed = CCM_EXAMPLE.families.flatMap(family => family.controls);
  const first = proposeArtifactMappings(CCM_EXAMPLE, allowed);
  const reversed = proposeArtifactMappings(
    { ...CCM_EXAMPLE, families: [...CCM_EXAMPLE.families].reverse() },
    [...allowed].reverse(),
  );
  const configuration = first.find(proposal => proposal.artifact === "configuration.raw.json");
  assert.ok(configuration);
  assert.deepEqual(configuration.candidates.map(candidate => candidate.controlId), ["AC-5", "AC-6", "CM-3", "CM-6", "SC-7", "SC-8"]);
  assert.match(configuration.candidates.find(candidate => candidate.controlId === "CM-6")!.reasons.join(" "), /Check id "configuration"/);
  assert.match(configuration.candidates.find(candidate => candidate.controlId === "CM-6")!.reasons.join(" "), /Existing mapping links configuration\.json to CM-6/);
  assert.deepEqual(first.map(proposal => proposal.key), reversed.map(proposal => proposal.key));
});

test("candidate controls are constrained by the caller's catalog/profile selection", () => {
  const proposals = proposeArtifactMappings(CCM_EXAMPLE, ["CM-6"]);
  const configuration = proposals.find(proposal => proposal.artifact === "configuration.raw.json");
  assert.deepEqual(configuration?.candidates.map(candidate => candidate.controlId), ["CM-6"]);
  assert.equal(proposals.some(proposal => proposal.candidates.some(candidate => candidate.controlId === "SI-7")), false);
});

test("an artifact absent from the prior stored release is marked newly seen", () => {
  const next = {
    ...CCM_EXAMPLE,
    pipelineId: "2894051000",
    commitSha: "01".repeat(20),
    releaseSha256: "ab".repeat(32),
    createdAt: "2026-10-05T12:00:00.000Z",
    approval: { ...CCM_EXAMPLE.approval, commitSha: "01".repeat(20), releaseSha256: "ab".repeat(32) },
    checks: [...CCM_EXAMPLE.checks, { id: "configuration-drift", status: "pass", findings: 0, blockingCount: 0, artifact: "configuration-drift.json" }],
    artifacts: [...CCM_EXAMPLE.artifacts!, "configuration-drift.json"],
  };
  const proposal = proposeArtifactMappings(next, CCM_EXAMPLE.families.flatMap(family => family.controls), [CCM_EXAMPLE])
    .find(item => item.artifact === "configuration-drift.json");
  assert.equal(proposal?.detection, "new");
  assert.ok(proposal?.candidates.some(candidate => candidate.controlId === "CM-6"));
});

test("only acceptance applies evidence links; rejection remains a stored decision", () => {
  const proposal = proposeArtifactMappings(CCM_EXAMPLE, ["CM-6"])
    .find(item => item.artifact === "configuration.raw.json")!;
  const rejectedState = recordArtifactMappingDecision(
    emptyPersisted(),
    CCM_EXAMPLE,
    proposal,
    "rejected",
    "2026-10-05T12:00:00.000Z",
  );
  assert.equal(decisionForProposal(rejectedState.pipelineMappingDecisions!, proposal)?.status, "rejected");
  assert.deepEqual(controlsForArtifact(applyAcceptedArtifactMappings(CCM_EXAMPLE, rejectedState.pipelineMappingDecisions!), proposal.artifact), []);

  const acceptedState = recordArtifactMappingDecision(
    rejectedState,
    CCM_EXAMPLE,
    proposal,
    "accepted",
    "2026-10-05T12:05:00.000Z",
  );
  assert.equal(acceptedState.pipelineMappingDecisions?.length, 1);
  assert.equal(acceptedState.pipelineMappingDecisions?.[0]?.releaseKey, pipelineReleaseKey(CCM_EXAMPLE));
  const mapped = applyAcceptedArtifactMappings(CCM_EXAMPLE, acceptedState.pipelineMappingDecisions!);
  assert.deepEqual(controlsForArtifact(mapped, proposal.artifact), ["CM-6"]);
  assert.match(mapped.families.at(-1)!.coverage, /does not establish control satisfaction or authorization/);
  assert.deepEqual(controlsForArtifact(CCM_EXAMPLE, proposal.artifact), []);
  assert.equal(resetPackage(acceptedState).pipelineMappingDecisions?.[0]?.status, "accepted");
  assert.equal(loadFixture({ ...acceptedState, catalogId: "fedramp-rev5" }, "gold", { root: process.cwd() }).pipelineMappingDecisions?.[0]?.status, "accepted");
});


test("approval keys and cached decisions bind the exact reviewed profile and candidates", () => {
  const narrow = proposeArtifactMappings(CCM_EXAMPLE,["CM-6"]).find(x=>x.artifact==="configuration.raw.json")!;
  const wide = proposeArtifactMappings(CCM_EXAMPLE,["CM-6","SC-7"]).find(x=>x.artifact===narrow.artifact)!;
  assert.notEqual(narrow.key,wide.key);
  const decision=mappingDecision(CCM_EXAMPLE,narrow,"accepted","2026-10-05T12:00:00Z");
  assert.deepEqual(restoreMappingDecision(decision,CCM_EXAMPLE,["CM-6"])?.controls,["CM-6"]);
  assert.equal(restoreMappingDecision(decision,CCM_EXAMPLE,["CM-6","SC-7"]),null);
  assert.equal(restoreMappingDecision(decision,CCM_EXAMPLE,["CM-6"],"fedramp-20x"),null);
  assert.equal(restoreMappingDecision({...decision,controls:["CM-6","SC-7"]},CCM_EXAMPLE,["CM-6"]),null);
  assert.equal(restoreMappingDecision({...decision,profile:undefined},CCM_EXAMPLE,["CM-6"]),null);
  assert.deepEqual(controlsForArtifact(applyAcceptedArtifactMappings(CCM_EXAMPLE,[{...decision,profile:undefined}]),narrow.artifact),[]);
});
