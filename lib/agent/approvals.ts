import {
  itemSource,
  personSource,
  type ItemSource,
} from "../aegis/item-source";
import { evaluateCollectedScannerGate } from "../aegis/gates/engine";
import {
  readRemediation,
  updateRemediationRecord,
  type RemediationRecord,
} from "../aegis/remediation-store";
import { collectedProposal } from "../aegis/collected-closure";
import {
  applyDecision,
  decisionFromProposal,
  normalizePlanDecision,
  proposePlans,
  type PlanProposal,
} from "../aegis/plan-proposal";
import { issueDraft, validateDraftText } from "../aegis/issue-actions";
import { containsSecret } from "../aegis/gates/redact";
import { canonicalSha256 } from "../collector/aws/jcs";
import { readConnection, listBundles } from "../server/builder-store";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { connectedReleases } from "../aegis/connected-evidence";
import { queryTimeline, appendTimeline } from "../timeline/store";
import { AgentAccessError } from "./agent-token";
type Review = {
  name: string;
  reason: string;
  at: string;
  source_label?: ItemSource;
  identity_verification?: "typed_unverified";
  stage: "plan" | "closure" | "triage";
  decision: "confirm" | "reject";
  version: string;
};
export const proposalKey = (connectionId: string) =>
  "binder.plan-proposals.v1:binder-connection:" + connectionId;
