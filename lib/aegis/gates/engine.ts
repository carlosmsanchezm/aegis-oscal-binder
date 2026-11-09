import { AegisError } from "../errors";
import type { Principal, Role } from "@/lib/account/types";
import { AUDIT_GENESIS } from "./audit";
import { classifyChange } from "./classify";
import { GATE_COPY, type ProblemCode, type ReasonCode } from "./copy";
import { previewGate, previewWorkflow, type GateMachineEvent } from "./machine";
import { policyFor, type GatePolicy } from "./matrix";
import { DEFAULT_MFA_MAX_AGE_MS, defaultMfaChecker, type MfaChecker, type MfaProof } from "./mfa";
import { closureAlreadyRecorded, historyAction, planApprovalProblems, readyForClosureReview, samePlan, validDecisionDate, withGateNote } from "./plan-link";
import { containsSecret, hashDetail, redactText } from "./redact";
import {
  HUMAN_GATES,
  type AuditBody,
  type CaseParties,
  type CheckFact,
  type Citation,
  type Decision,
  type GateAction,
  type GateCase,
  type GateRecord,
  type HumanGateId,
  type LaunchScope,
  type WorkflowEvent,
  type WorkflowState,
} from "./types";
import type { RemediationPlan } from "../remediation";

const NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WORKSPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_ID = /^[A-Za-z0-9._-]{1,80}$/;
const LABEL = /^[A-Za-z0-9._:-]{1,80}$/;
const CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const WORKFLOW_AT: Partial<Record<HumanGateId, WorkflowState>> = {
  "finding-validation": "planned",
  "plan-approval": "finding-validated",
  "agent-launch": "plan-approved",
  merge: "proposed",
  deploy: "merge-approved",
};

const CLASSIFY_ROLES: readonly Role[] = ["isso", "isse", "release-manager"];
const CHECK_ROLES: readonly Role[] = ["admin", "isso", "system-owner", "engineer", "assessor", "isse", "release-manager"];
const RESCAN_ROLES: readonly Role[] = ["isso", "system-owner", "assessor"];
const CITE_ROLES: readonly Role[] = ["isso", "system-owner"];

export type ActOptions = {
  now: string;
  actor: Principal;
  proof?: MfaProof | null;
  mfaChecker?: MfaChecker;
  maxAgeMs?: number;
  plan?: RemediationPlan;
};

export function openCase(input: {
  workspaceId: string;
  planId: string;
  poamId: string;
  projectId: string;
  environment: string;
  illustrative: boolean;
  parties: Pick<CaseParties, "findingAuthorId" | "planAuthorId" | "changeAuthorId" | "prAuthorId" | "agentId">;
  proposal?: { paths?: string[]; touches?: string[] };
}): GateCase {
  if (!WORKSPACE.test(input.workspaceId)) throw new AegisError("BAD_REQUEST", "Workspace id is not usable.", 400);
  if (!PLAN_ID.test(input.planId) || !PLAN_ID.test(input.poamId)) throw new AegisError("BAD_REQUEST", "Plan id is not usable.", 400);
  if (!LABEL.test(input.projectId) || !LABEL.test(input.environment)) throw new AegisError("BAD_REQUEST", "Project or environment is not usable.", 400);
  for (const id of Object.values(input.parties)) {
    if (!LABEL.test(id)) throw new AegisError("BAD_REQUEST", "A party id is not usable.", 400);
  }
  const suggestion = classifyChange({ paths: input.proposal?.paths, touches: input.proposal?.touches });
  const gates = Object.fromEntries(HUMAN_GATES.map((id) => [id, blankGate(id)])) as Record<HumanGateId, GateRecord>;
  return {
    schema: "binder.gate-case.v1",
    workspaceId: input.workspaceId,
    planId: input.planId,
    poamId: input.poamId,
    projectId: input.projectId,
    environment: input.environment,
    illustrative: input.illustrative,
    workflow: "planned",
    parties: { ...input.parties, launcherId: null, mergeApproverId: null },
    gates,
    checks: [],
    classification: null,
    suggestion: { impact: suggestion.impact, ruleIds: suggestion.ruleIds },
    proposal: null,
    limitations: [GATE_COPY.limitations.noAto, GATE_COPY.limitations.synthetic],
    auditHead: AUDIT_GENESIS,
    auditLength: 0,
  };
}

