import {addReleaseEvidence} from "./release-evidence-oscal";
import type {ReleaseEvidence} from "./release-evidence";
import { decisionPlan, matchesRow } from "./remediation-rollup";
import type { ControlRollupRow, ProvenResult, RollupCheck } from "./control-rollup";
import { recordedRows, releaseProject, rollupControlResults, resultForReviewItem } from "./control-rollup";
import { MODERATE_BASELINE_COUNT, MODERATE_BASELINE_PROFILE, MODERATE_PROFILE_VERSION } from "./moderate-baseline";
import { OSCAL_VERSION, REMEDIATION_NAMESPACE, stableUuid } from "./poam";
import { planOfActionFacts } from "./poam-facts";
import { normalizeStoredPlan, restorePlan, type RemediationPlan } from "./remediation";
import { gitlabArtifactUrl } from "./pipeline-evidence";
import { resolveContextDocument, validateContextDocument } from "./assessment-context";
import { validateAssessmentResults } from "./assessment-results";
import { validatePlanOfAction } from "./poam";
import { hasRecordedTestResult } from "./poam-facts";
import { plainPlan, type PlanProposal } from "./plan-proposal";
import type { PipelineEvidence } from "./pipeline-evidence";

type Prop = { name: string; value: string; ns: string };
type Document = Record<string, unknown>;

const STATUS_WORD = /^(open|closed|investigating|remediating|deviation-requested|deviation-approved)$/i;
const SCANNER_IDS = new Set(["sast", "dependencies", "image", "configuration", "secrets", "publisher-signature", "built-image-signature", "sbom"]);

function text(value: string): string {
  return value.trim();
}

function prop(name: string, value: string): Prop | null {
  const trimmed = text(value);
  if (!trimmed) return null;
  return { name, value: trimmed.replace(/\s+/g, " "), ns: REMEDIATION_NAMESPACE };
}

function properties(entries: [string, string][]): Prop[] {
  return entries.map(([name, value]) => prop(name, value)).filter((item): item is Prop => item !== null);
}

function oscalDate(value: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  return fallback;
}

function resource(uuid: string, title: string, filename: string, document: Document, mediaType="application/oscal+json"): Document {
  return {
    uuid,
    title,
    props: properties([
      ["context-origin", "rollup-of-stored-releases"],
      ["agency-approved", "false"],
    ]),
    base64: {
      filename,
      "media-type": mediaType,
      value: Buffer.from(JSON.stringify(document), "utf8").toString("base64"),
    },
  };
}

function rowIdentity(row: ControlRollupRow): string {
  return JSON.stringify([row.oscalId,row.result?.asset,row.result?.sourceReleaseUrl,row.result?.sourceReleaseSha256,row.result?.reviewItemId ?? row.result?.finding]);
}

function suppliedRisk(plan: RemediationPlan | null): string {
  const value = text(plan?.risk ?? "");
  if (!value || STATUS_WORD.test(value)) return "";
  return value;
}

function workload(rows: ControlRollupRow[], plan: RemediationPlan | null = null) {
  const source = plan?.source.pipelineUrl || recordedRows(rows)[0]?.result?.sourceReleaseUrl;
  const project = source ? releaseProject(source) : "internal:unassigned";
  const asset = plan?.asset || recordedRows(rows).find(r => r.result?.asset)?.result?.asset || "Release evidence workload";
  return { asset, project, id: stableUuid(JSON.stringify(["internal-release-workload", project, asset])) };
}

function metadata(title: string, now: string, remarks: string, extra: [string, string][] = []): Document {
  return {
    title,
    "last-modified": now,
    version: "0.1.0",
    "oscal-version": OSCAL_VERSION,
    props: properties([
      ["export-purpose", "internal-planning"],
      ["agency-submission", "not-performed"],
      ["authorization", "not-asserted"],
      ["baseline", MODERATE_BASELINE_PROFILE],
      ["baseline-version", MODERATE_PROFILE_VERSION],
      ["baseline-control-count", String(MODERATE_BASELINE_COUNT)],
      ...extra,
    ]),
    remarks,
  };
}

const REMARKS = "Internal planning rollup of stored releases against the FedRAMP Rev 5 Moderate baseline. A control with no stored evidence is blank. Baseline membership is not a pass, an implementation, or an authorization. Agency system id, official plan id, closure, accepted risk, owner, and milestones stay blank unless a person recorded them.";

