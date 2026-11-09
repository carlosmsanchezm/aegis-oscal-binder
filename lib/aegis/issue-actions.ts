import { containsSecret } from "./gates/redact";
import { resultForReviewItem } from "./control-rollup";
import type { PlanProposal } from "./plan-proposal";
import type { ReviewObservation } from "./review-context";
import type { PipelineEvidence } from "./pipeline-evidence";
export type TriageOutcome = "fix-now" | "plan-it";
export function isTriageOutcome(value: unknown): value is TriageOutcome {
  return value === "fix-now" || value === "plan-it";
}
export type IssueTriage = {
  id?: string;
  source_label?: import("./item-source").ItemSource;
  acceptance?: "proposed" | "accepted" | "rejected";
  review?: unknown;
  poam_item_id?: string;
  issueId: string;
  receiptId: string;
  outcome: TriageOutcome;
  reason: string;
  actor: string;
  at: string;
};
export function triageIssue(input: {
  issueId: string;
  receiptId: string;
  outcome: unknown;
  reason: unknown;
  actor: string;
  at: string;
}): IssueTriage {
  if (!isTriageOutcome(input.outcome))
    throw new Error("Select a triage outcome.");
  if (
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 4000
  )
    throw new Error("Record a reason for the triage decision.");
  if (containsSecret(input.reason as string))
    throw new Error("Remove credentials from the triage reason.");
  if (!input.actor || !Number.isFinite(Date.parse(input.at)))
    throw new Error("A recorded actor and time are required.");
  return {
    ...input,
    outcome: input.outcome,
    reason: input.reason.trim(),
  };
}
/** Unsupported historical decisions are not active triage actions. Preserve valid metadata. */
export function normalizeStoredIssueTriage(value: unknown): IssueTriage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const decision = entry as Record<string, unknown>;
    if (!isTriageOutcome(decision.outcome)) return [];
    if (!["issueId", "receiptId", "reason", "actor", "at"].every((key) => typeof decision[key] === "string")) return [];
    return [decision as IssueTriage];
  });
}
export type DraftText = { risk: string; action: string; verification: string };
export function validateDraftText(value: unknown): DraftText {
  if (!value || typeof value !== "object")
    throw new Error("The AI draft was not valid.");
  const v = value as Record<string, unknown>;
  for (const key of ["risk", "action", "verification"])
    if (
      typeof v[key] !== "string" ||
      !(v[key] as string).trim() ||
      (v[key] as string).length > 6000
    )
      throw new Error("The AI draft was not valid.");
  return {
    risk: String(v.risk),
    action: String(v.action),
    verification: String(v.verification),
  };
}
/** The model supplies draft text only. Identity and all acceptance/closure fields are server controlled. */
export function issueDraft(
  record: PipelineEvidence,
  issue: ReviewObservation,
  text: DraftText,
): PlanProposal {
  const control = issue.scope.controls[0];
  if (!control)
    throw new Error("Review the control mapping before drafting a plan.");
  return {
    id: `proposal:${control}:${record.pipelineId}:${issue.id}`,
    controlId: control,
    finding: issue.description,
    findingTitle: issue.scope.title,
    riskStatement: text.risk,
    action: text.action,
    milestone: { description: text.verification, target: "" },
    provingChecks: issue.scope.verification,
    retests: [],
    acceptance: "proposed",
    workflowState: "planned",
    readyToClose: false,
    closureConfirmed: false,
    officialId: "",
    sourceReleaseId: record.pipelineId,
    correctiveReleaseId: "",
    result: resultForReviewItem(record, issue, control, [record]) ?? undefined,
  };
}
