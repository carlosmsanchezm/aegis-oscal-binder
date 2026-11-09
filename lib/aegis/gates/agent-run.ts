import { AegisError } from "../errors";
import { GATE_COPY } from "./copy";
import { containsSecret } from "./redact";
import type { GateCase, LaunchScope } from "./types";

export type DeniedProbe = {
  action: "write-main" | "write-prod" | "approve-gate";
  result: "denied";
  at: string;
};

/** Placeholder a later GitHub agent run can fill. This record does not execute. */
export type AgentRunRecord = {
  schema: "binder.agent-run.v1";
  id: string;
  planId: string;
  poamId: string;
  agentId: string;
  status: "reserved";
  credentialRef: string;
  expiresAt: string;
  scope: LaunchScope;
  launchApprovalActorId: string;
  deniedProbes: DeniedProbe[];
  outputs: [];
  transcriptHash: null;
  illustrative: boolean;
  limitations: string[];
};

const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;
const CRED_REF = /^credref_[a-z0-9]{16,64}$/;

export function reserveAgentRun(gateCase: GateCase, input: { id: string; now: string; credentialRef: string; expiresAt: string }): AgentRunRecord {
  const launch = gateCase.gates["agent-launch"];
  if (launch.state !== "approved" || !launch.scope || !gateCase.parties.launcherId) {
    throw new AegisError("BAD_REQUEST", "An agent run needs an approved launch scope.", 400);
  }
  if (!RUN_ID.test(input.id) || !CRED_REF.test(input.credentialRef) || containsSecret(input.credentialRef)) {
    throw new AegisError("BAD_REQUEST", "Credential reference must be an opaque credref, not a secret.", 400);
  }
  const now = Date.parse(input.now);
  const expires = Date.parse(input.expiresAt);
  const approved = Date.parse(launch.updatedAt);
  const deadline = approved + launch.scope.hours * 60 * 60 * 1000;
  if (!Number.isFinite(now) || !Number.isFinite(expires) || !Number.isFinite(approved) || expires <= now || expires > deadline) {
    throw new AegisError("BAD_REQUEST", "Agent credential expiry is outside the approved window.", 400);
  }
  if (launch.scope.environments.some((item) => item === "prod" || item === "production") || launch.scope.branchPrefix === "main" || launch.scope.branchPrefix === "master") {
    throw new AegisError("BAD_REQUEST", "Agent scope cannot write main or production.", 400);
  }
  return {
    schema: "binder.agent-run.v1",
    id: input.id,
    planId: gateCase.planId,
    poamId: gateCase.poamId,
    agentId: gateCase.parties.agentId,
    status: "reserved",
    credentialRef: input.credentialRef,
    expiresAt: input.expiresAt,
    scope: { ...launch.scope, environments: [...launch.scope.environments] },
    launchApprovalActorId: gateCase.parties.launcherId,
    deniedProbes: [
      { action: "write-main", result: "denied", at: input.now },
      { action: "write-prod", result: "denied", at: input.now },
      { action: "approve-gate", result: "denied", at: input.now },
    ],
    outputs: [],
    transcriptHash: null,
    illustrative: gateCase.illustrative,
    limitations: [GATE_COPY.limitations.agentPlaceholder, GATE_COPY.limitations.noAto, GATE_COPY.limitations.synthetic],
  };
}

/** Execution is intentionally absent. A later GitHub connection plugs in here. */
export function executeAgentRun(_run: AgentRunRecord): never {
  throw new AegisError("NOT_BUILT", "Agent execution is not implemented. This record is a placeholder.", 501);
}
