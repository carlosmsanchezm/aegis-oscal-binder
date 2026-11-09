import {addReleaseEvidence} from "./release-evidence-oscal";
import type {ReleaseEvidence} from "./release-evidence";
import {schemaValidator} from "../oscal/validate-schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { findRepoRoot } from "./paths";
import { OSCAL_VERSION, REMEDIATION_NAMESPACE } from "./poam";
import { hasRecordedTestResult, planOfActionFacts, type PlanRetestFact } from "./poam-facts";
import { normalizeStoredPlan, safeReferenceUrl, type RemediationPlan } from "./remediation";
import { buildAssessmentContext, resolveContextDocument, validateContextDocument } from "./assessment-context";

const NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

function stableUuid(name: string): string {
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

type Prop = { name: string; value: string; ns: string; remarks?: string };

function prop(name: string, value: string): Prop | null {
  const trimmed = text(value);
  if (!trimmed) return null;
  const compact = trimmed.replace(/\s+/g, " ");
  return { name, value: compact, ns: REMEDIATION_NAMESPACE, ...(compact !== trimmed ? { remarks: trimmed } : {}) };
}

function properties(entries: [string, string][]): Prop[] {
  return entries.map(([name, value]) => prop(name, value)).filter((item): item is Prop => item !== null);
}

function checkEvidence(test: PlanRetestFact): Record<string, unknown> | null {
  if (!hasRecordedTestResult(test)) return null;
  const check = text(test.description);
  const evidence = text(test.evidence);
  const result = text(test.result);
  if (!check && !evidence && !result) return null;
  const summary = [check, result && result !== check ? result : ""].filter(Boolean).join(". ") || evidence;
  const dated = text(test.date) && (result || evidence) ? `${summary} (${text(test.date)})` : summary;
  const item: Record<string, unknown> = { description: dated };
  const props = properties([
    ["verification-check", test.description],
    ["reviewer", test.reviewer],
    ["collected-date", test.date],
    ["illustrative", String(test.illustrative)],
    ["verdict", test.verdict ?? ""],
    ["artifact-sha256", test.artifactSha256 ?? ""],
  ]);
  if (props.length) item.props = props;
  if (test.href) item.href = test.href;
  else item.remarks = "Recorded test result; no resolvable evidence link is recorded.";
  return item;
}

/**
 * One OSCAL assessment-results file for one saved draft and its source release.
 * The recorded review item is the only finding. Other review items are not added.
 * Risk stays open until the draft records a complete closure decision.
 * Official agency identifiers are omitted until the draft has them.
 * The file is not a copy of the internal draft JSON.
 */
export function buildAssessmentResults(plan: RemediationPlan, now = new Date(), bundles: ReleaseEvidence[] = []): Record<string, unknown> {
  const normalized = normalizeStoredPlan(plan);
  if (!normalized) throw new Error("Cannot export an invalid remediation draft.");
  plan = normalized;
  const facts = planOfActionFacts(plan);
  const title = facts.weakness || facts.controls[0] || "Internal assessment";
  const findingText = facts.observation || title;
  const observationUuid = stableUuid(`${plan.id}:observation`);
  const riskUuid = stableUuid(`${plan.id}:risk`);
  const findingUuid = stableUuid(`${plan.id}:finding`);
  const context = buildAssessmentContext(plan,now);
  const collected = oscalDate(plan.assessment?.date ?? "") ?? oscalDate(plan.createdAt) ?? now.toISOString();
  const evidence = facts.retests.map(checkEvidence).filter((item): item is Record<string, unknown> => item !== null);
  const observation: Record<string, unknown> = {
    uuid: observationUuid,
    title,
    description: findingText,
    methods: facts.methods,
    types: ["finding"],
    collected,
    props: properties([
      ["applicable-requirement", plan.assessment.requirement],
      ["assessment-reference", plan.assessment.reference],
      ["assessment-reviewer", plan.assessment.reviewer],
      ["assessment-date", plan.assessment.date],
      ["assessment-disposition", plan.assessment.disposition],
      ["illustrative-assessment", String(plan.assessment.illustrative)],
      ["framework", plan.assessment.scope!.framework],
      ["baseline-reference", plan.assessment.scope!.baseline],
      ["affected-asset", plan.asset],
    ]),
  };
  if (evidence.length) observation["relevant-evidence"] = evidence;
  const release = facts.correctiveRelease;
  const links = [
    { href: safeReferenceUrl(plan.source?.pipelineUrl ?? ""), text: "Source pipeline" },
    { href: release.href, text: "Corrective release" },
    ...((plan.source?.artifacts ?? []).map((artifact) => ({ href: safeReferenceUrl(artifact.href), text: artifact.name }))),
  ].filter((link): link is { href: string; text: string } => Boolean(link.href))
    .filter((link, index, all) => all.findIndex((item) => item.href === link.href) === index)
    .map((link) => ({ href: link.href, rel: "reference", text: link.text }));
  const controlIds = facts.controls.length ? facts.controls : [text(plan.control)].filter(Boolean);
  const controlId = controlIds[0] ?? "";
  const finding: Record<string, unknown> | null = findingText && controlId
    ? {
        uuid: findingUuid,
        title,
        description: findingText,
        target: {
          type: "objective-id",
          "target-id": context.objectiveId,
          title: "Internal scoped requirement",
          description: plan.assessment.requirement,
          status: { state: plan.validationRecorded && plan.validation==="demonstrated" ? "satisfied" : "not-satisfied", remarks:"Scoped requirement only. ISSE verification is separate from risk acceptance and agency closure." },
        },
        "related-observations": [{ "observation-uuid": observationUuid }],
        "related-risks": [{ "risk-uuid": riskUuid }],
      }
    : null;
  const risk: Record<string, unknown> = {
    uuid: riskUuid,
    title,
    description: facts.riskDescription || title,
    statement: facts.riskStatement || title,
    status: facts.closureRecorded ? "closed" : "open",
    props: properties([
      ["engineering-complete", String(plan.engineeringComplete)],
      ["verification-recorded", String(plan.validationRecorded)],
      ["verification-outcome", plan.validation],
      ["verification-reviewer", plan.validator],
      ["verification-date", plan.validationDate],
      ["verification-rationale", plan.validationNote],
      ["ready-for-closure-review", String(plan.readyForReview)],
      ...(facts.closureRecorded
        ? [
            ["external-decision-recorded", "true"],
            ["external-decision-reference", plan.closure.reference],
            ["external-decision-approver", plan.closure.approver],
            ["external-decision-date", plan.closure.date],
            ["external-decision-poam-id", plan.closure.officialId],
          ] as [string, string][]
        : []),
    ]),
    "related-observations": [{ "observation-uuid": observationUuid }],
  };
  const tasks = facts.milestones
    .map((milestone, index): Record<string, unknown> | null => {
      const taskTitle = text(milestone.description);
      if (!taskTitle) return null;
      return {
        uuid: stableUuid(`${plan.id}:milestone:${index}:${taskTitle}`),
        type: "milestone",
        title: taskTitle,
        description: `Status: ${milestone.status}.`,
        props: properties([
          ["status", milestone.status],
          ["original-target", milestone.target],
          ["revised-target", milestone.revised],
          ["revision-rationale", milestone.reason],
        ]),
      };
    })
    .filter((task): task is Record<string, unknown> => task !== null);
  if (facts.action || tasks.length || release.identity || facts.retests.length) {
    const remediation: Record<string, unknown> = {
      uuid: stableUuid(`${plan.id}:remediation`),
      lifecycle: plan.engineeringComplete ? "completed" : "planned",
      title: facts.action || (release.identity ? `Corrective release ${release.identity}` : title),
      description: facts.action || (release.identity ? `Corrective release ${release.identity}.` : title),
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
  const resultProps = [
    ...facts.controls.map((control) => prop("control-id", control)),
    prop("source-pipeline-id", plan.source.pipelineId),
    prop("source-commit", plan.source.commit),
    prop("source-release-sha256", plan.source.releaseSha256 ?? ""),
    prop("received-verification-commit", plan.receivedVerification?.commit ?? ""),
    prop("received-verification-release-sha256", plan.receivedVerification?.releaseSha256 ?? ""),
    prop("corrective-release", release.identity),
    prop("official-poam-id", facts.officialPoamId),
    prop("repository", facts.repository),
    prop("ticket", plan.ticket),
  ].filter((item): item is Prop => item !== null);
  const result: Record<string, unknown> = {
    uuid: stableUuid(`${plan.id}:result`),
    title,
    description: findingText,
    start: collected,
    "reviewed-controls": context.reviewedControls,
    observations: [observation],
    risks: [risk],
    remarks: [
      "Exported from the saved assessment and its source release. Agency review stays in the agency process.",
      ...facts.stillOpen,
    ].join(" "),
  };
  if (resultProps.length) result.props = resultProps;
  if (links.length) result.links = links;
  if (finding) result.findings = [finding];
  return addReleaseEvidence({
    "assessment-results": {
      uuid: stableUuid(`${plan.id}:assessment-results`),
      metadata: {
        title: `Assessment results: ${title}`,
        "last-modified": now.toISOString(),
        version: "0.1.0",
        "oscal-version": OSCAL_VERSION,
        props: properties([
          ["export-purpose", "internal-planning"],
          ["illustrative-assessment", String(plan.assessment.illustrative)],
          ["illustrative-release", String(plan.releaseIllustrative)],
          ["agency-submission", "not-performed"],
        ]),
        remarks: "Internal planning export of one saved assessment and its source release. Agency review stays in the agency process. This file is not an authorization or an agency acceptance.",
      },
      "import-ap": {
        href: `#${context.resource.uuid}`,
        remarks: "Attached internal scoped OSCAL assessment plan generated from the saved requirement. Not an agency-approved assessment plan.",
      },
      results: [result],
      "back-matter": {
        resources: [
          context.resource,
        ],
      },
    },
  }, bundles);
}

export const ASSESSMENT_RESULTS_SCHEMA_PATH = ["schemas", "oscal", "1.1.2", "oscal_assessment-results_schema.json"] as const;

function assessmentResultsValidator(root=findRepoRoot()):ValidateFunction{return schemaValidator("assessment-results",root);}

export function validateAssessmentResults(document: unknown, root = findRepoRoot()): { ok: true } | { ok: false; errors: string[] } {
  const validate = assessmentResultsValidator(root);
  if (validate(document)) {
    try {
      const body=(document as Record<string,any>)["assessment-results"];
      const ap=resolveContextDocument(body,body["import-ap"].href,"assessment-plan");
      const ssp=resolveContextDocument(ap["assessment-plan"],ap["assessment-plan"]["import-ssp"].href,"system-security-plan");
      const catalog=resolveContextDocument(ssp["system-security-plan"],ssp["system-security-plan"]["import-profile"].href,"catalog");
      const errors=[...validateContextDocument(ap,"assessment-plan",root),...validateContextDocument(ssp,"system-security-plan",root),...validateContextDocument(catalog,"catalog",root)];
      const defined=new Map<string,string>();
      for (const obj of ap["assessment-plan"]["local-definitions"]?.["objectives-and-methods"]??[]) {
        const methods=(obj.parts??[]).filter((p:any)=>p.name==="assessment-method");
        for (const method of methods) if ((method.props??[]).filter((p:any)=>p.name==="method").length!==1 || (method.parts??[]).filter((p:any)=>p.name==="assessment-objects").length!==1) errors.push("Assessment method must identify its method and assessment objects.");
        for (const part of obj.parts??[]) if (part.name==="assessment-objective" && part.id) {
          if (defined.has(part.id)) errors.push("Assessment objective IDs must be unique.");
          defined.set(part.id,obj["control-id"]);
          const refs=(part.props??[]).filter((p:any)=>p.name==="method-id");
          if (!refs.length || refs.some((p:any)=>!methods.some((m:any)=>m.id===p.value))) errors.push("Assessment objective must reference defined assessment methods.");
        }
      }
      const catalogIds=new Set(catalog.catalog.controls.map((c:any)=>c.id));
      const apIds=new Set(ap["assessment-plan"]["reviewed-controls"]["control-selections"].flatMap((s:any)=>(s["include-controls"]??[]).map((c:any)=>c["control-id"])));
      const sspIds=new Set(ssp["system-security-plan"]["control-implementation"]["implemented-requirements"].map((c:any)=>c["control-id"]));
      const componentIds=new Set((ssp["system-security-plan"]["system-implementation"].components??[]).map((c:any)=>c.uuid));
      for (const subject of ap["assessment-plan"]["assessment-subjects"]??[]) {
        for (const included of subject["include-subjects"]??[]) if (included.type==="component" && !componentIds.has(included["subject-uuid"])) errors.push("Assessment subject must resolve to a component in the attached SSP.");
      }
      const parts=(items:any[]):any[]=>items.flatMap(item=>[item,...parts(item.parts??[]),...parts(item.controls??[])]);
      const statementIds=new Set(parts(catalog.catalog.controls).filter(p=>p.name==="statement").map(p=>p.id));
      for (const requirement of ssp["system-security-plan"]["control-implementation"]["implemented-requirements"]) {
        for (const statement of requirement.statements??[]) if (!statementIds.has(statement["statement-id"])) errors.push("SSP statement must resolve to a statement in the attached catalog.");
      }
      for (const id of apIds) if (!catalogIds.has(id) || !sspIds.has(id)) errors.push("Assessment plan control must resolve in the attached scoped SSP and catalog.");
      for (const result of body.results) {
        const observations=new Set((result.observations??[]).map((o:any)=>o.uuid));
        const risks=new Set((result.risks??[]).map((r:any)=>r.uuid));
        for (const record of [...(result.findings??[]),...(result.risks??[])]) {
          for (const related of record["related-observations"]??[]) if (!observations.has(related["observation-uuid"])) errors.push("Related observation must resolve within the assessment result.");
          for (const related of record["related-risks"]??[]) if (!risks.has(related["risk-uuid"])) errors.push("Related risk must resolve within the assessment result.");
        }
        for (const selection of result["reviewed-controls"]["control-selections"]) for (const control of selection["include-controls"]??[]) if (!apIds.has(control["control-id"])) errors.push("Reviewed control must resolve in the attached assessment plan.");
        const selected=new Set((result["reviewed-controls"]["control-objective-selections"]??[]).flatMap((s:any)=>(s["include-objectives"]??[]).map((o:any)=>o["objective-id"])));
        for (const id of selected) if (!apIds.has(defined.get(id as string))) errors.push("Selected objective must resolve to a definition and control in the assessment plan.");
        for (const finding of result.findings??[]) if (finding.target.type!=="objective-id" || !selected.has(finding.target["target-id"]) || !catalogIds.has(defined.get(finding.target["target-id"]))) errors.push("Finding target must resolve to a selected, defined assessment objective and its scoped catalog control.");
        for (const finding of result.findings??[]) {
          const mapped=(finding.props??[]).find((p:any)=>p.name==="mapped-control-id")?.value;
          if (mapped && defined.get(finding.target["target-id"])!==mapped) errors.push("Finding objective must belong to its mapped control.");
        }
      }
      return errors.length ? {ok:false,errors:errors.slice(0,12)} : {ok:true};
    } catch(error) {return {ok:false,errors:[error instanceof Error ? error.message : "Invalid assessment context."]};}
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).slice(0, 12).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`),
  };
}
