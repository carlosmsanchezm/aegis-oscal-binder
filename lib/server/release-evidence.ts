import { createHash } from "node:crypto";
import { readRemediation, updateRemediationRecord } from "../aegis/remediation-store";
import { activePrLinks, type ReleaseEvidence, type ReleaseItem } from "../aegis/release-evidence";
import { trustedReleases } from "../collector/trusted-release";
import { scannerRetestDiff } from "../collector/retest-diff";
import { collectedScannerProof } from "../aegis/collected-closure";
import { readyToClose, type PlanProposal } from "../aegis/plan-proposal";
import { ciGreenFor, type PullRequestLink } from "../github/pr-types";
import { connectedPrRepo, prRecordKey, readPrSnapshot } from "../github/pull-requests";
import { withScanInstallation } from "../github/auth";
import { releaseRange } from "../github/release-range";
import { sealCollectedArtifact } from "../collector/seal";
import { collectorEvents } from "../collector/events";
import { readConnection, retainEvent } from "./builder-store";
import { appendTimeline } from "../timeline/store";
import type { SystemObservationEvidence } from "../aegis/pipeline-evidence";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function record(session: string, connection: string) {
  return (await readRemediation(session))?.records.find(r => r.key === prRecordKey(connection));
}
/** A fresh observation of identical CI is not a different proof binding. */
function unchangedPrProof(before:PullRequestLink[],current:PullRequestLink[]){
  const identity=(links:PullRequestLink[])=>links.map(({updatedAt:_updated,ciStatus:{checkedAt:_checked,...ciStatus},...link})=>({...link,ciStatus}));
  if(JSON.stringify(identity(before))!==JSON.stringify(identity(current)))return false;
  return before.every((link,i)=>{
    const previous=Date.parse(link.ciStatus.checkedAt),next=Date.parse(current[i].ciStatus.checkedAt);
    return Number.isFinite(previous)&&Number.isFinite(next)&&next>=previous&&next<=Date.now()+300_000;
  });
}
async function evaluate(session: string, connection: string, release: SystemObservationEvidence, link: PullRequestLink, proposal?: PlanProposal): Promise<ReleaseItem> {
  const runs = (link.ciStatus.runs ?? []).filter(run => /^[1-9][0-9]*$/.test(run.id) &&
    run.url.startsWith("https://github.com/" + link.owner + "/" + link.repo + "/") &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:actions\/runs\/[1-9][0-9]*(?:\/job\/[1-9][0-9]*)?|runs\/[1-9][0-9]*)$/.test(run.url));
  const item: ReleaseItem = {
    poamItemId: link.poamItemId, findingId: link.findingId, sourceReleaseId: link.sourceReleaseId,
    controlId: proposal?.controlId ?? "", prNumber: link.prNumber, prUrl: link.prUrl,
    mergeSha: link.mergedCommitSha!, ciRunId: runs[0]?.id ?? "", ciRunUrl: runs[0]?.url ?? "", ciRuns: runs,
    retestResult: "unverified",
  };
  if (!proposal || !ciGreenFor(link, item.mergeSha) || !runs.length) return item;
  const proof = await collectedScannerProof(session, link.sourceReleaseId, link.findingId, connection, release.commitSha, release.releaseSha256);
  if (proof.ready && readyToClose(proposal.provingChecks, proof.retests)) {
    item.retestResult = "pass";
    item.retestReceiptId = proof.retest!.releaseSha256;
  } else {
    const before = (await trustedReleases(session, connection)).find(r => r.pipelineId === link.sourceReleaseId);
    if (before && scannerRetestDiff(before, release).remaining.includes(link.findingId)) item.retestResult = "remaining";
  }
  return item;
}

