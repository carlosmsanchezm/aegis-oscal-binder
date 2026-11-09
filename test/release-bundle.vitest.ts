import {beforeEach, afterEach, it, expect, vi} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {Session, dropCachedSession} from "../lib/aegis/store";
import {createPullConnection, retainEvent, sha256, readBundle} from "../lib/server/builder-store";
import * as builderStore from "../lib/server/builder-store";
import {saveInstallation} from "../lib/github/store";
import {writeObjectOnce} from "../lib/immutable-log";
import {storageKey} from "../lib/storage-key";
import {connectionRecords} from "../lib/agent/service";
import {performIssueAction} from "../lib/server/issue-actions";
import {readRemediation, updateRemediationRecord, writeRemediationRecord} from "../lib/aegis/remediation-store";
import {prRecordKey, pullRequestLinks, proposeFixPr} from "../lib/github/pull-requests";
import {formReleaseEvidence, releaseEvidenceFor, releaseClosureBinding, projectPlanRelease} from "../lib/server/release-evidence";
import {releaseFixedControls} from "../lib/aegis/release-evidence";
import {collectedProposal, assertCollectedRecord} from "../lib/aegis/collected-closure";
import {sealCollectedArtifact} from "../lib/collector/seal";
import {trustedReleases, fetchAndRetainRelease} from "../lib/collector/trusted-release";
import * as reader from "../lib/collector/github-release";
import {buildBinderDocuments, validateBinderDocuments} from "../lib/aegis/baseline-binder";
import {releaseRange} from "../lib/github/release-range";
import type {PullRequestLink} from "../lib/github/pr-types";
import type {PlanProposal} from "../lib/aegis/plan-proposal";
import {queryTimeline} from "../lib/timeline/store";
import {newPlan} from "../lib/aegis/remediation";
import original from "../fixtures/boutique-live/40446239616/event.json";
const mocks = vi.hoisted(() => ({compare: vi.fn(), get: vi.fn(), paginate: vi.fn(), files: vi.fn(), checkList: vi.fn(), checkCreate: vi.fn(), checkUpdate: vi.fn()}));
vi.mock("../lib/github/auth", () => ({
  withScanInstallation: async (_id: number, _repo: string, run: Function) => run({octokit: {rest: {repos: {compareCommitsWithBasehead: mocks.compare}}}}),
  withPrInstallation: async (_id: number, _repo: string, _cap: string, run: Function) => run({octokit: {rest: {pulls: {get: mocks.get, listFiles: mocks.files}, checks: {listForRef: mocks.checkList, create: mocks.checkCreate, update: mocks.checkUpdate}}, paginate: mocks.paginate}}),
  withReleaseInstallation: vi.fn(),
}));
const g = {installationId: 42, owner: "carlosmsanchezm", repo: "microservices-demo"};
const repository = "https://github.com/" + g.owner + "/" + g.repo;
const ship = "d".repeat(40), merge1 = "a".repeat(40), merge2 = "b".repeat(40);
let dir: string, sid: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "release-bundle-")); sid = randomBytes(16).toString("hex");
  vi.stubEnv("AEGIS_DATA_DIR", dir); vi.useFakeTimers({toFake: ["Date"]});
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE", ""); vi.stubEnv("AEGIS_GITHUB_BREAK_GLASS_USERS", "");
  vi.setSystemTime(new Date("2026-10-27T04:02:00Z"));
  mocks.compare.mockImplementation(async ({page = 1}) => ({data: {status: "ahead", total_commits: 3,
    commits: page === 1 ? [merge1, merge2, ship].map(sha => ({sha})) : []}}));
  mocks.get.mockImplementation(async ({pull_number}) => ({data: {number: pull_number, merged: true, state: "closed",
    merge_commit_sha: pull_number === 7 ? merge1 : merge2, head: {sha: "c".repeat(40)},
    base: {sha: original.subject.revision, repo: {full_name: g.owner + "/" + g.repo}}}}));
  mocks.paginate.mockResolvedValue([{id: 77, html_url: repository + "/actions/runs/777/job/77", name: "tests", status: "completed", conclusion: "success"}]);
  mocks.checkList.mockResolvedValue({data: {check_runs: []}}); mocks.checkCreate.mockResolvedValue({data: {id: 1}});
});
afterEach(() => {dropCachedSession(sid); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, {recursive: true, force: true});});

