import { artifactFilename, gitlabArtifactUrl, pipelineArtifactNames, type PipelineEvidence } from "./pipeline-evidence";
import { NETWORK_POLICY_EXAMPLE_SCOPE, parseReviewScope, scopeProblems, type ReviewScope } from "./review-context";
import { parsePipelineVerification } from "./pipeline-verification";

/** Internal planning records, NOT official agency records or schema-validated OSCAL. */
export type Assessment = {
  disposition: "needs-verification" | "confirmed" | "no-deficiency";
  note: string; requirement: string; reference: string; reviewer: string; date: string;
  illustrative: boolean;
  scope?: ReviewScope;
};
export type Milestone = { id: string; description: string; target: string; revised: string; reason: string; status: "Not started" | "In progress" | "Delayed" | "Done" };
export type Retest = { id: string; description: string; evidence: string; result: string; reviewer: string; date: string; illustrative: boolean; artifactSha256?: string; verdict?: "pass" | "fail" };
export type RemediationPlan = {
  schema: "binder.remediation-draft.v1"; id: string; createdAt: string;
  source: { pipelineId: string; pipelineUrl: string; commit: string; releaseSha256?: string; reviewItem: string; artifacts: { name: string; href: string }[] };
  assessment: Assessment; weakness: string; asset: string; control: string;
  owner: string; risk: string; resources: string; action: string; protection: string;
  milestones: Milestone[]; repository: string; officialId: string; ticket: string;
  releaseRef: string; releaseUrl: string; releaseIllustrative: boolean; engineeringComplete: boolean;
  releaseReviewMode?: "vendor-test" | "independent-review";
  receivedVerification?: { pipelineUrl: string; commit: string; releaseSha256: string };
  tests: Retest[]; validation: "undetermined" | "demonstrated" | "not-demonstrated";
  validationNote: string; validator: string; validationDate: string; validationRecorded: boolean;
  readyForReview: boolean; protectionDisposition: string; riskDecision: string;
  closure: { reference: string; approver: string; date: string; officialId: string; recorded: boolean };
  history: { at: string; action: string }[];
};
export const emptyAssessment = (): Assessment => ({ disposition: "needs-verification", note: "", requirement: "", reference: "", reviewer: "", date: "", illustrative: false });
/** Reopen the latest saved record, not an older empty draft for the same item. */
export function latestReviewPlan(plans: RemediationPlan[], record: PipelineEvidence, reviewItem: string): RemediationPlan | undefined {
  const lastActivity = (p: RemediationPlan) => p.history.reduce((last, entry) => entry.at > last ? entry.at : last, p.createdAt);
  return plans.filter(p => p.source.reviewItem === reviewItem && p.source.pipelineUrl === record.pipelineUrl && p.source.commit === record.commitSha && (!p.source.releaseSha256 || p.source.releaseSha256 === record.releaseSha256))
    .sort((a,b) => lastActivity(b).localeCompare(lastActivity(a)) || b.createdAt.localeCompare(a.createdAt))[0];
}
export function isDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
const filled = (value: string) => !!value.trim();
export function reviewDescriptions(record: PipelineEvidence): string[] { return [...(record.reviewItems??[]).map(item=>item.description),...record.gaps]; }
export function planScope(p: RemediationPlan): ReviewScope { if(!p.assessment.scope) throw new Error("Assessment scope is missing."); return p.assessment.scope; }
export function remainingScope(p: RemediationPlan): string { return planScope(p).remainingScope.join(" · ") || "Other review items are outside this assessment"; }
export function assessmentProblems(a: Assessment): string[] {
  if (a.disposition === "needs-verification") return [];
  return [...scopeProblems(a.scope), !filled(a.requirement) && "State the applicable requirement.", !filled(a.note) && "Add the assessment rationale.", !filled(a.reference) && "Add a supporting assessment reference.", !filled(a.reviewer) && "Enter the reviewer.", !isDate(a.date) && "Enter a valid assessment date."].filter(Boolean) as string[];
}
export function confirmed(a: Assessment): boolean { return a.disposition === "confirmed" && assessmentProblems(a).length === 0; }
export function restoreAssessment(value: unknown): Assessment | null {
  if(!value || typeof value!=="object") return null;
  const a=structuredClone(value) as Assessment;
  if(!["needs-verification","confirmed","no-deficiency"].includes(a.disposition) || typeof a.illustrative!=="boolean" || [a.note,a.requirement,a.reference,a.reviewer,a.date].some(s=>typeof s!=="string" || s.length>12000)) return null;
  try {if(a.scope) a.scope=parseReviewScope(a.scope);} catch {return null;}
  return assessmentProblems(a).length ? null : a;
}
function scopedTestsMatch(p: RemediationPlan): boolean {const required=planScope(p).verification;return p.tests.length===required.length && p.tests.every((t,i)=>t.description===required[i]);}
export function newPlan(record: PipelineEvidence, reviewItem: string, assessment: Assessment, id: string, now: string): RemediationPlan {
  if (!confirmed(assessment)) throw new Error("A complete, confirmed assessment is required before preparing a draft.");
  const scope=parseReviewScope(assessment.scope);
  if(!reviewDescriptions(record).includes(reviewItem) || scope.artifacts.some(name=>!pipelineArtifactNames(record).includes(name) || !gitlabArtifactUrl(record,name))) throw new Error("Assessment source does not belong to this release.");
  return {
    schema: "binder.remediation-draft.v1", id, createdAt: now,
    source: { pipelineId: record.pipelineId, pipelineUrl: record.pipelineUrl, commit: record.commitSha, releaseSha256: record.releaseSha256, reviewItem, artifacts: scope.artifacts.map((name) => ({ name:artifactFilename(name), href: gitlabArtifactUrl(record, name)! })) },
    assessment: structuredClone(assessment), weakness: scope.title, asset: scope.asset, control: scope.controls[0],
    owner: "", risk: "", resources: "", action: "", protection: "", milestones: [], repository: "", officialId: "", ticket: "",
    releaseRef: "", releaseUrl: "", releaseIllustrative: false, engineeringComplete: false,
    tests: scope.verification.map((description, i) => ({ id: `test-${i + 1}`, description, evidence: "", result: "", reviewer: "", date: "", illustrative: false })),
    validation: "undetermined", validationNote: "", validator: "", validationDate: "", validationRecorded: false,
    readyForReview: false, protectionDisposition: "", riskDecision: "", closure: { reference: "", approver: "", date: "", officialId: "", recorded: false },
    history: [{ at: now, action: "Internal draft prepared from the saved scoped assessment; other review items remain unresolved." }],
  };
}
export function milestoneProblems(p: RemediationPlan): string[] {
  const result: string[] = [];
  for (const m of p.milestones) {
    if (!filled(m.description) || !isDate(m.target)) result.push("Every milestone needs a description and target date.");
    if (m.revised && (!isDate(m.revised) || m.revised < m.target)) result.push("A revised milestone date must be valid and not earlier than its target.");
    if ((m.status === "Delayed" || m.revised) && (!isDate(m.revised) || !filled(m.reason))) result.push("A delayed or revised milestone needs a revised date and justification.");
  }
  return [...new Set(result)];
}
export function engineeringProblems(p: RemediationPlan): string[] {
  return [...milestoneProblems(p), !filled(p.weakness) && "Describe the weakness.", !filled(p.asset) && "Identify the affected asset.", !filled(p.owner) && "Assign a responsible owner.", !filled(p.action) && "Describe the corrective action.", !filled(p.risk) && "Document the risk rationale.", !filled(p.resources) && "Identify required resources.", (!p.milestones.length || p.milestones.some((m) => m.status !== "Done")) && "Complete all milestones.", !filled(p.releaseRef) && "Link the remediation release reference."].filter(Boolean) as string[];
}
export function validationProblems(p: RemediationPlan): string[] {
  const result = [p.validation === "undetermined" && "Choose a validation outcome.", !filled(p.validationNote) && "Add the verification rationale.", !filled(p.validator) && "Enter the ISSE reviewer.", !isDate(p.validationDate) && "Enter a valid verification date."].filter(Boolean) as string[];
  if (p.validation === "demonstrated") {
    if (p.tests.some(t => t.verdict === "fail")) result.push("A required measured test failed; positive validation is not available.");
    result.push(...engineeringProblems(p));
    if (!p.engineeringComplete) result.push("Record engineering completion first.");
    if (!scopedTestsMatch(p)) result.push("Retest definitions must match the assessment's required verification scope.");
    if (!p.tests.length || p.tests.some((t) => !filled(t.evidence) || !filled(t.result) || !filled(t.reviewer) || !isDate(t.date))) result.push("Every required test needs evidence, result, reviewer and date.");
  }
  return [...new Set(result)];
}
export function readinessProblems(p: RemediationPlan): string[] {
  return [...engineeringProblems(p), !p.engineeringComplete && "Engineering completion is not recorded.", (!p.validationRecorded || p.validation !== "demonstrated" || validationProblems(p).length > 0) && "Record positive ISSE validation with complete retest evidence."].filter(Boolean) as string[];
}
export function closureProblems(p: RemediationPlan): string[] {
  return [...readinessProblems(p), !p.readyForReview && "Mark the internal package ready for closure review.", !filled(p.repository) && "Identify the agency-designated repository.", !filled(p.officialId) && "Link the official POA&M ID.", !filled(p.protectionDisposition) && "Record the interim protection disposition.", !filled(p.closure.reference) && "Enter the external approval reference.", !filled(p.closure.approver) && "Enter the external approver.", !isDate(p.closure.date) && "Enter the decision date.", (!filled(p.closure.officialId) || p.closure.officialId !== p.officialId) && "The decision must reference the linked official POA&M ID."].filter(Boolean) as string[];
}
/** Changes to underlying data invalidate decisions; changing persona does not. */
export function revisePlan(p: RemediationPlan, patch: Partial<RemediationPlan>): RemediationPlan {
  const next = { ...p, ...patch };
  const engineeringFields = ["weakness", "asset", "control", "assessment", "owner", "risk", "resources", "action", "protection", "milestones", "releaseRef", "releaseUrl", "releaseIllustrative", "releaseReviewMode"];
  const verificationFields = ["tests", "validation", "validationNote", "validator", "validationDate"];
  const changed = (fields: string[]) => fields.some((key) => key in patch && JSON.stringify(p[key as keyof RemediationPlan]) !== JSON.stringify(patch[key as keyof RemediationPlan]));
  if (changed(engineeringFields)) { next.engineeringComplete = false; next.validationRecorded = false; }
  if (changed(verificationFields)) next.validationRecorded = false;
  if (changed(["tests"]) && !("receivedVerification" in patch)) next.receivedVerification = undefined;
  if (changed([...engineeringFields, ...verificationFields, "repository", "officialId", "protectionDisposition", "closure"])) {
    next.readyForReview = false; next.closure = { ...next.closure, recorded: false };
  }
  return next;
}
export function addHistory(p: RemediationPlan, action: string, now: string): RemediationPlan {
  return { ...p, history: [...p.history, { at: now, action }].slice(-200) };
}
/** Append a gate fact. Closure, readiness, validation, and risk acceptance stay on their existing rules. */
export function noteGateEvent(p: RemediationPlan, action: string, now: string): RemediationPlan {
  const next = addHistory(p, action, now);
  if (next.riskDecision !== p.riskDecision || next.readyForReview !== p.readyForReview || next.validationRecorded !== p.validationRecorded || next.engineeringComplete !== p.engineeringComplete || JSON.stringify(next.closure) !== JSON.stringify(p.closure)) {
    throw new Error("A gate note cannot change closure, readiness, validation, or risk acceptance.");
  }
  return next;
}
/** Reopen internal decisions without rewriting performed work or pipeline evidence. */
export function resetReviewDecisions(p: RemediationPlan, now: string): RemediationPlan {
  if (p.closure.recorded) throw new Error("An external decision is recorded. Review it through the designated process instead of resetting it.");
  return addHistory({ ...p, engineeringComplete: false, validation: "undetermined", validationRecorded: false, readyForReview: false }, "Internal review decisions reset; recorded work and evidence preserved.", now);
}
/** Same-scope assessment edits update the current open draft and invalidate prior decisions. */
export function updatePlanAssessment(p: RemediationPlan, assessment: Assessment, now: string): RemediationPlan {
  if (p.closure.recorded || !confirmed(assessment) || JSON.stringify(p.assessment.scope) !== JSON.stringify(assessment.scope) || JSON.stringify(p.assessment) === JSON.stringify(assessment)) return p;
  return addHistory(revisePlan(p, { assessment: structuredClone(assessment) }), "Saved assessment updated; internal review decisions require review again.", now);
}
export function illustrativeAssessment(): Assessment {
  return { disposition: "confirmed", requirement: "Illustrative system requirement: default-deny podinfo traffic and explicitly allow the gateway path.", note: "Synthetic platform assessment confirms no NetworkPolicy is applied in the example namespace. This is not a conclusion from the recorded pipeline.", reference: "ILLUSTRATIVE-ASM-0003", reviewer: "Example ISSE (synthetic)", date: "2026-10-02", illustrative: true, scope:structuredClone(NETWORK_POLICY_EXAMPLE_SCOPE) };
}
export function illustrativeScopedAssessment(scope: ReviewScope): Assessment {
  if(scopeProblems(scope).length) throw new Error("Define the scope before loading illustrative reviewer fields.");
  return {disposition:"confirmed",requirement:scope.baseline,note:"The recorded observation is assessed against the selected requirement. Review is scoped to that criterion; agency applicability is not determined.",reference:"INTERNAL-ASSESSMENT",reviewer:"Internal assessment reviewer",date:new Date().toISOString().slice(0,10),illustrative:true,scope:parseReviewScope(scope)};
}
export function illustrativeProgress(p: RemediationPlan, includeRetest = false): RemediationPlan {
  if (!p.assessment.illustrative || p.control!=="SC-7") throw new Error("This illustrative template is only for the network-policy example.");
  let next = revisePlan(p, {
    weakness: "Network-policy enforcement not applied", owner: "Example platform engineer (synthetic)", risk: "Unrestricted namespace traffic would exceed the illustrative gateway-only requirement.", resources: "Platform engineer, staging namespace and ISSE test support.",
    action: "Apply a default-deny NetworkPolicy to the podinfo namespace; allow only gateway and required service traffic.", protection: "Illustrative ingress restriction to the managed gateway pending the corrective change.",
    ticket: "ILLUSTRATIVE-PLAT-412", milestones: [
      { id: "m-1", description: "Define NetworkPolicy for the podinfo namespace", target: "2026-10-09", revised: "", reason: "", status: "Done" },
      { id: "m-2", description: "Apply in staging", target: "2026-10-16", revised: "2026-10-23", reason: "Gateway allow-list depends on a platform change", status: includeRetest ? "Done" : "Delayed" },
      { id: "m-3", description: "Apply in the remediation release", target: "2026-10-30", revised: "", reason: "", status: includeRetest ? "Done" : "Not started" },
      { id: "m-4", description: "Retest and hand off to ISSE", target: "2026-11-04", revised: "", reason: "", status: includeRetest ? "Done" : "Not started" },
    ],
    releaseRef: includeRetest ? "ILLUSTRATIVE-RETEST-0003" : "", releaseUrl: "", releaseIllustrative: includeRetest,
    tests: p.tests.map((t, i) => ({ ...t, evidence: includeRetest ? ["ILLUSTRATIVE networkpolicy.json", "ILLUSTRATIVE denied-traffic.log", "ILLUSTRATIVE gateway-path.log"][i] : "", result: includeRetest ? ["Default-deny and explicit allow policies applied", "Cross-namespace probe denied", "Gateway path succeeds; other ingress paths denied"][i] : "", reviewer: includeRetest ? "Example ISSE (synthetic)" : "", date: includeRetest ? "2026-11-04" : "", illustrative: includeRetest })),
    validation: "undetermined", validationNote: includeRetest ? "Illustrative retest addresses only the network-policy corrective action. External ingress and mTLS are not assessed here." : "", validator: includeRetest ? "Example ISSE (synthetic)" : "", validationDate: includeRetest ? "2026-11-04" : "",
  });
  next.engineeringComplete = includeRetest;
  return next;
}
export function exportDraft(p: RemediationPlan) {
  return { ...p, limitations: { purpose: "Internal planning draft JSON. The separate plan of action and assessment results downloads are the OSCAL files. This JSON file is not an official agency record.", persistence: "Saved with this browser session in the durable store. This download is a JSON copy of the internal draft.", integration: "Received pipeline evidence can be linked to this draft; agency repository and ticket references remain manual. No agency submission or synchronization.", authorization: "No ATO, risk acceptance or Government approval is granted by this application.", remainingScope: remainingScope(p), illustrative: p.assessment.illustrative } };
}
export function safeReferenceUrl(value: string): string | null {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; }
}
/** Parse a bounded internal draft and recompute its decision gates on both server and client.
 * This validates a record, not the truth or independent approval of its supplied references.
 */
