import {referenceProposals as proposePlans} from "./support/reference-history";
import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {emptyPersisted, loadFixture, resetPackage} from "../lib/aegis/operations";
import {Session, runWithSession} from "../lib/aegis/store";
import {proposeArtifactMappings} from "../lib/aegis/artifact-mapping";
import {moderateControls} from "../lib/aegis/moderate-baseline";
import {CCM_EXAMPLE, controlsForArtifact} from "../lib/aegis/pipeline-evidence";
import {applyAcceptedArtifactMappings} from "../lib/aegis/artifact-mapping";
import {getPipelineMappings, postPipelineMapping} from "../lib/server/handlers";
import {decisionFromProposal, applyDecision, plainPlan, importProposalDecisions} from "../lib/aegis/plan-proposal";
import {buildBinderDocuments, validateBinderDocuments} from "../lib/aegis/baseline-binder";

test("catalog mapping acceptance survives loading an SSP with fewer controls", async () => {
  const previous = process.env.AEGIS_DATA_DIR;
  const root = mkdtempSync(path.join(tmpdir(), "demo-story-round1-mapping-"));
  process.env.AEGIS_DATA_DIR = root;
  try {
    const session = Session.create("93".repeat(16), root);
    await runWithSession(session, async () => {
      session.commit({...emptyPersisted(), catalogId: "fedramp-rev5"});
      const proposal = proposeArtifactMappings(CCM_EXAMPLE, moderateControls().map(control => control.id)).find(item => item.artifact === "publisher-manifest.json")!;
      const response = await postPipelineMapping({scope: "catalog", proposalKey: proposal.key, profile: proposal.profile, status: "accepted", controls: ["CM-8"], reviewer: "Alex Reviewer"});
      assert.equal(response.status, 200);
      const saved = (await response.json()).decision;
      session.commit(loadFixture(session.state, "gold", {root: process.cwd()}));
      const read = await getPipelineMappings(new Request("http://localhost/api/pipeline/mappings?scope=catalog")).json();
      assert.equal(read.decisions.length, 1, "SSP load must not filter out catalog-scoped review records");
      assert.deepEqual(read.decisions[0], saved);
      assert.deepEqual(controlsForArtifact(applyAcceptedArtifactMappings(CCM_EXAMPLE, read.decisions), proposal.artifact), ["CM-8"]);
      assert.equal(read.decisions[0].reviewer, "Alex Reviewer");
    });
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(root, {recursive: true, force: true});
  }
});

test("an unassigned owner is explicit and identical in plain plan and OSCAL contact fields", () => {
  const releases = mergeStoredReleases([CCM_EXAMPLE]);
  const proposal = proposePlans(releases)[0];
  assert.equal(plainPlan(proposal).whoOwnsIt, "Unassigned");
  const accepted = applyDecision(proposal, decisionFromProposal(proposal, {acceptance: "accepted"}));
  const documents = buildBinderDocuments(releases, null, new Date("2026-10-09T04:00:00Z"), [accepted]);
  assert.deepEqual(validateBinderDocuments(documents), []);
  const body = documents.poam["plan-of-action-and-milestones"] as any;
  const props = body["poam-items"][0].props;
  for (const name of ["owner", "point-of-contact"]) assert.equal(props.find((prop: any) => prop.name === name).value, "Unassigned");
  assert.equal(importProposalDecisions(documents.poam)[0].plain?.whoOwnsIt, "Unassigned");
});

test("a named owner round trips through contact, plain fields and import", () => {
  const releases = mergeStoredReleases([CCM_EXAMPLE]);
  const proposal = proposePlans(releases)[0];
  const accepted = applyDecision(proposal, decisionFromProposal(proposal, {acceptance: "accepted", owner: "Named reviewer"}));
  const poam = buildBinderDocuments(releases, null, new Date("2026-10-09T04:00:00Z"), [accepted]).poam;
  const props = (poam["plan-of-action-and-milestones"] as any)["poam-items"][0].props;
  assert.equal(props.find((prop: any) => prop.name === "point-of-contact")?.value, "Named reviewer");
  assert.equal(importProposalDecisions(poam)[0].owner, "Named reviewer");
});

test("an earlier SSP-scoped acceptance survives returning to catalog review without gaining controls", async () => {
  const previous = process.env.AEGIS_DATA_DIR, root = mkdtempSync(path.join(tmpdir(), "demo-story-round1-earlier-review-"));
  process.env.AEGIS_DATA_DIR = root;
  try {
    const session = Session.create("94".repeat(16), root);
    await runWithSession(session, async () => {
      session.commit(loadFixture({...emptyPersisted(), catalogId: "fedramp-rev5"}, "gold", {root: process.cwd()}));
      const proposal = proposeArtifactMappings(CCM_EXAMPLE, session.state.controls.map(control => control.id)).find(item => item.artifact === "configuration.raw.json")!;
      const response = await postPipelineMapping({proposalKey: proposal.key, profile: proposal.profile, status: "accepted", controls: ["CM-6"], reviewer: "Earlier reviewer"});
      assert.equal(response.status, 200);
      const original = (await response.json()).decision;
      session.commit(resetPackage(session.state));
      const read = await getPipelineMappings(new Request("http://localhost/api/pipeline/mappings", {headers: {"x-aegis-mapping-scope": "catalog"}})).json();
      assert.equal(read.decisions.length, 1);
      assert.deepEqual(read.decisions[0], original, "retain the original reviewed profile, name and time");
      assert.deepEqual(controlsForArtifact(applyAcceptedArtifactMappings(CCM_EXAMPLE, read.decisions), proposal.artifact), ["CM-6"]);
    });
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(root, {recursive: true, force: true});
  }
});