export function buildSystemSecurityPlan(rows: ControlRollupRow[], now: string, plan: RemediationPlan | null = null): Document {
  const { asset, id } = workload(rows, plan);
  const system = {
    id,
    "identifier-type": "urn:aegis:system-id:internal",
  };
  const assetUuid = stableUuid(`${system.id}:asset`);
  const catalogUuid = stableUuid("binder:moderate-catalog");
  const catalogResourceUuid = stableUuid("binder:moderate-catalog-resource");
  const sspUuid = stableUuid(`binder:moderate-ssp:${id}`);
  const catalog: Document = {
    catalog: {
      uuid: catalogUuid,
      metadata: metadata("FedRAMP Rev 5 Moderate baseline controls", now, "Control identifiers selected by the vendored FedRAMP Rev 5 Moderate profile. Titles are from the vendored NIST SP 800-53 Rev 5 catalog. This is not an authorization."),
      controls: rows.map((row) => ({
        id: row.oscalId,
        title: row.title,
        props: properties([
          ["source-control-reference", row.id],
          ["baseline-membership", "selected"],
          ["evidence-recorded", row.result ? "true" : "false"],
        ]),
      })),
    },
  };
  const requirements = rows.map((row) => {
    const item: Document = {
      uuid: stableUuid(`binder-ssp:${id}:${row.oscalId}`),
      "control-id": row.oscalId,
    };
    item.remarks = "Baseline mapping context only; linked scanner evidence does not assert control implementation.";
    if (row.result) {
      item.props = properties([["evidence-recorded", "true"], ["source-release", row.result.releaseId]]);
      item.links = row.result.evidence.flatMap(name => {
        const href = gitlabArtifactUrl({ pipelineUrl: row.result!.releaseUrl, artifactJobId: row.result!.artifactJobId, releaseSha256: row.result!.releaseSha256, artifacts: row.result!.evidence } as PipelineEvidence, name);
        return href ? [{ href, rel: "reference", text: name }] : [];
      });
    }
    return item;
  });
  return {
    "system-security-plan": {
      uuid: sspUuid,
      metadata: metadata(`Internal system security plan: ${asset}`, now, REMARKS),
      "import-profile": {
        href: `#${catalogResourceUuid}`,
        remarks: "Attached catalog lists the FedRAMP Rev 5 Moderate baseline. It is not an agency-approved profile import and it does not grant an ATO.",
      },
      "system-characteristics": {
        "system-ids": [system],
        "system-name": asset,
        description: "Internal assessment subject for the scoped stored releases. No agency system identifier and no Government authorization boundary are recorded.",
        "system-information": {
          "information-types": [{
            title: "Internal assessment records",
            description: "Stored release evidence and blank baseline gaps. No agency information-type categorization is asserted.",
          }],
        },
        status: { state: "other", remarks: "Operational and authorization status are not established by this plan." },
        "authorization-boundary": {
          description: `Internal assessment subject: ${asset}. No Government authorization boundary is asserted.`,
        },
      },
      "system-implementation": {
        users: [{
          uuid: stableUuid(`${sspUuid}:reviewer-context`),
          title: "Internal review context",
          remarks: "Context entry only. No account, assignment, or access privilege is asserted.",
        }],
        components: [{
          uuid: assetUuid,
          type: "system",
          title: asset,
          description: "Workload context for linked release evidence. No full control implementation is asserted.",
          status: { state: "other" },
        }],
      },
      "control-implementation": {
        description: "Full baseline mapping context, not implemented controls. No native implementation statements or implementation status are inferred from scanner evidence.",
        "implemented-requirements": requirements,
      },
      "back-matter": {
        resources: [resource(catalogResourceUuid, "FedRAMP Rev 5 Moderate baseline controls", "moderate-baseline-catalog.json", catalog)],
      },
    },
  };
}

function checkEvidence(check: RollupCheck): Document | null {
  if (!text(check.description) && !text(check.result)) return null;
  const summary = [text(check.description), text(check.result)].filter(Boolean).join(". ");
  const item: Document = { description: text(check.date) ? `${summary} (${text(check.date)})` : summary };
  const props = properties([
    ["verification-check", check.description],
    ["reviewer", check.reviewer],
    ["collected-date", check.date],
    ["artifact-sha256", check.artifactSha256 ?? ""],
    ["verdict", check.verdict ?? ""],
    ["reported-verdict", check.reportedVerdict ?? ""],
    ["evidence-state", check.evidenceState ?? ""],
    ["valid-until", check.validUntil ?? ""],
  ]);
  if (props.length) item.props = props;
  if (check.href) item.href = check.href;
  else item.remarks = "Recorded test result; no resolvable evidence link is recorded.";
  return item;
}

