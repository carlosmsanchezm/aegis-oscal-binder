import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { humanPrincipal, agentPrincipal } from "../lib/account/principal";
import { roleLimit } from "../lib/account/copy";
import { roleLabel } from "../lib/account/text";
import { canWriteBoundary, isRole, ROLES } from "../lib/account/types";
import { AegisError } from "../lib/aegis/errors";
import { dataDir, findRepoRoot } from "../lib/aegis/paths";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { buildPlanOfAction, validatePlanOfAction } from "../lib/aegis/poam";
import { applyRetestPacket, closureProblems, illustrativeScopedAssessment, newPlan, noteGateEvent, type RemediationPlan } from "../lib/aegis/remediation";
import { executeAgentRun, reserveAgentRun } from "../lib/aegis/gates/agent-run";
import { verifyChain } from "../lib/aegis/gates/audit";
import { classifyChange } from "../lib/aegis/gates/classify";
import { GATE_COPY } from "../lib/aegis/gates/copy";
import { openCase, reduceCase, type ActOptions } from "../lib/aegis/gates/engine";
import { previewGate, previewWorkflow } from "../lib/aegis/gates/machine";
import { GATE_MATRIX } from "../lib/aegis/gates/matrix";
import { defaultMfaChecker, type MfaProof } from "../lib/aegis/gates/mfa";
import { closureAlreadyRecorded, poamLinksFromCase, readyForClosureReview } from "../lib/aegis/gates/plan-link";
import { commitDecision, gateAuditKey, readGateAudit, readGateCase, saveAgentRun } from "../lib/aegis/gates/store";
import { HUMAN_GATES, type GateAction, type GateCase, type HumanGateId, type LaunchScope } from "../lib/aegis/gates/types";
import type { Principal, Role } from "../lib/account/types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-25T12:00:00.000Z";
const FRESH = "2026-10-25T11:50:00.000Z";
const STALE = "2026-10-25T11:40:00.000Z";
const projects = ["proj-1"];
const environments = ["test"];

function person(id: string, role: Role, governmentOfficial = false): Principal {
  return humanPrincipal({ id, role, projects, environments, governmentOfficial });
}

const actors = {
  isse: person("isse-1", "isse"),
  owner: person("owner-1", "system-owner"),
  isso: person("isso-1", "isso"),
  engineer: person("engineer-1", "engineer"),
  release: person("release-1", "release-manager"),
  assessor: person("assessor-1", "assessor"),
  viewer: person("viewer-1", "viewer"),
  official: person("official-1", "isso", true),
  agent: agentPrincipal({ id: "agent-1", projects, environments }),
};

function proofFor(actor: Principal, verifiedAt = FRESH): MfaProof {
  return { subjectId: actor.id, verifiedAt };
}

function act(gateCase: GateCase, action: GateAction, actor: Principal, extra: Partial<ActOptions> = {}) {
  return reduceCase(gateCase, action, { now: NOW, actor, proof: proofFor(actor), ...extra });
}

function scopeFor(planId = "DRAFT-gate", hours = 2): LaunchScope {
  return { repo: "example/binder", branchPrefix: `poam/${planId}/`, hours, environments: ["test"], planId, poamId: "POAM-gate" };
}

function baseCase(proposal?: { paths?: string[]; touches?: string[] }): GateCase {
  return openCase({
    workspaceId,
    planId: "DRAFT-gate",
    poamId: "POAM-gate",
    projectId: "proj-1",
    environment: "test",
    illustrative: true,
    parties: {
      findingAuthorId: "author-1",
      planAuthorId: "engineer-1",
      changeAuthorId: "engineer-1",
      prAuthorId: "engineer-1",
      agentId: "agent-1",
    },
    ...(proposal ? { proposal } : {}),
  });
}

function draftPlan(): RemediationPlan {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-gate", "2026-10-03T12:00:00.000Z");
  plan.owner = "Example owner";
  plan.risk = "Tracked weakness on the recorded criterion.";
  plan.resources = "Engineer time";
  plan.protection = "Interim restriction";
  plan.milestones = [{ id: "m-1", description: "Apply the correction", target: "2026-11-01", revised: "", reason: "", status: "Not started" }];
  return plan;
}

function must(decision: ReturnType<typeof act>, label: string): GateCase {
  assert.equal(decision.allowed, true, `${label}: ${decision.reason} ${decision.problems.join(",")}`);
  return decision.case;
}

