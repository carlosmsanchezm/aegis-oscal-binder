import type { PrincipalKind, Role } from "@/lib/account/types";
import type { ProblemCode, ReasonCode } from "./copy";

export const HUMAN_GATES = [
  "finding-validation",
  "plan-approval",
  "agent-launch",
  "significant-change",
  "merge",
  "deploy",
  "ssp-text",
  "exception",
  "risk-acceptance",
  "official-closure",
  "ato",
] as const;
export type HumanGateId = (typeof HUMAN_GATES)[number];

export const GATE_STATES = ["idle", "pending", "approved", "denied", "withdrawn", "submitted", "recorded-externally"] as const;
export type GateState = (typeof GATE_STATES)[number];

export const WORKFLOW_STATES = [
  "planned",
  "finding-validated",
  "plan-approved",
  "agent-running",
  "proposed",
  "merge-approved",
  "deployed",
  "rescan-pending",
  "ready-for-closure-review",
  "closed-externally",
  "reopened",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENTS = [
  "VALIDATE_FINDING",
  "APPROVE_PLAN",
  "LAUNCH",
  "PROPOSE",
  "APPROVE_MERGE",
  "APPROVE_DEPLOY",
  "RESCAN",
  "READY",
  "CLOSE_EXTERNAL",
  "REOPEN",
] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

export type PartyField = "findingAuthorId" | "planAuthorId" | "changeAuthorId" | "prAuthorId" | "agentId" | "launcherId";

export type CaseParties = {
  findingAuthorId: string;
  planAuthorId: string;
  changeAuthorId: string;
  prAuthorId: string;
  agentId: string;
  launcherId: string | null;
  mergeApproverId: string | null;
};

export type LaunchScope = {
  repo: string;
  branchPrefix: string;
  hours: number;
  environments: string[];
  planId: string;
  poamId: string;
};

export type CheckFact = { id: string; status: "pass" | "fail" };

export type Citation = {
  reference: string;
  approver: string;
  date: string;
  officialId: string;
};

export type GateRecord = {
  id: HumanGateId;
  state: GateState;
  receivedSlots: string[];
  approvals: { slot: string; actorId: string; role: Role; at: string }[];
  /** Always false. Risk acceptance and ATO are never granted here. */
  authorizationGranted: false;
  citation: Citation | null;
  scope: LaunchScope | null;
  checkIds: string[];
  justification: string;
  justificationSha256: string;
  updatedAt: string;
};

export type ClassificationRecord = {
  impact: "routine" | "significant";
  ruleIds: string[];
  justification: string;
  justificationSha256: string;
  actorId: string;
  at: string;
};

export type GateCase = {
  schema: "binder.gate-case.v1";
  workspaceId: string;
  planId: string;
  poamId: string;
  projectId: string;
  environment: string;
  illustrative: boolean;
  workflow: WorkflowState;
  parties: CaseParties;
  gates: Record<HumanGateId, GateRecord>;
  checks: CheckFact[];
  classification: ClassificationRecord | null;
  suggestion: { impact: "routine" | "significant"; ruleIds: string[] };
  proposal: { paths: string[]; touches: string[]; summary: string } | null;
  limitations: string[];
  auditHead: string;
  auditLength: number;
};

export type AuditBody = {
  workspaceId: string;
  planId: string;
  poamId: string;
  gateId: string;
  action: string;
  outcome: "allowed" | "denied";
  reason: ReasonCode;
  actorId: string;
  actorKind: PrincipalKind;
  actorRole: string | null;
  detailHash: string;
};

export type AuditEntry = AuditBody & {
  v: 1;
  index: number;
  at: string;
  prevHash: string;
  hash: string;
};

export type AuditChain = {
  schema: "binder.gate-audit.v1";
  workspaceId: string;
  entries: AuditEntry[];
};

export type GateAction =
  | { type: "request"; gateId: HumanGateId }
  | { type: "approve"; gateId: HumanGateId; justification?: string; scope?: LaunchScope; draftId?: string; checkIds?: string[] }
  | { type: "deny"; gateId: HumanGateId; justification?: string }
  | { type: "withdraw"; gateId: HumanGateId }
  | { type: "record-external"; gateId: "risk-acceptance" | "official-closure" | "ato"; reference: string; approver: string; date: string; officialId?: string }
  | { type: "submit-closure" }
  | { type: "classify"; impact: "routine" | "significant"; justification: string }
  | { type: "record-checks"; checks: CheckFact[] }
  | { type: "propose"; summary: string; paths?: string[]; touches?: string[] }
  | { type: "rescan-pending" }
  | { type: "ready-for-closure-review" }
  | { type: "observe-closure" }
  | { type: "reopen"; reason: string };

export type Decision = {
  allowed: boolean;
  reason: ReasonCode;
  problems: ProblemCode[];
  case: GateCase;
  plan?: import("../remediation").RemediationPlan;
  audit: AuditBody;
};

export function isHumanGate(value: string): value is HumanGateId {
  return (HUMAN_GATES as readonly string[]).includes(value);
}