/** Internal hook after trusted collection. Supplied pipeline notifications cannot create this projection. */
export async function formReleaseEvidence(session: string, connection: string, receiptId?: string) {
  const releases = (await trustedReleases(session, connection)).filter(r=>r.observation.producer==="GitHub Actions");
  const release = receiptId ? releases.find(r => r.releaseSha256 === receiptId) : releases.at(-1);
  if (!release) return null;
  const g = await connectedPrRepo(connection);
  const repository = "https://github.com/" + g.owner + "/" + g.repo;
  if (release.observation.subject.id.toLowerCase() !== repository.toLowerCase() || release.observation.producer !== "GitHub Actions")
    throw new Error("Release does not belong to the connected repository.");
  const prior = releases.filter(r => r.observation.subject.id === release.observation.subject.id &&
    Date.parse(r.createdAt) < Date.parse(release.createdAt)).at(-1);
  if (receiptId) {
    const beforeRefresh = await record(session, connection);
    const merged = activePrLinks(beforeRefresh?.pullRequests ?? []).filter(link => link.state === "merged");
    if (merged.length > 100) throw new Error("Release item limit exceeded.");
    const snapshots = new Map<number, Awaited<ReturnType<typeof readPrSnapshot>> | null>();
    for (const link of merged) if (!snapshots.has(link.prNumber)) {
      try {snapshots.set(link.prNumber, await readPrSnapshot(g, link.prNumber));}
      catch {snapshots.set(link.prNumber, null);}
    }
    if (merged.length) await updateRemediationRecord(session, prRecordKey(connection), async current => {
      if (!current) throw new Error("Remediation record unavailable.");
      return {...current, pullRequests: current.pullRequests?.map(link => {
        if (!merged.some(l => l === link || (l.poamItemId === link.poamItemId && l.draftRevision === link.draftRevision && l.prNumber === link.prNumber))) return link;
        const snapshot = snapshots.get(link.prNumber);
        const ciStatus = snapshot?.state === "merged" && snapshot.mergedCommitSha === link.mergedCommitSha ?
          snapshot.ciStatus : {sha: link.mergedCommitSha!, state: "pending" as const, checks: 0, runs: [], checkedAt: new Date().toISOString()};
        return {...link, ciStatus, updatedAt: new Date().toISOString()};
      })};
    }, undefined, true);
  }
  const stored = await record(session, connection);
  const links = activePrLinks(stored?.pullRequests ?? []).filter(link => link.connectionId === connection &&
    link.owner.toLowerCase() === g.owner.toLowerCase() && link.repo.toLowerCase() === g.repo.toLowerCase() &&
    link.installationId === g.installationId && link.state === "merged" && link.mergedCommitSha);
  if (links.length > 100) throw new Error("Release item limit exceeded.");
  let included = new Set<string>(), rangeProblem: string | undefined;
  try {
    if (links.length || prior) included = await withScanInstallation(g.installationId, g.repo, ({octokit}) =>
      releaseRange(octokit, g.owner, g.repo, prior?.commitSha ?? "", release.commitSha, links.map(link => link.mergedCommitSha!)));
  } catch {
    rangeProblem = "Complete bounded GitHub commit range unavailable; no closure proof granted.";
  }
  const previousBundle = stored?.releaseEvidence?.find(b => b.releaseSha256 === prior?.releaseSha256);
  const proposals = [...(stored?.proposals ?? []), ...(stored?.issueDrafts ?? [])] as PlanProposal[];
  const items: ReleaseItem[] = [];
  for (const link of links) {
    const carried = previousBundle?.rangeStatus === "verified" && previousBundle.items.some(item => item.poamItemId === link.poamItemId && item.mergeSha === link.mergedCommitSha);
    if (!rangeProblem && !included.has(link.mergedCommitSha!) && !carried) continue;
    const item = await evaluate(session, connection, release, link, proposals.find(p => p.id === link.poamItemId));
    if (carried && !included.has(link.mergedCommitSha!)) item.carriedForward = true;
    if (rangeProblem) {item.retestResult = "unverified"; delete item.retestReceiptId;}
    items.push(item);
  }
  const bundle: ReleaseEvidence = {
    schema: "binder.release-evidence.v1", connectionId: connection, repository,
    releaseId: release.pipelineId, releaseSha256: release.releaseSha256, commitSha: release.commitSha,
    previousCommitSha: prior?.commitSha ?? "", tagOrDeploy: release.artifactJobId,
    collectedAt: release.createdAt, releaseUrl: repository + "/actions/runs/" + release.artifactJobId,
    rangeStatus: rangeProblem ? "unverified" : "verified", ...(rangeProblem ? {rangeProblem} : {}),
    remainingControls: [...new Set(release.reviewItems?.flatMap(item => item.scope.controls) ?? [])], items,
  };
  // Retain the shared evidence/audit bytes before publishing a passing read projection.
  await retainBundleFacts(bundle);
  await updateRemediationRecord(session, prRecordKey(connection), async current => {
    const currentLinks=current?.pullRequests??[];
    if (!unchangedPrProof(stored?.pullRequests??[],currentLinks)||bundle.items.some(item=>item.retestResult==="pass"&&!currentLinks.some(link=>link.poamItemId===item.poamItemId&&link.prNumber===item.prNumber&&link.mergedCommitSha===item.mergeSha&&ciGreenFor(link,item.mergeSha))))
      throw new Error("PR links changed during release projection; collect again.");
    return {...(current ?? {key: prRecordKey(connection), plans: [], assessment: null, assessments: {}}),
      releaseEvidence: [...(current?.releaseEvidence ?? []).filter(b => b.releaseSha256 !== bundle.releaseSha256), bundle]};
  }, undefined, false, true);
  await (await import("../agent/fix-runner")).refreshFixRunner(session, connection);
  return bundle;
}