describe("rmf human gates", { concurrency: false }, () => {
  const previous = process.env.AEGIS_DATA_DIR;
  before(() => {
    process.env.AEGIS_DATA_DIR = mkdtempSync(`${tmpdir()}/aegis-gates-`);
  });
  after(() => {
    if (previous == null) delete process.env.AEGIS_DATA_DIR;
    else process.env.AEGIS_DATA_DIR = previous;
  });

  test("roles add ISSE and release manager and keep the agent non-human", () => {
    assert.equal(ROLES.includes("isse"), true);
    assert.equal(ROLES.includes("release-manager"), true);
    assert.equal(isRole("isse"), true);
    assert.equal(isRole("release-manager"), true);
    assert.equal(isRole("aegis-agent"), false);
    assert.equal(roleLabel("isse"), "ISSE");
    assert.equal(roleLabel("release-manager"), "Release manager");
    assert.equal(canWriteBoundary("isse"), false);
    assert.equal(canWriteBoundary("release-manager"), false);
    assert.match(roleLimit("release-manager"), /not an authorization decision/);
    assert.equal(actors.agent.kind, "aegis-agent");
    assert.equal(actors.agent.role, null);
    assert.equal(actors.agent.governmentOfficial, false);
    assert.equal(HUMAN_GATES.length, 11);
    for (const id of HUMAN_GATES) {
      assert.equal(GATE_MATRIX[id].title, GATE_COPY.gates[id].title);
      assert.equal(GATE_MATRIX[id].mfa, true);
      assert.equal(GATE_MATRIX[id].slots.some((slot) => (slot.roles as readonly string[]).includes("aegis-agent")), false);
    }
  });

  test("the state machines reject skipped and in-app authorization transitions", () => {
    assert.equal(previewWorkflow("planned", "APPROVE_DEPLOY"), null);
    assert.equal(previewWorkflow("planned", "VALIDATE_FINDING"), "finding-validated");
    assert.equal(previewWorkflow("merge-approved", "APPROVE_DEPLOY"), "deployed");
    assert.equal(previewWorkflow("closed-externally", "REOPEN"), "reopened");
    const outside = previewGate("idle", { mode: "outside", requiredSlots: [], receivedSlots: [], authorizationGranted: false, citation: "" }, { type: "APPROVE", slot: "any" });
    assert.equal(outside, null);
    const cited = previewGate("idle", { mode: "outside", requiredSlots: [], receivedSlots: [], authorizationGranted: false, citation: "" }, { type: "CITE", reference: "EXT-1" });
    assert.equal(cited?.state, "recorded-externally");
    assert.equal(cited?.context.authorizationGranted, false);
    const pending = previewGate("idle", { mode: "quorum", requiredSlots: ["reviewer"], receivedSlots: [], authorizationGranted: false, citation: "" }, { type: "REQUEST" });
    assert.equal(pending?.state, "pending");
  });

  test("change classification is data-driven and significant stays significant", () => {
    const identity = classifyChange({ paths: ["src/identity/rbac.ts"] });
    assert.equal(identity.impact, "significant");
    assert.deepEqual(identity.ruleIds, ["identity"]);
    assert.equal(identity.requiresGate, true);
    const data = classifyChange({ touches: ["data"] });
    assert.equal(data.impact, "significant");
    assert.deepEqual(data.ruleIds, ["data"]);
    const boundary = classifyChange({ paths: ["pkg/boundary/edge.ts"] });
    assert.equal(boundary.impact, "significant");
    assert.ok(boundary.ruleIds.includes("boundary"));
    const routine = classifyChange({ paths: ["docs/readme.md", "lib/validate.ts"] });
    assert.equal(routine.impact, "routine");
    assert.equal(routine.requiresGate, false);
    const gateCase = baseCase({ paths: ["src/identity/rbac.ts"] });
    assert.equal(gateCase.suggestion.impact, "significant");
    const downgrade = act(gateCase, { type: "classify", impact: "routine", justification: "Calling it routine." }, actors.isso);
    assert.equal(downgrade.allowed, false);
    assert.equal(downgrade.reason, "denied-classification");
    const recorded = act(gateCase, { type: "classify", impact: "significant", justification: "Identity path needs impact analysis." }, actors.isso);
    assert.equal(recorded.allowed, true);
    assert.equal(recorded.case.classification?.impact, "significant");
  });

  test("each gate rejects a principal outside its permission matrix", () => {
    const plan = draftPlan();
    const gateCase = baseCase();
    const wrong: { gate: HumanGateId; action: GateAction; actor: Principal }[] = [
      { gate: "finding-validation", action: { type: "approve", gateId: "finding-validation" }, actor: actors.engineer },
      { gate: "plan-approval", action: { type: "approve", gateId: "plan-approval" }, actor: actors.isse },
      { gate: "agent-launch", action: { type: "approve", gateId: "agent-launch", scope: scopeFor() }, actor: actors.engineer },
      { gate: "significant-change", action: { type: "approve", gateId: "significant-change", justification: "Analysis." }, actor: actors.engineer },
      { gate: "merge", action: { type: "approve", gateId: "merge" }, actor: actors.viewer },
      { gate: "deploy", action: { type: "approve", gateId: "deploy" }, actor: actors.isso },
      { gate: "deploy", action: { type: "approve", gateId: "deploy" }, actor: person("admin-1", "admin") },
      { gate: "ssp-text", action: { type: "approve", gateId: "ssp-text", draftId: "draft-1" }, actor: actors.engineer },
      { gate: "exception", action: { type: "approve", gateId: "exception", justification: "Because.", checkIds: ["unit"] }, actor: actors.engineer },
      { gate: "risk-acceptance", action: { type: "record-external", gateId: "risk-acceptance", reference: "RISK-1", approver: "Government official", date: "2026-10-25" }, actor: actors.engineer },
      { gate: "risk-acceptance", action: { type: "record-external", gateId: "risk-acceptance", reference: "RISK-1", approver: "Government official", date: "2026-10-25" }, actor: actors.isso },
      { gate: "official-closure", action: { type: "submit-closure" }, actor: actors.engineer },
      { gate: "ato", action: { type: "record-external", gateId: "ato", reference: "OUT-1", approver: "Outside authority", date: "2026-10-25" }, actor: actors.engineer },
    ];
    for (const item of wrong) {
      const decision = act(gateCase, item.action, item.actor, { plan });
      assert.equal(decision.reason, "denied-role", item.gate);
      assert.equal(decision.case.gates[item.gate].state, "idle");
      assert.equal(decision.case.workflow, "planned");
    }
  });

  test("an agent cannot approve any human gate", () => {
    const plan = draftPlan();
    const gateCase = baseCase();
    for (const gateId of HUMAN_GATES) {
      const decision = act(gateCase, { type: "approve", gateId, justification: "no", draftId: "draft-1", scope: scopeFor() }, actors.agent, { plan });
      assert.equal(decision.allowed, false, gateId);
      assert.equal(decision.reason, "denied-agent", gateId);
      assert.equal(decision.case.gates[gateId].authorizationGranted, false);
      assert.equal(JSON.stringify(decision.audit).includes("ghp_"), false);
    }
    for (const gateId of ["risk-acceptance", "official-closure", "ato"] as const) {
      const decision = act(gateCase, { type: "record-external", gateId, reference: "EXT", approver: "Outside", date: "2026-10-25", officialId: "POAM-1" }, actors.agent, { plan });
      assert.equal(decision.reason, "denied-agent", gateId);
    }
    assert.equal(act(gateCase, { type: "submit-closure" }, actors.agent).reason, "denied-agent");
    assert.equal(plan.riskDecision, "");
    assert.equal(plan.closure.recorded, false);
  });

  test("separation of duties blocks authors, launchers, and self approval", () => {
    const plan = draftPlan();
    const findingAuthor = person("author-1", "isse");
    const planAuthor = person("engineer-1", "isso");
    const changeRelease = person("engineer-1", "release-manager");
    let gateCase = must(act(baseCase(), { type: "request", gateId: "finding-validation" }, actors.viewer), "request finding");
    assert.equal(act(gateCase, { type: "approve", gateId: "finding-validation" }, findingAuthor, { plan }).reason, "denied-sod");
    gateCase = must(act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan }), "isse finding");
    assert.equal(gateCase.gates["finding-validation"].state, "pending");
    assert.equal(act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan }).reason, "denied-role");
    gateCase = must(act(baseCase(), { type: "request", gateId: "plan-approval" }, actors.viewer), "request plan");
    assert.equal(act(gateCase, { type: "approve", gateId: "plan-approval" }, planAuthor, { plan }).reason, "denied-sod");
    assert.equal(act(baseCase(), { type: "approve", gateId: "deploy" }, changeRelease).reason, "denied-sod");
    assert.equal(act(baseCase(), { type: "classify", impact: "routine", justification: "Routine patch." }, planAuthor).reason, "denied-sod");
  });

  test("step-up MFA must be fresh for the same person", () => {
    const plan = draftPlan();
    const gateCase = must(act(baseCase(), { type: "request", gateId: "finding-validation" }, actors.viewer), "request");
    const stale = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan, proof: proofFor(actors.isse, STALE) });
    assert.equal(stale.reason, "denied-mfa");
    assert.equal(stale.case.gates["finding-validation"].state, "pending");
    const missing = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan, proof: null });
    assert.equal(missing.reason, "denied-mfa");
    const other = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan, proof: proofFor(actors.owner, FRESH) });
    assert.equal(other.reason, "denied-mfa");
    const skew = defaultMfaChecker({ actorId: actors.isse.id, proof: { subjectId: actors.isse.id, verifiedAt: "2026-10-25T12:05:00.000Z" }, now: NOW, maxAgeMs: 15 * 60 * 1000 });
    assert.equal(skew.fresh, false);
    assert.equal(skew.reason, "skew");
    const fresh = defaultMfaChecker({ actorId: actors.isse.id, proof: proofFor(actors.isse, FRESH), now: NOW, maxAgeMs: 15 * 60 * 1000 });
    assert.equal(fresh.fresh, true);
    const tight = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan, maxAgeMs: 5 * 60 * 1000 });
    assert.equal(tight.reason, "denied-mfa");
    const allowed = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan });
    assert.equal(allowed.allowed, true);
  });

  test("attribute scope denies an unassigned project or environment", () => {
    const outsider = humanPrincipal({ id: "isse-9", role: "isse", projects: ["other"], environments: ["test"] });
    const decision = act(baseCase(), { type: "approve", gateId: "finding-validation" }, outsider, { plan: draftPlan() });
    assert.equal(decision.reason, "denied-abac");
    assert.match(GATE_COPY.reasons["denied-abac"], /not assigned/);
  });

  test("secrets are refused and do not appear in the audit body", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz";
    const gateCase = baseCase();
    const decision = act(gateCase, { type: "classify", impact: "routine", justification: `note ${token}` }, actors.isso);
    assert.equal(decision.reason, "denied-secret");
    assert.equal(JSON.stringify(decision).includes(token), false);
    assert.equal(JSON.stringify(decision.case).includes(token), false);
    const cited = act(gateCase, { type: "record-external", gateId: "ato", reference: "AKIAIOSFODNN7EXAMPLE", approver: "Outside", date: "2026-10-25" }, actors.isso);
    assert.equal(cited.reason, "denied-secret");
    assert.equal(JSON.stringify(cited).includes("AKIAIOSFODNN7EXAMPLE"), false);
  });

  test("plan approval rejects empty fields and does not write closure or risk", () => {
    const plan = draftPlan();
    plan.resources = " ";
    plan.protection = "";
    let gateCase = baseCase();
    gateCase = must(act(gateCase, { type: "request", gateId: "finding-validation" }, actors.viewer), "request finding");
    gateCase = must(act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan }), "isse");
    const noted = act(gateCase, { type: "approve", gateId: "finding-validation" }, actors.owner, { plan });
    gateCase = must(noted, "owner");
    const carried = noted.plan ?? plan;
    assert.equal(carried.riskDecision, "");
    assert.equal(carried.closure.recorded, false);
    gateCase = must(act(gateCase, { type: "request", gateId: "plan-approval" }, actors.isso), "request plan");
    const rejected = act(gateCase, { type: "approve", gateId: "plan-approval" }, actors.isso, { plan: carried });
    assert.equal(rejected.reason, "denied-fields");
    assert.ok(rejected.problems.includes("resources"));
    assert.ok(rejected.problems.includes("protection"));
    assert.equal(rejected.case.gates["plan-approval"].state, "pending");
    const filled = draftPlan();
    const approved = act(gateCase, { type: "approve", gateId: "plan-approval" }, actors.isso, { plan: filled });
    assert.equal(approved.allowed, true, approved.reason);
    assert.equal(approved.plan?.riskDecision, "");
    assert.equal(approved.plan?.closure.recorded, false);
    assert.match(approved.plan?.history.at(-1)?.action ?? "", /Plan approval/);
  });

  test("routine changes proceed and significant changes block launch and deploy", () => {
    const plan = draftPlan();
    const walked = walkRoutine(baseCase(), plan);
    assert.equal(walked.case.workflow, "deployed");
    assert.equal(walked.plan.riskDecision, plan.riskDecision);
    assert.equal(walked.plan.closure.recorded, false);
    assert.equal(walked.plan.validationRecorded, plan.validationRecorded);
    assert.equal(walked.case.gates.deploy.authorizationGranted, false);
    assert.match(walked.case.limitations.join(" "), /No ATO/);

    const significant = baseCase({ paths: ["src/identity/rbac.ts"] });
    const prepared = prepareLaunch(significant, plan);
    const blocked = act(prepared, { type: "approve", gateId: "agent-launch", scope: scopeFor() }, actors.isso, { plan });
    assert.equal(blocked.reason, "denied-classification");
    let gated = must(act(prepared, { type: "classify", impact: "significant", justification: "Identity change." }, actors.isso), "class");
    const still = act(gated, { type: "approve", gateId: "agent-launch", scope: scopeFor() }, actors.isso, { plan });
    assert.equal(still.reason, "denied-classification");
    gated = must(act(gated, { type: "request", gateId: "significant-change" }, actors.isse), "request impact");
    assert.equal(act(gated, { type: "approve", gateId: "significant-change", justification: "Accepting early." }, actors.isso).reason, "denied-state");
    gated = must(act(gated, { type: "approve", gateId: "significant-change", justification: "Impact analysis for the identity change." }, actors.isse), "isse impact");
    gated = must(act(gated, { type: "approve", gateId: "significant-change", justification: "Impact analysis accepted." }, actors.isso), "isso impact");
    gated = must(act(gated, { type: "request", gateId: "agent-launch" }, actors.isso), "request launch");
    gated = must(act(gated, { type: "approve", gateId: "agent-launch", scope: scopeFor() }, actors.isso, { plan }), "launch");
    assert.equal(gated.workflow, "agent-running");
    assert.equal(gated.parties.launcherId, actors.isso.id);
    const mergeRequest = must(act(gated, { type: "propose", summary: "Identity fix.", paths: ["src/identity/rbac.ts"] }, actors.agent, { plan }), "propose");
    assert.equal(act(mergeRequest, { type: "approve", gateId: "merge" }, actors.isso).reason, "denied-sod");
  });

  test("failed checks block merge until an exception, which is not risk acceptance", () => {
    const plan = draftPlan();
    let gateCase = walkToRunning(baseCase(), plan);
    gateCase = must(act(gateCase, { type: "propose", summary: "Adjust the check.", paths: ["docs/readme.md"] }, actors.agent, { plan }), "propose");
    gateCase = must(act(gateCase, { type: "record-checks", checks: [{ id: "unit", status: "fail" }] }, actors.engineer), "checks");
    gateCase = must(act(gateCase, { type: "request", gateId: "merge" }, actors.assessor), "request merge");
    const blocked = act(gateCase, { type: "approve", gateId: "merge" }, actors.assessor, { plan });
    assert.equal(blocked.reason, "denied-checks");
    assert.equal(blocked.plan ?? plan, plan);
    gateCase = must(act(gateCase, { type: "request", gateId: "exception" }, actors.isso), "request exception");
    gateCase = must(act(gateCase, { type: "approve", gateId: "exception", justification: "Temporary vendor dependency.", checkIds: ["unit"] }, actors.isso, { plan }), "exception");
    assert.match(GATE_COPY.limitations.exceptionNotRisk, /does not accept residual risk/);
    assert.equal(plan.riskDecision, "");
    const merged = act(gateCase, { type: "approve", gateId: "merge" }, actors.assessor, { plan });
    assert.equal(merged.allowed, true, merged.reason);
    assert.equal(merged.case.workflow, "merge-approved");
    assert.equal((merged.plan ?? plan).validationRecorded, false);
    assert.equal((merged.plan ?? plan).riskDecision, "");
    const bare = walkToRunning(baseCase(), plan);
    const proposed = must(act(bare, { type: "propose", summary: "No checks yet." }, actors.agent), "propose bare");
    const requested = must(act(proposed, { type: "request", gateId: "merge" }, actors.assessor), "request bare");
    assert.equal(act(requested, { type: "approve", gateId: "merge" }, actors.assessor).reason, "denied-evidence");
  });

  test("SSP acceptance needs ISSE review before ISSO and stays ungranted", () => {
    let gateCase = must(act(baseCase(), { type: "request", gateId: "ssp-text" }, actors.viewer), "request ssp");
    assert.equal(act(gateCase, { type: "approve", gateId: "ssp-text", draftId: "ssp-draft-1" }, actors.isso).reason, "denied-state");
    assert.equal(act(gateCase, { type: "approve", gateId: "ssp-text" }, actors.isse).reason, "denied-fields");
    gateCase = must(act(gateCase, { type: "approve", gateId: "ssp-text", draftId: "ssp-draft-1" }, actors.isse), "isse ssp");
    assert.equal(gateCase.gates["ssp-text"].state, "pending");
    gateCase = must(act(gateCase, { type: "approve", gateId: "ssp-text", draftId: "ssp-draft-1" }, actors.isso), "isso ssp");
    assert.equal(gateCase.gates["ssp-text"].state, "approved");
    assert.equal(gateCase.gates["ssp-text"].authorizationGranted, false);
    assert.match(GATE_COPY.limitations.sspDraft, /draft/);
  });

  test("risk acceptance and ATO are never written onto the plan", () => {
    const plan = draftPlan();
    const before = { risk: plan.riskDecision, closure: structuredClone(plan.closure) };
    const risk = act(baseCase(), { type: "record-external", gateId: "risk-acceptance", reference: "GOV-RISK-9", approver: "Government official", date: "2026-10-25" }, actors.official, { plan });
    assert.equal(risk.allowed, true, risk.reason);
    assert.equal(risk.case.gates["risk-acceptance"].state, "recorded-externally");
    assert.equal(risk.case.gates["risk-acceptance"].authorizationGranted, false);
    assert.equal(risk.plan?.riskDecision, "");
    assert.deepEqual(risk.plan?.closure, before.closure);
    const grant = act(baseCase(), { type: "approve", gateId: "risk-acceptance" }, actors.official, { plan });
    assert.equal(grant.reason, "denied-external");
    const atoGrant = act(baseCase(), { type: "approve", gateId: "ato" }, actors.official, { plan });
    assert.equal(atoGrant.reason, "denied-ato");
    const ato = act(baseCase(), { type: "record-external", gateId: "ato", reference: "OUTSIDE-ATO-1", approver: "Authorizing official", date: "2026-10-25" }, actors.isso, { plan });
    assert.equal(ato.allowed, true, ato.reason);
    assert.equal(ato.case.gates.ato.state, "recorded-externally");
    assert.equal(ato.case.gates.ato.authorizationGranted, false);
    assert.equal(ato.plan?.riskDecision, before.risk);
    assert.match(ato.plan?.history.at(-1)?.action ?? "", /No ATO was granted/);
    const sneaky = reduceCase(baseCase(), { type: "record-external", gateId: "ato", reference: "OUT-2", approver: "Official", date: "2026-10-25", grant: true } as GateAction, { now: NOW, actor: actors.official, proof: proofFor(actors.official), plan });
    assert.equal(sneaky.reason, "denied-ato");
    assert.equal(plan.riskDecision, before.risk);
  });

  test("official closure cites an external decision and leaves closure rules in place", () => {
    const plan = draftPlan();
    plan.officialId = "POAM-EXT-1";
    let gateCase = must(act(baseCase(), { type: "submit-closure" }, actors.isso, { plan }), "submit");
    assert.equal(gateCase.gates["official-closure"].state, "submitted");
    assert.equal(plan.closure.recorded, false);
    const samePerson = act(gateCase, { type: "record-external", gateId: "official-closure", reference: "EXT-9", approver: actors.isso.id, date: "2026-10-25", officialId: plan.officialId }, actors.isso, { plan });
    assert.equal(samePerson.reason, "denied-fields");
    assert.ok(samePerson.problems.includes("approver"));
    const recorded = act(gateCase, { type: "record-external", gateId: "official-closure", reference: "EXT-9", approver: "Designated approval authority", date: "2026-10-25", officialId: plan.officialId }, actors.isso, { plan });
    assert.equal(recorded.allowed, true, recorded.reason);
    assert.equal(recorded.case.gates["official-closure"].state, "recorded-externally");
    assert.equal(recorded.case.workflow, "planned");
    assert.equal(recorded.plan?.closure.recorded, false);
    assert.equal(recorded.plan?.readyForReview, false);
    assert.notEqual(closureProblems(recorded.plan ?? plan).length, 0);
    const mismatched = act(gateCase, { type: "record-external", gateId: "official-closure", reference: "EXT-9", approver: "Designated approval authority", date: "2026-10-25", officialId: "OTHER" }, actors.isso, { plan });
    assert.equal(mismatched.reason, "denied-fields");
  });

  test("a passing rescan path does not close the item until the existing closure rules already pass", () => {
    const plan = draftPlan();
    const walked = walkRoutine(baseCase(), plan);
    assert.equal(walked.case.workflow, "deployed");
    const rescanned = must(act(walked.case, { type: "rescan-pending" }, actors.assessor), "rescan");
    assert.equal(rescanned.workflow, "rescan-pending");
    assert.equal(act(rescanned, { type: "ready-for-closure-review" }, actors.isso, { plan: walked.plan }).reason, "denied-state");
    const readyPlan = readyPlanFor(walked.plan.id);
    assert.equal(readyForClosureReview(readyPlan), true);
    assert.equal(readyPlan.closure.recorded, false);
    const ready = must(act(rescanned, { type: "ready-for-closure-review" }, actors.isso, { plan: readyPlan }), "ready");
    assert.equal(ready.workflow, "ready-for-closure-review");
    assert.equal(readyPlan.closure.recorded, false);
    assert.equal(act(ready, { type: "observe-closure" }, actors.isso, { plan: readyPlan }).reason, "denied-state");
    const closed = closePlan(readyPlan);
    assert.equal(closureAlreadyRecorded(closed), true);
    const observed = act(ready, { type: "observe-closure" }, actors.isso, { plan: closed });
    assert.equal(observed.allowed, true, observed.reason);
    assert.equal(observed.case.workflow, "closed-externally");
    assert.deepEqual(observed.plan?.closure, closed.closure);
    assert.equal(observed.plan?.riskDecision, closed.riskDecision);
    assert.equal(observed.plan?.history.at(-1)?.action.includes("did not write"), true);
    const reopened = must(act(observed.case, { type: "reopen", reason: "Regression on the recorded check." }, actors.isse, { plan: observed.plan }), "reopen");
    assert.equal(reopened.workflow, "reopened");
    assert.equal(closed.closure.recorded, true);
  });

  test("POA&M export links gate facts and still refuses to grant closure", () => {
    const plan = draftPlan();
    const walked = walkRoutine(baseCase(), plan);
    const links = poamLinksFromCase(walked.case);
    assert.ok(links.some((link) => link.gateId === "deploy" && link.state === "approved"));
    const document = buildPlanOfAction(walked.plan, new Date("2026-10-25T12:00:00.000Z"), links);
    const validated = validatePlanOfAction(document);
    assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
    const body = document["plan-of-action-and-milestones"] as {
      observations: { title?: string; props?: { name: string; value: string }[] }[];
      risks: { status: string; props: { name: string; value: string }[] }[];
    };
    assert.equal(body.risks[0].status, "open");
    assert.equal(body.risks[0].props.some((prop) => prop.name === "ato-granted" && prop.value === "false"), true);
    assert.equal(body.risks[0].props.some((prop) => prop.name === "risk-acceptance-granted" && prop.value === "false"), true);
    assert.ok(body.observations.some((item) => item.title === GATE_COPY.gates.deploy.title));
    assert.equal(JSON.stringify(document).includes('"authorizationGranted":true'), false);
    const untouched = buildPlanOfAction(walked.plan, new Date("2026-10-25T12:00:00.000Z"));
    const untouchedBody = untouched["plan-of-action-and-milestones"] as { observations: unknown[] };
    assert.equal(untouchedBody.observations.length, 1);
  });

  test("the audit chain detects a changed entry and the store rejects it", async () => {
    const plan = draftPlan();
    const first = act(baseCase(), { type: "request", gateId: "finding-validation" }, actors.viewer, { plan });
    const stored = await commitDecision(first, NOW);
    assert.equal(verifyChain(stored.chain).ok, true);
    const second = act(stored.case, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan });
    const appended = await commitDecision(second, NOW);
    assert.equal(appended.chain.entries.length, 2);
    assert.equal(appended.chain.entries[1].prevHash, appended.chain.entries[0].hash);
    const tampered = structuredClone(appended.chain);
    tampered.entries[0].reason = "allowed";
    tampered.entries[0].outcome = "denied";
    const broken = verifyChain(tampered);
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.index, 0);
    const relinked = structuredClone(appended.chain);
    relinked.entries[0].actorId = "someone-else";
    assert.equal(verifyChain(relinked).ok, false);
    const file = path.join(dataDir(findRepoRoot()), gateAuditKey(workspaceId));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { entries: { reason: string }[] };
    onDisk.entries[0].reason = "tampered";
    writeFileSync(file, JSON.stringify(onDisk));
    await assert.rejects(() => readGateAudit(workspaceId), (error: unknown) => error instanceof AegisError && error.code === "AUDIT_TAMPER");
    const restored = await readGateCase(workspaceId, "DRAFT-gate").catch((error: unknown) => error);
    assert.ok(restored instanceof AegisError);
  });

  test("an agent run is a scoped expiring placeholder and does not execute", async () => {
    const plan = draftPlan();
    const running = walkToRunning(baseCase(), plan);
    assert.equal(running.workflow, "agent-running");
    const run = reserveAgentRun(running, {
      id: "run-1",
      now: NOW,
      credentialRef: "credref_aabbccddeeff0011",
      expiresAt: "2026-10-25T13:00:00.000Z",
    });
    assert.equal(run.status, "reserved");
    assert.equal(run.outputs.length, 0);
    assert.equal(run.transcriptHash, null);
    assert.equal(run.agentId, "agent-1");
    assert.equal(run.scope.branchPrefix, "poam/DRAFT-gate/");
    assert.deepEqual(run.deniedProbes.map((probe) => probe.action), ["write-main", "write-prod", "approve-gate"]);
    assert.equal(JSON.stringify(run).includes("ghp_"), false);
    assert.throws(() => reserveAgentRun(running, { id: "run-2", now: NOW, credentialRef: "ghp_abcdefghijklmnopqrstuvwxyz", expiresAt: "2026-10-25T13:00:00.000Z" }), /opaque credref/);
    assert.throws(() => reserveAgentRun(running, { id: "run-3", now: NOW, credentialRef: "credref_aabbccddeeff0011", expiresAt: "2026-10-26T12:00:00.000Z" }), /expiry/);
    assert.throws(() => executeAgentRun(run), (error: unknown) => error instanceof AegisError && error.code === "NOT_BUILT");
    await saveAgentRun(workspaceId, run);
    assert.equal(run.limitations.some((line) => /record only/.test(line)), true);
  });

  test("a gate note cannot move closure, and direct closure rules still fail closed", () => {
    const plan = draftPlan();
    const noted = noteGateEvent(plan, "Gate event recorded.", NOW);
    assert.equal(noted.history.length, plan.history.length + 1);
    assert.deepEqual(noted.closure, plan.closure);
    assert.equal(noted.riskDecision, plan.riskDecision);
    assert.ok(closureProblems(noted).length > 0);
    assert.equal(closureProblems(noted).some((item) => /external approver/i.test(item)), true);
  });
});

