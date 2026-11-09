import { resultForReviewItem, rollupControlResults, type ControlRollupRow } from "./control-rollup";
import type { PipelineEvidence } from "./pipeline-evidence";
import { restorePlan, type RemediationPlan } from "./remediation";

/** A saved assessment must match the asset, original release, hash and selected evidence. */
export function matchesRow(plan: RemediationPlan | null, row: ControlRollupRow): boolean {
  const r = row.result;
  return Boolean(plan && r && plan.assessment.scope?.controls.includes(row.id) && plan.asset === r.asset &&
    plan.source.pipelineId === r.sourceReleaseId && plan.source.pipelineUrl === r.sourceReleaseUrl &&
    plan.source.commit === r.sourceCommit && plan.source.releaseSha256 === r.sourceReleaseSha256 &&
    plan.source.reviewItem === r.finding &&
    plan.source.artifacts.length === r.sourceArtifacts.length &&
    plan.source.artifacts.every(a => r.sourceArtifacts.some(b => a.name === b.name && a.href === b.href)));
}

/** A human decision is not transferable to another retest, even of the same control. */
export function decisionPlan(plan: RemediationPlan | null, row: ControlRollupRow): RemediationPlan | null {
  if (!matchesRow(plan, row) || !plan) return null;
  const r = row.result!;
  const received = plan.receivedVerification;
  // Preserve explicitly authored draft decisions when no newer measured correction supersedes them.
  if (!r.correctiveReleaseId && !received) return plan;
  const bound = received && received.pipelineUrl === r.releaseUrl && received.commit === r.commit &&
    received.releaseSha256 === r.releaseSha256 && plan.tests.length === r.checks.length &&
    plan.tests.every(t => r.checks.some(c => c.description === t.description && c.href === t.evidence &&
      c.artifactSha256 === t.artifactSha256 && c.verdict === t.verdict && c.result === t.result && c.date === t.date));
  if (bound) return plan;
  return { ...plan, engineeringComplete: false, validationRecorded: false, readyForReview: false,
    closure: { ...plan.closure, recorded: false } };
}


/** The UI and export apply the same decision-to-retest binding rule. */
export function resolveDraftDecisions(plan: RemediationPlan, releases: PipelineEvidence[]): RemediationPlan {
  const rows = rollupControlResults(releases, plan.source.pipelineUrl);
  const original = releases.find(release => restorePlan(plan, release));
  const item = original?.reviewItems?.find(entry => entry.description === plan.source.reviewItem);
  if (original && item) for (const controlId of item.scope.controls) {
    const row = rows.find(candidate => candidate.id === controlId.toUpperCase());
    const result = resultForReviewItem(original, item, controlId, releases);
    if (row && result) row.result = result;
  }
  const row = rows.find(row => matchesRow(plan, row));
  return row ? decisionPlan(plan, row) ?? plan : plan;
}
