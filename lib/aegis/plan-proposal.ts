import {
  mergeStoredReleases,
  resultForReviewItem,
  rollupControlResults,
  type ProvenResult,
} from "./control-rollup";
import { CCM_EXAMPLE, type PipelineEvidence } from "./pipeline-evidence";
import {
  parsePipelineVerification,
  type PipelineVerification,
} from "./pipeline-verification";
import type { CheckState } from "../builder/evidence";

/**
 * A proposed plan of action is a draft. It is not an accepted record,
 * a closure, or an agency identifier. Retest evidence is attached only
 * from stored measured checks.
 */
export type AttachedRetest = {
  source_label?: import("./item-source").ItemSource;
  description: string;
  evidence: string;
  result: string;
  date: string;
  capturedAt?: string;
  reviewer: string;
  verdict: "pass" | "fail" | "";
  releaseId: string;
  reportedVerdict?: "pass" | "fail" | "unknown";
  evidenceState?: CheckState;
  validUntil?: string;
};

export type PlanMilestoneDraft = { description: string; target: string };

export type PlainPlan = {
  whatIsWrong: string;
  whyItMatters: string;
  whatWeWillDo: string;
  whoOwnsIt: string;
  doneWhen: string;
  dueBy: string;
  status:
    | "Drafted"
    | "Accepted"
    | "Retest passed"
    | "Closure proposed"
    | "Closed";
};
export type ClosureDecision = { name: string; reason: string; at: string };
export type PlanProposal = {
  pullRequest?: import("../github/pr-types").PullRequestLink;
  draft_revision?: string;
  source_label?: import("./item-source").ItemSource;
  agent_draft_fields?: string[];
  closure_review?: {
    id?: string;
    state?: "requested" | "rejected";
    rejected_at?: string;
    requested_at: string;
    token_id?: string;
    prior_step: import("./gates/types").WorkflowState;
  };

  workflowState?: import("./gates/types").WorkflowState;
  plain?: PlainPlan;
  owner?: string;
  closure?: ClosureDecision;
  id: string;
  controlId: string;
  finding: string;
  findingTitle: string;
  riskStatement: string;
  action: string;
  milestone: PlanMilestoneDraft;
  provingChecks: string[];
  retests: AttachedRetest[];
  acceptance: "proposed" | "accepted";
  readyToClose: boolean;
  closureConfirmed: boolean;
  officialId: string;
  sourceReleaseId: string;
  correctiveReleaseId: string;
  result?: ProvenResult;
};

/** Person-recorded edits. Measured retests are never taken from this record. */
export type PlanDecision = {
  draft_revision?: string;
  plain?: PlainPlan;
  owner?: string;
  closure?: ClosureDecision;
  schema: "binder.plan-proposal.v1";
  id: string;
  controlId: string;
  finding: string;
  sourceReleaseId: string;
  riskStatement: string;
  action: string;
  milestone: PlanMilestoneDraft;
  acceptance: "proposed" | "accepted";
  closureConfirmed: boolean;
  officialId: string;
};

const DECISION_SCHEMA = "binder.plan-proposal.v1";

