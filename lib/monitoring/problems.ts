import { collectorEvents } from "../collector/events";
import { parseEvidenceEvent, type EvidenceEvent } from "../builder/evidence";
import { connectedReleases } from "../aegis/connected-evidence";
import { decisionFromProposal, normalizePlanDecision, proposePlans, type PlanDecision } from "../aegis/plan-proposal";
import { prepareRegressionDraft, type RemediationPlan } from "../aegis/remediation";
import type { ReviewObservation } from "../aegis/review-context";
import { sourceCommitLink } from "../collector/source-link";
import type { CollectedArtifact } from "../collector/types";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { sha256, verifyBundle } from "../server/builder-store";
import { monitoringCopy } from "./copy";
import type { DriftRow, ScanTrigger } from "./types";

export type RegressionDraft = { plan: RemediationPlan; decision: PlanDecision; problem: ReviewObservation };

function marker(row: DriftRow, captureSha256: string): { name: string; bytes: Buffer } {
  const name = `regression-${row.subjectId}.json`;
  const bytes = Buffer.from(JSON.stringify({ captureSha256, subjectId: row.subjectId, subjectKind: row.subjectKind, drift: row.drift, label: row.label, regressionLabel: row.regressionLabel }));
  return { name, bytes };
}

/** Evidence events for pass-to-fail regressions. Inventory events stay on the collector path. */
export function regressionEvents(trigger: ScanTrigger, capturedAt: string, captureSha256: string, sourceId: string, rows: DriftRow[]): { id: string; rawEvent: string }[] {
  const regressions = rows.filter(row => row.regression);
  const output: { id: string; rawEvent: string }[] = [];
  for (let start = 0; start < regressions.length; start += 20) {
    const batch = regressions.slice(start, start + 20);
    const markers = batch.map(row => marker(row, captureSha256));
    const observedAt = capturedAt;
    const event: EvidenceEvent = {
      schema: "aegis.evidence-event.v1",
      run: { id: `reg-${captureSha256.slice(0, 12)}-${start}`, producer: monitoringCopy.producer, observedAt },
      subject: { kind: trigger.kind === "schedule" ? "infrastructure" : "code", id: sourceId, revision: trigger.revision },
      checks: batch.map((row, index) => ({
        id: `regression-${row.subjectId}`,
        version: "1",
        description: monitoringCopy.checkDescription,
        requirement: {
          framework: row.subjectKind === "ksi" ? monitoringCopy.frameworkKsi : monitoringCopy.frameworkControl,
          reference: row.subjectId,
          objective: monitoringCopy.objective,
        },
        verdict: "fail" as const,
        artifacts: [markers[index].name],
        validUntil: new Date(Date.parse(observedAt) + 86_400_000).toISOString(),
      })),
      artifacts: markers.map(item => ({ name: item.name, mediaType: "application/json", contentBase64: item.bytes.toString("base64"), sha256: sha256(item.bytes) })),
      limitations: [...monitoringCopy.limitations],
    };
    const rawEvent = JSON.stringify(parseEvidenceEvent(event));
    if (Buffer.byteLength(rawEvent) > 512_000) throw new Error("Collector chunk exceeds the import limit.");
    output.push({ id: sha256(rawEvent), rawEvent });
  }
  return output;
}

export function inventoryEvents(artifacts: CollectedArtifact[]): { id: string; rawEvent: string }[] {
  return collectorEvents(artifacts);
}

function releaseFor(connectionId: string, rawEvent: string, id: string, capturedAt: string) {
  const bundle = verifyBundle({
    schema: "aegis.evidence-bundle.v1", id, connectionId, receivedAt: capturedAt, rawEvent,
    event: parseEvidenceEvent(JSON.parse(rawEvent)), integrity: "verified", authentication: "connection-token",
  });
  const [release] = connectedReleases({
    id: connectionId, name: monitoringCopy.producer, createdAt: capturedAt, revokedAt: null, history: [summarizeBuilderBundle(bundle)],
  }, "https://example.com");
  return release;
}

function decisionFor(row: DriftRow, problem: ReviewObservation, releaseId: string): PlanDecision {
  const proposalId = `proposal:${row.subjectId}:${releaseId}:regression`;
  const decision = normalizePlanDecision({
    schema: "binder.plan-proposal.v1",
    id: proposalId,
    controlId: row.subjectId,
    finding: problem.description,
    sourceReleaseId: releaseId,
    riskStatement: monitoringCopy.risk,
    action: monitoringCopy.action,
    milestone: { description: monitoringCopy.milestone, target: "" },
    acceptance: "proposed",
    closureConfirmed: false,
    officialId: "",
    owner: "",
    plain: {
      whatIsWrong: problem.description,
      whyItMatters: monitoringCopy.risk,
      whatWeWillDo: monitoringCopy.action,
      whoOwnsIt: "",
      doneWhen: monitoringCopy.milestone,
      dueBy: "",
      status: "Drafted",
    },
  });
  if (!decision || decision.acceptance !== "proposed" || decision.closureConfirmed) throw new Error("Regression drafts stay unaccepted.");
  return decision;
}

/** Problems are the review items the map already reads. Drafts stay proposed. */
export function regressionDrafts(connectionId: string, trigger: ScanTrigger, capturedAt: string, captureSha256: string, sourceId: string, commit: string, rows: DriftRow[], events: { id: string; rawEvent: string }[]): RegressionDraft[] {
  const releases = events.map(event => releaseFor(connectionId, event.rawEvent, event.id, capturedAt));
  const problems = releases.flatMap(release => release?.reviewItems ?? []);
  const proposals = proposePlans(releases.filter((release): release is NonNullable<typeof release> => !!release));
  const link = sourceCommitLink({ repo: sourceId.startsWith("https://") ? sourceId : trigger.repo, commit });
  if (!link) throw new Error("Invalid regression source.");
  const releaseId = `mon${captureSha256.slice(0, 12)}`;
  return rows.filter(row => row.regression).map(row => {
    const problem = problems.find(item => item.scope.controls.some(id => id.toUpperCase() === row.subjectId.toUpperCase()));
    if (!problem) throw new Error("Regression did not become a review item.");
    const proposal = proposals.find(item => item.controlId.toUpperCase() === row.subjectId.toUpperCase() && item.acceptance === "proposed");
    const proposed = proposal ? normalizePlanDecision(decisionFromProposal(proposal)) : null;
    const decision = proposed?.acceptance === "proposed" && !proposed.closureConfirmed ? proposed : decisionFor(row, problem, releaseId);
    if (decision.acceptance !== "proposed" || decision.closureConfirmed) throw new Error("Regression drafts stay unaccepted.");
    const artifactName = problem.scope.artifacts[0] ?? `regression-${row.subjectId}.json`;
    const plan = prepareRegressionDraft({
      id: `regression:${row.subjectId}:${captureSha256.slice(0, 16)}`,
      now: capturedAt,
      control: row.subjectId,
      finding: problem.description,
      title: problem.scope.title,
      asset: problem.scope.asset,
      framework: problem.scope.framework,
      baseline: problem.scope.baseline,
      pipelineId: releaseId,
      pipelineUrl: link.href,
      commit,
      artifacts: [{ name: artifactName, href: link.href }],
      verification: problem.scope.verification,
      historyAction: monitoringCopy.history,
    });
    return { plan, decision, problem };
  });
}
