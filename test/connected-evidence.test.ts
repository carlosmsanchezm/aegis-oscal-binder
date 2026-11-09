import assert from "node:assert/strict";
import test from "node:test";
import { buildBinderDocuments, validateBinderDocuments } from "../lib/aegis/baseline-binder";
import { connectedReleases, type EvidenceConnection } from "../lib/aegis/connected-evidence";
import { mergeStoredReleases, rollupControlResults, releaseProject } from "../lib/aegis/control-rollup";
import { proposePlans } from "../lib/aegis/plan-proposal";
import { gitlabArtifactUrl } from "../lib/aegis/pipeline-evidence";

const now = Date.now();
function connection(): EvidenceConnection {
  return { id: "11111111-1111-4111-8111-111111111111", name: "Connected reference system", createdAt: new Date(now).toISOString(), revokedAt: null,
    history: ["fail", "pass"].map((verdict, i) => ({ id: String(i + 1).repeat(64), receivedAt: new Date(now).toISOString(),
      run: { id: `run-${i}`, producer: "Actual collector", observedAt: new Date(now - 2000 + i * 1000).toISOString() },
      subject: { kind: "identity", id: "frontend-service-account", revision: `rbac-${i}` },
      checks: [{ id: "secret-read", version: "1", description: "Restrict secret read", requirement: { framework: "NIST SP 800-53 Rev 5", reference: "AC-6", objective: "Frontend cannot get Secrets." }, verdict: verdict as "fail" | "pass", artifacts: ["authorization.json"], validUntil: new Date(now + 3600_000).toISOString() }],
      artifacts: [{ name: "authorization.json", sha256: "a".repeat(64) }], limitations: ["One authorization objective; producer identity unverified."],
    })) };
}
test("connected observations reuse the control rollup and finding proposals without injecting Podinfo", () => {
  const releases = connectedReleases(connection(), "https://binder.test", now);
  const scoped = mergeStoredReleases(releases, releases[0].pipelineUrl);
  assert.equal(scoped.length, 2);
  assert.equal(scoped.some(r => r.pipelineUrl.includes("gitlab")), false);
  const rows = rollupControlResults(scoped);
  assert.equal(rows.filter(r => r.result).length, 1);
  assert.equal(rows.find(r => r.id === "AC-6")?.result?.checks[0].verdict, "pass");
  assert.match(rows.find(r => r.id === "AC-6")?.result?.finding ?? "", /Check reported FAIL/);
  assert.equal(rows.find(r => r.id === "AC-6")?.result?.sourceReleaseSha256, releases[0].releaseSha256);
  const [proposal] = proposePlans(scoped);
  assert.equal(proposal.controlId, "AC-6");
  assert.equal(proposal.readyToClose, true);
  assert.equal(proposal.acceptance, "proposed");
  assert.equal(proposal.closureConfirmed, false);
  assert.match(proposal.retests[0].evidence, /artifact=authorization.json/);
  assert.match(proposal.retests[0].reviewer, /identity unverified/);
  const documents = buildBinderDocuments(scoped, null, new Date(), [{ ...proposal, acceptance: "accepted" }]);
  assert.deepEqual(validateBinderDocuments(documents), []);
  assert.equal(releases[0].runtime, null);
  assert.equal(releases[0].approval, null);
  assert.equal(gitlabArtifactUrl(releases[0], "absent.json"), null);
  assert.notEqual(releaseProject(releases[0].pipelineUrl), releaseProject(releases[0].pipelineUrl.replace(connection().id, "22222222-2222-4222-8222-222222222222")));
});
test("another subject, criterion, version, missing check, or unchanged revision cannot prove the repair", () => {
  const mutations = [
    (c: EvidenceConnection) => { c.history[1].subject.id = "another-identity"; },
    (c: EvidenceConnection) => { c.history[1].checks[0].version = "2"; },
    (c: EvidenceConnection) => { c.history[1].checks[0].requirement.objective = "Another criterion"; },
    (c: EvidenceConnection) => { c.history[1].checks[0].id = "another-check"; },
    (c: EvidenceConnection) => { c.history[1].subject.revision = c.history[0].subject.revision; },
    (c: EvidenceConnection) => { c.history[1].checks[0].validUntil = new Date(now - 500).toISOString(); },
    (c: EvidenceConnection) => { c.history[1].checks[0].verdict = "unknown"; },
  ];
  for (const mutate of mutations) {
    const c = connection(); mutate(c);
    const [proposal] = proposePlans(connectedReleases(c, "https://binder.test", now));
    assert.equal(proposal.readyToClose, false);
  }
});
test("non-NIST requirements retain evidence without acquiring NIST mappings", () => {
  const c = connection(); c.history.forEach(h => { h.checks[0].requirement.framework = "SOC 2"; });
  const releases = connectedReleases(c, "https://binder.test", now);
  assert.equal(releases[0].families.length, 0);
  assert.equal(proposePlans(releases).length, 0);
  assert.match(releases[0].gaps.join(" "), /no NIST mapping inferred/);
  assert.deepEqual(proposePlans([]), []);
});