function prepareLaunch(gateCase: GateCase, plan: RemediationPlan): GateCase {
  let next = must(act(gateCase, { type: "request", gateId: "finding-validation" }, actors.viewer), "request finding");
  next = must(act(next, { type: "approve", gateId: "finding-validation" }, actors.isse, { plan }), "isse finding");
  const finding = act(next, { type: "approve", gateId: "finding-validation" }, actors.owner, { plan });
  next = must(finding, "owner finding");
  const carried = finding.plan ?? plan;
  next = must(act(next, { type: "request", gateId: "plan-approval" }, actors.isso), "request plan");
  const approved = act(next, { type: "approve", gateId: "plan-approval" }, actors.isso, { plan: carried });
  next = must(approved, "plan");
  return next;
}

function walkToRunning(gateCase: GateCase, plan: RemediationPlan): GateCase {
  let next = prepareLaunch(gateCase, plan);
  if (!next.classification) {
    next = must(act(next, { type: "classify", impact: "routine", justification: "No boundary, identity, or data change." }, actors.release), "classify");
  }
  next = must(act(next, { type: "request", gateId: "agent-launch" }, actors.isso), "request launch");
  const launched = act(next, { type: "approve", gateId: "agent-launch", scope: scopeFor() }, actors.isso, { plan });
  return must(launched, "launch");
}