export function reduceCase(gateCase: GateCase, action: GateAction, options: ActOptions): Decision {
  if (!NOW.test(options.now) || Number.isNaN(Date.parse(options.now))) {
    throw new AegisError("BAD_REQUEST", "Decision time is not usable.", 400);
  }
  const actor = options.actor;
  if (actor.kind === "aegis-agent" && actor.role !== null) {
    return deny(gateCase, options, "denied-agent", [], actionLabel(action), gateOf(action));
  }
  if (secretInAction(action)) return deny(gateCase, options, "denied-secret", ["secret"], actionLabel(action), gateOf(action));
  switch (action.type) {
    case "request": return onRequest(gateCase, action.gateId, options);
    case "approve": return onApprove(gateCase, action, options);
    case "deny": return onDeny(gateCase, action.gateId, options);
    case "withdraw": return onWithdraw(gateCase, action.gateId, options);
    case "record-external": return onExternal(gateCase, action, options);
    case "submit-closure": return onSubmitClosure(gateCase, options);
    case "classify": return onClassify(gateCase, action, options);
    case "record-checks": return onChecks(gateCase, action.checks, options);
    case "propose": return onPropose(gateCase, action, options);
    case "rescan-pending": return onWorkflow(gateCase, options, "RESCAN", RESCAN_ROLES, "rescan-pending");
    case "ready-for-closure-review": return onReady(gateCase, options);
    case "observe-closure": return onObserve(gateCase, options);
    case "reopen": return onReopen(gateCase, action.reason, options);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function onRequest(gateCase: GateCase, gateId: HumanGateId, options: ActOptions): Decision {
  const blocked = humanGate(gateCase, options, gateId, false);
  if (blocked) return blocked;
  if (policyFor(gateId).mode !== "quorum") return deny(gateCase, options, "denied-state", [], "request", gateId);
  return apply(gateCase, options, gateId, { type: "REQUEST" }, "request", null);
}

function onApprove(gateCase: GateCase, action: Extract<GateAction, { type: "approve" }>, options: ActOptions): Decision {
  const gateId = action.gateId;
  const policy = policyFor(gateId);
  if (options.actor.kind === "aegis-agent") return deny(gateCase, options, "denied-agent", [], "approve", gateId);
  if (policy.mode === "outside") return deny(gateCase, options, "denied-ato", [], "approve", gateId);
  if (policy.mode !== "quorum") return deny(gateCase, options, "denied-external", [], "approve", gateId);
  const blocked = humanGate(gateCase, options, gateId, false);
  if (blocked) return blocked;
  const slot = nextSlot(policy, options.actor.role, gateCase.gates[gateId].receivedSlots);
  if (slot.kind === "role" || slot.kind === "done") return deny(gateCase, options, "denied-role", [], "approve", gateId);
  if (slot.kind !== "slot") return deny(gateCase, options, "denied-state", [], "approve", gateId);
  const chosen = slot.slot;
  const sod = separation(gateCase, options.actor, policy);
  if (sod) return deny(gateCase, options, "denied-sod", [], "approve", gateId);
  const mfa = freshMfa(options);
  if (mfa) return deny(gateCase, options, "denied-mfa", [], "approve", gateId);
  const problems = approvalProblems(gateCase, gateId, action, options.plan);
  if (problems.length) return deny(gateCase, options, problems[0].reason, problems[0].problems, "approve", gateId);
  const expected = WORKFLOW_AT[gateId];
  if (expected && gateCase.workflow !== expected) return deny(gateCase, options, "denied-state", [], "approve", gateId);
  const preview = previewGate(gateCase.gates[gateId].state, machineContext(policy, gateCase.gates[gateId]), { type: "APPROVE", slot: chosen.id });
  if (!preview || preview.context.authorizationGranted !== false) return deny(gateCase, options, "denied-state", [], "approve", gateId);
  let next = writeGate(gateCase, gateId, preview.state, preview.context.receivedSlots, options.now, (gate) => ({
    ...gate,
    approvals: preview.context.receivedSlots.includes(chosen.id)
      ? [...gate.approvals.filter((item) => item.slot !== chosen.id), { slot: chosen.id, actorId: options.actor.id, role: options.actor.role as Role, at: options.now }]
      : gate.approvals,
    justification: action.justification ? redactText(action.justification) : gate.justification,
    justificationSha256: action.justification ? hashDetail(redactText(action.justification)) : gate.justificationSha256,
    scope: gateId === "agent-launch" && action.scope ? action.scope : gate.scope,
    checkIds: gateId === "exception" ? [...(action.checkIds ?? [])] : gate.checkIds,
  }));
  if (preview.state === "approved" && policy.workflowEvent) {
    const moved = shift(next, policy.workflowEvent);
    if (!moved) return deny(gateCase, options, "denied-state", [], "approve", gateId);
    next = moved;
  }
  if (gateId === "agent-launch" && next.gates[gateId].state === "approved") {
    next = { ...next, parties: { ...next.parties, launcherId: options.actor.id } };
  }
  if (gateId === "merge" && next.gates[gateId].state === "approved") {
    next = { ...next, parties: { ...next.parties, mergeApproverId: options.actor.id } };
  }
  return allow(gateCase, next, options, "approve", gateId, preview.state === "approved");
}

function onDeny(gateCase: GateCase, gateId: HumanGateId, options: ActOptions): Decision {
  const policy = policyFor(gateId);
  if (policy.mode !== "quorum") return deny(gateCase, options, policy.mode === "outside" ? "denied-ato" : "denied-external", [], "deny", gateId);
  const blocked = humanGate(gateCase, options, gateId, false);
  if (blocked) return blocked;
  if (!options.actor.role || !policy.slots.some((slot) => slot.roles.includes(options.actor.role as Role))) {
    return deny(gateCase, options, "denied-role", [], "deny", gateId);
  }
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "deny", gateId);
  return apply(gateCase, options, gateId, { type: "DENY" }, "deny", (gate) => ({ ...gate, approvals: [], justification: "" }));
}

function onWithdraw(gateCase: GateCase, gateId: HumanGateId, options: ActOptions): Decision {
  if (policyFor(gateId).mode !== "quorum") return deny(gateCase, options, "denied-state", [], "withdraw", gateId);
  const blocked = humanGate(gateCase, options, gateId, false);
  if (blocked) return blocked;
  if (!options.actor.role || options.actor.role === "viewer") return deny(gateCase, options, "denied-role", [], "withdraw", gateId);
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "withdraw", gateId);
  return apply(gateCase, options, gateId, { type: "WITHDRAW" }, "withdraw", (gate) => ({ ...gate, approvals: [] }));
}

