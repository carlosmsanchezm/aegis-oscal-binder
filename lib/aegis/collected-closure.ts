import { trustedReleases } from "../collector/trusted-release";
import { scannerRetestDiff } from "../collector/retest-diff";
import {
  readyToClose,
  type AttachedRetest,
  type PlanProposal,
} from "./plan-proposal";
import {
  closureProblems,
  normalizeStoredPlan,
  type RemediationPlan,
} from "./remediation";
import { AegisError } from "./errors";
import type { RemediationRecord } from "./remediation-store";
import { AWS_DEPLOYMENT_PRODUCER } from "../collector/aws/deployment-criteria";
import { awsIaCHeadProof } from "../collector/aws/head-proof";
/** Merge readiness is a separate claim from deployed-cloud closure. In particular,
 * Checkov head proof creates no passing AWS retest attachment. */
export async function collectedPrHeadProof(sessionId:string,sourceReleaseId:string,issueId:string,connectionId:string,headSha:string) {
  const releases=await trustedReleases(sessionId,connectionId);
  const before=releases.find(r=>r.pipelineId===sourceReleaseId||r.releaseSha256===sourceReleaseId||r.artifactJobId===sourceReleaseId);
  if(before?.observation.producer!==AWS_DEPLOYMENT_PRODUCER)
    return collectedScannerProof(sessionId,sourceReleaseId,issueId,connectionId,headSha);
  const head=awsIaCHeadProof(before,issueId,releases,headSha);
  return {ready:!!head,headReviewOnly:true,reviewBasis:"Collected Checkov validates proposed IaC only. Live deployed AWS retest is still required.",
    problems:head?[]:["Current-head collected Checkov proof is required for the exact IaC criterion and paths."],retests:[] as AttachedRetest[]};
}
/** Resolve both source and retest from server collector receipts. Caller verdicts and hashes are ignored. */
export async function collectedScannerProof(
  sessionId: string,
  sourceReleaseId: string,
  issueId: string,
  connectionId?: string,
  expectedCommit?: string,
  expectedReceipt?: string,
) {
  if (connectionId) {
    const emergency = (await (await import("../github/pull-requests")).pullRequestLinks(sessionId, connectionId)).findLast(l => l.sourceReleaseId === sourceReleaseId && l.findingId === issueId);
    if (emergency?.emergency) {
      if (!expectedCommit && (emergency.state !== "merged" || !emergency.mergedCommitSha ||
        !(await import("../github/pr-types")).ciGreenFor(emergency, emergency.mergedCommitSha)))
        return {ready: false as const, problems: ["Emergency change needs merged-commit CI."], retests: [] as AttachedRetest[]};
      const binding = !expectedCommit ? await (await import("../server/release-evidence")).releaseClosureBinding(sessionId, connectionId, emergency) : null;
      if (binding && !binding.verified) return {ready: false as const, problems: ["The shipped release has no passing emergency retest."], retests: [] as AttachedRetest[]};
      return (await import("../github/poam-gate")).collectedEmergencyProof(sessionId, emergency, expectedCommit ?? binding?.commit, expectedReceipt ?? binding?.receipt);
    }
  }
  const releases = await trustedReleases(sessionId, connectionId);
  const before = releases.find(
    (r) =>
      r.pipelineId === sourceReleaseId ||
      r.releaseSha256 === sourceReleaseId ||
      r.artifactJobId === sourceReleaseId,
  );
  const issue = before?.reviewItems?.find((i) => i.id === issueId);
  if (!before || !issue)
    return {
      ready: false as const,
      problems: ["Source finding needs a server collector receipt."],
      retests: [] as AttachedRetest[],
    };
  const boundConnectionId = connectionId ?? before.observation.connectionId;
  const links = boundConnectionId ? await (await import("../github/pull-requests")).pullRequestLinks(sessionId, boundConnectionId) : [];
  const link = links.findLast(l => l.findingId === issueId && l.sourceReleaseId === before.pipelineId);
  const cloud = before.observation.producer === AWS_DEPLOYMENT_PRODUCER;
  if (link && !expectedCommit) {
    const { ciGreenFor } = await import("../github/pr-types");
    if (!await (await import("../github/store")).activeInstallationRepo(link.installationId, link.owner, link.repo) || link.state !== "merged" || !link.mergedCommitSha || !ciGreenFor(link, link.mergedCommitSha))
      return {ready: false as const, problems: ["Linked PR needs merged-commit CI before closure review."], retests: [] as AttachedRetest[]};
  }
  const binding = link && !expectedCommit && boundConnectionId ?
    await (await import("../server/release-evidence")).releaseClosureBinding(sessionId, boundConnectionId, link) : null;
  if (binding && !binding.verified) return {ready: false as const, problems: ["The shipped release has no passing collected retest for this item."], retests: [] as AttachedRetest[]};
  const requiredCommit = expectedCommit ?? binding?.commit ?? link?.mergedCommitSha;
  const requiredReceipt = expectedReceipt ?? binding?.receipt;
  const receiptRelease = requiredReceipt ? releases.find(r=>r.releaseSha256===requiredReceipt) : undefined;
  const nativeReceipt = cloud && receiptRelease?.observation.producer === "GitHub Actions" ? receiptRelease : undefined;
  const after = [...releases]
    .reverse()
    .find((r) => (!requiredCommit || r.commitSha === requiredCommit) &&
      (!requiredReceipt || r.releaseSha256 === requiredReceipt || (!!nativeReceipt && nativeReceipt.commitSha===r.commitSha && Date.parse(r.createdAt)>=Date.parse(nativeReceipt.createdAt))) && scannerRetestDiff(before, r).comparable);
  if (!after || !scannerRetestDiff(before, after).fixed.includes(issue.id))
    return {
      ready: false as const,
      problems: [
        "No later complete, fresh collected retest proves this rule absent for this target.",
      ],
      retests: [] as AttachedRetest[],
    };
  const retests: AttachedRetest[] = issue.scope.verification.map(
    (description) => ({
      description,
      evidence:
        cloud ? after.pipelineUrl : after.observation.subject.id + "/actions/runs/" + after.artifactJobId,
      result: cloud ? "Live AWS collector: explicit PASS for this criterion in every originally bound account, partition and region." : "Collector scanner diff: rule absent for the original target.",
      date: after.createdAt.slice(0, 10),
      capturedAt: after.createdAt,
      reviewer: cloud ? "Operator-local AWS collector; server receipt verified" : "Server evidence collector",
      source_label: { kind: "server-collected" },
      verdict: "pass",
      evidenceState: "pass",
      releaseId: after.pipelineId,
    }),
  );
  return {
    ready: readyToClose(issue.scope.verification, retests),
    problems: [] as string[],
    retests,
    source: before,
    retest: after,
    issue,
  };
}
/** Durable mutation boundary shared by MCP and existing HTTP/UI save handlers. */
export function proposalConnectionId(key: string): string | undefined {
  return /^binder\.plan-proposals\.v1:binder-connection:([a-f0-9-]{36})$/.exec(
    key,
  )?.[1];
}
export async function assertCollectedRecord(
  sessionId: string,
  record: RemediationRecord,
) {
  const connectionId = proposalConnectionId(record.key);
  for (const value of [
    ...(record.proposals ?? []),
    ...(record.issueDrafts ?? []),
  ]) {
    const p = value as PlanProposal;
    if (
      !p.closureConfirmed &&
      !p.readyToClose &&
      p.workflowState !== "ready-for-closure-review" &&
      p.workflowState !== "closed-externally"
    )
      continue;
    const issueId = p.id.split(":").at(-1) ?? "";
    if (!connectionId)
      throw new AegisError(
        "EVIDENCE_REQUIRED",
        "A connection-bound proposal record is required for closure.",
        409,
      );
    const proof = await collectedScannerProof(
      sessionId,
      p.sourceReleaseId,
      issueId,
      connectionId,
    );
    if (!proof.ready)
      throw new AegisError("EVIDENCE_REQUIRED", proof.problems.join(" "), 409);
    if (
      p.finding !== proof.issue!.description ||
      !proof.issue!.scope.controls.includes(p.controlId)
    )
      throw new AegisError(
        "EVIDENCE_REQUIRED",
        "Closure must bind to the exact collected finding and control.",
        409,
      );
  }
  for (const value of record.plans) {
    const p = normalizeStoredPlan(value);
    if (!p || (!p.readyForReview && !p.closure?.recorded)) continue;
    const releases = await trustedReleases(sessionId);
    const source = releases.find((r) => r.pipelineId === p.source?.pipelineId);
    const issue = source?.reviewItems?.find(
      (i) => i.description === p.source.reviewItem,
    );
    const proof = issue
      ? await collectedScannerProof(sessionId, source!.pipelineId, issue.id)
      : null;
    if (!proof?.ready)
      throw new AegisError(
        "EVIDENCE_REQUIRED",
        "Collected retest evidence is required; supplied retest packets cannot earn closure.",
        409,
      );
    if (p.closure.recorded && closureProblems(p).length)
      throw new AegisError(
        "EVIDENCE_REQUIRED",
        closureProblems(p).join(" "),
        409,
      );
  }
}

