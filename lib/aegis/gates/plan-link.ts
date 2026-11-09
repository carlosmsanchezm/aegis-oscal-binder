import { closureProblems, isDate, milestoneProblems, noteGateEvent, readinessProblems, type RemediationPlan } from "../remediation";
import { GATE_COPY, type ProblemCode } from "./copy";
import type { PoamGateLink } from "./poam-link";
import type { GateCase, HumanGateId } from "./types";
import { HUMAN_GATES } from "./types";

const filled = (value: string | undefined) => !!value?.trim();

export function planApprovalProblems(plan: RemediationPlan): ProblemCode[] {
  const problems: ProblemCode[] = [];
  if (plan.assessment.disposition !== "confirmed") problems.push("confirmed-assessment");
  if (!filled(plan.weakness)) problems.push("weakness");
  if (!filled(plan.asset)) problems.push("asset");
  if (!filled(plan.control)) problems.push("control");
  if (!filled(plan.owner)) problems.push("owner");
  if (!filled(plan.risk)) problems.push("risk");
  if (!filled(plan.resources)) problems.push("resources");
  if (!filled(plan.protection)) problems.push("protection");
  if (!plan.milestones.length || milestoneProblems(plan).length > 0) problems.push("milestone");
  return problems;
}

export function closureAlreadyRecorded(plan: RemediationPlan): boolean {
  return plan.readyForReview === true && plan.closure.recorded === true && closureProblems(plan).length === 0;
}

export function readyForClosureReview(plan: RemediationPlan): boolean {
  return plan.readyForReview === true && plan.validationRecorded === true && plan.validation === "demonstrated" && readinessProblems(plan).length === 0 && plan.closure.recorded === false;
}

export function samePlan(plan: RemediationPlan, gateCase: GateCase): boolean {
  return plan.id === gateCase.planId;
}

export function assertSensitiveUnchanged(before: RemediationPlan, after: RemediationPlan): void {
  if (after.riskDecision !== before.riskDecision || after.readyForReview !== before.readyForReview || after.validationRecorded !== before.validationRecorded || after.engineeringComplete !== before.engineeringComplete || JSON.stringify(after.closure) !== JSON.stringify(before.closure)) {
    throw new Error("The gate engine cannot write risk acceptance, authorization, or closure.");
  }
}

export function withGateNote(plan: RemediationPlan, action: string, now: string): RemediationPlan {
  const next = noteGateEvent(plan, action, now);
  assertSensitiveUnchanged(plan, next);
  return next;
}

export function validDecisionDate(value: string): boolean {
  return isDate(value);
}

const HISTORY: Record<string, string> = {
  "finding-validation": "Finding validation recorded on the human gate.",
  "plan-approval": "Plan approval recorded on the human gate.",
  "agent-launch": "Agent launch scope recorded on the human gate.",
  "significant-change": "Significant-change determination recorded on the human gate.",
  merge: "Merge approval recorded on the human gate.",
  deploy: "Deploy approval recorded on the human gate. Release approval is not an authorization.",
  "ssp-text": "SSP draft review recorded on the human gate.",
  exception: "Exception recorded on the human gate. Residual risk is not accepted.",
  "risk-acceptance": "External risk reference recorded. This application did not accept the risk.",
  "official-closure": "Official closure reference recorded. The existing closure rules are unchanged.",
  ato: "Outside authorization citation recorded. No ATO was granted.",
  propose: "Agent proposal recorded. No approval was granted.",
  "observe-closure": "External closure was already recorded on the draft. The gate did not write it.",
  reopen: "Workflow reopened. Recorded closure fields were left unchanged.",
};

export function historyAction(kind: HumanGateId | "propose" | "observe-closure" | "reopen"): string {
  return HISTORY[kind] ?? "Gate event recorded.";
}

export function poamLinksFromCase(gateCase: GateCase): PoamGateLink[] {
  const links: PoamGateLink[] = [];
  for (const id of HUMAN_GATES) {
    const gate = gateCase.gates[id];
    if (gate.state === "idle") continue;
    const copy = GATE_COPY.gates[id];
    links.push({
      gateId: id,
      state: gate.state,
      at: gate.updatedAt,
      title: copy.title,
      summary: `${copy.summary} ${GATE_COPY.limitations.noAto}`,
    });
  }
  return links;
}