export function normalizeStoredPlan(value: unknown): RemediationPlan | null {
  if (!value || typeof value !== "object") return null;
  const p = structuredClone(value) as RemediationPlan;
  // Backward-compatible migration of the original explicit SC-7 example only.
  if (p.assessment && !p.assessment.scope && p.control==="SC-7" && p.source?.reviewItem && /network.policy/i.test(p.source.reviewItem)) p.assessment.scope=structuredClone(NETWORK_POLICY_EXAMPLE_SCOPE);
  try { if(p.assessment?.scope) p.assessment.scope=parseReviewScope(p.assessment.scope); } catch { return null; }
  const strings = ["id", "createdAt", "weakness", "asset", "owner", "risk", "resources", "action", "protection", "repository", "officialId", "ticket", "releaseRef", "releaseUrl", "validationNote", "validator", "validationDate", "protectionDisposition", "riskDecision"] as const;
  const aStrings = ["note", "requirement", "reference", "reviewer", "date"] as const;
  if (p.schema !== "binder.remediation-draft.v1" || typeof p.control!=="string" || !p.assessment?.scope?.controls.includes(p.control) || strings.some((k) => typeof p[k] !== "string" || p[k].length > 12000) || !p.assessment || aStrings.some((k) => typeof p.assessment[k] !== "string") || !confirmed(p.assessment)) return null;
  if (!p.source || [p.source.pipelineId,p.source.pipelineUrl,p.source.commit,p.source.reviewItem].some(s => typeof s !== "string" || s.length > 12000) || !safeReferenceUrl(p.source.pipelineUrl)) return null;
  if (p.source.releaseSha256 != null && !/^[a-f0-9]{64}$/.test(p.source.releaseSha256)) return null;
  if (!Array.isArray(p.source.artifacts) || p.source.artifacts.length!==p.assessment.scope.artifacts.length || p.source.artifacts.some((a,i) => !a || a.name!==p.assessment.scope!.artifacts[i] || typeof a.href!=="string" || a.href.length>12000 || !safeReferenceUrl(a.href))) return null;
  if (!Array.isArray(p.milestones) || p.milestones.length > 50 || p.milestones.some((m) => !m || [m.id, m.description, m.target, m.revised, m.reason].some((s) => typeof s !== "string" || s.length>12000) || !["Not started", "In progress", "Delayed", "Done"].includes(m.status))) return null;
  if (!Array.isArray(p.tests) || !p.tests.length || p.tests.length>30 || p.tests.some((t) => !t || [t.id, t.description, t.evidence, t.result, t.reviewer, t.date].some((s) => typeof s !== "string" || s.length>12000) || typeof t.illustrative !== "boolean") || new Set(p.tests.map(t=>t.id)).size!==p.tests.length) return null;
  if (p.tests.some(t => (t.verdict != null && !["pass", "fail"].includes(t.verdict)) || (t.artifactSha256 != null && !/^[a-f0-9]{64}$/.test(t.artifactSha256)))) return null;
  if (p.receivedVerification && (p.receivedVerification.pipelineUrl !== p.releaseUrl || !safeReferenceUrl(p.receivedVerification.pipelineUrl) || !/^[a-f0-9]{40,64}$/.test(p.receivedVerification.commit) || !/^[a-f0-9]{64}$/.test(p.receivedVerification.releaseSha256))) return null;
  if(!scopedTestsMatch(p)) return null;
  if (!p.closure || [p.closure.reference, p.closure.approver, p.closure.date, p.closure.officialId].some((s) => typeof s !== "string" || s.length>12000) || !Array.isArray(p.history) || p.history.length > 200 || p.history.some((h) => !h || typeof h.at !== "string" || typeof h.action !== "string" || h.action.length>12000)) return null;
  if (![p.assessment.illustrative, p.releaseIllustrative, p.engineeringComplete, p.validationRecorded, p.readyForReview, p.closure.recorded].every((b) => typeof b === "boolean") || !["undetermined", "demonstrated", "not-demonstrated"].includes(p.validation)) return null;
  if(p.releaseReviewMode!=null && !["vendor-test","independent-review"].includes(p.releaseReviewMode)) return null;
  // Stored flags are not trusted blindly. Recompute dependency gates when reopening.
  if (engineeringProblems(p).length) p.engineeringComplete = false;
  if (validationProblems(p).length) p.validationRecorded = false;
  if (readinessProblems(p).length) p.readyForReview = false;
  if (closureProblems(p).length) p.closure.recorded = false;
  return p;
}

