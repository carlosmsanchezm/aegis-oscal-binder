import {releaseEvidenceFor, projectPlanRelease} from "./release-evidence";
import { itemSource, personSource } from "@/lib/aegis/item-source";
import { requireIssoReview } from "@/lib/agent/review-access";
import { retainDocumentBundle } from "@/lib/oscal/export-artifact";
import { assertSchema } from "@/lib/oscal/validate-schema";
import {
  assertCollectedRecord,
  collectedProposal,
  proposalConnectionId,
} from "@/lib/aegis/collected-closure";
import { issueDraft, validateDraftText } from "@/lib/aegis/issue-actions";
import { createHash } from "node:crypto";
import { connectedReleases } from "@/lib/aegis/connected-evidence";
import { summarizeBuilderBundle } from "./builder-observation";
import { builderOwner, listConnections, listBundles } from "./builder-store";
import { AegisError, getSession } from "@/lib/aegis";
import { validateAssessmentResults } from "@/lib/aegis/assessment-results";
import {
  buildBinderDocuments,
  validateBinderDocuments,
} from "@/lib/aegis/baseline-binder";
import { RECORDED_EVIDENCE } from "@/lib/aegis/recorded-evidence";
import { mergeStoredReleases } from "@/lib/aegis/control-rollup";
import { durableStorageConfigured, storageUnconfigured } from "@/lib/durable";
import type { PipelineEvidence } from "@/lib/aegis/pipeline-evidence";
import { validatePlanOfAction } from "@/lib/aegis/poam";
import {
  readRemediation,
  writeRemediationRecord,
  type RemediationRecord,
} from "@/lib/aegis/remediation-store";
import {
  applyDecision,
  normalizePlanDecision,
  proposePlans,
  type PlanDecision,
  type PlanProposal,
} from "@/lib/aegis/plan-proposal";
import {
  normalizeStoredPlan,
  restoreAssessment,
  type RemediationPlan,
} from "@/lib/aegis/remediation";
import { readReleaseHistory } from "./pipeline-inbound";
import {
  readRemediationCookie,
  remediationSessionCookie,
} from "./remediation-session";
import { jsonOk } from "./http";

const MAX_BODY = 1_000_000;

export async function loadRecords(
  cookieHeader: string | null,
): Promise<RemediationRecord[]> {
  try {
    const stored = await readRemediation(getSession().id);
    return stored?.records ?? [];
  } catch (error) {
    if (!storageUnconfigured(error)) throw error;
    return readRemediationCookie(cookieHeader, getSession().id);
  }
}

export async function getRemediation(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  try {
    const record =
      (await loadRecords(req.headers.get("cookie"))).find(
        (item) => item.key === key,
      ) ?? null;
    if (record?.issueDrafts)
      record.issueDrafts = await Promise.all(
        record.issueDrafts.map((p) =>
          collectedProposal(
            getSession().id,
            p as PlanProposal,
            proposalConnectionId(record.key),
          ),
        ),
      );
    if (record) {
      if (record.plans.length) {
        const bundles = await ownedReleaseEvidence(req.headers.get("cookie"));
        record.plans = await Promise.all(record.plans.map(value => {
          const plan = normalizeStoredPlan(value);
          return plan ? projectPlanRelease(getSession().id, plan, bundles) : value;
        }));
      }
      record.issueDrafts = record.issueDrafts?.map((p) => ({
        ...(p as object),
        source_label: itemSource((p as PlanProposal).source_label),
      }));
      record.issueTriage = record.issueTriage?.map((p) => ({
        ...(p as object),
        source_label: itemSource(
          (p as { source_label?: unknown }).source_label,
        ),
      }));
      record.proposals = record.proposals?.map((p) => ({
        ...(p as object),
        source_label: personSource((p as PlanDecision).closure?.name),
        identity_verification: "typed_unverified",
      }));
      record.plans = record.plans.map((p) => ({
        ...(p as object),
        source_label: personSource(),
      }));
    }
    return jsonOk({
      record,
      sessionScope: createHash("sha256").update(getSession().id).digest("hex"),
    });
  } catch (error) {
    // No encrypted cookie key and no durable store: this tab keeps its own copy.
    if (
      error instanceof AegisError &&
      error.code === "SESSION_CONFIGURATION" &&
      !durableStorageConfigured()
    ) {
      return jsonOk({
        record: null,
        storage: "tab",
        sessionScope: createHash("sha256")
          .update(getSession().id)
          .digest("hex"),
      });
    }
    throw error;
  }
}