export function reviewVersion(p: PlanProposal) {
  return canonicalSha256({
    id: p.id,
    finding: p.finding,
    controlId: p.controlId,
    risk: p.riskStatement,
    action: p.action,
    milestone: p.milestone,
    acceptance: p.acceptance,
    readyToClose: p.readyToClose,
    closureConfirmed: p.closureConfirmed,
    correctiveReleaseId: p.correctiveReleaseId,
    closure_review: p.closure_review ?? null,
    draft_revision: p.draft_revision ?? null,
    source_label: p.source_label ?? null,
    agent_draft_fields: p.agent_draft_fields ?? [],
  });
}
function storedReview(value: unknown): Review | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Review;
  return typeof r.name === "string" &&
    r.name.trim().length > 0 &&
    r.name.length <= 200 &&
    typeof r.reason === "string" &&
    r.reason.trim().length > 0 &&
    r.reason.length <= 4000 &&
    Number.isFinite(Date.parse(r.at)) &&
    ["plan", "closure", "triage"].includes(r.stage) &&
    ["confirm", "reject"].includes(r.decision) &&
    /^[a-f0-9]{64}$/.test(r.version)
    ? r
    : null;
}
async function proposalsFromRecord(
  connectionId: string,
  sessionId: string,
  record: RemediationRecord | null,
  origin: string,
  poamItemId?: string,
) {
  const c = await readConnection(connectionId);
  if (!c || c.revokedAt)
    throw new AgentAccessError("Connection is unavailable.", 403, "scope");
  const releases = connectedReleases(
    {
      ...c,
      revokedAt: null,
      history: (await listBundles(connectionId)).map(summarizeBuilderBundle),
    },
    origin,
  );
  const drafts: PlanProposal[] = [];
  for (const value of record?.issueDrafts ?? []) {
    const p = value as PlanProposal,
      source = releases.find((r) => r.pipelineId === p.sourceReleaseId),
      issue = source?.reviewItems?.find(
        (i) => p.id.endsWith(":" + i.id) && i.description === p.finding,
      );
    if (!source || !issue) continue;
    const draft = issueDraft(
      source,
      issue,
      validateDraftText({
        risk: p.riskStatement,
        action: p.action,
        verification: p.milestone.description,
      }),
    );
    if (draft.id === p.id)
      drafts.push({
        ...draft,
        draft_revision: p.draft_revision,
        source_label: itemSource(p.source_label),
        agent_draft_fields: p.agent_draft_fields,
        closure_review: p.closure_review,
      });
  }
  const decisions = (record?.proposals ?? []).map((value) => ({
    decision: normalizePlanDecision(value),
    review: storedReview((value as { review?: unknown }).review),
  }));
  const fresh = [
    ...new Map(
      [...proposePlans(releases), ...drafts].map((p) => [p.id, p]),
    ).values(),
  ];
  return Promise.all(
    fresh.filter(p => poamItemId === undefined || p.id === poamItemId).map(async (p) => {
      const saved = decisions.find((d) => d.decision?.id === p.id);
      const computed = await collectedProposal(sessionId, p, connectionId);
      if (
        saved?.review?.decision === "reject" &&
        saved.review.stage === "plan" &&
        reviewVersion(computed) !== saved.review.version
      )
        return { proposal: computed, review: null };
      return {
        proposal: applyDecision(computed, saved?.decision ?? null),
        review: saved?.review ?? null,
      };
    }),
  );
}
export async function connectionProposals(
  connectionId: string,
  sessionId: string,
  origin = "http://localhost:3000",
  poamItemId?: string,
) {
  const record =
    (await readRemediation(sessionId))?.records.find(
      (r) => r.key === proposalKey(connectionId),
    ) ?? null;
  return proposalsFromRecord(connectionId, sessionId, record, origin, poamItemId);
}
export async function listApprovals(
  connectionId: string,
  sessionId: string,
  origin: string,
) {
  return (await connectionProposals(connectionId, sessionId, origin)).flatMap(
    ({ proposal: p, review }) => {
      if (
        p.closureConfirmed ||
        (p.acceptance === "accepted" &&
          !p.readyToClose &&
          p.closure_review?.state !== "requested")
      )
        return [];
      const version = reviewVersion(p),
        stage = p.acceptance === "proposed" ? "plan" : "closure";
      if (
        review?.decision === "reject" &&
        review.stage === stage &&
        review.version === version
      )
        return [];
      return [
        {
          proposal_id: p.id,
          poam_item_id: p.id,
          finding_id: p.id.split(":").at(-1),
          source_label: itemSource(p.source_label),
          agent_draft_fields: p.agent_draft_fields ?? [],
          required_role: "isso",
          workflow_step: stage === "plan" ? "poam" : "closure-review",
          approver_identity_verification: "typed_unverified",
          finding: p.finding,
          control: p.controlId,
          source_release_id: p.sourceReleaseId,
          stage,
          version,
          server_evidence_ready: p.readyToClose,
          requires_name: true,
          requires_reason: true,
        },
      ];
    },
  );
}
export async function decideApproval(
  connectionId: string,
  sessionId: string,
  body: Record<string, unknown>,
  origin: string,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AgentAccessError(
      "A review object is required.",
      400,
      "invalid_request",
    );
  const { proposal_id, stage, decision, name, reason, version } = body;
  if (
    typeof proposal_id !== "string" ||
    proposal_id.length > 200 ||
    !["plan", "closure", "triage"].includes(String(stage)) ||
    !["confirm", "reject"].includes(String(decision)) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 200 ||
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.length > 4000 ||
    typeof version !== "string" ||
    !/^[a-f0-9]{64}$/.test(version)
  )
    throw new AgentAccessError(
      "A proposal, stage, decision, version, name and reason are required.",
      400,
      "invalid_request",
    );
  if (containsSecret(name) || containsSecret(reason))
    throw new AgentAccessError(
      "Remove credentials from the review fields.",
      400,
      "invalid_request",
    );
  if (stage === "triage") return decideTriage(connectionId, sessionId, body);
  let result: unknown;
  await updateRemediationRecord(
    sessionId,
    proposalKey(connectionId),
    async (record) => {
      const all = await proposalsFromRecord(
          connectionId,
          sessionId,
          record,
          origin,
        ),
        found = all.find((p) => p.proposal.id === proposal_id);
      if (!found)
        throw new AgentAccessError(
          "Finding proposal is unavailable.",
          404,
          "invalid_request",
        );
      const p = found.proposal;
      if (reviewVersion(p) !== version)
        throw new AgentAccessError(
          "This review changed. Reload it before deciding.",
          409,
          "invalid_request",
        );
      if (p.closureConfirmed)
        throw new AgentAccessError(
          "Closure is already recorded by a person.",
          409,
          "needs_human",
        );
      if (stage === "closure" && decision === "confirm") {
        const proof = await evaluateCollectedScannerGate(
          sessionId,
          p.sourceReleaseId,
          p.id.split(":").at(-1)!,
          connectionId,
        );
        if (!proof.ready || !p.readyToClose)
          throw new AgentAccessError(
            "A fresh server-collected retest is required before closure.",
            409,
            "needs_server_evidence",
          );
      }
      if (stage === "closure" && p.acceptance !== "accepted")
        throw new AgentAccessError(
          "A person must accept the plan before reviewing closure.",
          409,
          "needs_human",
        );
      if (stage === "plan" && p.acceptance === "accepted")
        throw new AgentAccessError(
          "Plan acceptance is already recorded.",
          409,
          "needs_human",
        );
      let review: Review = {
        name: name.trim(),
        reason: reason.trim(),
        at: new Date().toISOString(),
        stage: stage as Review["stage"],
        decision: decision as Review["decision"],
        version,
        source_label: personSource(name.trim()),
        identity_verification: "typed_unverified",
      };
      const id = canonicalSha256({ proposal_id, stage, version });
      const prior = (await queryTimeline(connectionId)).find(
        (e) => e.body.id === id,
      )?.body.review;
      if (prior) {
        if (
          prior.decision !== decision ||
          prior.name !== review.name ||
          prior.reason !== review.reason
        )
          throw new AgentAccessError(
            "This review version already has a person's decision. Reload it.",
            409,
            "needs_human",
          );
        review = prior;
      }
      const next = decisionFromProposal(p, {
        acceptance:
          stage === "plan"
            ? decision === "confirm"
              ? "accepted"
              : "proposed"
            : p.acceptance,
        closureConfirmed: stage === "closure" && decision === "confirm",
        ...(stage === "closure" && decision === "confirm"
          ? {
              closure: {
                name: review.name,
                reason: review.reason,
                at: review.at,
              },
            }
          : {}),
      });
      // Record the person's decision before its mutable projection. A failed log write blocks the mutation.
      const event = await appendTimeline(connectionId, {
        id,
        kind: "human-review",
        source: {},
        commit: "",
        observedAt: review.at,
        artifactSha256: [],
        controls: [p.controlId],
        findings: [p.id.split(":").at(-1)!],
        collected: false,
        source_label: personSource(review.name),
        reason_code:
          stage === "closure"
            ? decision === "confirm"
              ? "closure_confirmed"
              : "closure_rejected"
            : decision === "confirm"
              ? "poam_accepted"
              : "poam_rejected",
        items: [p.id],
        summary: {
          proposalId: p.id,
          stage: review.stage,
          decision: review.decision,
          name: review.name,
          reason: review.reason,
        },
        review: { ...review, proposalId: p.id },
      });
      if (
        JSON.stringify(event.body.review) !==
        JSON.stringify({ ...review, proposalId: p.id })
      )
        throw new AgentAccessError(
          "Another person decided this review version. Reload it.",
          409,
          "needs_human",
        );
      const proposals = all
        .filter(
          (x) =>
            x.proposal.acceptance === "accepted" ||
            record?.proposals?.some(
              (v) => (v as { id: string }).id === x.proposal.id,
            ),
        )
        .map((x) => ({
          ...decisionFromProposal(x.proposal),
          ...(x.review ? { review: x.review } : {}),
        }));
      const base = record ?? {
        key: proposalKey(connectionId),
        assessment: null,
        assessments: {},
        plans: [],
        proposals: [],
      };
      result = {
        proposal:
          stage === "closure" && decision === "reject"
            ? {
                ...applyDecision(p, next),
                readyToClose: false,
                workflowState: p.closure_review?.prior_step ?? "rescan-pending",
                closure_review: {
                  ...p.closure_review,
                  state: "rejected",
                  requested_at: p.closure_review?.requested_at ?? review.at,
                  prior_step: p.closure_review?.prior_step ?? "rescan-pending",
                  rejected_at: review.at,
                },
              }
            : applyDecision(p, next),
        review,
        timeline: { sequence: event.sequence, hash: event.hash },
      };
      return {
        ...base,
        proposals: [
          ...proposals.filter((d) => d.id !== p.id),
          { ...next, review },
        ],
        issueDrafts: all
          .filter((x) =>
            base.issueDrafts?.some(
              (v) => (v as { id: string }).id === x.proposal.id,
            ),
          )
          .map((x) => ({
            ...x.proposal,
            source_label: (
              base.issueDrafts?.find(
                (v) => (v as { id: string }).id === x.proposal.id,
              ) as PlanProposal | undefined
            )?.source_label,
            closureConfirmed: false,
            readyToClose:
              x.proposal.readyToClose || x.proposal.closureConfirmed,
            ...(x.proposal.id === p.id &&
            stage === "closure" &&
            decision === "reject"
              ? {
                  closure_review: {
                    ...p.closure_review,
                    requested_at: p.closure_review?.requested_at ?? review.at,
                    prior_step:
                      p.closure_review?.prior_step ?? "rescan-pending",
                    state: "rejected" as const,
                    rejected_at: review.at,
                  },
                  readyToClose: false,
                  workflowState:
                    p.closure_review?.prior_step ?? "rescan-pending",
                }
              : {}),
            workflowState:
              x.proposal.id === p.id &&
              stage === "closure" &&
              decision === "reject"
                ? (p.closure_review?.prior_step ?? "rescan-pending")
                : (x.proposal.workflowState ?? "planned"),
          })),
      };
    },
  );
  await recordDecisionApplied(connectionId, result);
  return result;
}