function releaseEvent(failures: string[] = [], commit = ship, at = "2026-10-27T04:01:00Z", run = "777777") {
  const event = structuredClone(original);
  event.subject.revision = commit; event.run.observedAt = at; event.run.id = run;
  event.run.url = repository + "/actions/runs/" + run;
  for (const artifact of event.artifacts) {
    const a = JSON.parse(Buffer.from(artifact.contentBase64, "base64").toString("utf8"));
    a.source.commit = commit; a.capturedAt = at;
    a.facts = a.facts.filter((f: any) => f.outcome !== "fail" || failures.includes(f.field));
    const count = a.facts.filter((f: any) => f.outcome === "fail").length;
    for (const f of a.facts) if (f.key === "scan-findings" || f.key === "scan-blocking") {f.value = count; f.content = f.field + " = " + count;}
    const content = JSON.stringify(sealCollectedArtifact(a));
    artifact.contentBase64 = Buffer.from(content).toString("base64"); artifact.sha256 = sha256(content);
  }
  for (const check of event.checks) {check.verdict = "pass"; check.validUntil = "2026-10-28T05:00:00Z";}
  return event;
}
async function collect(connection: string, event: typeof original) {
  const bundle = await retainEvent(connection, JSON.stringify(event), undefined, "browser-owner", true);
  await writeObjectOnce(storageKey(["collector-receipts", sid, connection + "-" + bundle.id + ".json"]), {
    sessionId: sid, connectionId: connection, receiptId: bundle.id, runId: event.run.id,
    commit: event.subject.revision, collectedAt: new Date().toISOString(),
  });
  return bundle;
}
it("trusted inventory starts independent verified bundle reads together and retains chronological order",async()=>{
  const connection=await createPullConnection("Inventory",randomBytes(32).toString("hex"));
  const newer=await collect(connection.id,releaseEvent([],ship,"2026-10-27T04:01:00Z","777777"));
  const older=await collect(connection.id,releaseEvent([],merge1,"2026-10-27T04:00:00Z","666666"));
  const originalRead=builderStore.readBundle;
  let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
  const reads=vi.spyOn(builderStore,"readBundle").mockImplementation(async(...args)=>{await blocked;return originalRead(...args);});
  const pending=trustedReleases(sid,connection.id);
  let releases:Awaited<ReturnType<typeof trustedReleases>>=[];
  try{await vi.waitFor(()=>expect(reads).toHaveBeenCalledTimes(2));}
  finally{unblock();releases=await pending;}
  expect(releases.map(r=>r.releaseSha256)).toEqual([older.id,newer.id]);
});
async function setup(count = 2) {
  const session = Session.create(sid); session.commit(session.state); await session.flush();
  const owner = randomBytes(32).toString("hex"), connection = await createPullConnection("Release bundle", owner, undefined, g);
  await saveInstallation("session:" + sid, {...g, accountLogin: g.owner, accountType: "User",
    repos: [{owner: g.owner, name: g.repo, private: true}], suspended: false,
    connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
  await collect(connection.id, original);
  const source = (await connectionRecords({connectionId: connection.id, ownerHash: connection.ownerHash})).find(r => r.artifactJobId === original.run.id)!;
  const issues = source.reviewItems!.filter(i => /frontend.*KSV-002[01]|KSV-002[01].*frontend/.test(i.description)).slice(0, count);
  expect(issues).toHaveLength(count);
  const proposals: PlanProposal[] = [];
  for (const issue of issues) {
    const result = await performIssueAction({connectionId: connection.id, sessionId: sid, receiptId: source.releaseSha256,
      issueId: issue.id, actor: "agent:" + "a".repeat(32), at: new Date().toISOString(), action: "draft",
      draft: {risk: "Unsafe workload identity", action: "Set nonroot identity", verification: "Collect the same scanner"}}) as {proposal: PlanProposal};
    proposals.push(result.proposal);
  }
  const links: PullRequestLink[] = proposals.map((p, i) => ({schema: "binder.pull-request-link.v1", ...g,
    poamItemId: p.id, findingId: issues[i].id, sourceReleaseId: source.pipelineId, connectionId: connection.id,
    prNumber: 7 + i, prUrl: repository + "/pull/" + (7 + i), headSha: "c".repeat(40), baseSha: original.subject.revision,
    state: "merged", mergedCommitSha: i ? merge2 : merge1, createdBy: "agent:unit-agent",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ciStatus: {sha: i ? merge2 : merge1, state: "success", checks: 1, checkedAt: new Date().toISOString(),
      runs: [{id: String(700 + i), url: repository + "/actions/runs/" + (700 + i)}]},
  }));
  await updateRemediationRecord(sid, prRecordKey(connection.id), async record => ({...record!, pullRequests: links}), undefined, true);
  return {connection, source, issues, proposals, links, owner};
}
it("two merged PRs produce one connection-bound release bundle; shipped SHA differs from both merges; closure stays human", async () => {
  const s = await setup(); const collected = await collect(s.connection.id, releaseEvent());
  const bundle = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(bundle.schema).toBe("binder.release-evidence.v1"); expect(bundle.items).toHaveLength(2);
  expect(bundle.previousCommitSha).toBe(original.subject.revision);
  expect(bundle.items.map(i => i.prNumber)).toEqual([7,8]);
  expect(bundle.items.every(i => i.retestResult === "pass" && i.retestReceiptId === collected.id)).toBe(true);
  expect([...releaseFixedControls(bundle)]).toEqual(["CM-6"]);
  const p = await collectedProposal(sid, s.proposals[0], s.connection.id);
  expect(p.correctiveReleaseId).toBe(bundle.releaseId); expect(p.readyToClose).toBe(true);
  expect(p.closureConfirmed).toBe(false); expect(p.acceptance).toBe("proposed");
  expect((await pullRequestLinks(sid, s.connection.id)).map(l => l.mergedCommitSha)).toEqual([merge1, merge2]);
  const record = (await readRemediation(sid))!.records.find(r => r.key === prRecordKey(s.connection.id))!;
  await writeRemediationRecord(sid, {...record, releaseEvidence: []});
  expect((await releaseEvidenceFor(sid, s.connection.id))).toHaveLength(1);
  expect(await releaseEvidenceFor(randomBytes(16).toString("hex"), s.connection.id)).toEqual([]);
  expect((await queryTimeline(s.connection.id, {control: "CM-3"})).some(row => row.body.reason_code === "release_bundle_collected")).toBe(true);
  expect((await connectionRecords({connectionId: s.connection.id, ownerHash: s.connection.ownerHash})).some(r =>
    r.collectedArtifacts?.some(a => a.source.path.endsWith("/bundle.json") && a.facts.every(f => f.key === "change-control")))).toBe(true);
});
it("one PR may cover two items with independent retests; a remaining finding prevents the control turning green", async () => {
  const s = await setup(); s.links[1] = {...s.links[1], prNumber: 7, prUrl: s.links[0].prUrl, mergedCommitSha: merge1, ciStatus: s.links[0].ciStatus};
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async record => ({...record!, pullRequests: s.links}), undefined, true);
  await collect(s.connection.id, releaseEvent([s.issues[1].scope.title]));
  const bundle = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(bundle.items.map(i => [i.prNumber, i.mergeSha, i.retestResult])).toEqual([[7,merge1,"pass"],[7,merge1,"remaining"]]);
  expect(releaseFixedControls(bundle).size).toBe(0);
});
it("a partial verification set is never promoted into passing strip membership", async () => {
  const s = await setup(1);
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async r => ({...r!, issueDrafts: [{...s.proposals[0], provingChecks: [...s.proposals[0].provingChecks, "Runtime identity and health verified"]}]}), undefined, true);
  await collect(s.connection.id, releaseEvent());
  expect((await formReleaseEvidence(sid, s.connection.id))!.items[0].retestResult).toBe("unverified");
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
});
it.each(["failure","stale","wrong-sha","no-run"] as const)("rejects %s PR CI even when the shipped scanner is clean", async mode => {
  const s = await setup(1), link = s.links[0];
  if (mode === "failure") link.ciStatus.state = "failure";
  if (mode === "stale") link.ciStatus.checkedAt = "2026-10-26T01:00:00Z";
  if (mode === "wrong-sha") link.ciStatus.sha = ship;
  if (mode === "no-run") link.ciStatus.runs = [];
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async r => ({...r!, pullRequests: [link]}), undefined, true);
  await collect(s.connection.id, releaseEvent());
  expect((await formReleaseEvidence(sid, s.connection.id))!.items[0].retestResult).toBe("unverified");
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
});
it("retests carry forward into later releases; a reverted finding removes readiness without rewriting merged identity", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent()); await formReleaseEvidence(sid, s.connection.id);
  const later = "e".repeat(40);
  mocks.compare.mockResolvedValue({data: {status: "ahead", total_commits: 1, commits: [{sha: later}]}});
  await collect(s.connection.id, releaseEvent([s.issues[0].scope.title], later, "2026-10-27T04:01:30Z", "888888"));
  const bundle = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(bundle.items[0]).toMatchObject({mergeSha: merge1, carriedForward: true, retestResult: "remaining"});
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
  expect((await pullRequestLinks(sid, s.connection.id))[0].mergedCommitSha).toBe(merge1);
});
it("range truncation or divergence fails closed; a caller cannot submit a passing bundle", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent());
  mocks.compare.mockResolvedValue({data: {status: "diverged", total_commits: 1001, commits: []}});
  const bundle = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(bundle.rangeStatus).toBe("unverified"); expect(bundle.items[0].retestResult).toBe("unverified");
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
  const r = (await readRemediation(sid))!.records[0];
  await writeRemediationRecord(sid, {...r, releaseEvidence: [{...bundle, rangeStatus: "verified", items: bundle.items.map(i => ({...i, retestResult: "pass"}))}]});
  expect((await releaseEvidenceFor(sid, s.connection.id))[0].rangeStatus).toBe("unverified");
});
it("OSCAL uses per-item PR/CI/release resources and observations, preserves open risks and validates all 1.1.2 documents", async () => {
  const s = await setup(); await collect(s.connection.id, releaseEvent()); await formReleaseEvidence(sid, s.connection.id);
  const bundles = await releaseEvidenceFor(sid, s.connection.id);
  const releases = await trustedReleases(sid, s.connection.id);
  const documents = buildBinderDocuments(releases, null, new Date(), s.proposals.map(p => ({...p, acceptance: "accepted"})), bundles);
  expect(validateBinderDocuments(documents)).toEqual([]);
  const poam = documents.poam["plan-of-action-and-milestones"] as any;
  const ar = documents.assessmentResults["assessment-results"] as any;
  expect(ar.results[0].observations.filter((o: any) => o.props?.some((p: any) => p.name === "pr-number"))).toHaveLength(2);
  expect(poam.risks.every((r: any) => r.status !== "closed")).toBe(true);
  const resources = poam["back-matter"].resources;
  expect(resources.filter((r: any) => r.title.startsWith("Pull request"))).toHaveLength(2);
  expect(resources.filter((r: any) => r.title.startsWith("CI run"))).toHaveLength(2);
  expect(resources.filter((r: any) => r.title.startsWith("Collected release"))).toHaveLength(1);
  const ssp = documents.ssp["system-security-plan"] as any;
  expect(ssp["control-implementation"]["implemented-requirements"].find((r: any) => r["control-id"] === "cm-6").links.some((l: any) => l.href.startsWith("#"))).toBe(true);
});
it("trusted collection forms the bundle and refreshes PR CI; replay retains a single identity", async () => {
  const s = await setup(1), event = releaseEvent();
  vi.spyOn(reader, "readGithubRelease").mockResolvedValue({event: event as never, runId: Number(event.run.id), commit: ship});
  const bundle = await fetchAndRetainRelease(s.connection.id, sid, {} as never, g.owner, g.repo, Number(event.run.id));
  expect(await readBundle(s.connection.id, bundle.id)).toBeTruthy();
  expect((await releaseEvidenceFor(sid, s.connection.id))[0].items[0].retestResult).toBe("pass");
  await fetchAndRetainRelease(s.connection.id, sid, {} as never, g.owner, g.repo, Number(event.run.id));
  expect((await readRemediation(sid))!.records[0].releaseEvidence).toHaveLength(1);
  expect(mocks.get).toHaveBeenCalled();
});
it("closure binding checks the latest selected item without computing unrelated item proofs", async () => {
  const s = await setup(), collected = await collect(s.connection.id, releaseEvent());
  await formReleaseEvidence(sid, s.connection.id);
  const closure = await import("../lib/aegis/collected-closure"), compute = closure.collectedScannerProof;
  vi.spyOn(closure, "collectedScannerProof").mockImplementation(async (...args) => {
    if (args[2] === s.issues[1].id) throw new Error("Unrelated item proof unavailable.");
    return compute(...args);
  });
  expect(await releaseClosureBinding(sid, s.connection.id, s.links[0])).toEqual({verified: true, commit: ship, receipt: collected.id});
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async record => ({...record!,
    pullRequests: record!.pullRequests!.map(link => link.poamItemId === s.proposals[0].id ?
      {...link, ciStatus: {...link.ciStatus, state: "failure"}} : link)}), undefined, true);
  expect((await releaseClosureBinding(sid, s.connection.id, s.links[0]))?.verified).toBe(false);
  vi.setSystemTime(new Date("2026-10-28T06:00:00Z"));
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async record => ({...record!,
    pullRequests: record!.pullRequests!.map(link => ({...link, ciStatus: {...link.ciStatus,
      state: "success", checkedAt: new Date().toISOString()}}))}), undefined, true);
  expect((await releaseClosureBinding(sid, s.connection.id, s.links[0]))?.verified).toBe(false);
});
it("changed derived release snapshots keep separate immutable identities and unchanged replay is idempotent", async () => {
  const s = await setup(1), collected = await collect(s.connection.id, releaseEvent());
  const first = (await formReleaseEvidence(sid, s.connection.id))!;
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async record => ({...record!,
    pullRequests: record!.pullRequests!.map(link => ({...link, ciStatus: {...link.ciStatus,
      runs: [{id: "900", url: repository + "/actions/runs/900"}]}}))}), undefined, true);
  const second = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(first.items[0].ciRunId).not.toBe(second.items[0].ciRunId);
  expect(second.items[0]).toMatchObject({retestResult: "pass", retestReceiptId: collected.id});
  const rows = await queryTimeline(s.connection.id);
  const snapshots = rows.filter(row => row.body.kind === "monitoring-capture" && row.body.source.runId?.startsWith("source-"));
  expect(snapshots).toHaveLength(2);
  expect(new Set(snapshots.map(row => row.body.id)).size).toBe(2);
  expect(new Set(snapshots.map(row => row.body.observedAt)).size).toBe(1);
  await formReleaseEvidence(sid, s.connection.id);
  expect(await queryTimeline(s.connection.id)).toEqual(rows);
  await expect(collect(s.connection.id, releaseEvent([s.issues[0].scope.title])))
    .rejects.toThrow("Timeline source identity conflicts with an existing run.");
  expect(await queryTimeline(s.connection.id)).toEqual(rows);
});
it("an imported event with no server receipt cannot form a bundle or authorize closure", async () => {
  const s = await setup(1);
  await retainEvent(s.connection.id, JSON.stringify(releaseEvent()), undefined, "browser-owner");
  const bundle = await formReleaseEvidence(sid, s.connection.id);
  expect(bundle?.items.every(i => i.retestResult !== "pass")).toBe(true);
  await expect(assertCollectedRecord(sid, {key: prRecordKey(s.connection.id), assessment: null, assessments: {}, plans: [],
    issueDrafts: [{...s.proposals[0], readyToClose: true}]})).rejects.toMatchObject({code: "EVIDENCE_REQUIRED"});
});
it("bounds and paginates commit comparisons, including first-release ancestry and missing pages", async () => {
  const compare = vi.fn().mockImplementation(async ({page}) => ({data: {status: "ahead", total_commits: 101,
    commits: page === 1 ? Array.from({length: 100}, (_, i) => ({sha: (i + 1).toString(16).padStart(40,"0")})) : [{sha: ship}]}}));
  const client = {rest: {repos: {compareCommitsWithBasehead: compare}}} as never;
  expect((await releaseRange(client, "o", "r", merge1, ship, [merge2])).size).toBe(101);
  expect(compare).toHaveBeenCalledTimes(2);
  compare.mockResolvedValue({data: {status: "ahead", total_commits: 101, commits: []}});
  await expect(releaseRange(client, "o", "r", merge1, ship, [merge2])).rejects.toThrow(/Complete/);
  compare.mockResolvedValue({data: {status: "ahead", total_commits: 1001, commits: [{sha: ship}]}});
  await expect(releaseRange(client, "o", "r", merge1, ship, [merge2])).rejects.toThrow(/bounded/);
  await expect(releaseRange(client, "o", "r", "", ship, [merge2])).rejects.toThrow(/bounded/);
  compare.mockResolvedValue({data: {status: "identical", total_commits: 0, commits: []}});
  expect(await releaseRange(client, "o", "r", "", ship, [ship])).toEqual(new Set([ship]));
  compare.mockResolvedValue({data: {status: "behind", total_commits: 0, commits: []}});
  expect((await releaseRange(client, "o", "r", "", ship, [merge1])).size).toBe(0);
});
it("a new draft revision appends another PR for an item; the earlier merged identity remains immutable", async () => {
  const s = await setup(1);
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async r => ({...r!,
    pullRequests: [{...s.links[0], draftRevision: "old-revision"}],
    issueDrafts: [{...s.proposals[0], draft_revision: "new-revision"}]}), undefined, true);
  await proposeFixPr(sid, s.connection.id, "agent:unit", {poamItemId: s.proposals[0].id, prNumber: 9});
  const links = await pullRequestLinks(sid, s.connection.id);
  expect(links.map(l => l.mergedCommitSha)).toEqual([merge1, merge2]);
  await collect(s.connection.id, releaseEvent());
  const bundle = (await formReleaseEvidence(sid, s.connection.id))!;
  expect(bundle.items).toHaveLength(1); expect(bundle.items[0].mergeSha).toBe(merge2);
});
it("break glass succeeds at the merge gate but cannot prove a release fix or close a post-hoc item", async () => {
  const s = await setup(1);
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE", "true"); vi.stubEnv("AEGIS_GITHUB_BREAK_GLASS_USERS", "overrider");
  const account = await import("../lib/account/session");
  vi.spyOn(account, "accountFromRequest").mockResolvedValue({uid: "overrider", name: "Operator", email: "operator@example.invalid", provider: "google"});
  mocks.get.mockResolvedValue({data: {number: 9, changed_files: 1, merged: false, state: "open", merge_commit_sha: null,
    head: {sha: "c".repeat(40)}, base: {sha: original.subject.revision, repo: {full_name: g.owner + "/" + g.repo}}}});
  mocks.paginate.mockImplementation(async fn => fn === mocks.files ? [{filename: "src/control.ts"}] :
    [{id: 77, html_url: repository + "/actions/runs/777/job/77", name: "tests", status: "completed", conclusion: "success"}]);
  const {breakGlass} = await import("../lib/github/poam-gate");
  const override = await breakGlass(new Request("https://binder.example"), sid, s.connection.id, s.owner, {prNumber: 9, name: "Operator", reason: "Emergency repair"});
  expect(override.decision?.conclusion).toBe("success");
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE", "");
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async r => ({...r!, pullRequests: r!.pullRequests!.map(l =>
    l.poamItemId === override.poamItemId ? {...l, state: "merged", mergedCommitSha: merge2,
      ciStatus: {...s.links[0].ciStatus, sha: merge2}} : l)}), undefined, true);
  expect((await formReleaseEvidence(sid, s.connection.id))!.items.find(i => i.poamItemId === override.poamItemId)?.retestResult).toBe("unverified");
  const r = (await readRemediation(sid))!.records.find(r => r.key === prRecordKey(s.connection.id))!;
  const p = r.issueDrafts!.find((p: any) => p.id === override.poamItemId) as PlanProposal;
  await expect(assertCollectedRecord(sid, {...r, issueDrafts: [{...p, readyToClose: true}]})).rejects.toMatchObject({code: "EVIDENCE_REQUIRED"});
  vi.setSystemTime(new Date("2026-10-27T04:03:00Z"));
  await collect(s.connection.id, releaseEvent([], ship, "2026-10-27T04:02:30Z"));
  expect((await formReleaseEvidence(sid, s.connection.id))!.items.find(i => i.poamItemId === override.poamItemId)?.retestResult).toBe("pass");
  expect((await collectedProposal(sid, p, s.connection.id)).closureConfirmed).toBe(false);
});
it("HTTP builder projections require the owning browser and the original remediation session", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent()); await formReleaseEvidence(sid, s.connection.id);
  const {GET} = await import("../app/api/builder/route");
  const request = (owner: string, session: string) => new Request("https://binder.example/api/builder", {headers: {cookie: "aegis_builder_owner=" + owner + "; aegis_sid=" + session}});
  const body = await (await GET(request(s.owner, sid))).json();
  expect(body.connections[0].releaseEvidence[0].items[0].retestResult).toBe("pass");
  expect(JSON.stringify(body)).not.toMatch(/ownerHash|tokenHash|PRIVATE KEY/);
  expect((await (await GET(request(randomBytes(32).toString("hex"), sid))).json()).connections).toEqual([]);
  expect((await (await GET(request(s.owner, randomBytes(16).toString("hex")))).json()).connections[0].releaseEvidence).toEqual([]);
});
it("connected pipeline notifications refetch the official artifact instead of trusting their supplied clean verdict", async () => {
  const s = await setup(1);
  const {indexPrLink} = await import("../lib/github/pull-requests");
  await indexPrLink(s.links[0], sid);
  const official = releaseEvent([s.issues[0].scope.title]);
  vi.spyOn(reader, "collectGithubRelease").mockResolvedValue({event: official as never, runId: Number(official.run.id), commit: ship});
  const {collectNotifiedRelease} = await import("../lib/server/release-notification");
  expect(await collectNotifiedRelease(s.connection.id, releaseEvent() as never)).toBe("collected");
  expect((await releaseEvidenceFor(sid, s.connection.id))[0].items[0].retestResult).toBe("remaining");
  const foreign = releaseEvent(); foreign.subject.id = "https://github.com/other/repository";
  expect(await collectNotifiedRelease(s.connection.id, foreign as never)).toBe("not-applicable");
});
it("a failed inbound provider read leaves notification bytes untrusted and grants no closure", async () => {
  const s = await setup(1);
  const {indexPrLink} = await import("../lib/github/pull-requests");
  await indexPrLink(s.links[0], sid);
  vi.spyOn(reader, "collectGithubRelease").mockRejectedValue(new Error("Provider unavailable"));
  const {collectNotifiedRelease} = await import("../lib/server/release-notification");
  expect(await collectNotifiedRelease(s.connection.id, releaseEvent() as never)).toBe("unavailable");
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
});
it("an unverified previous range cannot confer ancestry to a later carried-forward item", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent());
  mocks.compare.mockRejectedValue(new Error("Range unavailable"));
  await formReleaseEvidence(sid, s.connection.id);
  const later = "e".repeat(40);
  mocks.compare.mockResolvedValue({data: {status: "ahead", total_commits: 1, commits: [{sha: later}]}});
  await collect(s.connection.id, releaseEvent([], later, "2026-10-27T04:01:30Z", "888888"));
  expect((await formReleaseEvidence(sid, s.connection.id))!.items).toEqual([]);
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
});
it("a retained newer release with an unfinished bundle cannot fall back to an older passing merge receipt", async () => {
  const s = await setup(1);
  await updateRemediationRecord(sid, prRecordKey(s.connection.id), async r => ({...r!, pullRequests: [{...s.links[0],
    mergedCommitSha: ship, ciStatus: {...s.links[0].ciStatus, sha: ship}}]}), undefined, true);
  await collect(s.connection.id, releaseEvent()); await formReleaseEvidence(sid, s.connection.id);
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(true);
  await collect(s.connection.id, releaseEvent([s.issues[0].scope.title], "e".repeat(40), "2026-10-27T04:01:30Z", "888888"));
  expect((await collectedProposal(sid, s.proposals[0], s.connection.id)).readyToClose).toBe(false);
  expect((await releaseEvidenceFor(sid, s.connection.id)).at(-1)?.rangeStatus).toBe("unverified");
});
it("a proving release updates a saved plan reference without recording validation, acceptance or closure", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent()); await formReleaseEvidence(sid, s.connection.id);
  const plan = newPlan(s.source, s.issues[0].description, {disposition: "confirmed", note: "Confirmed criterion", requirement: "Identity criteria",
    reference: "https://example.invalid/criteria", reviewer: "Reviewer", date: "2026-10-27", illustrative: false, scope: s.issues[0].scope},
    "saved-plan", new Date().toISOString());
  const bundles = await releaseEvidenceFor(sid, s.connection.id);
  const projected = await projectPlanRelease(sid, plan, bundles);
  expect(projected.releaseRef).toBe(bundles[0].releaseId);
  expect(projected.releaseUrl).toBe(bundles[0].releaseUrl);
  expect(projected.validationRecorded).toBe(false); expect(projected.readyForReview).toBe(false);
  expect(projected.closure.recorded).toBe(false);
});
it("a collector retention failure cannot publish a passing domain-only bundle", async () => {
  const s = await setup(1); await collect(s.connection.id, releaseEvent());
  const store = await import("../lib/server/builder-store");
  vi.spyOn(store, "retainEvent").mockRejectedValue(new Error("Collector store unavailable"));
  await expect(formReleaseEvidence(sid, s.connection.id)).rejects.toThrow(/Collector store unavailable/);
  expect((await readRemediation(sid))!.records[0].releaseEvidence ?? []).toEqual([]);
});
it.each(["freshness","head","merge","ci","revision","rollback"])("projection race %s preserves exact proof identity and monotone CI freshness",async(change)=>{
 const s=await setup(1);await collect(s.connection.id,releaseEvent());
 const store=await import("../lib/aegis/remediation-store"),originalUpdate=store.updateRemediationRecord;
 let raced=false;
 vi.spyOn(store,"updateRemediationRecord").mockImplementation(async(...args:Parameters<typeof originalUpdate>)=>{
  if(args[5]&&!raced){
   raced=true;vi.setSystemTime(new Date(Date.now()+1000));
   await originalUpdate(sid,prRecordKey(s.connection.id),async current=>({...current!,pullRequests:current!.pullRequests!.map(link=>{
    const next={...link,updatedAt:new Date().toISOString(),ciStatus:{...link.ciStatus,checkedAt:new Date().toISOString()}};
    if(change==="head")next.headSha="e".repeat(40);
    if(change==="merge")next.mergedCommitSha="e".repeat(40);
    if(change==="ci")next.ciStatus.state="failure";
    if(change==="revision")next.draftRevision="changed";
    if(change==="rollback")next.ciStatus.checkedAt=new Date(Date.now()-2000).toISOString();
    return next;
   })}),undefined,true);
  }
  return originalUpdate(...args);
 });
 if(change==="freshness")expect((await formReleaseEvidence(sid,s.connection.id))!.items[0].retestResult).toBe("pass");
 else await expect(formReleaseEvidence(sid,s.connection.id)).rejects.toThrow(/PR links changed/);
});
