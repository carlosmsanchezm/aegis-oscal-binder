import {addReleaseEvidence} from "./release-evidence-oscal";
import type {ReleaseEvidence} from "./release-evidence";
import {schemaValidator} from "../oscal/validate-schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { findRepoRoot } from "./paths";
import { hasRecordedTestResult, planOfActionFacts, type PlanMilestoneFact, type PlanRetestFact } from "./poam-facts";
import type { PoamGateLink } from "./gates/poam-link";
import { normalizeStoredPlan, safeReferenceUrl, type RemediationPlan } from "./remediation";

/** OSCAL version written by the binder's SSP serializer. */
export const OSCAL_VERSION = "1.1.2";

const NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export function stableUuid(name: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function oscalDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value) return `${value}T00:00:00Z`;
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return value;
  return null;
}

function text(value: string): string {
  return value.trim();
}

export const REMEDIATION_NAMESPACE = "urn:aegis:remediation:v1";

/** Internal scoped subject, not an agency identifier or an assertion of an ATO boundary. */
export function internalSystemId(plan: RemediationPlan): {id:string; "identifier-type":string} {
  const source = new URL(plan.source.pipelineUrl);
  source.search = "";
  source.hash = "";
  source.pathname = source.pathname.replace(/\/-\/pipelines\/\d+\/?$/, "");
  return {id:stableUuid(`internal-system:${JSON.stringify([source.href, plan.assessment.scope!.asset])}`),"identifier-type":"urn:aegis:system-id:internal"};
}
type Prop = { name: string; value: string; ns: string; remarks?: string };

function prop(name: string, value: string): Prop | null {
  const trimmed = text(value);
  if (!trimmed) return null;
  const compact = trimmed.replace(/\s+/g, " ");
  return { name, value: compact, ns: REMEDIATION_NAMESPACE, ...(compact!==trimmed ? { remarks: trimmed } : {}) };
}

function properties(entries: [string, string][]): Prop[] {
  return entries.map(([name,value]) => prop(name,value)).filter((item): item is Prop => item!==null);
}

function milestoneTask(planId: string, milestone: PlanMilestoneFact, index: number): Record<string, unknown> | null {
  const title = text(milestone.description);
  if (!title) return null;
  const intended = oscalDate(milestone.revised) ?? oscalDate(milestone.target);
  const notes = [`Status: ${milestone.status}.`];
  if (text(milestone.target)) notes.push(`Target ${text(milestone.target)}.`);
  if (text(milestone.revised)) notes.push(`Revised ${text(milestone.revised)}.`);
  if (text(milestone.reason)) notes.push(text(milestone.reason));
  const task: Record<string, unknown> = {
    uuid: stableUuid(`${planId}:milestone:${index}:${title}`),
    type: "milestone",
    title,
    description: notes.join(" "),
    props: properties([["status",milestone.status], ["original-target",milestone.target], ["revised-target",milestone.revised], ["revision-rationale",milestone.reason]]),
  };
  if (intended) task.timing = { "on-date": { date: intended } };
  return task;
}

function evidenceItem(test: PlanRetestFact): Record<string, unknown> | null {
  if (!hasRecordedTestResult(test)) return null;
  const check = text(test.description);
  const evidence = text(test.evidence);
  const result = text(test.result);
  if (!check && !evidence && !result) return null;
  const summary = [check, result && result !== check ? result : ""].filter(Boolean).join(". ") || evidence;
  const dated = text(test.date) && (result || evidence) ? `${summary} (${text(test.date)})` : summary;
  const item: Record<string, unknown> = { description: dated };
  const props = properties([["verification-test",test.description], ["reviewer",test.reviewer], ["collected-date",test.date], ["illustrative",String(test.illustrative)], ["verdict",test.verdict ?? ""], ["artifact-sha256",test.artifactSha256 ?? ""]]);
  if (props.length) item.props = props;
  if (test.href) item.href = test.href;
  else item.remarks = "Recorded test result; no resolvable evidence link is recorded.";
  return item;
}

/**
 * One OSCAL plan of action for one saved draft.
 * The weakness already on the draft is the only POA&M item.
 * A gap is closed only when the draft is ready for closure review and a closure decision is recorded.
 * The system binding is explicitly internal, never an invented agency identifier.
 */