function trimmed(value: string): string {
  return value.trim();
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function controlKey(id: string): string {
  return id.trim().toUpperCase();
}

export function plainPlan(proposal: PlanProposal): PlainPlan {
  return {
    whatIsWrong: proposal.finding,
    whyItMatters: proposal.riskStatement,
    whatWeWillDo: proposal.action,
    whoOwnsIt: proposal.owner?.trim() || "Unassigned",
    doneWhen: proposal.milestone.description,
    dueBy: proposal.milestone.target,
    status: proposal.closureConfirmed
      ? "Closed"
      : proposal.readyToClose
        ? "Closure proposed"
        : proposal.acceptance === "accepted"
          ? "Accepted"
          : "Drafted",
  };
}
export function proposalStatus(proposal: PlanProposal): string {
  if (proposal.closureConfirmed)
    return `Closed · Closure confirmed by a person · ${proposal.officialId.trim() ? `official plan id ${proposal.officialId.trim()}` : "official plan id blank"}`;
  if (proposal.readyToClose)
    return (
      "Closure proposed · " +
      (proposal.acceptance === "accepted"
        ? "Accepted · ready to close · needs a person"
        : "Drafted · needs a person")
    );

  if (
    proposal.acceptance === "accepted" &&
    proposal.retests.some((r) => r.evidenceState === "stale")
  )
    return "Accepted · retest expired";
  if (proposal.acceptance === "accepted") return "Accepted · open";
  return proposal.retests.some((r) => r.evidenceState === "stale")
    ? "Drafted · retest expired · Proposed · not accepted"
    : "Drafted · Proposed · not accepted";
}

/** A plan closure must be visible without concealing another finding on the control. */
export function controlPlanLabel(proposals: PlanProposal[]): string | null {
  const closed = proposals.filter(
    (proposal) => proposal.closureConfirmed,
  ).length;
  if (!closed) return null;
  const open = proposals.length - closed;
  return open ? `Closed · ${open} open` : "Closed";
}

function reviewItemFor(
  releases: PipelineEvidence[],
  controlId: string,
  finding: string,
  result: ProvenResult,
) {
  const key = controlKey(controlId);
  for (const release of releases) {
    if (
      release.pipelineUrl !== result.sourceReleaseUrl ||
      release.commitSha !== result.sourceCommit ||
      release.releaseSha256 !== result.sourceReleaseSha256
    )
      continue;
    const item = release.reviewItems?.find(
      (entry) =>
        (!result.reviewItemId || entry.id === result.reviewItemId) &&
        entry.description === finding &&
        entry.scope?.controls.some((id) => controlKey(id) === key),
    );
    if (item?.scope) return item;
  }
  return undefined;
}

function engineeringFor(
  releases: PipelineEvidence[],
  controlId: string,
  finding: string,
  result: ProvenResult,
): PipelineVerification["engineering"] | undefined {
  const key = controlKey(controlId);
  for (const release of releases) {
    if (
      !result.correctiveReleaseId ||
      release.pipelineUrl !== result.correctiveReleaseUrl ||
      release.commitSha !== result.commit ||
      release.releaseSha256 !== result.releaseSha256 ||
      !release.verification?.engineering
    )
      continue;
    let verification: PipelineVerification;
    try {
      verification = parsePipelineVerification(release.verification, release);
    } catch {
      continue;
    }
    if (!verification.engineering) continue;
    const bound = releases.some(
      (original) =>
        original.pipelineUrl === verification.sourcePipelineUrl &&
        original.commitSha === verification.sourceCommit &&
        original.releaseSha256 === verification.sourceReleaseSha256 &&
        original.reviewItems?.some(
          (item) =>
            item.description === finding &&
            item.scope?.controls.some((id) => controlKey(id) === key),
        ),
    );
    if (bound) return verification.engineering;
  }
  return undefined;
}

function attachedRetests(result: ProvenResult): AttachedRetest[] {
  const releaseId = result.correctiveReleaseId || result.releaseId;
  return result.checks
    .filter((check) => trimmed(check.description))
    .map((check) => ({
      description: check.description,
      evidence: check.href,
      result: check.result,
      date: check.date,
      capturedAt: result.createdAt,
      reviewer: check.reviewer,
      verdict:
        check.verdict === "pass" || check.verdict === "fail"
          ? check.verdict
          : "",
      releaseId,
      reportedVerdict: check.reportedVerdict,
      evidenceState: check.evidenceState,
      validUntil: check.validUntil,
    }));
}

export function readyToClose(
  provingChecks: string[],
  retests: AttachedRetest[],
): boolean {
  if (!provingChecks.length) return false;
  return provingChecks.every((description) =>
    retests.some(
      (retest) =>
        retest.description === description &&
        retest.verdict === "pass" &&
        (!retest.evidenceState || retest.evidenceState === "pass") &&
        trimmed(retest.result) &&
        trimmed(retest.evidence) &&
        isDate(retest.date) &&
        trimmed(retest.reviewer),
    ),
  );
}

function proposedRisk(finding: string, recorded: string): string {
  const risk = trimmed(recorded);
  if (risk) return risk;
  return `${trimmed(finding)} No separate risk rationale is recorded. Agency risk acceptance is not recorded.`;
}

function proposedAction(
  controlId: string,
  provingChecks: string[],
  recorded: string,
): string {
  const action = trimmed(recorded);
  if (action) return action;
  const checks = provingChecks.filter((check) => trimmed(check));
  const criteria = checks.join("; ").trim();
  const retest = criteria
    ? ` The retest that would prove the fix is: ${criteria}${/[.!?]$/.test(criteria) ? "" : "."}`
    : "";
  return `Address the recorded finding on ${controlId}.${retest}`;
}

function proposedMilestone(
  provingChecks: string[],
  recorded: PipelineVerification["engineering"] | undefined,
): PlanMilestoneDraft {
  const milestone = recorded?.milestones.find((item) =>
    trimmed(item.description),
  );
  if (milestone)
    return {
      description: trimmed(milestone.description),
      target: isDate(milestone.target) ? milestone.target : "",
    };
  const checks = provingChecks.filter((check) => trimmed(check));
  return {
    description: checks.length
      ? `Prove the fix: ${checks.join("; ")}`
      : "Prove the fix with a recorded retest",
    target: "",
  };
}

function proposalId(
  controlId: string,
  sourceReleaseId: string,
  reviewId: string,
): string {
  const slug = /^[A-Za-z0-9_.-]{1,80}$/.test(reviewId) ? reviewId : "finding";
  return `proposal:${controlKey(controlId)}:${sourceReleaseId}:${slug}`;
}

function toProposal(
  result: ProvenResult,
  releases: PipelineEvidence[],
): PlanProposal | null {
  const finding = trimmed(result.finding);
  if (!finding) return null;
  const controlId = controlKey(result.controlId);
  const item = reviewItemFor(releases, controlId, finding, result);
  const engineering = engineeringFor(releases, controlId, finding, result);
  const recordedChecks = result.checks
    .map((check) => check.description)
    .filter((description) => trimmed(description));
  const provingChecks = recordedChecks.length
    ? recordedChecks
    : (item?.scope.verification ?? [])
        .map((description) => trimmed(description))
        .filter(Boolean);
  const retests = attachedRetests(result);
  return {
    id: proposalId(controlId, result.sourceReleaseId, item?.id ?? "finding"),
    controlId,
    finding,
    findingTitle: trimmed(
      result.findingTitle || item?.scope.title || controlId,
    ),
    riskStatement: proposedRisk(finding, engineering?.risk ?? ""),
    action: proposedAction(controlId, provingChecks, engineering?.action ?? ""),
    milestone: proposedMilestone(provingChecks, engineering),
    provingChecks,
    retests,
    acceptance: "proposed",
    readyToClose: readyToClose(provingChecks, retests),
    closureConfirmed: false,
    officialId: "",
    sourceReleaseId: result.sourceReleaseId,
    correctiveReleaseId: result.correctiveReleaseId,
    result,
  };
}

/**
 * One proposed entry per scoped finding and control, including multiple findings on one control.
 * The catalog and profile decide which controls are in the posture.
 * The pipeline mapping decides which artifact links to that control.
 * A blank control stays blank.
 */
export function proposePlans(releases: PipelineEvidence[]): PlanProposal[] {
  if (!releases.length) return [];
  const source = releases[0]?.pipelineUrl ?? CCM_EXAMPLE.pipelineUrl;
  const stored = mergeStoredReleases(releases, source);
  const inPosture = new Set(
    rollupControlResults(stored, source).map((row) => row.id),
  );
  const proposals: PlanProposal[] = [];
  for (const release of stored) {
    for (const item of release.reviewItems ?? []) {
      // Scanner findings need an explicit AI draft action before they become plans.
      if (item.id.startsWith("scan-")) continue;
      for (const controlId of [
        ...new Set(item.scope.controls.map(controlKey)),
      ]) {
        if (!inPosture.has(controlId)) continue;
        const result = resultForReviewItem(release, item, controlId, stored);
        if (!result?.finding.trim()) continue;
        const proposal = toProposal(result, stored);
        if (proposal) proposals.push(proposal);
      }
    }
  }
  return proposals.map((proposal) => ({
    ...proposal,
    plain: plainPlan(proposal),
  }));
}

/** Keep a person's edits. Recompute retest links from stored releases. */
export function applyDecision(
  computed: PlanProposal,
  saved: PlanDecision | null,
): PlanProposal {
  if (
    !saved ||
    saved.id !== computed.id ||
    saved.finding !== computed.finding ||
    (computed.draft_revision &&
      saved.draft_revision !== computed.draft_revision)
  )
    return computed;
  const closureConfirmed =
    saved.acceptance === "accepted" &&
    saved.closureConfirmed === true &&
    computed.readyToClose &&
    Boolean(
      saved.closure?.name.trim() &&
        saved.closure.reason.trim() &&
        Number.isFinite(Date.parse(saved.closure.at)),
    );
  // Repair only the exact earlier generated default; preserve reviewer-authored actions.
  const legacyDefault = `Address the recorded finding on ${computed.controlId}. The retest that would prove the fix is: ${computed.provingChecks.filter((check) => trimmed(check)).join("; ")}.`;
  const action =
    saved.action === legacyDefault &&
    computed.action === legacyDefault.slice(0, -1)
      ? computed.action
      : saved.action;
  const applied: PlanProposal = {
    ...computed,
    riskStatement: saved.riskStatement,
    action,
    milestone: {
      description: saved.milestone.description,
      target: isDate(saved.milestone.target) ? saved.milestone.target : "",
    },
    acceptance: saved.acceptance,
    closureConfirmed,
    readyToClose: computed.readyToClose && !closureConfirmed,
    ...(computed.id.split(":").at(-1)?.startsWith("scan-")
      ? {
          workflowState: closureConfirmed
            ? ("closed-externally" as const)
            : computed.readyToClose
              ? ("ready-for-closure-review" as const)
              : (computed.workflowState ?? ("planned" as const)),
        }
      : {}),
    officialId: trimmed(saved.officialId),
    owner: saved.owner ?? "",
    closure: closureConfirmed ? saved.closure : undefined,
  };
  return { ...applied, plain: plainPlan(applied) };
}

export function decisionFromProposal(
  proposal: PlanProposal,
  patch: Partial<
    Pick<
      PlanDecision,
      | "riskStatement"
      | "action"
      | "milestone"
      | "acceptance"
      | "closureConfirmed"
      | "officialId"
      | "owner"
      | "closure"
    >
  > = {},
): PlanDecision {
  const milestone = patch.milestone ?? proposal.milestone;
  return {
    schema: DECISION_SCHEMA,
    ...(proposal.draft_revision
      ? { draft_revision: proposal.draft_revision }
      : {}),
    id: proposal.id,
    controlId: proposal.controlId,
    finding: proposal.finding,
    sourceReleaseId: proposal.sourceReleaseId,
    riskStatement: patch.riskStatement ?? proposal.riskStatement,
    action: patch.action ?? proposal.action,
    milestone: {
      description: milestone.description,
      target: isDate(milestone.target) ? milestone.target : "",
    },
    acceptance: patch.acceptance ?? proposal.acceptance,
    closureConfirmed: patch.closureConfirmed ?? proposal.closureConfirmed,
    officialId: trimmed(patch.officialId ?? proposal.officialId),
    owner: plainPlan({ ...proposal, ...patch, milestone }).whoOwnsIt,
    closure: patch.closure ?? proposal.closure,
    plain: plainPlan({ ...proposal, ...patch, milestone }),
  };
}

function bounded(value: unknown, max = 12000): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  return value;
}