function walkRoutine(gateCase: GateCase, plan: RemediationPlan): { case: GateCase; plan: RemediationPlan } {
  let next = walkToRunning(gateCase, plan);
  const proposed = act(next, { type: "propose", summary: "Adjust the documented check.", paths: ["docs/readme.md"] }, actors.agent, { plan });
  next = must(proposed, "propose");
  let carried = proposed.plan ?? plan;
  next = must(act(next, { type: "record-checks", checks: [{ id: "unit", status: "pass" }] }, actors.engineer), "checks");
  next = must(act(next, { type: "request", gateId: "merge" }, actors.assessor), "request merge");
  const merged = act(next, { type: "approve", gateId: "merge" }, actors.assessor, { plan: carried });
  next = must(merged, "merge");
  carried = merged.plan ?? carried;
  next = must(act(next, { type: "request", gateId: "deploy" }, actors.release), "request deploy");
  const deployed = act(next, { type: "approve", gateId: "deploy" }, actors.release, { plan: carried });
  return { case: must(deployed, "deploy"), plan: deployed.plan ?? carried };
}

function readyPlanFor(id: string): RemediationPlan {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const packet = JSON.parse(readFileSync(path.join(findRepoRoot(), "public/samples/remediation/podinfo-identity-retest.json"), "utf8")) as unknown;
  const plan = applyRetestPacket(newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), id, "2026-10-03T12:00:00.000Z"), packet);
  plan.engineeringComplete = true;
  plan.validation = "demonstrated";
  plan.validationNote = "Illustrative ISSE review of the scoped recorded tests.";
  plan.validator = "Illustrative ISSE";
  plan.validationDate = "2026-10-03";
  plan.validationRecorded = true;
  plan.readyForReview = true;
  plan.repository = "Illustrative designated repository";
  plan.officialId = "ILLUSTRATIVE-POAM-ID";
  plan.protectionDisposition = "Illustrative disposition: maintain protection for remaining scope.";
  plan.closure = { reference: "", approver: "", date: "", officialId: "", recorded: false };
  return plan;
}

function closePlan(plan: RemediationPlan): RemediationPlan {
  return {
    ...plan,
    closure: { reference: "Illustrative external decision", approver: "Illustrative external approver", date: "2026-10-03", officialId: plan.officialId, recorded: true },
  };
}