/** Reset review decisions only in the caller's session and selected proposal record. */
export async function resetProposalDecisions(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key.startsWith("binder.plan-proposals.v1:") || key.length > 2000)
    throw new AegisError(
      "BAD_REQUEST",
      "A proposal workspace key is required.",
      400,
    );
  let records: RemediationRecord[] = [];
  try {
    records = await loadRecords(req.headers.get("cookie"));
  } catch (error) {
    if (
      !(
        error instanceof AegisError &&
        error.code === "SESSION_CONFIGURATION" &&
        !durableStorageConfigured()
      )
    )
      throw error;
  }
  const existing = records.find((r) => r.key === key);
  if (
    existing?.issueDrafts?.some(
      (p) => (p as PlanProposal).source_label !== undefined,
    )
  )
    await requireIssoReview(
      req,
      builderOwner(req.headers.get("cookie")) ?? "",
      true,
    );
  const next = {
    key,
    assessment: existing?.assessment ?? null,
    assessments: existing?.assessments ?? {},
    plans: existing?.plans ?? [],
    proposals: [],
  };
  try {
    await writeRemediationRecord(getSession().id, next);
    return jsonOk({ reset: true });
  } catch (error) {
    if (!storageUnconfigured(error)) throw error;
    try {
      const cookie = remediationSessionCookie(next, getSession().id, req);
      const response = jsonOk({ reset: true });
      response.headers.append("set-cookie", cookie);
      return response;
    } catch (error) {
      if (error instanceof AegisError && error.code === "SESSION_CONFIGURATION")
        return jsonOk({ reset: true, storage: "tab" });
      throw error;
    }
  }
}