/** Restore a person's decision. Reject anything that is not a bounded draft record. */
export function normalizePlanDecision(value: unknown): PlanDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<PlanDecision>;
  const id = bounded(record.id, 200);
  const controlId = bounded(record.controlId, 80);
  const finding = bounded(record.finding);
  const sourceReleaseId = bounded(record.sourceReleaseId, 40);
  const riskStatement = bounded(
    record.plain?.whyItMatters ?? record.riskStatement,
  );
  const action = bounded(record.plain?.whatWeWillDo ?? record.action);
  const officialId = bounded(record.officialId, 200);
  if (
    record.schema !== DECISION_SCHEMA ||
    !id ||
    !controlId ||
    finding == null ||
    !sourceReleaseId ||
    riskStatement == null ||
    action == null ||
    officialId == null
  )
    return null;
  if (record.acceptance !== "proposed" && record.acceptance !== "accepted")
    return null;
  if (typeof record.closureConfirmed !== "boolean") return null;
  const milestone = record.milestone;
  if (!milestone || typeof milestone !== "object") return null;
  const description = bounded(record.plain?.doneWhen ?? milestone.description);
  const target = bounded(record.plain?.dueBy ?? milestone.target, 10);
  if (
    description == null ||
    target == null ||
    (target !== "" && !isDate(target))
  )
    return null;
  const owner = bounded(record.plain?.whoOwnsIt ?? record.owner ?? "", 200);
  if (owner === null) return null;
  if (!/^proposal:[A-Z0-9.-]+:[^:]+:[A-Za-z0-9_.-]+$/.test(id)) return null;
  return {
    schema: DECISION_SCHEMA,
    ...(typeof record.draft_revision === "string" &&
    /^[a-f0-9-]{36}$/.test(record.draft_revision)
      ? { draft_revision: record.draft_revision }
      : {}),
    id,
    controlId: controlKey(controlId),
    finding,
    sourceReleaseId,
    riskStatement,
    action,
    milestone: { description, target },
    acceptance: record.acceptance,
    closureConfirmed: record.closureConfirmed,
    officialId: officialId.trim(),
    owner,
    closure:
      record.closure &&
      typeof record.closure === "object" &&
      bounded(record.closure.name, 200) &&
      bounded(record.closure.reason) &&
      typeof record.closure.at === "string" &&
      Number.isFinite(Date.parse(record.closure.at))
        ? {
            name: record.closure.name.trim(),
            reason: record.closure.reason.trim(),
            at: record.closure.at,
          }
        : undefined,
    plain: {
      whatIsWrong: finding,
      whyItMatters: riskStatement,
      whatWeWillDo: action,
      whoOwnsIt: owner,
      doneWhen: description,
      dueBy: target,
      status:
        record.closureConfirmed && record.closure
          ? "Closed"
          : record.plain?.status === "Closure proposed"
            ? "Closure proposed"
            : record.acceptance === "accepted"
              ? "Accepted"
              : "Drafted",
    },
  };
}

/** Recover the bounded internal plain-language record from a portable OSCAL item. */
export function importProposalDecisions(document: unknown): PlanDecision[] {
  if (!document || typeof document !== "object") return [];
  const body = (document as Record<string, unknown>)[
    "plan-of-action-and-milestones"
  ];
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as Record<string, unknown>)["poam-items"])
  )
    return [];
  return (
    (body as Record<string, unknown>)["poam-items"] as Record<string, unknown>[]
  ).flatMap((item) => {
    const props = Array.isArray(item.props)
      ? (item.props as { name: string; ns?: string; remarks?: string }[])
      : [];
    const raw = props.find(
      (prop) =>
        prop.name === "plain-plan-record" &&
        prop.ns === "urn:aegis:remediation:v1",
    )?.remarks;
    try {
      const restored = raw ? normalizePlanDecision(JSON.parse(raw)) : null;
      return restored ? [restored] : [];
    } catch {
      return [];
    }
  });
}