/** Reject drafts from another release when reopening in a release workspace. */
export function restorePlan(value: unknown, record: PipelineEvidence): RemediationPlan | null {
  const p = normalizeStoredPlan(value);
  if (!p || p.source.pipelineUrl !== record.pipelineUrl || p.source.commit !== record.commitSha || p.source.pipelineId !== record.pipelineId || !reviewDescriptions(record).includes(p.source.reviewItem)) return null;
  if (p.source.releaseSha256 && p.source.releaseSha256 !== record.releaseSha256) return null;
  if (p.source.artifacts.some(a => !pipelineArtifactNames(record).includes(a.name) || a.href!==gitlabArtifactUrl(record,a.name))) return null;
  return p;
}

/** Apply only a received release bound to the original subject and exact scoped tests. */
export function applyReceivedVerification(p: RemediationPlan, original: PipelineEvidence, corrective: PipelineEvidence): RemediationPlan {
  if (corrective.source !== "Inbound pipeline event" || original.pipelineUrl !== p.source.pipelineUrl || original.commitSha !== p.source.commit) throw new Error("Use a received correction for this source release.");
  const v = parsePipelineVerification(corrective.verification, corrective);
  if (v.sourcePipelineUrl !== original.pipelineUrl || v.sourceCommit !== original.commitSha || v.sourceReleaseSha256 !== original.releaseSha256 || (p.source.releaseSha256 && p.source.releaseSha256 !== v.sourceReleaseSha256)) throw new Error("Correction does not bind to the original release hash.");
  if (v.tests.length !== p.tests.length || p.tests.some(t => !v.tests.some(result => result.description === t.description))) throw new Error("Measured tests do not match the assessment scope.");
  const tests = p.tests.map(t => {
    const measured = v.tests.find(result => result.description === t.description)!;
    const evidence = gitlabArtifactUrl(corrective, measured.artifact);
    if (!evidence) throw new Error("No supported artifact source for this correction.");
    return { ...t, evidence, result: measured.result, date: measured.date, reviewer: `Pipeline evidence collector · job #${corrective.artifactJobId}`, illustrative: false, artifactSha256: measured.artifactSha256, verdict: measured.verdict };
  });
  const next = revisePlan(p, { ...(v.engineering ?? {}), tests, releaseRef: `#${corrective.pipelineId} · ${corrective.commitSha.slice(0, 12)}`, releaseUrl: corrective.pipelineUrl, releaseIllustrative: false, releaseReviewMode: corrective.approval?.mode, receivedVerification: { pipelineUrl: corrective.pipelineUrl, commit: corrective.commitSha, releaseSha256: corrective.releaseSha256 } });
  if (milestoneProblems(next).length) throw new Error("Invalid engineering milestone notes.");
  return addHistory(next, "Measured evidence applied from a received pipeline event. Engineering completion, ISSE validation and external closure remain separate decisions.", new Date().toISOString());
}