function observation(row: ControlRollupRow, result: ProvenResult, now: string, plan: RemediationPlan | null = null): Document {
  const finding = text(result.finding);
  const description = finding || text(result.coverage) || row.title;
  const methods = ["EXAMINE"];
  if (result.checks.length) methods.push("TEST");
  const item: Document = {
    uuid: stableUuid(`binder-ar:${rowIdentity(row)}:observation`),
    title: result.findingTitle || row.id,
    description,
    methods,
    collected: oscalDate(finding ? result.sourceCreatedAt ?? result.createdAt : result.createdAt, now),
    props: properties([
      ["control-id", row.id],
      ["source-release", finding ? result.sourceReleaseId : result.releaseId],
      ["source-commit", finding ? result.sourceCommit : result.commit],
      ["source-release-sha256", finding ? result.sourceReleaseSha256 : result.releaseSha256],
      ["corrective-release", result.correctiveReleaseId],
      ["original-release", result.sourceReleaseId],
      ["review-status", "requires-recorded-assessment"],
    ]),
  };
  if (finding) item.types = ["finding"];
  if (matchesRow(plan,row) && plan) {
    (item.props as Prop[]).push(...properties([
      ["assessment-disposition",plan.assessment.disposition], ["assessment-requirement",plan.assessment.requirement],
      ["assessment-rationale",plan.assessment.note], ["assessment-reference",plan.assessment.reference],
      ["assessment-reviewer",plan.assessment.reviewer], ["assessment-date",plan.assessment.date],
      ["illustrative-assessment",String(plan.assessment.illustrative)],
    ]));
  }
  const evidence = [
    ...(finding ? result.sourceArtifacts.map(artifact => ({ href: artifact.href, description: `Original finding evidence: ${artifact.name}; not an implementation assertion.` })) : result.evidence.flatMap(name => {
      const href = gitlabArtifactUrl({ pipelineUrl: result.releaseUrl, artifactJobId: result.artifactJobId, releaseSha256: result.releaseSha256, artifacts: result.evidence } as PipelineEvidence, name);
      return href ? [{ href, description: `Linked artifact: ${name}; not an implementation assertion.` }] : [];
    })),
    ...result.checks.map(checkEvidence).filter((entry): entry is Document => entry !== null),
    ...(matchesRow(plan,row) && plan ? plan.tests.filter(hasRecordedTestResult).map(test => ({
      description: `${test.description}. ${test.result}`,
      ...(test.evidence ? { href: test.evidence } : {}),
      props: properties([["evidence-origin","saved-draft"], ["reviewer",test.reviewer], ["collected-date",test.date],
        ["illustrative",String(test.illustrative)], ["artifact-sha256",test.artifactSha256 ?? ""], ["verdict",test.verdict ?? ""]]),
    })) : []),
  ];
  if (matchesRow(plan,row) && plan?.tests.some(hasRecordedTestResult) && !methods.includes("TEST")) methods.push("TEST");
  if (evidence.length) item["relevant-evidence"] = evidence;
  return item;
}