/** Read projections recheck current CI and scanner freshness; old green flags are never proof. */
async function readReleaseEvidence(session: string, connection: string, selected?: {receipt: string; item: string; merge?: string}): Promise<ReleaseEvidence[]> {
  const c = await readConnection(connection);
  if (!c || c.revokedAt) return [];
  try {await connectedPrRepo(connection);} catch {return [];}
  const stored = await record(session, connection);
  const releases = (await trustedReleases(session, connection)).filter(r=>r.observation.producer==="GitHub Actions");
  const links = activePrLinks(stored?.pullRequests ?? []);
  const proposals = [...(stored?.proposals ?? []), ...(stored?.issueDrafts ?? [])] as PlanProposal[];
  const output: ReleaseEvidence[] = [];
  for (const bundle of stored?.releaseEvidence ?? []) {
    if (selected && bundle.releaseSha256 !== selected.receipt) continue;
    const release = releases.find(r => r.releaseSha256 === bundle.releaseSha256 && r.commitSha === bundle.commitSha);
    if (!release || bundle.connectionId !== connection) continue;
    const items: ReleaseItem[] = [];
    for (const item of bundle.items) {
      if (selected && (item.poamItemId !== selected.item || item.mergeSha !== selected.merge)) continue;
      const link = links.find(l => l.poamItemId === item.poamItemId && l.state === "merged" && l.mergedCommitSha === item.mergeSha);
      const current = link ? await evaluate(session, connection, release, link, proposals.find(p => p.id === item.poamItemId)) :
        {...item, retestResult: "unverified" as const, retestReceiptId: undefined};
      items.push({...current, ...(item.carriedForward ? {carriedForward: true} : {}),
        ...(bundle.rangeStatus === "unverified" ? {retestResult: "unverified" as const, retestReceiptId: undefined} : {})});
    }
    output.push({...bundle, items});
  }
  const latest = releases.at(-1);
  if (latest && stored?.releaseEvidence?.length && !output.some(bundle => bundle.releaseSha256 === latest.releaseSha256)) {
    output.push({schema: "binder.release-evidence.v1", connectionId: connection,
      repository: latest.observation.subject.id, releaseId: latest.pipelineId,
      releaseSha256: latest.releaseSha256, commitSha: latest.commitSha,
      previousCommitSha: releases.at(-2)?.commitSha ?? "", tagOrDeploy: latest.artifactJobId,
      collectedAt: latest.createdAt, releaseUrl: latest.observation.subject.id + "/actions/runs/" + latest.artifactJobId,
      rangeStatus: "unverified", rangeProblem: "Trusted release retained; bundle projection needs collection retry.", items: []});
  }
  return output.sort((a,b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
}

export async function releaseEvidenceFor(session: string, connection: string): Promise<ReleaseEvidence[]> {
  return readReleaseEvidence(session, connection);
}

async function retainBundleFacts(bundle: ReleaseEvidence) {
  const hash = digest(JSON.stringify(bundle));
  const artifact = sealCollectedArtifact({
    schema: "aegis.collected-artifact.v1", name: "source-" + hash.slice(0,24) + ".json", type: "change-control",
    source: {kind: "release-asset", repo: bundle.repository, commit: bundle.commitSha,
      path: "releases/" + bundle.releaseId + "/bundle.json", url: bundle.releaseUrl, sha256: hash},
    capturedAt: bundle.collectedAt, sha256: "0".repeat(64),
    facts: Object.entries(Object.assign({"release.commit": bundle.commitSha, "release.receipt": bundle.releaseSha256,
      "release.range": bundle.rangeStatus}, ...bundle.items.map(item => {
      const field = "item." + digest(item.poamItemId).slice(0,24);
      return {[field + ".result"]: item.retestResult, [field + ".id"]: item.poamItemId,
        [field + ".control"]: item.controlId || "unmapped", [field + ".pr"]: item.prNumber,
        [field + ".merge"]: item.mergeSha, [field + ".ci"]: item.ciRunId || "unverified"};
    }))).map(([field, value]) => ({key: "change-control", field, value: value as string | number,
      content: field + " = " + value, line: 1})),
    limitations: ["Per-item collected scanner proof only. Human closure and agency acceptance remain separate.",
      "Commit range and PR CI are not a control authorization.", "Connecting a repository does not authorize processing agency evidence."],
  });
  for (const event of collectorEvents([artifact], {snapshotDigest: hash})) await retainEvent(bundle.connectionId, event.rawEvent, undefined, "browser-owner", true);
  await appendTimeline(bundle.connectionId, {
    id: "release-bundle-" + hash, kind: "monitoring-capture", source: {repo: bundle.repository, url: bundle.releaseUrl},
    commit: bundle.commitSha, observedAt: bundle.collectedAt, artifactSha256: [artifact.sha256],
    controls: [...new Set(["CM-3", ...bundle.items.map(item => item.controlId).filter(Boolean)])],
    findings: bundle.items.map(item => item.findingId), items: bundle.items.map(item => item.poamItemId),
    collected: true, reason_code: "release_bundle_collected",
    summary: {releaseId: bundle.releaseId, passed: bundle.items.filter(item => item.retestResult === "pass").length, humanClosure: "false"},
  });
}

/** null preserves legacy exact-merge proof where no bundle has ever been formed. */
export async function releaseClosureBinding(session: string, connection: string, link: PullRequestLink) {
  const latest = (await trustedReleases(session, connection)).filter(r=>r.observation.producer==="GitHub Actions").at(-1);
  if (!latest) return null;
  const bundle = (await readReleaseEvidence(session, connection, {receipt: latest.releaseSha256,
    item: link.poamItemId, merge: link.mergedCommitSha})).find(b => b.releaseSha256 === latest.releaseSha256);
  if (!bundle) return (await record(session, connection))?.releaseEvidence?.length ? {verified: false, commit: latest.commitSha, receipt: latest.releaseSha256} : null;
  const item = bundle.items.find(i => i.poamItemId === link.poamItemId && i.mergeSha === link.mergedCommitSha);
  return {verified: item?.retestResult === "pass", commit: bundle.commitSha, receipt: item?.retestReceiptId ?? bundle.releaseSha256};
}

/** Derive the corrective release reference without recording ISSE/ISSO decisions. */
export async function projectPlanRelease(session: string, plan: import("../aegis/remediation").RemediationPlan, bundles: ReleaseEvidence[]) {
  const latest = new Map(bundles.map(bundle => [bundle.connectionId, bundle]));
  for (const bundle of latest.values()) {
    const source = (await trustedReleases(session, bundle.connectionId)).find(r => r.pipelineId === plan.source.pipelineId &&
      (!plan.source.releaseSha256 || r.releaseSha256 === plan.source.releaseSha256));
    const finding = source?.reviewItems?.find(issue => issue.description === plan.source.reviewItem);
    if (bundle.items.some(item => item.findingId === finding?.id && item.sourceReleaseId === source?.pipelineId &&
      item.controlId === plan.control && item.retestResult === "pass"))
      return {...plan, releaseRef: bundle.releaseId, releaseUrl: bundle.releaseUrl};
  }
  return plan;
}
