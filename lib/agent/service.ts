import { hasAgentScope } from "./scopes";
import { evidenceSource } from "../aegis/evidence-source";
import { itemSource, personSource, agentSource } from "../aegis/item-source";
import { collectedProposal } from "../aegis/collected-closure";
import { applyDecision, normalizePlanDecision } from "../aegis/plan-proposal";
import { randomUUID } from "node:crypto";
import { readConnection, listBundles } from "../server/builder-store";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { connectedReleases } from "../aegis/connected-evidence";
import { releaseIssues } from "../aegis/release-issues";
import { releaseProject } from "../aegis/control-rollup";
import { gateIssueState } from "../aegis/gate-issue-state";
import { evaluateCollectedScannerGate } from "../aegis/gates/engine";
import {
  readRemediation,
  writeRemediationRecord,
} from "../aegis/remediation-store";
import { issueDraft } from "../aegis/issue-actions";
import { performIssueAction } from "../server/issue-actions";
import { storageKey } from "../storage-key";
import { appendLog } from "../immutable-log";
import { getAgentActivity } from "./audit";
import { AgentAccessError, type AgentToken } from "./agent-token";
import type { PlanProposal } from "../aegis/plan-proposal";
export async function connectionRecords(
  principal: Pick<AgentToken, "connectionId" | "ownerHash">,
  origin = "http://localhost:3000",
) {
  const c = await readConnection(principal.connectionId);
  if (!c || c.revokedAt || c.ownerHash !== principal.ownerHash)
    throw new Error("Connection unavailable.");
  return connectedReleases(
    {
      ...c,
      revokedAt: null,
      history: (await listBundles(c.id)).map(summarizeBuilderBundle),
    },
    origin,
  );
}
export async function agentAction(
  principal: AgentToken,
  tool: string,
  input: {
    receiptId?: string;
    issueId?: string;
    control?: string;
    outcome?: string;
    reason?: string;
    draft?: { risk: string; action: string; verification: string };
    runnerAssignmentId?: string;
    poamItemId?: string;
    operation?: string; prUrl?: string; prNumber?: number; head?: string; base?: string; title?: string;
  },
  origin = "http://localhost:3000",
) {
  if (tool === "get_agent_activity")
    return getAgentActivity(principal.connectionId);
  if (tool === "claim_fix" || tool === "get_fix_assignments") {
    if (!hasAgentScope(principal, "propose_fix_pr")) throw new AgentAccessError("Agent scope is required: propose_fix_pr", 403, "scope");
    await connectionRecords(principal, origin);
    const runner = await import("./fix-runner");
    if (tool === "get_fix_assignments") {
      if (input.runnerAssignmentId) await runner.renewFix(principal.sessionId, principal.connectionId, principal.id, input.runnerAssignmentId);
      return runner.getFixRunner(principal.sessionId, principal.connectionId);
    }
    await runner.refreshFixRunner(principal.sessionId, principal.connectionId);
    return runner.claimFix(principal.sessionId, principal.connectionId, principal.id);
  }
  if (tool === "propose_fix_pr") {
    if (!hasAgentScope(principal, "propose_fix_pr")) throw new AgentAccessError("Agent scope is required: propose_fix_pr", 403, "scope");
    await connectionRecords(principal, origin);
    return (await import("../github/pull-requests")).proposeFixPr(principal.sessionId, principal.connectionId, `agent:${principal.id}`, input);
  }
  const releases = await connectionRecords(principal, origin),
    record = input.receiptId
      ? releases.find((r) => r.releaseSha256 === input.receiptId)
      : releases.at(-1);
  const stored = (
    (await readRemediation(principal.sessionId))?.records ?? []
  ).filter(
    (r) =>
      r.key ===
      `binder.plan-proposals.v1:binder-connection:${principal.connectionId}`,
  );
  const decisions = stored
    .flatMap((r) => r.proposals ?? [])
    .map(normalizePlanDecision)
    .filter((p) => p !== null);
  const plans = await Promise.all(
    (stored.flatMap((r) => r.issueDrafts ?? []) as PlanProposal[]).map(
      async (p) =>
        applyDecision(
          await collectedProposal(
            principal.sessionId,
            p,
            principal.connectionId,
          ),
          decisions.find((d) => d.id === p.id) ?? null,
        ),
    ),
  );
  if (tool === "get_package") {
    const c = await readConnection(principal.connectionId);
    const { readActiveSession } = await import("../aegis/store");
    const { getPackageState } = await import("../aegis");
    const session = await readActiveSession(principal.sessionId);
    if (!session)
      throw new AgentAccessError("Agent credential is invalid or revoked.");
    const pkg = getPackageState(session.state, session.ctx);
    const summary = {
      loaded: pkg.loaded,
      workspaceName: pkg.workspaceName,
      boundaryId: pkg.boundaryId,
      catalog: pkg.catalog,
      catalogPin: pkg.catalogPin,
      sourceProfileHref: pkg.sourceProfileHref,
      inScopeCount: pkg.inScopeCount,
      families: pkg.families.map((f) => ({
        id: f.id,
        total: f.total,
        open: f.open,
      })),
      gate: {
        status: pkg.gate.status,
        total: pkg.gate.total,
        complete: pkg.gate.complete,
        incomplete: pkg.gate.incomplete,
      },
    };
    return {
      connectionId: c!.id,
      system: c!.name,
      package: summary,
      sourceRuns: releases.map((r) => ({
        runId: r.artifactJobId,
        commit: r.commitSha,
      })),
      mappedControls: [
        ...new Set(
          releases.flatMap(
            (r) => r.reviewItems?.flatMap((i) => i.scope.controls) ?? [],
          ),
        ),
      ],
    };
  }
  if (!record) throw new Error("No retained collection is available.");
  if (tool === "list_findings") {
    const source_label = await evidenceSource(
      principal.sessionId,
      principal.connectionId,
      record.releaseSha256,
    );
    return {
      receiptId: record.releaseSha256,
      retainedEvidenceUrl: record.pipelineUrl,
      sourceRun: record.artifactJobId,
      issues: releaseIssues(record, plans, releases).groups.map((group) => ({
        control: group.control,
        open: group.open,
        findings: group.issues.map((i) => ({
          id: i.observation?.id ?? i.id,
          source_label,
          proposals: plans
            .filter((p) => p.id.endsWith(":" + (i.observation?.id ?? i.id)))
            .map((p) => ({ ...p, source_label: itemSource(p.source_label) })),
          rule: i.id,
          title: i.what,
          target: i.observation?.scope.title ?? null,
          state: i.state,
          sourceRun: i.source?.artifactJobId ?? record.artifactJobId,
          triage_proposals: stored
            .flatMap((r) => r.issueTriage ?? [])
            .filter(
              (t) =>
                (t as { issueId: string }).issueId ===
                (i.observation?.id ?? i.id),
            )
            .map((t) => ({
              ...(t as object),
              source_label: itemSource(
                (t as { source_label?: unknown }).source_label,
              ),
            })),
          artifactSha256:
            i.source?.collectedArtifacts?.find((a) => a.name === i.file)
              ?.sha256 ??
            record.collectedArtifacts?.find((a) => a.name === i.file)?.sha256 ??
            null,
        })),
      })),
      artifacts: record.collectedArtifacts?.map((a) => ({
        name: a.name,
        sha256: a.sha256,
        source_label,
      })),
    };
  }
  if (tool === "get_gate_status")
    return {
      release: record.pipelineId,
      checks: record.checks,
      plans: plans
        .filter((p) => p.sourceReleaseId === record.pipelineId)
        .map((p) => ({
          id: p.id,
          source_label: itemSource(p.source_label),
          workflow: p.workflowState ?? "planned",
          ...gateIssueState(p.workflowState ?? "planned"),
        })),
    };
  const issue = record.reviewItems?.find((i) => i.id === input.issueId);
  if (tool === "get_evidence") {
    const { scannerRetestDiff } = await import("../collector/retest-diff");
    const { queryTimeline } = await import("../timeline/store");
    const retestRequests = await (
      await import("./retest")
    ).retestRequests(principal.connectionId, principal.sessionId);
    return {
      retestRequests: retestRequests.map((r) => ({
        ...r,
        source_label: agentSource(r.tokenId),
      })),
      artifacts: (
        await Promise.all(
          (record.collectedArtifacts ?? []).map(async (a) => ({
            ...a,
            source_label: await evidenceSource(
              principal.sessionId,
              principal.connectionId,
              record.releaseSha256,
            ),
          })),
        )
      ).filter(
        (a) =>
          !input.control ||
          record.reviewItems?.some(
            (i) =>
              i.scope.controls.includes(input.control!) &&
              i.scope.artifacts.includes(a.name),
          ),
      ),
      retests: await Promise.all(
        releases.map(async (r) => ({
          runId: r.artifactJobId,
          ...scannerRetestDiff(record, r),
          // A historical measured difference is retained even after its evidence expires.
          // Current fixed/unverified and all closure decisions still use the current clock.
          measuredAt: r.createdAt,
          measured: scannerRetestDiff(record, r, Date.parse(r.createdAt)),
          source_label: await evidenceSource(
            principal.sessionId,
            principal.connectionId,
            r.releaseSha256,
          ),
        })),
      ),
      timeline: await queryTimeline(principal.connectionId, {
        control: input.control,
        finding: input.issueId,
      }),
    };
  }
  if (!issue) throw new Error("Select a retained finding id.");
  if (tool === "draft_plan" || tool === "triage_finding")
    return performIssueAction({
      connectionId: principal.connectionId,
      receiptId: record.releaseSha256,
      issueId: issue.id,
      sessionId: principal.sessionId,
      origin,
      actor: `agent:${principal.id}`,
      at: new Date().toISOString(),
      action: tool === "draft_plan" ? "draft" : "triage",
      outcome: input.outcome,
      reason: input.reason,
      draft: input.draft,
      poamItemId: input.poamItemId,
    });
  if (tool === "request_retest") {
    const trusted = await (
      await import("../collector/trusted-release")
    ).trustedReleases(principal.sessionId, principal.connectionId);
    if (
      record.observation.producer !== "GitHub Actions" ||
      !trusted.some((r) => r.releaseSha256 === record.releaseSha256)
    )
      throw new Error(
        "Collect the source workflow through the server reader before requesting its retest. No workflow source is inferred from an upload.",
      );
    const request = {
      id: randomUUID(),
      at: new Date().toISOString(),
      tokenId: principal.id,
      source_label: agentSource(principal.id),
      issueId: issue.id,
      sourceReceipt: record.releaseSha256,
      sourceWorkflow:
        record.observation.subject.id +
        "/actions/workflows/aegis-release-evidence.yml",
      state: "pending",
    };
    await appendLog(
      storageKey(["retest-requests", principal.connectionId]) + "/",
      request,
      (x) => x.id === request.id,
    );
    return request;
  }
  if (tool === "attempt_close") {
    const proof = await evaluateCollectedScannerGate(
      principal.sessionId,
      record.pipelineId,
      issue.id,
      principal.connectionId,
    );
    if (!proof.ready)
      return {
        refused: true,
        refusalCode: "needs_server_evidence",
        problems: proof.problems,
        closureConfirmed: false,
      };
    const existing = plans.find(
      (p) =>
        p.sourceReleaseId === record.pipelineId &&
        p.id.endsWith(":" + issue.id),
    );
    if (!existing)
      throw new Error(
        "Draft a proposed plan before requesting closure review.",
      );
    if (existing.closureConfirmed)
      return {
        refused: true,
        refusalCode: "needs_human",
        problems: [
          "A person already recorded closure; an agent cannot change that decision.",
        ],
        closureConfirmed: true,
      };
    const previous = stored
      .flatMap((r) => r.issueDrafts ?? [])
      .find((p) => (p as PlanProposal).id === existing.id) as
      | PlanProposal
      | undefined;
    const priorStep =
      previous?.closure_review?.prior_step ??
      (previous?.workflowState === "ready-for-closure-review"
        ? "rescan-pending"
        : (previous?.workflowState ?? "planned"));
    const proposal = {
      ...issueDraft(record, issue, {
        risk: existing.riskStatement,
        action: existing.action,
        verification: existing.milestone.description,
      }),
      draft_revision: existing.draft_revision,
      source_label: itemSource(existing.source_label),
      agent_draft_fields: existing.agent_draft_fields,
      closure_review: {
        id: randomUUID(),
        state: "requested" as const,
        requested_at: new Date().toISOString(),
        token_id: principal.id,
        prior_step: priorStep,
      },
      retests: proof.retests,
      correctiveReleaseId: proof.retest!.pipelineId,
      readyToClose: true,
      workflowState: proof.workflowState,
      closureConfirmed: false,
    };
    const key = `binder.plan-proposals.v1:${releaseProject(record.pipelineUrl)}`;
    const current = stored.find((r) => r.key === key) ?? {
      key,
      assessment: null,
      assessments: {},
      plans: [],
      proposals: [],
    };
    await writeRemediationRecord(principal.sessionId, {
      ...current,
      issueDrafts: [
        ...(current.issueDrafts ?? []).filter(
          (p) => (p as PlanProposal).id !== proposal.id,
        ),
        proposal,
      ],
    });
    return {
      refused: false,
      workflowState: proof.workflowState,
      closureConfirmed: false,
      retests: proof.retests,
      humanConfirmationRequired: true,
    };
  }
  throw new Error("Unknown tool.");
}
