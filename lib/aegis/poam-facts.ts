import { closureProblems, isDate, planScope, remainingScope, safeReferenceUrl, type RemediationPlan } from "./remediation";

export type PlanMilestoneFact = {
  description: string;
  target: string;
  revised: string;
  reason: string;
  status: RemediationPlan["milestones"][number]["status"];
};

export type PlanRetestFact = {
  description: string;
  evidence: string;
  href: string | null;
  result: string;
  date: string;
  reviewer: string;
  illustrative: boolean;
  artifactSha256?: string;
  verdict?: "pass" | "fail";
};

export type CorrectiveReleaseFact = {
  identity: string;
  href: string | null;
};

/** Plain-language reading of one saved draft. The OSCAL file is built from the same facts. */
export type PlanOfActionFacts = {
  weakness: string;
  finding: string;
  observation: string;
  methods: ("EXAMINE" | "INTERVIEW" | "TEST" | "UNKNOWN")[];
  riskDescription: string;
  riskStatement: string;
  action: string;
  correctiveRelease: CorrectiveReleaseFact;
  controls: string[];
  owner: string;
  milestones: PlanMilestoneFact[];
  retests: PlanRetestFact[];
  stillOpen: string[];
  closureRecorded: boolean;
  officialPoamId: string;
  repository: string;
};

function trimmed(value: string): string {
  return value.trim();
}

const RISK_STATUS_WORD = /^(open|closed|investigating|remediating|deviation-requested|deviation-approved)$/i;
const STOCK_ASSESSMENT_NOTE = /^Illustrative reviewer decision against the stated requirement\b/;

function sentence(value: string): string {
  const body = trimmed(value);
  if (!body) return "";
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

function pipelineIdFromUrl(value: string): string {
  return safeReferenceUrl(value)?.match(/\/-\/pipelines\/(\d+)(?:[/?#]|$)/)?.[1] ?? "";
}

/** Only a recorded URL establishes a release link; prose and ticket numbers do not. */
function correctiveRelease(plan: RemediationPlan): CorrectiveReleaseFact {
  const sourceHref = safeReferenceUrl(plan.source?.pipelineUrl ?? "");
  const recordedHref = safeReferenceUrl(plan.releaseUrl);
  if (recordedHref && recordedHref !== sourceHref) {
    return { identity: pipelineIdFromUrl(recordedHref) || trimmed(plan.releaseRef) || recordedHref, href: recordedHref };
  }
  return { identity: trimmed(plan.releaseRef), href: null };
}

/** A reference or a planned check alone is not a performed test. Missing links remain explicit. */
export function hasRecordedTestResult(test: Pick<PlanRetestFact, "result" | "date" | "reviewer">): boolean {
  return Boolean(trimmed(test.result) && isDate(test.date) && trimmed(test.reviewer));
}

function observationMethods(plan: RemediationPlan, finding: string): PlanOfActionFacts["methods"] {
  const methods: PlanOfActionFacts["methods"] = [];
  if (finding || (plan.source?.artifacts?.length ?? 0) > 0) methods.push("EXAMINE");
  if (plan.tests.some(hasRecordedTestResult)) methods.push("TEST");
  return methods.length ? methods : ["UNKNOWN"];
}

/** A status word stays on the risk status. It is not a risk statement. */
function riskProse(plan: RemediationPlan, finding: string, title: string): { description: string; statement: string } {
  const recorded = trimmed(plan.risk);
  if (recorded && !RISK_STATUS_WORD.test(recorded)) return { description: recorded, statement: recorded };
  const requirement = trimmed(plan.assessment?.requirement ?? "");
  const asset = trimmed(plan.asset);
  const parts = [sentence(finding || title)];
  if (asset) parts.push(`Affected asset: ${asset}.`);
  if (requirement) parts.push(`Stated requirement: ${sentence(requirement)}`);
  parts.push("No separate risk rationale is recorded. Agency risk acceptance is not recorded.");
  const statement = parts.filter(Boolean).join(" ");
  return { description: statement, statement };
}

/** Read the draft the app already has. Does not add review items, findings, or agency identifiers. */
export function planOfActionFacts(plan: RemediationPlan): PlanOfActionFacts {
  let controls: string[] = [];
  let outside = "";
  try {
    controls = planScope(plan).controls;
    outside = remainingScope(plan);
  } catch {
    if (trimmed(plan.control)) controls = [trimmed(plan.control)];
  }
  const milestones = plan.milestones.map((milestone) => ({
    description: milestone.description,
    target: milestone.target,
    revised: milestone.revised,
    reason: milestone.reason,
    status: milestone.status,
  }));
  const retests = plan.tests.map((test) => ({
    description: test.description,
    evidence: test.evidence,
    href: safeReferenceUrl(test.evidence),
    result: test.result,
    date: test.date,
    reviewer: test.reviewer,
    illustrative: test.illustrative,
    artifactSha256: test.artifactSha256,
    verdict: test.verdict,
  }));
  const stillOpen: string[] = [];
  for (const milestone of milestones) {
    if (milestone.status !== "Done") {
      stillOpen.push(`Milestone still open: ${trimmed(milestone.description) || "Untitled milestone"}.`);
    }
  }
  for (const test of retests) {
    if (!hasRecordedTestResult(test)) stillOpen.push(`Retest result not recorded with reviewer and date: ${trimmed(test.description) || "Untitled retest"}.`);
    if (!trimmed(test.evidence)) stillOpen.push(`Retest evidence not linked: ${trimmed(test.description) || "Untitled retest"}.`);
  }
  if (!(plan.validationRecorded && plan.validation === "demonstrated")) {
    stillOpen.push("ISSE verification is not recorded as demonstrated.");
  }
  const closureRecorded = plan.readyForReview === true && plan.closure.recorded === true && closureProblems(plan).length === 0;
  if (plan.closure.recorded && !closureRecorded) stillOpen.push("Recorded closure is incomplete; the risk remains open.");
  if (!plan.readyForReview) stillOpen.push("Not marked ready for closure review.");
  else if (!plan.closure.recorded) stillOpen.push("Ready for closure review. No closure decision is recorded.");
  if (!trimmed(plan.officialId)) stillOpen.push("Official POA&M ID is not recorded.");
  stillOpen.push("Agency system identifier is not recorded.");
  if (outside) stillOpen.push(outside.endsWith(".") ? `Outside this item: ${outside}` : `Outside this item: ${outside}.`);
  const weakness = trimmed(plan.weakness);
  const finding = trimmed(plan.source?.reviewItem ?? "");
  const note = trimmed(plan.assessment?.note ?? "");
  const observation = finding || (STOCK_ASSESSMENT_NOTE.test(note) ? "" : note) || weakness;
  const risk = riskProse(plan, finding, weakness);
  return {
    weakness,
    finding,
    observation,
    methods: observationMethods(plan, finding),
    riskDescription: risk.description,
    riskStatement: risk.statement,
    action: trimmed(plan.action),
    correctiveRelease: correctiveRelease(plan),
    controls,
    owner: trimmed(plan.owner),
    milestones,
    retests,
    stillOpen,
    closureRecorded,
    officialPoamId: trimmed(plan.officialId),
    repository: trimmed(plan.repository),
  };
}