export function buildRolledUpAssessmentResults(rows: ControlRollupRow[], ssp: Document, plan: RemediationPlan | null, now: string): Document {
  const recorded = recordedRows(rows).filter((row) => row.result);
  const findings = recorded.filter(row => matchesRow(plan,row) && text(row.result?.finding ?? ""));
  const primary = findings[0] ?? recorded[0];
  const assetUuid = ((ssp["system-security-plan"] as Document)["system-implementation"] as Document).components as Document[];
  const subjectUuid = assetUuid[0].uuid as string;
  const scopeId = workload(rows,plan).id;
  const sspResourceUuid = stableUuid(`binder:moderate-ssp-resource:${scopeId}`);
  const apUuid = stableUuid(`binder:moderate-assessment-plan:${scopeId}`);
  const apResourceUuid = stableUuid(`binder:moderate-assessment-plan-resource:${scopeId}`);
  const objectiveId = (row: ControlRollupRow) => `aegis-objective-${stableUuid(`binder-objective:${row.oscalId}:${row.result?.sourceReleaseUrl}:${matchesRow(plan,row) ? plan?.assessment.requirement : row.result?.coverage}`)}`;
  const objectiveText = (row: ControlRollupRow) => matchesRow(plan,row) ? plan!.assessment.requirement : row.result?.finding || row.result?.coverage || "Evidence review only; applicable requirement has not been assessed.";
  const localObjectives = recorded.map(row => {
    const id = objectiveId(row);
    const requiredTests = matchesRow(plan,row) ? plan!.assessment.scope!.verification : row.result!.checks.map(c=>c.description);
    const methods = ["examine", ...(requiredTests.length ? ["test"] : [])];
    return {
      "control-id": row.oscalId,
      description: "Local evidence-review objective; not an authoritative NIST objective or a full-control assessment.",
      parts: [
        { id, name: "assessment-objective", prose: objectiveText(row),
          props: methods.map(method => ({ name: "method-id", value: `${id}-${method}` })) },
        ...methods.map(method => ({
          id: `${id}-${method}`, name: "assessment-method",
          props: [{ name: "method", ns: "http://csrc.nist.gov/ns/rmf", value: method.toUpperCase() }],
          parts: [{ name: "assessment-objects", prose: method === "test" ? requiredTests.join("\n\n") : row.result!.evidence.join(", ") }],
        })),
      ],
    };
  });
  const reviewed = {
    description: "Full baseline is listed as mapping context, not assessed or satisfied. Only linked evidence has observations.",
    "control-selections": [{ "include-controls": rows.map(row => ({ "control-id": row.oscalId })) }],
    ...(recorded.length ? { "control-objective-selections": [{ "include-objectives": recorded.map(row => ({ "objective-id": objectiveId(row) })) }] } : {}),
  };
  const ap: Document = {
    "assessment-plan": {
      uuid: apUuid,
      metadata: metadata("Internal assessment plan for scoped stored releases", now, `${REMARKS} Retrospective context reconstructed from saved evidence and scope; not proof of a pre-approved assessment plan.`),
      "import-ssp": { href: `#${sspResourceUuid}`, remarks: "Attached internal SSP. Not an agency system security plan." },
      ...(localObjectives.length ? { "local-definitions": { "objectives-and-methods": localObjectives } } : {}),
      "reviewed-controls": reviewed,
      "assessment-subjects": [{ type: "component", "include-subjects": [{ "subject-uuid": subjectUuid, type: "component" }] }],
      "back-matter": { resources: [resource(sspResourceUuid, "Internal system security plan", "system-security-plan.json", ssp)] },
    },
  };
  const observations = recorded.map((row) => observation(row, row.result as ProvenResult, now, plan));
  const findingDocs = findings.map((row) => {
    const result = row.result as ProvenResult;
    const decision = decisionPlan(plan, row);
    const demonstrated = decision?.validationRecorded === true && decision.validation === "demonstrated";
    return {
      uuid: stableUuid(`binder-ar:${rowIdentity(row)}:finding`),
      title: result.findingTitle || row.id,
      description: result.finding,
      props: properties([["mapped-control-id",row.oscalId]]),
      target: {
        type: "objective-id",
        "target-id": objectiveId(row),
        title: "Recorded scoped requirement",
        description: objectiveText(row),
        status: {
          state: demonstrated ? "satisfied" : "not-satisfied",
          remarks: "Scoped requirement only. A stored observation is not agency closure or an authorization.",
        },
      },
      "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
      "related-risks": [{ "risk-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:risk`) }],
    };
  });
  const risks = findings.map((row) => {
    const result = row.result as ProvenResult;
    const scopedPlan = decisionPlan(plan, row);
    const closed = scopedPlan !== null && planOfActionFacts(scopedPlan).closureRecorded;
    const risk: Document = {
      uuid: stableUuid(`binder-ar:${rowIdentity(row)}:risk`),
      title: result.findingTitle || row.id,
      description: (matchesRow(plan, row) ? suppliedRisk(plan) : "") || result.finding || row.title,
      statement: (matchesRow(plan, row) ? suppliedRisk(plan) : "") || result.finding || row.title,
      status: closed ? "closed" : "open",
      props: properties([
        ["control-id", row.id],
        ["ready-for-closure-review", String(scopedPlan?.readyForReview === true)],
        ...(closed && plan ? [
          ["external-decision-recorded", "true"],
          ["external-decision-reference", plan.closure.reference],
          ["external-decision-approver", plan.closure.approver],
          ["external-decision-date", plan.closure.date],
          ["external-decision-poam-id", plan.closure.officialId],
        ] as [string, string][] : []),
      ]),
      "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
    };
    if (result.correctiveReleaseId || result.checks.length || matchesRow(plan,row)) {
      const remediation: Document = {
        uuid: stableUuid(`binder-ar:${rowIdentity(row)}:remediation`),
        lifecycle: scopedPlan?.engineeringComplete ? "completed" : "planned",
        title: result.correctiveReleaseId ? `Corrective release ${result.correctiveReleaseId}` : row.id,
        description: result.correctiveReleaseId ? `Corrective release ${result.correctiveReleaseId}.` : result.finding,
        props: properties([
          ...(result.correctiveReleaseId ? [["corrective-release", result.correctiveReleaseId] as [string, string]] : []),
          ...(matchesRow(plan,row) ? plan!.assessment.scope!.verification : result.checks.map(c => c.description)).map(description => ["required-verification", description] as [string,string]),
          ["resources", matchesRow(plan,row) ? plan!.resources : ""],
          ["interim-protection", matchesRow(plan,row) ? plan!.protection : ""],
        ]),
      };
      if (result.correctiveReleaseUrl) remediation.links = [{ href: result.correctiveReleaseUrl, rel: "reference", text: "Corrective release" }];
      if (matchesRow(plan, row) && plan) {
        const tasks = planOfActionFacts(plan).milestones
          .filter((milestone) => text(milestone.description))
          .map((milestone, index) => ({
            uuid: stableUuid(`${plan.id}:milestone:${index}:${milestone.description}`),
            type: "milestone",
            title: text(milestone.description),
            description: `Status: ${milestone.status}.`,
            props: properties([
              ["status", milestone.status],
              ["original-target", milestone.target],
              ["revised-target", milestone.revised],
              ["revision-rationale", milestone.reason],
            ]),
          }));
        if (tasks.length) remediation.tasks = tasks;
        if (text(plan.action)) {
          remediation.title = text(plan.action);
          remediation.description = text(plan.action);
        }
      }
      risk.remediations = [remediation];
    }
    return risk;
  });
  const resultProps = [
    ...recorded.map((row) => prop("control-id", row.id)),
    ...recorded.map(row => prop("source-pipeline-id", row.result!.sourceReleaseId)),
    prop("corrective-release", findings.find((row) => row.result?.correctiveReleaseId)?.result?.correctiveReleaseId ?? ""),
    ...(plan && text(plan.officialId) ? [prop("official-poam-id", plan.officialId)] : []),
    ...(plan && text(plan.repository) ? [prop("repository", plan.repository)] : []),
  ].filter((item): item is Prop => item !== null);
  if (resultProps.some((item) => SCANNER_IDS.has(item.value))) {
    throw new Error("Scanner ids must not be written as control ids.");
  }
  const links = [...new Set([...recorded.flatMap(row => [row.result!.sourceReleaseUrl, row.result!.releaseUrl]), ...(plan?.releaseUrl ? [plan.releaseUrl] : [])])]
    .map(href => ({ href, rel: "reference", text: "Recorded release" }));
  const result: Document = {
    uuid: stableUuid(`binder:assessment-result:${scopeId}`),
    title: primary?.result?.findingTitle || "Stored release rollup",
    description: "Current result per control. Controls with no stored evidence are listed in reviewed controls and left blank.",
    start: now,
    "reviewed-controls": reviewed,
    ...(observations.length ? { observations } : {}),
    ...(risks.length ? { risks } : {}),
    ...(findingDocs.length ? { findings: findingDocs } : {}),
    ...(resultProps.length ? { props: resultProps } : {}),
    ...(links.length ? { links } : {}),
    remarks: "Agency review stays in the agency process. Blank controls are not passed.",
  };
  return {
    "assessment-results": {
      uuid: stableUuid(`binder:assessment-results:${scopeId}`),
      metadata: metadata("Assessment results for scoped stored releases", now, REMARKS, [
        ["illustrative-assessment", String(plan?.assessment.illustrative === true)],
      ]),
      "import-ap": {
        href: `#${apResourceUuid}`,
        remarks: "Attached internal assessment plan. Not an agency-approved assessment plan.",
      },
      results: [result],
      "back-matter": { resources: [resource(apResourceUuid, "Internal assessment plan", "assessment-plan.json", ap), ...(plan ? [resource(stableUuid(`${plan.id}:assessment-record`), "Saved scoped assessment and decision record", "internal-assessment-record.json", plan as unknown as Document,"application/json")] : [])] },
    },
  };
}

function proposalMatches(proposal: PlanProposal, row: ControlRollupRow): boolean {
  const finding = text(row.result?.finding ?? "");
  return proposal.acceptance === "accepted" && text(proposal.finding) === finding && proposal.controlId === row.id && text(proposal.sourceReleaseId) === text(row.result?.sourceReleaseId ?? "");
}

function proposalRisk(row: ControlRollupRow, proposal: PlanProposal): Document {
  const result = row.result as ProvenResult;
  const risk: Document = {
    uuid: stableUuid(`binder-poam:${rowIdentity(row)}:risk`),
    title: result.findingTitle || row.id,
    description: text(proposal.riskStatement) || result.finding,
    statement: text(proposal.riskStatement) || result.finding,
    status: proposal.closureConfirmed ? "closed" : "open",
    props: properties([
      ["control-id", row.id],
      ["proposal-acceptance", "accepted"],
      ["ready-to-close", String(proposal.readyToClose)],
      ["person-closure-confirmed", String(proposal.closureConfirmed)],
      ["external-decision-recorded", "false"],
    ]),
    "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
  };
  const remediation: Document = {
    uuid: stableUuid(`binder-poam:${rowIdentity(row)}:remediation`),
    lifecycle: proposal.closureConfirmed ? "completed" : "planned",
    title: text(proposal.action) || row.id,
    description: text(proposal.action) || result.finding,
    props: properties([
      ["corrective-release", result.correctiveReleaseId],
      ...proposal.provingChecks.map((description) => ["required-verification", description] as [string, string]),
    ]),
  };
  if (result.correctiveReleaseUrl) remediation.links = [{ href: result.correctiveReleaseUrl, rel: "reference", text: "Corrective release" }];
  if (text(proposal.milestone.description)) {
    const task: Document = {
      uuid: stableUuid(`${proposal.id}:milestone:${proposal.milestone.description}`),
      type: "milestone",
      title: text(proposal.milestone.description),
      description: proposal.closureConfirmed ? "Accepted milestone. A person confirmed closure; agency acceptance is not recorded." : "Accepted milestone. A person has not recorded closure.",
      props: properties([
        ["status", "Accepted"],
        ["original-target", proposal.milestone.target],
      ]),
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(proposal.milestone.target)) task.timing = { "on-date": { date: `${proposal.milestone.target}T00:00:00Z` } };
    remediation.tasks = [task];
  }
  if (proposal.closureConfirmed && proposal.closure) {
    risk["risk-log"] = {entries: [{uuid: stableUuid(`${proposal.id}:closure:${proposal.closure.at}`), title: "Person confirmed closure", description: proposal.closure.reason, start: proposal.closure.at, end: proposal.closure.at, props: properties([["reviewer", proposal.closure.name], ["completion-date", proposal.closure.at]])}]};
  }
  risk.remediations = [remediation];
  return risk;
}

function proposalItem(row: ControlRollupRow, proposal: PlanProposal): Document {
  const result = row.result as ProvenResult;
  const remarks = [
    proposal.closureConfirmed ? "Closed internal plan. Agency acceptance is not recorded." : "Accepted draft. Risk status stays open.",
    proposal.closureConfirmed || proposal.readyToClose ? "Retest evidence is attached and passes every required check." : "Retest evidence is not a passing proof for every required check.",
    proposal.closureConfirmed ? "A person confirmed closure of this internal plan. Agency acceptance is not recorded." : proposal.readyToClose ? "Ready to close. Closure is not confirmed." : "Closure is not confirmed.",
    text(proposal.officialId) ? `Official plan id: ${text(proposal.officialId)}. Agency system identifier is not recorded.` : "Official plan id and agency system identifier are not recorded.",
  ];
  const props = [
    prop("control-id", row.id),
    prop("source-pipeline-id", result.sourceReleaseId),
    prop("corrective-release", result.correctiveReleaseId),
    prop("proposal-acceptance", "accepted"),
    prop("ready-to-close", String(proposal.readyToClose)),
    prop("person-closure-confirmed", String(proposal.closureConfirmed)),
    prop("poam-id", proposal.officialId),
    prop("status", plainPlan(proposal).status),
    prop("owner", plainPlan(proposal).whoOwnsIt),
    prop("point-of-contact", plainPlan(proposal).whoOwnsIt),
    prop("completion-date", proposal.closureConfirmed ? proposal.closure?.at ?? "" : ""),
    prop("closure-reviewer", proposal.closureConfirmed ? proposal.closure?.name ?? "" : ""),
    prop("closure-reason", proposal.closureConfirmed ? proposal.closure?.reason ?? "" : ""),
    {name: "plain-plan-record", value: "binder.plan-proposal.v1", ns: REMEDIATION_NAMESPACE, remarks: JSON.stringify({...proposal, schema: "binder.plan-proposal.v1", result: undefined, plain: plainPlan(proposal)})},
  ].filter((item): item is Prop => item !== null);
  const links = [
    { href: result.sourceReleaseUrl, rel: "reference", text: "Original release" },
    ...(result.correctiveReleaseUrl ? [{ href: result.correctiveReleaseUrl, rel: "reference", text: "Corrective release" }] : []),
  ];
  return {
    uuid: stableUuid(`binder-poam:${rowIdentity(row)}:item`),
    title: result.findingTitle || row.id,
    description: [result.finding, text(proposal.action) ? `Corrective action: ${text(proposal.action)}.` : ""].filter(Boolean).join(" "),
    props,
    links,
    "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
    "related-risks": [{ "risk-uuid": stableUuid(`binder-poam:${rowIdentity(row)}:risk`) }],
    remarks: remarks.join(" "),
  };
}

export function buildRolledUpPlanOfAction(rows: ControlRollupRow[], plan: RemediationPlan | null, now: string, proposals: PlanProposal[] = []): Document {
  const findings = recordedRows(rows).filter(row => matchesRow(plan, row) && text(row.result?.finding ?? ""));
  const { id } = workload(rows, plan);
  const observations = recordedRows(rows).map((row) => observation(row, row.result as ProvenResult, now, plan));
  const risks = findings.map((row) => {
    const result = row.result as ProvenResult;
    const scopedPlan = decisionPlan(plan, row);
    const facts = scopedPlan ? planOfActionFacts(scopedPlan) : null;
    const closed = facts?.closureRecorded === true;
    const risk: Document = {
      uuid: stableUuid(`binder-poam:${rowIdentity(row)}:risk`),
      title: result.findingTitle || row.id,
      description: (facts ? suppliedRisk(plan) : "") || result.finding,
      statement: (facts ? suppliedRisk(plan) : "") || result.finding,
      status: closed ? "closed" : "open",
      props: properties([
        ["control-id", row.id],
        ["engineering-complete", String(scopedPlan?.engineeringComplete === true)],
        ["verification-recorded", String(scopedPlan?.validationRecorded === true)],
        ["ready-for-closure-review", String(scopedPlan?.readyForReview === true)],
        ["external-decision-recorded", String(closed)],
        ...(closed && plan ? [
          ["external-decision-reference", plan.closure.reference],
          ["external-decision-approver", plan.closure.approver],
          ["external-decision-date", plan.closure.date],
          ["external-decision-poam-id", plan.closure.officialId],
        ] as [string, string][] : []),
      ]),
      "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
    };
    if (result.correctiveReleaseId || facts) {
      const remediation: Document = {
        uuid: stableUuid(`binder-poam:${rowIdentity(row)}:remediation`),
        lifecycle: scopedPlan?.engineeringComplete ? "completed" : "planned",
        title: (facts && facts.action) || (result.correctiveReleaseId ? `Corrective release ${result.correctiveReleaseId}` : row.id),
        description: (facts && facts.action) || (result.correctiveReleaseId ? `Corrective release ${result.correctiveReleaseId}.` : result.finding),
        props: properties([
          ...(result.correctiveReleaseId ? [["corrective-release", result.correctiveReleaseId] as [string, string]] : []),
          ...(matchesRow(plan,row) ? plan!.assessment.scope!.verification : result.checks.map(c => c.description)).map(description => ["required-verification", description] as [string,string]),
          ["resources", matchesRow(plan,row) ? plan!.resources : ""],
          ["interim-protection", matchesRow(plan,row) ? plan!.protection : ""],
        ]),
      };
      if (result.correctiveReleaseUrl) remediation.links = [{ href: result.correctiveReleaseUrl, rel: "reference", text: "Corrective release" }];
      if (facts && plan) {
        const tasks = facts.milestones.filter((milestone) => text(milestone.description)).map((milestone, index) => ({
          uuid: stableUuid(`${plan.id}:milestone:${index}:${milestone.description}`),
          type: "milestone",
          title: text(milestone.description),
          description: `Status: ${milestone.status}.`,
          props: properties([
            ["status", milestone.status],
            ["original-target", milestone.target],
            ["revised-target", milestone.revised],
            ["revision-rationale", milestone.reason],
          ]),
        }));
        if (tasks.length) remediation.tasks = tasks;
      }
      risk.remediations = [remediation];
    }
    return risk;
  });
  const items = findings.map((row) => {
    const result = row.result as ProvenResult;
    const scopedPlan = decisionPlan(plan, row);
    const facts = scopedPlan ? planOfActionFacts(scopedPlan) : null;
    const props = [
      prop("control-id", row.id),
      facts ? prop("owner", facts.owner) : null,
      facts ? prop("poam-id", facts.officialPoamId) : null,
      facts ? prop("repository", facts.repository) : null,
      prop("source-pipeline-id", result.sourceReleaseId),
      prop("corrective-release", result.correctiveReleaseId),
    ].filter((item): item is Prop => item !== null);
    const links = [
      { href: result.sourceReleaseUrl, rel: "reference", text: "Original release" },
      ...(result.correctiveReleaseUrl ? [{ href: result.correctiveReleaseUrl, rel: "reference", text: "Corrective release" }] : []),
    ];
    return {
      uuid: stableUuid(`binder-poam:${rowIdentity(row)}:item`),
      title: result.findingTitle || row.id,
      description: result.finding,
      props,
      links,
      "related-observations": [{ "observation-uuid": stableUuid(`binder-ar:${rowIdentity(row)}:observation`) }],
      "related-risks": [{ "risk-uuid": stableUuid(`binder-poam:${rowIdentity(row)}:risk`) }],
      remarks: "Open until a person records closure. Other baseline controls are not added as plan items.",
    };
  });
  const covered = new Set(findings.map(rowIdentity));
  for (const proposal of plan ? [] : proposals) {
    const control = rows.find(candidate => candidate.id === proposal.controlId);
    const row = control && proposal.result ? { ...control, result: proposal.result } : rows.find(candidate => proposalMatches(proposal, candidate));
    if (!row || !proposalMatches(proposal, row) || covered.has(rowIdentity(row))) continue;
    covered.add(rowIdentity(row));
    if (!observations.some(item => item.uuid === stableUuid(`binder-ar:${rowIdentity(row)}:observation`))) observations.push(observation(row, row.result as ProvenResult, now, null));
    risks.push(proposalRisk(row, proposal));
    items.push(proposalItem(row, proposal) as (typeof items)[number]);
  }
  const resources: Document[] = [];
  if (plan) {
    const draftUuid = stableUuid(`${plan.id}:internal-record`);
    resources.push({
      uuid: draftUuid,
      title: "Internal assessment and remediation record",
      description: "Saved draft supplied by a person. Empty agency fields stay empty.",
      props: properties([["record-schema", plan.schema], ["illustrative-assessment", String(plan.assessment.illustrative)]]),
      base64: {
        filename: `${plan.id.replace(/[^a-z0-9_.-]/gi, "_")}.json`,
        "media-type": "application/json",
        value: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
      },
    });
    for (const item of items) item.links = [...item.links, { href: `#${draftUuid}`, rel: "reference", text: "Internal decision record" }];
  }
  return {
    "plan-of-action-and-milestones": {
      uuid: stableUuid(`binder:plan-of-action:${id}`),
      metadata: metadata("Plan of action for scoped stored releases", now, REMARKS, [
        ["illustrative-assessment", String(plan?.assessment.illustrative === true)],
      ]),
      "system-id": {
        id,
        "identifier-type": "urn:aegis:system-id:internal",
      },
      ...(observations.length ? { observations } : {}),
      ...(risks.length ? { risks } : {}),
      ...(items.length ? { "poam-items": items } : {}),
      ...(resources.length ? { "back-matter": { resources } } : {}),
    },
  };
}

export type BinderDocuments = {
  ssp: Document;
  assessmentResults: Document;
  poam: Document;
  rows: ControlRollupRow[];
};

export function buildBinderDocuments(releases: PipelineEvidence[], plan: RemediationPlan | null, now = new Date(), proposals: PlanProposal[] = [], bundles: ReleaseEvidence[] = []): BinderDocuments {
  plan = plan ? normalizeStoredPlan(plan) : null;
  bundles = bundles.filter(bundle => releases.some(release => release.releaseSha256 === bundle.releaseSha256 &&
    release.schema === "aegis.evidence-event.v1" && release.observation.connectionId === bundle.connectionId));
  if (plan) {
    const saved = plan;
    const source = releases.find(release => release.pipelineId === saved.source.pipelineId);
    const finding = source?.reviewItems?.find(item => item.description === saved.source.reviewItem);
    bundles = bundles.map(bundle => ({...bundle, items: bundle.items.filter(item =>
      item.sourceReleaseId === saved.source.pipelineId && item.findingId === finding?.id && item.controlId === saved.control)}));
    const proving = [...bundles].reverse().find(bundle => bundle.items.some(item => item.retestResult === "pass"));
    if (proving) plan = {...plan, releaseRef: proving.releaseId, releaseUrl: proving.releaseUrl};
  }
  const boundPlanItem = plan ? bundles.flatMap(bundle => bundle.items)[0]?.poamItemId : undefined;

  // A reviewer can author a scope for any release review item, not only producer-supplied templates.
  // Reconstruct that scope only after resolving its original commit, hash and artifact links.
  if (plan) {
    const original = releases.find(r => restorePlan(plan,r));
    if (original) {
      const saved = plan;
      releases = releases.map(r => r === original ? {
        ...r, reviewItems: [
          ...(r.reviewItems ?? []).filter(item=>item.description!==saved.source.reviewItem),
          {id:"saved-scoped-assessment",description:saved.source.reviewItem,scope:saved.assessment.scope!},
        ],
      } : r);
    } else plan = null;
  }
  const sourceUrl = plan?.source.pipelineUrl ?? releases[0]?.pipelineUrl;
  const rows = rollupControlResults(releases, sourceUrl);
  // A saved draft retains its own exact finding even when a newer, different
  // finding becomes the aggregate map result on the same control.
  if (plan) {
    const scopedPlan = plan;
    const original = releases.find(release => restorePlan(scopedPlan, release));
    const item = original?.reviewItems?.find(entry => entry.description === scopedPlan.source.reviewItem);
    if (original && item) for (const controlId of item.scope.controls) {
      const row = rows.find(candidate => candidate.id === controlId.toUpperCase());
      const result = resultForReviewItem(original, item, controlId, releases);
      if (row && result) row.result = result;
    }
  }
  // Do not attach decisions from a draft with no matching original evidence in this rollup.
  if (plan && !rows.some(row => matchesRow(plan,row))) plan = null;
  const stamp = now.toISOString();
  const ssp = buildSystemSecurityPlan(rows, stamp, plan);
  return {
    rows,
    ssp: addReleaseEvidence(ssp, bundles),
    assessmentResults: addReleaseEvidence(buildRolledUpAssessmentResults(rows, ssp, plan, stamp), bundles),
    poam: addReleaseEvidence(buildRolledUpPlanOfAction(rows, plan, stamp, proposals), bundles, boundPlanItem),
  };
}

/** Validate every downloaded model and its shared internal context, not just its JSON shape. */
export function validateBinderDocuments(documents: BinderDocuments): string[] {
  const errors = validateContextDocument(documents.ssp, "system-security-plan");
  const ar = validateAssessmentResults(documents.assessmentResults);
  const poam = validatePlanOfAction(documents.poam);
  if (!ar.ok) errors.push(...ar.errors);
  if (!poam.ok) errors.push(...poam.errors);
  const poamBody=documents.poam["plan-of-action-and-milestones"] as Document;
  const observations=new Set(((poamBody.observations ?? []) as Document[]).map(o=>o.uuid));
  const risks=new Set(((poamBody.risks ?? []) as Document[]).map(r=>r.uuid));
  for (const record of [...((poamBody["poam-items"] ?? []) as Document[]), ...((poamBody.risks ?? []) as Document[])]) {
    for (const related of (record["related-observations"] ?? []) as Document[]) if (!observations.has(related["observation-uuid"])) errors.push("POA&M observation reference must resolve.");
    for (const related of (record["related-risks"] ?? []) as Document[]) if (!risks.has(related["risk-uuid"])) errors.push("POA&M risk reference must resolve.");
  }
  try {
    const body = documents.assessmentResults["assessment-results"] as Document;
    const ap = resolveContextDocument(body, (body["import-ap"] as Document).href as string, "assessment-plan");
    const attached = resolveContextDocument(ap["assessment-plan"], ap["assessment-plan"]["import-ssp"].href, "system-security-plan");
    if (JSON.stringify(attached) !== JSON.stringify(documents.ssp)) errors.push("Assessment results must reference the downloaded SSP content.");
    const system = ((documents.ssp["system-security-plan"] as Document)["system-characteristics"] as Document)["system-ids"] as Document[];
    if (JSON.stringify(system[0]) !== JSON.stringify((documents.poam["plan-of-action-and-milestones"] as Document)["system-id"])) errors.push("POA&M and SSP system identities must match.");
  } catch { errors.push("Missing shared binder context."); }
  return errors;
}