function onExternal(gateCase: GateCase, action: Extract<GateAction, { type: "record-external" }>, options: ActOptions): Decision {
  const gateId = action.gateId;
  const raw = action as unknown as Record<string, unknown>;
  if (raw.grant === true || raw.granted === true || raw.riskDecision != null || raw.authorizationGranted === true) {
    return deny(gateCase, options, gateId === "ato" ? "denied-ato" : "denied-external", [], "record-external", gateId);
  }
  if (options.actor.kind === "aegis-agent") return deny(gateCase, options, "denied-agent", [], "record-external", gateId);
  const blocked = scopeAndHuman(gateCase, options, gateId);
  if (blocked) return blocked;
  if (gateId === "risk-acceptance" && !options.actor.governmentOfficial) return deny(gateCase, options, "denied-role", [], "record-external", gateId);
  if (gateId === "ato" && !options.actor.governmentOfficial && !CITE_ROLES.includes(options.actor.role as Role)) {
    return deny(gateCase, options, "denied-role", [], "record-external", gateId);
  }
  if (gateId === "official-closure" && options.actor.role !== "isso") return deny(gateCase, options, "denied-role", [], "record-external", gateId);
  const sod = separation(gateCase, options.actor, policyFor(gateId));
  if (sod) return deny(gateCase, options, "denied-sod", [], "record-external", gateId);
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "record-external", gateId);
  const problems = citationProblems(action, gateId === "official-closure", options);
  if (problems.length) return deny(gateCase, options, "denied-fields", problems, "record-external", gateId);
  const citation: Citation = {
    reference: redactText(action.reference.trim()),
    approver: redactText(action.approver.trim()),
    date: action.date,
    officialId: (action.officialId ?? "").trim(),
  };
  const preview = previewGate(gateCase.gates[gateId].state, machineContext(policyFor(gateId), gateCase.gates[gateId]), { type: "CITE", reference: citation.reference });
  if (!preview || preview.state !== "recorded-externally" || preview.context.authorizationGranted !== false) {
    return deny(gateCase, options, "denied-state", [], "record-external", gateId);
  }
  const next = writeGate(gateCase, gateId, "recorded-externally", preview.context.receivedSlots, options.now, (gate) => ({
    ...gate,
    citation,
    authorizationGranted: false,
  }));
  if (next.gates[gateId].authorizationGranted !== false) return deny(gateCase, options, "denied-ato", [], "record-external", gateId);
  return allow(gateCase, next, options, "record-external", gateId, true);
}

