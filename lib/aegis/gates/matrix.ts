import type { Role } from "@/lib/account/types";
import { GATE_COPY } from "./copy";
import type { HumanGateId, PartyField } from "./types";

export type GateMode = "quorum" | "external" | "outside" | "closure";

export type GatePolicy = {
  id: HumanGateId;
  mode: GateMode;
  title: string;
  summary: string;
  requirements: readonly string[];
  slots: readonly { id: string; roles: readonly Role[] }[];
  sod: readonly PartyField[];
  mfa: boolean;
  workflowEvent: "VALIDATE_FINDING" | "APPROVE_PLAN" | "LAUNCH" | "APPROVE_MERGE" | "APPROVE_DEPLOY" | null;
};

const reviewer: readonly Role[] = ["assessor", "isse", "isso", "system-owner", "release-manager", "admin", "engineer"];

export const GATE_MATRIX: Record<HumanGateId, GatePolicy> = {
  "finding-validation": {
    id: "finding-validation",
    mode: "quorum",
    title: GATE_COPY.gates["finding-validation"].title,
    summary: GATE_COPY.gates["finding-validation"].summary,
    requirements: ["R13", "R14", "R32", "R33"],
    slots: [
      { id: "isse-validation", roles: ["isse"] },
      { id: "system-owner-validation", roles: ["system-owner"] },
    ],
    sod: ["findingAuthorId", "agentId"],
    mfa: true,
    workflowEvent: "VALIDATE_FINDING",
  },
  "plan-approval": {
    id: "plan-approval",
    mode: "quorum",
    title: GATE_COPY.gates["plan-approval"].title,
    summary: GATE_COPY.gates["plan-approval"].summary,
    requirements: ["R11", "R14", "R15", "R21", "R38"],
    slots: [{ id: "isso-approval", roles: ["isso"] }],
    sod: ["planAuthorId", "agentId"],
    mfa: true,
    workflowEvent: "APPROVE_PLAN",
  },
  "agent-launch": {
    id: "agent-launch",
    mode: "quorum",
    title: GATE_COPY.gates["agent-launch"].title,
    summary: GATE_COPY.gates["agent-launch"].summary,
    requirements: ["R11", "R34", "R35", "R38"],
    slots: [{ id: "authorizer", roles: ["isso", "system-owner"] }],
    sod: ["changeAuthorId", "agentId"],
    mfa: true,
    workflowEvent: "LAUNCH",
  },
  "significant-change": {
    id: "significant-change",
    mode: "quorum",
    title: GATE_COPY.gates["significant-change"].title,
    summary: GATE_COPY.gates["significant-change"].summary,
    requirements: ["R02", "R04", "R38"],
    slots: [
      { id: "impact-analysis", roles: ["isse"] },
      { id: "accept-analysis", roles: ["isso"] },
    ],
    sod: ["changeAuthorId", "prAuthorId", "agentId"],
    mfa: true,
    workflowEvent: null,
  },
  merge: {
    id: "merge",
    mode: "quorum",
    title: GATE_COPY.gates.merge.title,
    summary: GATE_COPY.gates.merge.summary,
    requirements: ["R36", "R42", "R50"],
    slots: [{ id: "reviewer", roles: reviewer }],
    sod: ["launcherId", "agentId", "prAuthorId", "changeAuthorId"],
    mfa: true,
    workflowEvent: "APPROVE_MERGE",
  },
  deploy: {
    id: "deploy",
    mode: "quorum",
    title: GATE_COPY.gates.deploy.title,
    summary: GATE_COPY.gates.deploy.summary,
    requirements: ["R03", "R36", "R37", "R40", "R42"],
    slots: [{ id: "release-manager", roles: ["release-manager"] }],
    sod: ["launcherId", "agentId", "prAuthorId", "changeAuthorId"],
    mfa: true,
    workflowEvent: "APPROVE_DEPLOY",
  },
  "ssp-text": {
    id: "ssp-text",
    mode: "quorum",
    title: GATE_COPY.gates["ssp-text"].title,
    summary: GATE_COPY.gates["ssp-text"].summary,
    requirements: ["R01", "R48", "R49"],
    slots: [
      { id: "isse-review", roles: ["isse"] },
      { id: "isso-accept", roles: ["isso"] },
    ],
    sod: ["agentId", "changeAuthorId"],
    mfa: true,
    workflowEvent: null,
  },
  exception: {
    id: "exception",
    mode: "quorum",
    title: GATE_COPY.gates.exception.title,
    summary: GATE_COPY.gates.exception.summary,
    requirements: ["R42", "R43"],
    slots: [{ id: "isso-exception", roles: ["isso"] }],
    sod: ["prAuthorId", "changeAuthorId", "agentId"],
    mfa: true,
    workflowEvent: null,
  },
  "risk-acceptance": {
    id: "risk-acceptance",
    mode: "external",
    title: GATE_COPY.gates["risk-acceptance"].title,
    summary: GATE_COPY.gates["risk-acceptance"].summary,
    requirements: ["R18", "R41", "R43"],
    slots: [],
    sod: ["changeAuthorId", "planAuthorId", "prAuthorId", "agentId"],
    mfa: true,
    workflowEvent: null,
  },
  "official-closure": {
    id: "official-closure",
    mode: "closure",
    title: GATE_COPY.gates["official-closure"].title,
    summary: GATE_COPY.gates["official-closure"].summary,
    requirements: ["R17", "R27", "R30", "R31"],
    slots: [{ id: "isso-submit", roles: ["isso"] }],
    sod: ["agentId"],
    mfa: true,
    workflowEvent: null,
  },
  ato: {
    id: "ato",
    mode: "outside",
    title: GATE_COPY.gates.ato.title,
    summary: GATE_COPY.gates.ato.summary,
    requirements: ["R05", "R10", "R40", "R41"],
    slots: [],
    sod: ["agentId"],
    mfa: true,
    workflowEvent: null,
  },
};

export function policyFor(id: HumanGateId): GatePolicy {
  return GATE_MATRIX[id];
}