export function buildPlanOfAction(plan: RemediationPlan, now = new Date(), gateLinks: readonly PoamGateLink[] = [], bundles: ReleaseEvidence[] = []): Record<string, unknown> {
  const normalized = normalizeStoredPlan(plan);
  if (!normalized) throw new Error("Cannot export an invalid remediation draft.");
  plan = normalized;
  const facts = planOfActionFacts(plan);
  const title = facts.weakness || facts.controls[0] || "Internal draft";
  const action = facts.action;
  const observationUuid = stableUuid(`${plan.id}:observation`);
  const riskUuid = stableUuid(`${plan.id}:risk`);
  const collected = oscalDate(plan.assessment?.date ?? "") ?? oscalDate(plan.createdAt) ?? now.toISOString();
  const evidence = facts.retests.map(evidenceItem).filter((item): item is Record<string, unknown> => item !== null);
  const observation: Record<string, unknown> = {
    uuid: observationUuid,
    title,
    description: facts.observation || title,
    methods: facts.methods,
    collected,
    props: properties([
      ["applicable-requirement",plan.assessment.requirement], ["assessment-reference",plan.assessment.reference],
      ["assessment-reviewer",plan.assessment.reviewer], ["assessment-date",plan.assessment.date],
      ["assessment-disposition",plan.assessment.disposition], ["assessment-rationale",plan.assessment.note],
      ["illustrative-assessment",String(plan.assessment.illustrative)],
      ["framework",plan.assessment.scope!.framework], ["baseline-reference",plan.assessment.scope!.baseline],
      ["affected-asset",plan.asset],
    ]),
  };
  if (evidence.length) observation["relevant-evidence"] = evidence;
  const gateObservations = gateLinks.map((link, index) => ({
    uuid: stableUuid(`${plan.id}:gate:${link.gateId}:${index}`),
    title: link.title,
    description: link.summary,
    methods: ["EXAMINE"],
    collected: oscalDate(link.at) ?? now.toISOString(),
    props: properties([
      ["gate-id", link.gateId],
      ["gate-state", link.state],
      ["authorization-granted", "false"],
      ["risk-acceptance-granted", "false"],
      ["ato-granted", "false"],
    ]),
  }));
  const tasks = facts.milestones
    .map((milestone, index) => milestoneTask(plan.id, milestone, index))
    .filter((task): task is Record<string, unknown> => task !== null);
  const risk: Record<string, unknown> = {
    uuid: riskUuid,
    title,
    description: facts.riskDescription || title,
    statement: facts.riskStatement || title,
    status: facts.closureRecorded ? "closed" : "open",
    props: properties([
      ["engineering-complete",String(plan.engineeringComplete)], ["verification-recorded",String(plan.validationRecorded)],
      ["verification-outcome",plan.validation], ["verification-reviewer",plan.validator],
      ["verification-date",plan.validationDate], ["verification-rationale",plan.validationNote],
      ["ready-for-closure-review",String(plan.readyForReview)], ["external-decision-recorded",String(facts.closureRecorded)],
      ["external-decision-reference",plan.closure.reference], ["external-decision-approver",plan.closure.approver],
      ["external-decision-date",plan.closure.date], ["external-decision-poam-id",plan.closure.officialId],
      ["risk-decision",plan.riskDecision], ["interim-protection",plan.protection], ["protection-disposition",plan.protectionDisposition],
    ]),
    "related-observations": [{ "observation-uuid": observationUuid }],
  };
  if (gateLinks.length) {
    const props = risk.props as { name: string; value: string; ns: string }[];
    props.push(...properties([
      ["authorization-granted", "false"],
      ["risk-acceptance-granted", "false"],
      ["ato-granted", "false"],
    ]));
  }
  const release = facts.correctiveRelease;
  if (action || tasks.length || release.identity || release.href || facts.retests.length) {
    const remediation: Record<string, unknown> = {
      uuid: stableUuid(`${plan.id}:remediation`),
      lifecycle: plan.engineeringComplete ? "completed" : "planned",
      title: action || (release.identity ? `Corrective release ${release.identity}` : title),
      description: action || (release.identity ? `Corrective release ${release.identity}.` : title),
    };
    const releaseProps = properties([
      ...(release.identity ? [["corrective-release", release.identity]] as [string,string][] : []),
      ...facts.retests.map(test => ["required-verification", test.description] as [string,string]),
    ]);
    if (releaseProps.length) remediation.props = releaseProps;
    if (release.href) remediation.links = [{ href: release.href, rel: "reference", text: "Corrective release" }];
    if (tasks.length) remediation.tasks = tasks;
    risk.remediations = [remediation];
  }
  const props = [
    ...facts.controls.map((control) => prop("control-id", control)),
    prop("owner", facts.owner),
    prop("poam-id", facts.officialPoamId),
    prop("repository", facts.repository),
    prop("ticket", plan.ticket),
    ...properties([
      ["affected-asset",plan.asset], ["required-resources",plan.resources],
      ["source-pipeline-id",plan.source.pipelineId], ["source-commit",plan.source.commit], ["source-release-sha256",plan.source.releaseSha256 ?? ""],
      ["source-review-item",plan.source.reviewItem], ["remediation-release-reference",plan.releaseRef],
      ["illustrative-release",String(plan.releaseIllustrative)], ["release-review-mode",plan.releaseReviewMode ?? ""],
      ["received-verification-commit",plan.receivedVerification?.commit ?? ""],
      ["received-verification-release-sha256",plan.receivedVerification?.releaseSha256 ?? ""],
      ["outside-assessment-scope",plan.assessment.scope!.remainingScope.join(" · ")],
    ]),
  ].filter((item): item is Prop => item !== null);
  const links = [
    { href: safeReferenceUrl(plan.source?.pipelineUrl ?? ""), text: "Original release" },
    { href: release.href, text: "Corrective release" },
    { href: safeReferenceUrl(plan.releaseUrl), text: "Remediation release" },
    ...((plan.source?.artifacts ?? []).map((artifact) => ({ href: safeReferenceUrl(artifact.href), text: artifact.name }))),
    { href: safeReferenceUrl(plan.receivedVerification?.pipelineUrl ?? ""), text: "Received verification release" },
  ].filter((link): link is { href: string; text: string } => Boolean(link.href))
    .filter((link, index, all) => all.findIndex((item) => item.href === link.href) === index)
    .map((link) => ({ href: link.href, rel: "reference", text: link.text }));
  const poamItem: Record<string, unknown> = {
    uuid: stableUuid(`${plan.id}:poam-item`),
    title,
    description: [facts.observation || title, action ? `Corrective action: ${action}.` : ""].filter(Boolean).join(" "),
    "related-observations": [{ "observation-uuid": observationUuid }],
    "related-risks": [{ "risk-uuid": riskUuid }],
    remarks: ["Exported from the saved internal draft. Agency review stays in the agency process.", ...facts.stillOpen].join(" "),
  };
  if (props.length) poamItem.props = props;
  if (links.length) poamItem.links = links;
  if (gateObservations.length) {
    const related = poamItem["related-observations"] as { "observation-uuid": string }[];
    poamItem["related-observations"] = [...related, ...gateObservations.map((item) => ({ "observation-uuid": item.uuid }))];
  }
  // Keep a lossless, explicitly internal record alongside portable OSCAL fields.
  // This is not an agency connector, approval assertion, or signed audit log.
  const draftUuid = stableUuid(`${plan.id}:internal-record`);
  const resources: Record<string, unknown>[] = [{
    uuid: draftUuid,
    title: "Internal assessment and remediation record",
    description: "Normalized internal draft, including recorded reviewer decisions, history and illustrative flags. References are supplied records, not independently verified agency approval.",
    props: properties([["record-schema",plan.schema], ["illustrative-assessment",String(plan.assessment.illustrative)]]),
    base64: { filename: `${plan.id.replace(/[^a-z0-9_.-]/gi,"_")}.json`, "media-type": "application/json", value: Buffer.from(JSON.stringify(plan),"utf8").toString("base64") },
  }];
  for (const [index,test] of facts.retests.entries()) {
    if (test.href && test.artifactSha256) resources.push({
      uuid: stableUuid(`${plan.id}:retest:${index}`), title: test.description,
      props: properties([["illustrative",String(test.illustrative)], ["reviewer",test.reviewer]]),
      rlinks: [{ href: test.href, hashes: [{ algorithm: "SHA-256", value: test.artifactSha256 }] }],
    });
  }
  poamItem.links = [...links, { href: `#${draftUuid}`, rel: "reference", text: "Internal decision record" }];
  // Stable across draft/release revisions for the same scoped workload in the same
  // source project. This binds the internal assessment subject, not an agency ATO boundary.
  return addReleaseEvidence({
    "plan-of-action-and-milestones": {
      uuid: stableUuid(`${plan.id}:plan-of-action-and-milestones`),
      metadata: {
        title: `Plan of action: ${title}`,
        "last-modified": now.toISOString(),
        version: "0.1.0",
        "oscal-version": OSCAL_VERSION,
        props: properties([["export-purpose","internal-planning"], ["illustrative-assessment",String(plan.assessment.illustrative)], ["illustrative-release",String(plan.releaseIllustrative)], ["agency-submission","not-performed"]]),
        remarks: "Internal planning export of one saved draft. Agency review stays in the agency process.",
      },
      "system-id": internalSystemId(plan),
      observations: [observation, ...gateObservations],
      risks: [risk],
      "poam-items": [poamItem],
      "back-matter": { resources },
    },
  }, bundles, plan.id);
}

export const POAM_SCHEMA_PATH = ["schemas", "oscal", "1.1.2", "oscal_poam_schema.json"] as const;

function planOfActionValidator(root=findRepoRoot()):ValidateFunction{return schemaValidator("plan-of-action-and-milestones",root);}

export function validatePlanOfAction(document: unknown, root = findRepoRoot()): { ok: true } | { ok: false; errors: string[] } {
  const validate = planOfActionValidator(root);
  if (validate(document)) {
    // OSCAL's cross-field system-binding requirement is not enforced by its JSON schema.
    const body = (document as Record<string, Record<string, unknown>>)["plan-of-action-and-milestones"];
    if (!body["system-id"] && !body["import-ssp"]) return { ok: false, errors: ["/plan-of-action-and-milestones requires system-id or import-ssp."] };
    return { ok: true };
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`),
  };
}