function onSubmitClosure(gateCase: GateCase, options: ActOptions): Decision {
  const blocked = humanGate(gateCase, options, "official-closure", false);
  if (blocked) return blocked;
  if (options.actor.role !== "isso") return deny(gateCase, options, "denied-role", [], "submit-closure", "official-closure");
  if (separation(gateCase, options.actor, policyFor("official-closure"))) return deny(gateCase, options, "denied-sod", [], "submit-closure", "official-closure");
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "submit-closure", "official-closure");
  return apply(gateCase, options, "official-closure", { type: "SUBMIT" }, "submit-closure", null);
}

function onClassify(gateCase: GateCase, action: Extract<GateAction, { type: "classify" }>, options: ActOptions): Decision {
  const blocked = scopeAndHuman(gateCase, options, "significant-change");
  if (blocked) return blocked;
  if (!options.actor.role || !CLASSIFY_ROLES.includes(options.actor.role)) return deny(gateCase, options, "denied-role", [], "classify", "significant-change");
  if (options.actor.id === gateCase.parties.changeAuthorId || options.actor.id === gateCase.parties.agentId) {
    return deny(gateCase, options, "denied-sod", [], "classify", "significant-change");
  }
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "classify", "significant-change");
  const justification = action.justification.trim();
  if (!justification) return deny(gateCase, options, "denied-fields", ["justification"], "classify", "significant-change");
  if (gateCase.suggestion.impact === "significant" && action.impact === "routine") {
    return deny(gateCase, options, "denied-classification", ["downgrade"], "classify", "significant-change");
  }
  const text = redactText(justification);
  const next: GateCase = {
    ...gateCase,
    classification: {
      impact: action.impact,
      ruleIds: action.impact === "significant" ? gateCase.suggestion.ruleIds : [],
      justification: text,
      justificationSha256: hashDetail(text),
      actorId: options.actor.id,
      at: options.now,
    },
  };
  return allow(gateCase, next, options, "classify", "significant-change", false);
}

function onChecks(gateCase: GateCase, checks: CheckFact[], options: ActOptions): Decision {
  const blocked = scopeAndHuman(gateCase, options, "merge", true);
  if (blocked) return blocked;
  const actor = options.actor;
  const allowedActor = actor.kind === "aegis-agent" ? actor.id === gateCase.parties.agentId : !!actor.role && CHECK_ROLES.includes(actor.role);
  if (!allowedActor) return deny(gateCase, options, actor.kind === "aegis-agent" ? "denied-agent" : "denied-role", [], "record-checks", "merge");
  if (!checks.length || checks.some((check) => !CHECK_ID.test(check.id) || (check.status !== "pass" && check.status !== "fail"))) {
    return deny(gateCase, options, "denied-fields", ["checks"], "record-checks", "merge");
  }
  if (new Set(checks.map((check) => check.id)).size !== checks.length) return deny(gateCase, options, "denied-fields", ["checks"], "record-checks", "merge");
  return allow(gateCase, { ...gateCase, checks: checks.map((check) => ({ ...check })) }, options, "record-checks", "merge", false);
}