/** Recompute measured state on read/export; persisted caller flags and old retests are not proof. */
export async function collectedProposal(
  sessionId: string,
  proposal: PlanProposal,
  connectionId?: string,
): Promise<PlanProposal> {
  const link = connectionId ? (await (await import("../github/pull-requests")).pullRequestLinks(sessionId, connectionId)).findLast(l => l.poamItemId === proposal.id) : undefined;
  if (!proposal.id.split(":").at(-1)?.startsWith("scan-") && !link?.emergency) return {...proposal, pullRequest: link};
  const proof = connectionId
    ? await collectedScannerProof(
        sessionId,
        proposal.sourceReleaseId,
        proposal.id.split(":").at(-1)!,
        connectionId,
      )
    : { ready: false, retests: [], retest: undefined };
  return {
    ...proposal,
    ...(connectionId ? {pullRequest: (await (await import("../github/pull-requests")).pullRequestLinks(sessionId, connectionId)).findLast(l => l.poamItemId === proposal.id)} : {}),
    retests: proof.retests,
    correctiveReleaseId: ("retest" in proof ? proof.retest?.pipelineId : undefined) ?? "",
    readyToClose: proof.ready && proposal.closure_review?.state !== "rejected",
    closureConfirmed: false,
    workflowState:
      proposal.closure_review?.state === "rejected"
        ? proposal.closure_review.prior_step
        : proof.ready
          ? "ready-for-closure-review"
          : "planned",
  };
}