test("a newer subject revision without the proving check invalidates an earlier passing retest", () => {
  const c = connection();
  const third = structuredClone(c.history[1]);
  third.id = "3".repeat(64); third.subject.revision = "rbac-3";
  third.run.observedAt = new Date(now).toISOString(); third.checks[0].id = "other-check";
  c.history.push(third);
  const [proposal] = proposePlans(connectedReleases(c, "https://binder.test", now));
  assert.equal(proposal.readyToClose, false);
  assert.equal(proposal.retests.length, 0);
});

test("person-approved artifact mappings remain evidence links without invented verdicts", () => {
  const releases = connectedReleases(connection(), "https://binder.test", now);
  releases[1].families.push({ family: "CM", controls: ["CM-6"], evidence: ["authorization.json"], coverage: "Person-approved mapping; evidence link only." });
  const result = rollupControlResults(releases).find(r => r.id === "CM-6")?.result;
  assert.equal(result?.evidence.length, 1);
  assert.deepEqual(result?.checks, []);
  assert.equal(result?.finding, "");
  assert.equal(proposePlans(releases).some(p => p.controlId === "CM-6"), false);
});

test("long retained histories bound repeated finding evaluation and preserve the exact retest source", () => {
  const c=connection(),length=24;
  c.history=Array.from({length},(_,i)=>{
    const row=structuredClone(c.history[i?1:0]);
    row.id=(i+1).toString(16).padStart(4,"0").repeat(16);
    row.run={...row.run,id:`scale-${i}`,observedAt:new Date(now-(length-i)*1000).toISOString()};
    row.subject.revision=`rbac-${i}`;return row;
  });
  const releases=connectedReleases(c,"https://binder.test",now),item=releases[0].reviewItems![0],scope=item.scope;
  let scopeReads=0;
  Object.defineProperty(item,"scope",{enumerable:true,configurable:true,get(){scopeReads++;return scope;}});
  const result=rollupControlResults(releases).find(row=>row.id==="AC-6")!.result!;
  assert.ok(scopeReads<=length*2,`Repeated historical scope evaluation: ${scopeReads}`);
  assert.equal(result.sourceReleaseSha256,releases[0].releaseSha256);
  assert.equal(result.correctiveReleaseUrl,releases.at(-1)!.pipelineUrl);
  assert.equal(result.checks[0].verdict,"pass");
  const original=rollupControlResults([releases[0]]).find(row=>row.id==="AC-6")!.result!;
  assert.equal(original.correctiveReleaseUrl,"");assert.deepEqual(original.checks,[]);
});

test("rollup evaluation does not reuse an earlier clock's passing verdict", context => {
  const releases=connectedReleases(connection(),"https://binder.test",now);
  assert.equal(rollupControlResults(releases).find(row=>row.id==="AC-6")!.result!.checks[0].verdict,"pass");
  context.mock.method(Date,"now",()=>now+7200_000);
  const result=rollupControlResults(releases).find(row=>row.id==="AC-6")!.result!;
  assert.equal(result.checks.some(check=>check.verdict==="pass"),false);
  assert.equal(result.checks[0].reportedVerdict,"pass");
});