export async function putRemediation(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY)
    throw new AegisError(
      "PAYLOAD_TOO_LARGE",
      "Remediation record exceeds the storage limit.",
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new AegisError(
      "BAD_REQUEST",
      "Remediation record must be a JSON object.",
      400,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AegisError(
      "BAD_REQUEST",
      "Remediation record must be a JSON object.",
      400,
    );
  const record = body as Partial<RemediationRecord> & { key?: unknown };
  if (
    typeof record.key !== "string" ||
    !record.key.trim() ||
    record.key.length > 2000
  )
    throw new AegisError(
      "BAD_REQUEST",
      "A bounded remediation key is required.",
      400,
    );
  if (!Array.isArray(record.plans) || record.plans.length > 50)
    throw new AegisError(
      "BAD_REQUEST",
      "Remediation plans must be a bounded list.",
      400,
    );
  await assertCollectedRecord(getSession().id, record as RemediationRecord);
  const plans = record.plans.map(normalizeStoredPlan);
  if (plans.some((plan) => !plan))
    throw new AegisError("BAD_REQUEST", "A remediation draft is invalid.", 400);
  const assessment =
    record.assessment == null ? null : restoreAssessment(record.assessment);
  if (record.assessment != null && !assessment)
    throw new AegisError("BAD_REQUEST", "The assessment is invalid.", 400);
  const byItem = record.assessments ?? {};
  if (
    typeof byItem !== "object" ||
    Array.isArray(byItem) ||
    Object.keys(byItem).length > 100
  )
    throw new AegisError(
      "BAD_REQUEST",
      "Assessment records must be a bounded object.",
      400,
    );
  const assessments = Object.fromEntries(
    Object.entries(byItem).map(([item, value]) => [
      item,
      restoreAssessment(value),
    ]),
  );
  if (
    Object.entries(assessments).some(
      ([item, value]) => item.length > 12000 || !value,
    )
  )
    throw new AegisError(
      "BAD_REQUEST",
      "An assessment record is invalid.",
      400,
    );
  const storedRecord = durableStorageConfigured()
    ? (await readRemediation(getSession().id))?.records.find(
        (r) => r.key === record.key,
      )
    : undefined;
  if (
    storedRecord?.issueDrafts?.some(
      (p) => (p as PlanProposal).source_label !== undefined,
    )
  )
    await requireIssoReview(
      req,
      builderOwner(req.headers.get("cookie")) ?? "",
      true,
    );
  const rawProposals = record.proposals ?? [];
  if (!Array.isArray(rawProposals) || rawProposals.length > 50)
    throw new AegisError(
      "BAD_REQUEST",
      "Plan proposals must be a bounded list.",
      400,
    );
  const proposals = rawProposals.map(normalizePlanDecision);
  if (
    storedRecord?.issueDrafts?.some(
      (p) => (p as PlanProposal).source_label !== undefined,
    )
  ) {
    const before = (storedRecord.proposals ?? []).map(normalizePlanDecision);
    if (JSON.stringify(before) !== JSON.stringify(proposals))
      throw new AegisError(
        "HUMAN_REVIEW_REQUIRED",
        "Use the version-bound approvals endpoint with an ISSO name and reason for this item.",
        409,
      );
  }

  if (proposals.some((item) => !item))
    throw new AegisError("BAD_REQUEST", "A plan proposal is invalid.", 400);
  const next: RemediationRecord = {
    key: record.key,
    assessment,
    assessments,
    plans,
    proposals,
  };
  try {
    const stored = await writeRemediationRecord(getSession().id, next);
    return jsonOk({ savedAt: stored.savedAt });
  } catch (error) {
    if (!storageUnconfigured(error)) throw error;
    let cookie: string;
    try {
      cookie = remediationSessionCookie(next, getSession().id, req);
    } catch (cause) {
      if (cause instanceof AegisError) throw cause;
      throw new AegisError(
        "SESSION_TOO_LARGE",
        cause instanceof Error
          ? cause.message
          : "The draft is too large for this browser session.",
        413,
      );
    }
    const response = jsonOk({
      savedAt: new Date().toISOString(),
      storage: "session",
    });
    response.headers.append("set-cookie", cookie);
    return response;
  }
}

async function savedPlan(
  id: string,
  cookieHeader: string | null,
): Promise<RemediationPlan> {
  if (!id) throw new AegisError("BAD_REQUEST", "Draft id is required.", 400);
  const plan =
    (await loadRecords(cookieHeader))
      .flatMap((record) => record.plans)
      .map(normalizeStoredPlan)
      .find((item) => item?.id === id) ?? null;
  if (!plan)
    throw new AegisError("NOT_FOUND", "No saved draft with that id.", 404);
  return plan;
}

async function releaseHistory() {
  try {
    const received = await readReleaseHistory();
    return [
      ...RECORDED_EVIDENCE,
      ...received.map((release) => release.evidence),
    ];
  } catch (error) {
    if (!storageUnconfigured(error)) throw error;
    return [...RECORDED_EVIDENCE];
  }
}

export async function connectedHistory(
  cookieHeader: string | null,
  origin: string,
): Promise<PipelineEvidence[]> {
  const connections = await listConnections(builderOwner(cookieHeader));
  const histories = await Promise.all(
    connections.map(async (connection) => {
      const bundles = await listBundles(connection.id);
      return connectedReleases(
        {
          ...connection,
          revokedAt: connection.revokedAt ?? null,
          history: bundles.map(summarizeBuilderBundle),
        },
        origin,
      );
    }),
  );
  return histories.flat();
}

export function acceptedProposals(
  releases: PipelineEvidence[],
  decisions: PlanDecision[],
  issueDrafts: PlanProposal[] = [],
): PlanProposal[] {
  const fresh = [...proposePlans(releases), ...issueDrafts];
  return decisions.flatMap((decision) => {
    if (decision.acceptance !== "accepted") return [];
    const computed = fresh.find((proposal) => proposal.id === decision.id);
    return computed && computed.finding === decision.finding
      ? [applyDecision(computed, decision)]
      : [];
  });
}

async function savedDecisions(
  cookieHeader: string | null,
): Promise<PlanDecision[]> {
  return (await loadRecords(cookieHeader))
    .flatMap((record) =>
      Array.isArray(record.proposals) ? record.proposals : [],
    )
    .flatMap((value) => {
      const decision = normalizePlanDecision(value);
      return decision ? [decision] : [];
    });
}

async function ownedReleaseEvidence(cookieHeader: string | null) {
  const connections = await listConnections(builderOwner(cookieHeader));
  return (await Promise.all(connections.map(c => releaseEvidenceFor(getSession().id, c.id)))).flat();
}

async function binderDocuments(plan: RemediationPlan, cookieHeader: string | null, origin: string) {
  // A configured store that fails still blocks export. An unconfigured preview uses the shipped receipts.
  const releases = mergeStoredReleases(
    [...await releaseHistory(), ...await connectedHistory(cookieHeader, origin)],
    plan.source.pipelineUrl,
  );
  // A draft-id download contains only this draft's assessed scope.
  const documents = buildBinderDocuments(releases, plan, new Date(), [], await ownedReleaseEvidence(cookieHeader));
  const errors = validateBinderDocuments(documents);
  if (errors.length)
    throw new AegisError("BINDER_INVALID", errors.join(" "), 500);
  return documents;
}

async function oscalAttachment(
  document: unknown,
  filename: string,
): Promise<Response> {
  assertSchema(document);
  const bundle = await retainDocumentBundle(document, filename);
  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      link: bundle.id
        ? `</api/oscal/bundle?artifact=${bundle.id}>; rel="evidence-bundle"`
        : `</api/oscal/bundle>; rel="evidence-bundle"`,
      "x-aegis-bundle-mode": bundle.id ? "retained" : "stateless-post",
      "x-aegis-manifest-status": bundle.manifest.signing.status,
    },
  });
}