function onPropose(gateCase: GateCase, action: Extract<GateAction, { type: "propose" }>, options: ActOptions): Decision {
  const actor = options.actor;
  if (actor.kind !== "aegis-agent") return deny(gateCase, options, "denied-role", [], "propose", "agent-launch");
  if (!inScope(actor, gateCase)) return deny(gateCase, options, "denied-abac", [], "propose", "agent-launch");
  if (actor.id !== gateCase.parties.agentId) return deny(gateCase, options, "denied-sod", [], "propose", "agent-launch");
  const summary = action.summary.trim();
  if (!summary) return deny(gateCase, options, "denied-fields", ["justification"], "propose", "agent-launch");
  const suggestion = classifyChange({ paths: action.paths, touches: action.touches });
  const shifted = shift(gateCase, "PROPOSE");
  if (!shifted) return deny(gateCase, options, "denied-state", [], "propose", "agent-launch");
  const sameRules = suggestion.impact === gateCase.suggestion.impact && suggestion.ruleIds.join("\n") === gateCase.suggestion.ruleIds.join("\n");
  const gates = { ...shifted.gates };
  if (!sameRules) gates["significant-change"] = blankGate("significant-change");
  const next: GateCase = {
    ...shifted,
    gates,
    suggestion: { impact: suggestion.impact, ruleIds: suggestion.ruleIds },
    proposal: { paths: [...(action.paths ?? [])], touches: [...(action.touches ?? [])], summary: redactText(summary) },
    classification: sameRules ? gateCase.classification : null,
  };
  return allow(gateCase, next, options, "propose", "agent-launch", true);
}

function onWorkflow(gateCase: GateCase, options: ActOptions, event: WorkflowEvent, roles: readonly Role[], action: string): Decision {
  const blocked = humanGate(gateCase, options, "deploy", false);
  if (blocked) return blocked;
  if (!options.actor.role || !roles.includes(options.actor.role)) return deny(gateCase, options, "denied-role", [], action, "deploy");
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], action, "deploy");
  const next = shift(gateCase, event);
  if (!next) return deny(gateCase, options, "denied-state", [], action, "deploy");
  return allow(gateCase, next, options, action, "deploy", false);
}

function onReady(gateCase: GateCase, options: ActOptions): Decision {
  const blocked = humanGate(gateCase, options, "official-closure", false);
  if (blocked) return blocked;
  if (options.actor.role !== "isso") return deny(gateCase, options, "denied-role", [], "ready-for-closure-review", "official-closure");
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "ready-for-closure-review", "official-closure");
  if (!options.plan || !samePlan(options.plan, gateCase) || !readyForClosureReview(options.plan)) {
    return deny(gateCase, options, "denied-state", [], "ready-for-closure-review", "official-closure");
  }
  const next = shift(gateCase, "READY");
  if (!next) return deny(gateCase, options, "denied-state", [], "ready-for-closure-review", "official-closure");
  return allow(gateCase, next, options, "ready-for-closure-review", "official-closure", false);
}

function onObserve(gateCase: GateCase, options: ActOptions): Decision {
  const blocked = humanGate(gateCase, options, "official-closure", false);
  if (blocked) return blocked;
  if (options.actor.role !== "isso") return deny(gateCase, options, "denied-role", [], "observe-closure", "official-closure");
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "observe-closure", "official-closure");
  if (!options.plan || !samePlan(options.plan, gateCase) || !closureAlreadyRecorded(options.plan)) {
    return deny(gateCase, options, "denied-state", [], "observe-closure", "official-closure");
  }
  const next = shift(gateCase, "CLOSE_EXTERNAL");
  if (!next) return deny(gateCase, options, "denied-state", [], "observe-closure", "official-closure");
  return allow(gateCase, next, options, "observe-closure", "official-closure", true);
}

function onReopen(gateCase: GateCase, reason: string, options: ActOptions): Decision {
  const blocked = scopeAndHuman(gateCase, options, "official-closure");
  if (blocked) return blocked;
  if (options.actor.role !== "isso" && options.actor.role !== "isse") return deny(gateCase, options, "denied-role", [], "reopen", "official-closure");
  if (freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "reopen", "official-closure");
  if (!reason.trim()) return deny(gateCase, options, "denied-fields", ["justification"], "reopen", "official-closure");
  const next = shift(gateCase, "REOPEN");
  if (!next) return deny(gateCase, options, "denied-state", [], "reopen", "official-closure");
  return allow(gateCase, next, options, "reopen", "official-closure", true);
}

