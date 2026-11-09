import { getAgentActivity } from "./audit";
import { legacyRefusalCode } from "./refusal";
import { verifyConnectionChains } from "./verify";
import { connectionProposals } from "./approvals";
import { queryTimeline } from "../timeline/store";
import { readConnection, listBundles } from "../server/builder-store";
import { trustedReleases } from "../collector/trusted-release";
import {
  listConnectionExports,
  verifyConnectionExport,
} from "../oscal/export-history";
export async function agentSummary(
  connectionId: string,
  sessionId: string,
  origin: string,
) {
  const chains = await verifyConnectionChains(connectionId);
  const [audit, timeline, connection, bundles, trusted, exports, proposals] =
    await Promise.all([
      chains.audit.valid
        ? getAgentActivity(connectionId)
        : Promise.resolve(null),
      chains.evidence.valid
        ? queryTimeline(connectionId)
        : Promise.resolve(null),
      readConnection(connectionId),
      listBundles(connectionId),
      trustedReleases(sessionId, connectionId),
      listConnectionExports(connectionId),
      connectionProposals(connectionId, sessionId, origin),
    ]);
  const outcomes = audit?.filter((e) => e.body.result !== "requested") ?? null;
  const refusals_by_reason: Record<string, number> = Object.create(null);
  for (const e of outcomes ?? [])
    if (e.body.refusalReason) {
      const code =
        e.body.refusalCode ?? legacyRefusalCode(e.body.refusalReason);
      refusals_by_reason[code] = (refusals_by_reason[code] ?? 0) + 1;
    }
  const actions_by_tool: Record<string, number> = Object.create(null);
  for (const e of outcomes ?? [])
    actions_by_tool[e.body.tool] = (actions_by_tool[e.body.tool] ?? 0) + 1;
  const trustedIds = new Set(trusted.map((r) => r.releaseSha256));
  const collected = bundles.filter((b) => trustedIds.has(b.id)),
    uploaded = bundles.filter((b) => !trustedIds.has(b.id));
  const closed = proposals
    .map((p) => p.proposal)
    .filter((p) => p.closureConfirmed && p.closure?.name && p.closure.reason);
  const confirmationEvents = (timeline ?? []).filter(
    (e) =>
      e.body.review?.stage === "closure" &&
      e.body.review.decision === "confirm",
  );
  const appliedReviews = new Set(
    (timeline ?? [])
      .filter((e) => e.body.reason_code === "person_decision_applied")
      .map((e) => e.body.summary.review_hash),
  );
  const projected = confirmationEvents.filter(
    (e) =>
      appliedReviews.has(e.hash) ||
      proposals.some(
        (p) =>
          p.proposal.id === e.body.review!.proposalId &&
          p.review?.at === e.body.review!.at &&
          p.review.decision === "confirm" &&
          p.review.stage === "closure",
      ),
  );
  const named = projected.map((e) => ({
    proposal_id: e.body.review!.proposalId,
    name: e.body.review!.name,
    reason: e.body.review!.reason,
    at: e.body.review!.at,
    currently_verified: closed.some(
      (p) =>
        p.id === e.body.review!.proposalId &&
        p.closure!.at === e.body.review!.at,
    ),
  }));
  for (const p of closed)
    if (!named.some((n) => n.proposal_id === p.id && n.at === p.closure!.at))
      named.push({
        proposal_id: p.id,
        ...p.closure!,
        currently_verified: true,
      });
  const last = exports.find((e) => e.manifest.signing.status === "signed");
  const dates = [
    connection?.createdAt,
    ...(audit ?? []).map((e) => e.body.at),
    ...(timeline ?? []).map((e) => e.body.recordedAt),
    ...exports.map((e) => e.createdAt),
  ]
    .filter((s): s is string => !!s && Number.isFinite(Date.parse(s)))
    .sort();
  return {
    connection_id: connectionId,
    generated_at: new Date().toISOString(),
    agent_actions: outcomes
      ? { total: outcomes.length, by_tool: actions_by_tool }
      : null,
    refusals_by_reason: outcomes ? refusals_by_reason : null,
    closures_confirmed_by_named_people: timeline
      ? {
          count: named.length,
          items: named,
          unprojected_decisions: confirmationEvents.length - projected.length,
        }
      : null,
    evidence: {
      server_collected: {
        runs: collected.length,
        artifacts: collected.reduce((n, b) => n + b.event.artifacts.length, 0),
      },
      uploaded: {
        runs: uploaded.length,
        artifacts: uploaded.reduce((n, b) => n + b.event.artifacts.length, 0),
      },
    },
    chains,
    last_signed_export: last
      ? {
          id: last.id,
          created_at: last.createdAt,
          key_id: last.manifest.signing.keyId,
          verification: await verifyConnectionExport(last),
        }
      : null,
    history_start_date: dates[0] ?? null,
    history_complete: chains.valid,
    history_scope:
      "Retained connection history; export history begins when connection-export retention was enabled. Unauthenticated attempts cannot be attributed to a connection.",
  };
}
