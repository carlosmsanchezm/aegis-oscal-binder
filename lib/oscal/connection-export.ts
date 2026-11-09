import { retainConnectionExport } from "./export-history";
import { validateContextDocument } from "../aegis/assessment-context";
import { validateAssessmentResults } from "../aegis/assessment-results";
import { readRemediation } from "../aegis/remediation-store";
import { normalizePlanDecision, applyDecision } from "../aegis/plan-proposal";
import { collectedProposal } from "../aegis/collected-closure";
import { issueDraft, validateDraftText } from "../aegis/issue-actions";
import type { PlanProposal } from "../aegis/plan-proposal";
import { trustedReleases } from "../collector/trusted-release";
import { queryTimeline } from "../timeline/store";
import { getAgentActivity } from "../agent/audit";
import { readConnection, listBundles } from "../server/builder-store";
import { summarizeBuilderBundle } from "../server/builder-observation";
import { connectedReleases } from "../aegis/connected-evidence";
import {
  buildBinderDocuments,
  validateBinderDocuments,
} from "../aegis/baseline-binder";
import { embeddedFiles, makeBundle } from "../manifest/bundle";
import type { BundleFile } from "../manifest/manifest";
export async function exportConnectionBundle(
  connectionId: string,
  sessionId?: string,
  origin = "http://localhost:3000",
  options: { retain?: boolean } = {},
) {
  const connection = await readConnection(connectionId);
  if (!connection || connection.revokedAt)
    throw new Error("Connection unavailable.");
  const bundles = await listBundles(connectionId);
  if (!bundles.length) throw new Error("No collected observations to export.");
  const releases = connectedReleases(
    {
      ...connection,
      releaseEvidence: sessionId ? await (await import("../server/release-evidence")).releaseEvidenceFor(sessionId, connectionId) : [],
      revokedAt: null,
      history: bundles.map(summarizeBuilderBundle),
    },
    origin,
  );
  const records = sessionId
    ? ((await readRemediation(sessionId))?.records ?? [])
    : [];
  const decisions = records
    .flatMap((r) => r.proposals ?? [])
    .map(normalizePlanDecision)
    .filter((p) => p?.acceptance === "accepted");
  const proposals = [];
  for (const raw of records.flatMap((r) => r.issueDrafts ?? [])) {
    const p = raw as PlanProposal,
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
    draft.draft_revision = p.draft_revision;
    draft.source_label = p.source_label;
    const decision = decisions.find((d) => d?.id === draft.id);
    if (decision)
      proposals.push(
        applyDecision(
          await collectedProposal(sessionId!, draft, connectionId),
          decision,
        ),
      );
  }
  const documents = buildBinderDocuments(releases, null, new Date(), proposals);
  const body = documents.poam["plan-of-action-and-milestones"] as Record<
      string,
      unknown
    >,
    hasPoam =
      Array.isArray(body["poam-items"]) && body["poam-items"].length > 0;
  const ar = validateAssessmentResults(documents.assessmentResults);
  const errors = hasPoam
    ? validateBinderDocuments(documents)
    : [
        ...validateContextDocument(documents.ssp, "system-security-plan"),
        ...(ar.ok ? [] : ar.errors),
      ];
  if (errors.length)
    throw new Error("OSCAL validation failed: " + errors.join(" "));
  const exported: Record<string, unknown> = {
    "system-security-plan.json": documents.ssp,
    "assessment-results.json": documents.assessmentResults,
    ...(hasPoam
      ? { "plan-of-action-and-milestones.json": documents.poam }
      : {}),
  };
  const files: BundleFile[] = Object.entries(exported).map(
    ([name, document]) => ({
      path: name,
      mediaType: "application/oscal+json",
      bytes: Buffer.from(JSON.stringify(document, null, 2)),
    }),
  );
  if (!hasPoam)
    files.push({
      path: "export-notes.json",
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          omitted: [
            {
              model: "plan-of-action-and-milestones",
              reason:
                "No accepted plan items are recorded. A required item is never fabricated to satisfy the OSCAL schema.",
            },
          ],
        }),
      ),
    });
  for (const document of Object.values(exported))
    files.push(...embeddedFiles(document));
  for (const b of bundles) {
    files.push({
      path: `evidence/${b.id}/event.json`,
      mediaType: "application/json",
      bytes: Buffer.from(b.rawEvent),
    });
    for (const a of b.event.artifacts)
      files.push({
        path: `evidence/${b.id}/${a.name}`,
        mediaType: a.mediaType,
        bytes: Buffer.from(a.contentBase64, "base64"),
      });
  }
  const trusted = new Set(
    sessionId
      ? (await trustedReleases(sessionId, connectionId)).map(
          (r) => r.releaseSha256,
        )
      : [],
  );
  files.push(
    {
      path: "timeline.json",
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify(await queryTimeline(connectionId), null, 2),
      ),
    },
    {
      path: "agent-activity.json",
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify(await getAgentActivity(connectionId), null, 2),
      ),
    },
  );
  const unique = [...new Map(files.map((f) => [f.path, f])).values()];
  const result = makeBundle(
    unique,
    bundles.map((b) => ({
      url: b.event.run.url ?? b.event.subject.id,
      commit: b.event.subject.revision,
      runId: b.event.run.id,
      provenance: trusted.has(b.id)
        ? ("server-collector" as const)
        : ("caller-import" as const),
    })),
  );
  const record =
    options.retain === false
      ? null
      : await retainConnectionExport(connectionId, result);
  return { ...result, exportId: record?.id ?? null };
}