function approvalProblems(gateCase: GateCase, gateId: HumanGateId, action: Extract<GateAction, { type: "approve" }>, plan: RemediationPlan | undefined): { reason: ReasonCode; problems: ProblemCode[] }[] {
  if ((gateId === "finding-validation" || gateId === "plan-approval") && (!plan || !samePlan(plan, gateCase))) {
    return [{ reason: "denied-fields", problems: ["confirmed-assessment"] }];
  }
  if (gateId === "finding-validation" && plan?.assessment.disposition !== "confirmed") {
    return [{ reason: "denied-fields", problems: ["confirmed-assessment"] }];
  }
  if (gateId === "plan-approval" && plan) {
    const problems = planApprovalProblems(plan);
    if (problems.length) return [{ reason: "denied-fields", problems }];
    if (gateCase.gates["finding-validation"].state !== "approved") return [{ reason: "denied-state", problems: [] }];
  }
  if (gateId === "agent-launch" || gateId === "deploy") {
    if (!gateCase.classification) return [{ reason: "denied-classification", problems: ["justification"] }];
    if (gateCase.classification.impact === "significant" && gateCase.gates["significant-change"].state !== "approved") {
      return [{ reason: "denied-classification", problems: ["downgrade"] }];
    }
  }
  if (gateId === "agent-launch") {
    if (gateCase.gates["plan-approval"].state !== "approved") return [{ reason: "denied-state", problems: [] }];
    const scopeProblems = action.scope ? launchScopeProblems(action.scope, gateCase) : ["scope" as const];
    if (scopeProblems.length) return [{ reason: "denied-scope", problems: scopeProblems }];
  }
  if (gateId === "merge" || gateId === "deploy") {
    const block = blockedChecks(gateCase);
    if (block) return [{ reason: block, problems: block === "denied-evidence" ? [] : ["checks"] }];
  }
  if (gateId === "significant-change" && !action.justification?.trim()) return [{ reason: "denied-fields", problems: ["justification"] }];
  if (gateId === "ssp-text" && !action.draftId?.trim()) return [{ reason: "denied-fields", problems: ["draft"] }];
  if (gateId === "exception") {
    const failed = gateCase.checks.filter((check) => check.status === "fail").map((check) => check.id);
    if (!failed.length) return [{ reason: "denied-fields", problems: ["checks"] }];
    if (!action.justification?.trim()) return [{ reason: "denied-fields", problems: ["justification"] }];
    const ids = action.checkIds ?? [];
    if (failed.some((id) => !ids.includes(id)) || ids.some((id) => !failed.includes(id))) return [{ reason: "denied-fields", problems: ["checks"] }];
  }
  return [];
}

function citationProblems(action: Extract<GateAction, { type: "record-external" }>, requireOfficial: boolean, options: ActOptions): ProblemCode[] {
  const problems: ProblemCode[] = [];
  if (!action.reference.trim()) problems.push("reference");
  if (!action.approver.trim()) problems.push("approver");
  if (!validDecisionDate(action.date)) problems.push("date");
  if (requireOfficial) {
    if (!action.officialId?.trim()) problems.push("official-id");
    if (action.approver.trim() === options.actor.id) problems.push("approver");
    if (options.plan && action.officialId?.trim() !== options.plan.officialId) problems.push("official-id");
  }
  return [...new Set(problems)];
}

function launchScopeProblems(scope: LaunchScope, gateCase: GateCase): ProblemCode[] {
  const prefix = `poam/${gateCase.planId}/`;
  if (!REPO.test(scope.repo)) return ["scope"];
  if (scope.branchPrefix !== prefix || scope.branchPrefix.includes("..")) return ["scope"];
  if (!Number.isInteger(scope.hours) || scope.hours < 1 || scope.hours > 8) return ["scope"];
  if (scope.planId !== gateCase.planId || scope.poamId !== gateCase.poamId) return ["scope"];
  if (scope.environments.length !== 1 || scope.environments[0] !== gateCase.environment) return ["scope"];
  if (scope.environments.some((item) => item === "prod" || item === "production")) return ["scope"];
  return [];
}

