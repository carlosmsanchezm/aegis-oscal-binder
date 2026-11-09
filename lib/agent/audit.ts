import { agentSource } from "../aegis/item-source";
import { appendTimeline } from "../timeline/store";
import { legacyRefusalCode, type RefusalCode } from "./refusal";
import { randomUUID } from "node:crypto";
import { appendLog, readLog } from "../immutable-log";
import { storageKey } from "../storage-key";
import { redactText, redactValue } from "../aegis/gates/redact";
export type AgentActivity = {
  schema: "binder.agent-activity.v1";
  id: string;
  at: string;
  tokenId: string;
  source_label?: import("../aegis/item-source").ItemSource;
  tool: string;
  inputs: unknown;
  result: string;
  refusalReason: string | null;
  refusalCode?: RefusalCode | null;
};
const prefix = (id: string) => storageKey(["agent-audit", id]) + "/";
export function auditSafe(value: unknown): unknown {
  const bounded = JSON.stringify(redactValue(value))
    .replace(/aegis_agt_[a-f0-9]{32}_[a-f0-9]{64}/g, "[redacted]")
    .slice(0, 16000);
  try {
    return JSON.parse(bounded);
  } catch {
    return { summary: bounded };
  }
}
export async function appendAgentActivity(
  connectionId: string,
  input: Omit<AgentActivity, "schema" | "id" | "at">,
) {
  const body: AgentActivity = {
    schema: "binder.agent-activity.v1",
    id: randomUUID(),
    at: new Date().toISOString(),
    ...input,
    source_label: agentSource(input.tokenId),
    tool: redactText(input.tool).slice(0, 120),
    inputs: auditSafe(input.inputs),
    refusalReason: input.refusalReason
      ? String(auditSafe(input.refusalReason)).replace(/^"|"$/g, "")
      : null,
    refusalCode:
      input.refusalCode ??
      (input.refusalReason ? legacyRefusalCode(input.refusalReason) : null),
  };
  const entry = await appendLog(
    prefix(connectionId),
    body,
    (x) => x.id === body.id,
  );
  const rawInputs = input.inputs as {
    issueId?: unknown;
    proposal_id?: unknown;
    poam_item_id?: unknown;
    poamItemId?: unknown;
  } | null;
  const inputs = auditSafe({
    issueId: rawInputs?.issueId,
    proposal_id: rawInputs?.proposal_id,
    poam_item_id: rawInputs?.poam_item_id,
    poamItemId: rawInputs?.poamItemId,
  }) as {
    issueId?: unknown;
    proposal_id?: unknown;
    poam_item_id?: unknown;
    poamItemId?: unknown;
  };
  const finding =
    typeof inputs?.issueId === "string" && inputs.issueId.length <= 200
      ? inputs.issueId
      : undefined;
  const poam =
    typeof inputs?.proposal_id === "string"
      ? inputs.proposal_id
      : typeof inputs?.poam_item_id === "string"
        ? inputs.poam_item_id
        : undefined;
  if (finding || poam)
    await appendTimeline(connectionId, {
      id: "agent:" + body.id,
      kind: "agent-action",
      source: {},
      source_label: agentSource(body.tokenId),
      reason_code:
        body.refusalCode ??
        (body.result === "requested"
          ? "agent_action_requested"
          : body.tool === "propose_fix_pr"
            ? "fix_pr_proposed"
          : body.tool === "draft_plan"
            ? "poam_draft_proposed"
            : body.tool === "triage_finding"
              ? "triage_proposed"
              : body.tool === "request_retest"
                ? "retest_requested"
                : body.tool === "attempt_close"
                  ? "closure_review_requested"
                  : "agent_action_recorded"),
      items: poam ? [poam] : [],
      findings: finding ? [finding] : poam ? [poam.split(":").at(-1)!] : [],
      commit: "",
      observedAt: body.at,
      artifactSha256: [],
      controls: [],
      collected: false,
      summary: {
        tool: body.tool,
        result: body.result,
        message: body.refusalReason ?? "Agent action recorded.",
        auditHash: entry.hash,
      },
    });
  return entry;
}
export function getAgentActivity(connectionId: string) {
  return readLog<AgentActivity>(prefix(connectionId));
}

export async function verifyAgentActivity(connectionId: string) {
  try {
    const entries = await getAgentActivity(connectionId);
    return {
      valid: true,
      entries: entries.length,
      head: entries.at(-1)?.hash ?? null,
    };
  } catch {
    return { valid: false, error: "Agent audit chain verification failed." };
  }
}
