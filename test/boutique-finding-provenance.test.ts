import {referenceProposals as proposePlans} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import before from "../lib/reference/online-boutique-before.json";
import after from "../lib/reference/online-boutique-after.json";
import { parseEvidenceEvent } from "../lib/builder/evidence";
import { verifyBundle } from "../lib/server/builder-store";
import { summarizeBuilderBundle } from "../lib/server/builder-observation";
import { connectedReleases } from "../lib/aegis/connected-evidence";
import { applyDecision, decisionFromProposal, proposalStatus } from "../lib/aegis/plan-proposal";
import { acceptedProposals } from "../lib/server/remediation-draft";
import { buildBinderDocuments, validateBinderDocuments } from "../lib/aegis/baseline-binder";

const connectionId = "11111111-1111-4111-8111-111111111111";
function capture(value: typeof before) {
  return verifyBundle({ schema: "aegis.evidence-bundle.v1", ...value, connectionId,
    receivedAt: "2026-10-06T02:55:00.000Z", event: parseEvidenceEvent(JSON.parse(value.rawEvent)),
    integrity: "verified", authentication: "browser-owner" });
}
function releases() {
  return connectedReleases({ id: connectionId, name: "Online Boutique", createdAt: "2026-10-06T02:55:00.000Z", revokedAt: null,
    history: [before, after].map(c => summarizeBuilderBundle(capture(c))) }, "https://binder.test", Date.parse("2026-10-07T00:00:00Z"));
}

test("actual Boutique risk describes excess access and pins failed evidence separately from an expired passing retest", () => {
  const stored = releases(), [proposal] = proposePlans(stored);
  assert.match(proposal.finding, /was authorized to get Kubernetes Secrets/);
  assert.match(proposal.riskStatement, /was authorized to get Kubernetes Secrets/);
  assert.doesNotMatch(proposal.finding, /has no get permission/);
  assert.match(proposal.provingChecks[0], /has no get permission/);
  assert.match(proposal.action, /namespace\.$/);
  assert.doesNotMatch(proposal.action, /\.\.$/);
  assert.equal(proposal.retests[0].reportedVerdict, "pass");
  assert.equal(proposal.retests[0].evidenceState, "stale");
  assert.equal(proposal.retests[0].verdict, "");
  assert.equal(proposal.readyToClose, false);
  assert.equal(stored[1].observation.reportedOutcome, "pass");
  assert.equal(stored[1].policyVerdict, "unknown");
  const documents = buildBinderDocuments(stored, null, new Date(), [{ ...proposal, acceptance: "accepted" }]);
  assert.deepEqual(validateBinderDocuments(documents), []);
  type Prop = { name: string; value: string };
  const body = documents.poam["plan-of-action-and-milestones"] as {
    observations: { types?: string[]; collected: string; props: Prop[]; "relevant-evidence": { href: string; description: string; props?: Prop[] }[] }[];
    risks: { status: string; description: string }[];
  };
  const finding = body.observations.find((o: { types?: string[] }) => o.types?.includes("finding"));
  assert.ok(finding);
  assert.equal(finding.collected, "2026-10-06T02:54:20.612Z");
  const original = finding["relevant-evidence"].filter((e: { description: string }) => e.description.startsWith("Original finding evidence:"));
  assert.equal(original.length, 3);
  assert.ok(original.every((e: { href: string }) => e.href.includes(before.id)));
  const retest = finding["relevant-evidence"].find((e: { props?: { name: string }[] }) => e.props?.some(p => p.name === "verification-check"));
  assert.ok(retest);
  assert.ok(retest.href.includes(after.id));
  assert.ok(retest.props?.some((p: { name: string; value: string }) => p.name === "reported-verdict" && p.value === "pass"));
  assert.ok(retest.props?.some((p: { name: string; value: string }) => p.name === "evidence-state" && p.value === "stale"));
  assert.equal(body.risks[0].status, "open");
  assert.match(body.risks[0].description, /was authorized to get Kubernetes Secrets/);
  assert.equal(finding.props.find((p: { name: string }) => p.name === "source-release-sha256")?.value, before.id);
});

test("an acceptance of the reversed finding cannot be reused for the corrected finding", () => {
  const stored = releases(), [proposal] = proposePlans(stored);
  const old = decisionFromProposal(proposal, { acceptance: "accepted", riskStatement: "Incorrect saved good-state risk" });
  old.finding = "Reported failure: The Online Boutique frontend service account has no get permission for Secrets in this namespace.";
  assert.equal(applyDecision(proposal, old).acceptance, "proposed");
  assert.match(applyDecision(proposal, old).riskStatement, /was authorized to get/);
  assert.deepEqual(acceptedProposals(stored, [old]), []);
});

test("unrecognized or inconsistent authorization artifacts cannot invent the excess-access finding", () => {
  for (const mutate of [
    (b: ReturnType<typeof capture>) => { b.event.subject.id = "different-subject"; },
    (b: ReturnType<typeof capture>) => { b.event.checks[0].verdict = "unknown"; },
    (b: ReturnType<typeof capture>) => { b.event.checks[0].version = "unrecognized"; },
    (b: ReturnType<typeof capture>) => { b.event.artifacts = []; },
  ]) {
    const b = capture(before); mutate(b);
    assert.deepEqual(summarizeBuilderBundle(b).observedResults, {});
  }
});


test("restored generated punctuation is corrected without changing a reviewer's action", () => {
  const [proposal] = proposePlans(releases());
  const saved = decisionFromProposal(proposal, { acceptance: "accepted", action: proposal.action + "." });
  assert.equal(applyDecision(proposal, saved).action, proposal.action);
  assert.equal(applyDecision(proposal, saved).acceptance, "accepted");
  saved.action = "Reviewer-authored action..";
  assert.equal(applyDecision(proposal, saved).action, saved.action);
});

test("Boutique check counts and retest time come from the retained captures",()=>{
 const stored=releases();
 assert.deepEqual(stored.map(r=>r.checks.length),[1,1]);
 assert.equal(proposePlans([stored[0]])[0].retests.length,0);
 const [proposal]=proposePlans(stored);
 assert.equal(proposal.retests.length,1);
 assert.equal(proposal.retests[0].capturedAt,stored[1].createdAt);
 assert.match(proposal.retests[0].capturedAt!,/T02:54:/);
 assert.equal(proposalStatus({...proposal,acceptance:"accepted"}),"Accepted · retest expired");
});