function blockedChecks(gateCase: GateCase): ReasonCode | null {
  if (!gateCase.checks.length) return "denied-evidence";
  const failed = gateCase.checks.filter((check) => check.status === "fail").map((check) => check.id);
  if (!failed.length) return null;
  const exception = gateCase.gates.exception;
  if (exception.state !== "approved" || failed.some((id) => !exception.checkIds.includes(id))) return "denied-checks";
  return null;
}

function nextSlot(policy: GatePolicy, role: Role | null, received: string[]): { kind: "slot"; slot: GatePolicy["slots"][number] } | { kind: "role" | "early" | "done" } {
  const index = policy.slots.findIndex((slot) => !received.includes(slot.id));
  if (index < 0) return { kind: "done" };
  const slot = policy.slots[index];
  if (role && slot.roles.includes(role)) return { kind: "slot", slot };
  if (policy.slots.slice(index + 1).some((item) => role && item.roles.includes(role))) return { kind: "early" };
  return { kind: "role" };
}

function separation(gateCase: GateCase, actor: Principal, policy: GatePolicy): boolean {
  if (actor.kind === "aegis-agent" || actor.id === gateCase.parties.agentId) return true;
  for (const field of policy.sod) {
    const party = gateCase.parties[field];
    if (party && party === actor.id) return true;
  }
  const gate = gateCase.gates[policy.id];
  return gate.approvals.some((approval) => approval.actorId === actor.id);
}

function humanGate(gateCase: GateCase, options: ActOptions, gateId: HumanGateId, mfa: boolean): Decision | null {
  if (options.actor.kind === "aegis-agent") return deny(gateCase, options, "denied-agent", [], "gate", gateId);
  const scoped = scopeAndHuman(gateCase, options, gateId);
  if (scoped) return scoped;
  if (mfa && policyFor(gateId).mfa && freshMfa(options)) return deny(gateCase, options, "denied-mfa", [], "gate", gateId);
  return null;
}

function scopeAndHuman(gateCase: GateCase, options: ActOptions, gateId: HumanGateId, allowAgent = false): Decision | null {
  if (!allowAgent && options.actor.kind !== "human") return deny(gateCase, options, "denied-agent", [], "gate", gateId);
  if (!inScope(options.actor, gateCase)) return deny(gateCase, options, "denied-abac", [], "gate", gateId);
  return null;
}

function inScope(actor: Principal, gateCase: GateCase): boolean {
  return actor.projects.includes(gateCase.projectId) && actor.environments.includes(gateCase.environment);
}

function freshMfa(options: ActOptions): boolean {
  const checker = options.mfaChecker ?? defaultMfaChecker;
  const result = checker({
    actorId: options.actor.id,
    proof: options.proof ?? null,
    now: options.now,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MFA_MAX_AGE_MS,
  });
  return !result.fresh;
}

function machineContext(policy: GatePolicy, gate: GateRecord) {
  return {
    mode: policy.mode,
    requiredSlots: policy.slots.map((slot) => slot.id),
    receivedSlots: [...gate.receivedSlots],
    authorizationGranted: false as const,
    citation: gate.citation?.reference ?? "",
  };
}

function apply(gateCase: GateCase, options: ActOptions, gateId: HumanGateId, event: GateMachineEvent, action: string, edit: ((gate: GateRecord) => GateRecord) | null): Decision {
  const preview = previewGate(gateCase.gates[gateId].state, machineContext(policyFor(gateId), gateCase.gates[gateId]), event);
  if (!preview || preview.context.authorizationGranted !== false) return deny(gateCase, options, "denied-state", [], action, gateId);
  const next = writeGate(gateCase, gateId, preview.state, preview.context.receivedSlots, options.now, edit);
  return allow(gateCase, next, options, action, gateId, preview.state === "approved" || preview.state === "recorded-externally" || preview.state === "submitted");
}

function writeGate(gateCase: GateCase, gateId: HumanGateId, state: GateRecord["state"], receivedSlots: string[], now: string, edit: ((gate: GateRecord) => GateRecord) | null): GateCase {
  const current = gateCase.gates[gateId];
  const edited = edit ? edit(current) : current;
  const gate: GateRecord = { ...edited, state, receivedSlots: [...receivedSlots], authorizationGranted: false, updatedAt: now };
  return { ...gateCase, gates: { ...gateCase.gates, [gateId]: gate } };
}