/**
 * Draft plan for a continuous-monitoring regression.
 * The assessment stays needs-verification. Nothing in this record is accepted,
 * validated, or closed.
 */
export function prepareRegressionDraft(input: {
  id: string; now: string; control: string; finding: string; title: string; asset: string;
  framework: string; baseline: string; pipelineId: string; pipelineUrl: string; commit: string;
  artifacts: { name: string; href: string }[]; verification: string[]; historyAction: string;
}): RemediationPlan {
  if (!input.id.trim() || !input.control.trim() || !input.finding.trim() || !input.historyAction.trim()) throw new Error("A regression draft needs a control and finding.");
  if (!safeReferenceUrl(input.pipelineUrl) || !/^[a-f0-9]{40,64}$/.test(input.commit)) throw new Error("Invalid regression source.");
  if (!input.artifacts.length || input.artifacts.some(a => !a.name.trim() || !safeReferenceUrl(a.href))) throw new Error("Invalid regression source.");
  const verification = input.verification.map(item => item.trim()).filter(Boolean);
  if (!verification.length) throw new Error("A regression draft needs a verification statement.");
  const scope = parseReviewScope({
    title: input.title, asset: input.asset, controls: [input.control], framework: input.framework, baseline: input.baseline,
    artifacts: input.artifacts.map(a => a.name), verification, remainingScope: [],
  });
  const plan: RemediationPlan = {
    schema: "binder.remediation-draft.v1", id: input.id, createdAt: input.now,
    source: { pipelineId: input.pipelineId, pipelineUrl: input.pipelineUrl, commit: input.commit, reviewItem: input.finding, artifacts: input.artifacts.map(a => ({ name: a.name, href: a.href })) },
    assessment: { disposition: "needs-verification", note: "", requirement: "", reference: "", reviewer: "", date: "", illustrative: false, scope },
    weakness: input.title, asset: input.asset, control: input.control,
    owner: "", risk: "", resources: "", action: "", protection: "", milestones: [], repository: "", officialId: "", ticket: "",
    releaseRef: "", releaseUrl: "", releaseIllustrative: false, engineeringComplete: false,
    tests: verification.map((description, i) => ({ id: `test-${i + 1}`, description, evidence: "", result: "", reviewer: "", date: "", illustrative: false })),
    validation: "undetermined", validationNote: "", validator: "", validationDate: "", validationRecorded: false,
    readyForReview: false, protectionDisposition: "", riskDecision: "",
    closure: { reference: "", approver: "", date: "", officialId: "", recorded: false },
    history: [{ at: input.now, action: input.historyAction }],
  };
  if (plan.readyForReview || plan.closure.recorded || plan.engineeringComplete || plan.validationRecorded || plan.assessment.disposition !== "needs-verification" || confirmed(plan.assessment)) {
    throw new Error("Regression drafts stay unaccepted.");
  }
  return plan;
}