async function proposalFile(
  decision: PlanDecision,
  cookieHeader: string | null,
  origin: string,
): Promise<Response> {
  if (decision.acceptance !== "accepted")
    throw new AegisError(
      "PROPOSAL_NOT_ACCEPTED",
      "Accept the draft before export. A proposed draft is not written as a closed plan.",
      409,
    );
  const history = [
    ...(await releaseHistory()),
    ...(await connectedHistory(cookieHeader, origin)),
  ];
  const source = history.find(
    (release) => release.pipelineId === decision.sourceReleaseId,
  )?.pipelineUrl;
  const releases = source
    ? mergeStoredReleases(history, source)
    : mergeStoredReleases(history);
  // Rebind saved AI text to a finding still present in this caller’s retained source.
  const storedIssueDrafts = decision.id.includes(":scan-")
    ? (await loadRecords(cookieHeader)).flatMap((r) => r.issueDrafts ?? [])
    : [];
  const rawIssueDrafts = storedIssueDrafts.flatMap((value) => {
    try {
      const p = value as PlanProposal;
      const record = releases.find((r) => r.pipelineId === p.sourceReleaseId);
      const issue = record?.reviewItems?.find(
        (i) => p.id.endsWith(":" + i.id) && i.description === p.finding,
      );
      if (!record || !issue) return [];
      const draft = issueDraft(
        record,
        issue,
        validateDraftText({
          risk: p.riskStatement,
          action: p.action,
          verification: p.milestone.description,
        }),
      );
      return draft.id === p.id
        ? [
            {
              ...draft,
              draft_revision: p.draft_revision,
              source_label: p.source_label,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
  const issueDrafts = await Promise.all(
    rawIssueDrafts.map((p) => {
      const release = releases.find((r) => r.pipelineId === p.sourceReleaseId);
      return collectedProposal(
        getSession().id,
        p,
        release?.schema === "aegis.evidence-event.v1"
          ? release.observation.connectionId
          : undefined,
      );
    }),
  );
  const current = [...proposePlans(releases), ...issueDrafts].find(
    (proposal) => proposal.id === decision.id,
  );
  if (current && current.finding !== decision.finding)
    throw new AegisError(
      "FINDING_CHANGED",
      "The finding description changed. Review and accept the corrected draft before export.",
      409,
    );
  const accepted = acceptedProposals(releases, [decision], issueDrafts);
  if (!accepted.length)
    throw new AegisError(
      "NOT_FOUND",
      "The recorded finding is no longer in the stored releases.",
      404,
    );
  const documents = buildBinderDocuments(releases, null, new Date(), accepted, await ownedReleaseEvidence(cookieHeader));
  const errors = validateBinderDocuments(documents);
  if (errors.length)
    throw new AegisError("BINDER_INVALID", errors.join(" "), 500);
  const validated = validatePlanOfAction(documents.poam);
  if (!validated.ok)
    throw new AegisError(
      "POAM_INVALID",
      "The plan of action file did not match the OSCAL schema.",
      500,
    );
  return oscalAttachment(documents.poam, "plan-of-action-and-milestones.json");
}

export async function getPlanOfActionFile(
  url: URL,
  cookieHeader: string | null = null,
): Promise<Response> {
  const proposalId = url.searchParams.get("proposal") ?? "";
  if (proposalId) {
    const decision = (await savedDecisions(cookieHeader)).find(
      (item) => item.id === proposalId,
    );
    if (!decision)
      throw new AegisError(
        "NOT_FOUND",
        "No saved plan proposal with that id.",
        404,
      );
    return proposalFile(decision, cookieHeader, url.origin);
  }
  const documents = await binderDocuments(
    await savedPlan(url.searchParams.get("id") ?? "", cookieHeader), cookieHeader, url.origin,
  );
  const validated = validatePlanOfAction(documents.poam);
  if (!validated.ok)
    throw new AegisError(
      "POAM_INVALID",
      "The plan of action file did not match the OSCAL schema.",
      500,
    );
  return oscalAttachment(documents.poam, "plan-of-action-and-milestones.json");
}

/** One-shot export for a tab-held acceptance when no durable store and no cookie key exist. A configured store still requires the saved record. */
export async function postPlanOfActionFile(req: Request): Promise<Response> {
  if (durableStorageConfigured())
    throw new AegisError(
      "PROPOSAL_NOT_ACCEPTED",
      "Accept the draft before export. A proposed draft is not written as a closed plan.",
      409,
    );
  const text = await req.text();
  if (text.length > MAX_BODY)
    throw new AegisError(
      "PAYLOAD_TOO_LARGE",
      "Remediation record exceeds the storage limit.",
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new AegisError(
      "BAD_REQUEST",
      "Remediation record must be a JSON object.",
      400,
    );
  }
  const decision = normalizePlanDecision(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "decision" in body
      ? (body as { decision: unknown }).decision
      : null,
  );
  if (!decision)
    throw new AegisError("BAD_REQUEST", "A plan proposal is invalid.", 400);
  const requested = new URL(req.url).searchParams.get("proposal") ?? "";
  if (requested !== decision.id)
    throw new AegisError(
      "BAD_REQUEST",
      "The export does not match the accepted draft.",
      400,
    );
  return proposalFile(
    decision,
    req.headers.get("cookie"),
    new URL(req.url).origin,
  );
}

export async function getAssessmentResultsFile(
  url: URL,
  cookieHeader: string | null = null,
): Promise<Response> {
  const documents = await binderDocuments(
    await savedPlan(url.searchParams.get("id") ?? "", cookieHeader), cookieHeader, url.origin,
  );
  const validated = validateAssessmentResults(documents.assessmentResults);
  if (!validated.ok)
    throw new AegisError(
      "ASSESSMENT_RESULTS_INVALID",
      validated.errors.join(" "),
      500,
    );
  return oscalAttachment(
    documents.assessmentResults,
    "assessment-results.json",
  );
}

export async function getSystemSecurityPlanFile(
  url: URL,
  cookieHeader: string | null = null,
): Promise<Response> {
  const documents = await binderDocuments(
    await savedPlan(url.searchParams.get("id") ?? "", cookieHeader), cookieHeader, url.origin,
  );
  return oscalAttachment(documents.ssp, "system-security-plan.json");
}