function shift(gateCase: GateCase, event: WorkflowEvent): GateCase | null {
  const workflow = previewWorkflow(gateCase.workflow, event);
  if (!workflow) return null;
  return { ...gateCase, workflow };
}

function allow(before: GateCase, next: GateCase, options: ActOptions, action: string, gateId: string, note: boolean): Decision {
  let plan = options.plan;
  if (plan) {
    if (!samePlan(plan, before)) return deny(before, options, "denied-state", [], action, gateId as HumanGateId);
    if (note && (action === "approve" || action === "record-external" || action === "propose" || action === "observe-closure" || action === "reopen")) {
      const kind = action === "propose" || action === "observe-closure" || action === "reopen" ? action : (gateId as HumanGateId);
      plan = withGateNote(plan, historyAction(kind), options.now);
    } else {
      plan = undefined;
    }
  }
  for (const id of HUMAN_GATES) {
    if (next.gates[id].authorizationGranted !== false) {
      throw new Error("The gate engine cannot grant authorization.");
    }
  }
  return {
    allowed: true,
    reason: "allowed",
    problems: [],
    case: next,
    ...(plan ? { plan } : {}),
    audit: body(before, options, gateId, action, "allowed", "allowed", []),
  };
}

function deny(gateCase: GateCase, options: ActOptions, reason: ReasonCode, problems: ProblemCode[], action: string, gateId: HumanGateId | string): Decision {
  return {
    allowed: false,
    reason,
    problems,
    case: gateCase,
    audit: body(gateCase, options, gateId, action, "denied", reason, problems),
  };
}

function body(gateCase: GateCase, options: ActOptions, gateId: string, action: string, outcome: "allowed" | "denied", reason: ReasonCode, problems: ProblemCode[]): AuditBody {
  const actorId = containsSecret(options.actor.id) ? "[redacted]" : options.actor.id;
  return {
    workspaceId: gateCase.workspaceId,
    planId: gateCase.planId,
    poamId: gateCase.poamId,
    gateId,
    action,
    outcome,
    reason,
    actorId,
    actorKind: options.actor.kind,
    actorRole: options.actor.role,
    detailHash: hashDetail({ reason, problems, action, gateId }),
  };
}

function blankGate(id: HumanGateId): GateRecord {
  return {
    id,
    state: "idle",
    receivedSlots: [],
    approvals: [],
    authorizationGranted: false,
    citation: null,
    scope: null,
    checkIds: [],
    justification: "",
    justificationSha256: "",
    updatedAt: "",
  };
}

function secretInAction(action: GateAction): boolean {
  const texts: string[] = [];
  if ("justification" in action && action.justification) texts.push(action.justification);
  if ("reference" in action && action.reference) texts.push(action.reference);
  if ("approver" in action && action.approver) texts.push(action.approver);
  if ("summary" in action && action.summary) texts.push(action.summary);
  if ("reason" in action && action.reason) texts.push(action.reason);
  if ("draftId" in action && action.draftId) texts.push(action.draftId);
  if ("scope" in action && action.scope) texts.push(JSON.stringify(action.scope));
  return texts.some((text) => containsSecret(text));
}

function actionLabel(action: GateAction): string {
  return action.type;
}

function gateOf(action: GateAction): HumanGateId {
  if ("gateId" in action) return action.gateId;
  if (action.type === "submit-closure" || action.type === "observe-closure" || action.type === "reopen" || action.type === "ready-for-closure-review") return "official-closure";
  if (action.type === "classify") return "significant-change";
  if (action.type === "propose") return "agent-launch";
  return "merge";
}

/** Measured scanner readiness does not grant or alter any human approval. */
export async function evaluateCollectedScannerGate(sessionId:string,sourceReleaseId:string,issueId:string,connectionId?:string){
 const {collectedScannerProof}=await import("../collected-closure");
 const proof=await collectedScannerProof(sessionId,sourceReleaseId,issueId,connectionId);
 return {...proof,workflowState:proof.ready?"ready-for-closure-review" as const:"rescan-pending" as const,closureConfirmed:false as const};
}