/** Imported engineering evidence never records security validation or agency approval. */
export function applyRetestPacket(p: RemediationPlan, value: unknown): RemediationPlan {
  if(!value || typeof value!=="object") throw new Error("Invalid retest packet.");
  const v=value as Record<string,unknown>;
  if(v.schema!=="binder.retest-evidence.v1" || v.sourcePipelineUrl!==p.source.pipelineUrl || v.sourceCommit!==p.source.commit) throw new Error("Retest packet does not match the original release.");
  const release=v.remediation as Record<string,unknown>;
  if(!release || typeof release.pipelineId!=="string" || !/^\d{1,30}$/.test(release.pipelineId) || typeof release.url!=="string" || release.url.length>500 || !safeReferenceUrl(release.url) || release.url===p.source.pipelineUrl || typeof release.commit!=="string" || !/^[a-f0-9]{40,64}$/.test(release.commit) || release.commit===p.source.commit) throw new Error("Link a distinct remediation release and source commit.");
  if(release.reviewMode!=null && !["vendor-test","independent-review"].includes(String(release.reviewMode))) throw new Error("Invalid remediation review mode.");
  const fields=["owner","action","risk","resources","protection"] as const;
  if(fields.some(key=>typeof v[key]!=="string" || (v[key] as string).length>12000)) throw new Error("Invalid engineering fields.");
  if(!Array.isArray(v.tests) || v.tests.length!==p.tests.length) throw new Error("Retest must address every scoped verification test.");
  const importedTests=v.tests;
  const tests=p.tests.map((test,i)=>{
    const t=importedTests[i] as Record<string,unknown>;
    if(!t || t.description!==test.description || ["evidence","result","reviewer","date"].some(key=>typeof t[key]!=="string" || !(t[key] as string).trim() || (t[key] as string).length>12000) || !safeReferenceUrl(t.evidence as string) || !isDate(t.date as string) || t.illustrative!==false) throw new Error("Invalid or mismatched retest evidence.");
    return {...test,evidence:t.evidence as string,result:t.result as string,reviewer:t.reviewer as string,date:t.date as string,illustrative:false};
  });
  if(!Array.isArray(v.milestones) || !v.milestones.length || v.milestones.length>50) throw new Error("Invalid corrective milestones.");
  const milestones=v.milestones as Milestone[];
  if(milestones.some(m=>!m || [m.id,m.description,m.target,m.revised,m.reason].some(s=>typeof s!=="string") || !["Not started","In progress","Delayed","Done"].includes(m.status))) throw new Error("Invalid corrective milestones.");
  const next=revisePlan(p,{owner:v.owner as string,action:v.action as string,risk:v.risk as string,resources:v.resources as string,protection:v.protection as string,milestones:structuredClone(milestones),releaseRef:`#${release.pipelineId} · ${(release.commit as string).slice(0,12)}`,releaseUrl:release.url,releaseIllustrative:false,releaseReviewMode:release.reviewMode as RemediationPlan["releaseReviewMode"],tests});
  if(milestoneProblems(next).length) throw new Error("Invalid milestone dates or justification.");
  return addHistory(next,"Engineering retest packet imported locally; source signatures are not verified by this viewer. Completion and ISSE validation require separate review.",new Date().toISOString());
}