export async function triageApprovals(connectionId: string, sessionId: string) {
  const record = (await readRemediation(sessionId))?.records.find(
    (r) => r.key === proposalKey(connectionId),
  );
  return (record?.issueTriage ?? []).flatMap((value) => {
    const t = value as import("../aegis/issue-actions").IssueTriage;
    if (
      t.source_label?.kind !== "agent" ||
      t.acceptance !== "proposed" ||
      !t.id
    )
      return [];
    return [
      {
        proposal_id: t.id,
        finding_id: t.issueId,
        poam_item_id: t.poam_item_id ?? null,
        finding: t.reason,
        control: null,
        source_release_id: t.receiptId,
        stage: "triage",
        version: canonicalSha256(t),
        source_label: itemSource(t.source_label),
        required_role: "isso",
        workflow_step: "finding",
        outcome: t.outcome,
        requires_name: true,
        requires_reason: true,
        approver_identity_verification: "typed_unverified",
      },
    ];
  });
}
async function decideTriage(
  connectionId: string,
  sessionId: string,
  body: Record<string, unknown>,
) {
  const { proposal_id, version, decision, name, reason } = body;
  let result: unknown;
  await updateRemediationRecord(
    sessionId,
    proposalKey(connectionId),
    async (record) => {
      if (!record)
        throw new AgentAccessError(
          "Finding proposal is unavailable.",
          404,
          "invalid_request",
        );
      const t = record.issueTriage?.find(
        (v) => (v as { id: string }).id === proposal_id,
      ) as import("../aegis/issue-actions").IssueTriage | undefined;
      if (!t || t.source_label?.kind !== "agent")
        throw new AgentAccessError(
          "Finding proposal is unavailable.",
          404,
          "invalid_request",
        );
      if (t.acceptance !== "proposed" || canonicalSha256(t) !== version)
        throw new AgentAccessError(
          "This finding review changed. Reload it.",
          409,
          "invalid_request",
        );
      const review = {
        name: String(name).trim(),
        reason: String(reason).trim(),
        at: new Date().toISOString(),
        stage: "triage" as const,
        decision: decision as "confirm" | "reject",
        version: String(version),
        source_label: personSource(String(name).trim()),
        identity_verification: "typed_unverified" as const,
      };
      const event = await appendTimeline(connectionId, {
        id: canonicalSha256({ proposal_id, version }),
        kind: "human-review",
        source: {},
        source_label: review.source_label,
        reason_code:
          decision === "confirm" ? "triage_accepted" : "triage_rejected",
        items: t.poam_item_id ? [t.poam_item_id] : [],
        commit: "",
        observedAt: review.at,
        artifactSha256: [],
        controls: [],
        findings: [t.issueId],
        collected: false,
        summary: {
          outcome: t.outcome,
          name: review.name,
          reason: review.reason,
        },
        review: { ...review, proposalId: t.id! },
      });
      if (
        !event.body.review ||
        event.body.review.decision !== decision ||
        event.body.review.name !== review.name ||
        event.body.review.reason !== review.reason
      )
        throw new AgentAccessError(
          "Another ISSO decided this finding proposal.",
          409,
          "needs_human",
        );
      const updated = {
        ...t,
        acceptance: decision === "confirm" ? "accepted" : "rejected",
        review,
      };
      result = {
        decision: updated,
        review,
        timeline: { sequence: event.sequence, hash: event.hash },
      };
      return {
        ...record,
        issueTriage: record.issueTriage!.map((v) =>
          (v as { id: string }).id === t.id ? updated : v,
        ),
      };
    },
  );
  await recordDecisionApplied(connectionId, result);
  return result;
}

async function recordDecisionApplied(connectionId: string, value: unknown) {
  const result = value as {
    review: Review;
    timeline: { hash: string };
    proposal?: PlanProposal;
    decision?: import("../aegis/issue-actions").IssueTriage;
  };
  const item = result.proposal?.id ?? result.decision?.poam_item_id,
    finding = result.decision?.issueId ?? result.proposal?.id.split(":").at(-1);
  await appendTimeline(connectionId, {
    id: "review-applied:" + result.timeline.hash,
    kind: "person-action",
    source: {},
    source_label: personSource(result.review.name),
    reason_code: "person_decision_applied",
    items: item ? [item] : [],
    findings: finding ? [finding] : [],
    commit: "",
    observedAt: result.review.at,
    artifactSha256: [],
    controls: result.proposal ? [result.proposal.controlId] : [],
    collected: false,
    summary: {
      review_hash: result.timeline.hash,
      decision: result.review.decision,
      stage: result.review.stage,
      message: "Person's decision applied to the item.",
    },
  });
}
