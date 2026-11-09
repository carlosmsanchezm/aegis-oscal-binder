import {referenceProposals as proposePlans} from "./support/reference-history";
import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBinderDocuments, validateBinderDocuments } from "../lib/aegis/baseline-binder";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { applyDecision, decisionFromProposal, normalizePlanDecision, proposalStatus, } from "../lib/aegis/plan-proposal";
import { validatePlanOfAction } from "../lib/aegis/poam";
import { illustrativeScopedAssessment, newPlan } from "../lib/aegis/remediation";
import { runWithSession, Session } from "../lib/aegis/store";
import { proposalKeptInTab, RemediationSaveError } from "../lib/client/remediation-save";
import { withSession } from "../lib/server/http";
import { getPlanOfActionFile, getRemediation, putRemediation } from "../lib/server/remediation-draft";
import { GET as getRemediationRoute, PUT as putRemediationRoute } from "../app/api/remediation/route";
import { GET as getOscalRoute, POST as postOscalRoute } from "../app/api/remediation/oscal/route";
import { receivedRetest } from "./support/received-retest";

const now = new Date("2026-10-03T18:00:00.000Z");

function poamBody(documents: ReturnType<typeof buildBinderDocuments>) {
  return documents.poam["plan-of-action-and-milestones"] as {
    "poam-items"?: Array<{ description: string; props?: Array<{ name: string; value: string }>; remarks?: string }>;
    risks?: Array<{ status: string; props?: Array<{ name: string; value: string }> }>;
  };
}

test("CM-6 draft comes from the older finding and the passing retest stays proposed", () => {
  const [draft] = proposePlans([receivedRetest()]);
  assert.equal(draft.controlId, "CM-6");
  assert.equal(draft.sourceReleaseId, "2894050908");
  assert.equal(draft.correctiveReleaseId, "2908682168");
  assert.match(draft.finding, /KSV-0020/);
  assert.match(draft.finding, /KSV-0021/);
  assert.match(draft.riskStatement, /hardening criterion/);
  assert.match(draft.action, /10001/);
  assert.match(draft.milestone.description, /Commit and rescan/);
  assert.equal(draft.milestone.target, "2026-10-03");
  assert.deepEqual(draft.provingChecks, [
    "Configuration rescan no longer reports KSV-0020 or KSV-0021",
    "Actual application process UID and GID match the corrected manifest",
    "Corrected workload remains ready and /healthz succeeds",
  ]);
  assert.equal(draft.retests.length, 3);
  assert.equal(draft.retests.every((retest) => retest.verdict === "pass" && retest.releaseId === "2908682168" && retest.evidence.includes("16910084348")), true);
  assert.equal(draft.acceptance, "proposed");
  assert.equal(draft.readyToClose, true);
  assert.equal(draft.closureConfirmed, false);
  assert.equal(draft.officialId, "");
  assert.equal(proposePlans([receivedRetest()]).some((proposal) => proposal.controlId === "AC-1"), false);
  assert.equal(proposePlans([receivedRetest()]).some((proposal) => proposal.controlId === "AC-6"), false);
});

test("the shipped Podinfo receipt attaches the later retest while the caller is still on the original release", () => {
  const [draft] = proposePlans([CCM_EXAMPLE]);
  assert.match(draft.finding, /KSV-0020/);
  assert.equal(draft.sourceReleaseId, "2894050908");
  assert.equal(draft.correctiveReleaseId, "2908682168");
  assert.equal(draft.retests.length, 3);
  assert.equal(draft.retests.every((retest) => retest.verdict === "pass" && retest.releaseId === "2908682168"), true);
  assert.equal(draft.readyToClose, true);
  assert.equal(draft.acceptance, "proposed");
  assert.equal(draft.officialId, "");
  assert.equal(draft.closureConfirmed, false);
});

test("another project does not receive the Podinfo retest", () => {
  const other = structuredClone(CCM_EXAMPLE);
  other.pipelineUrl = "https://gitlab.com/other/project/-/pipelines/42";
  other.pipelineId = "42";
  const [draft] = proposePlans([other]);
  assert.match(draft.finding, /KSV-0020/);
  assert.equal(draft.retests.length, 0);
  assert.equal(draft.readyToClose, false);
  assert.equal(draft.correctiveReleaseId, "");
});

test("a failed proving check stays open with the retest attached", () => {
  const release = receivedRetest();
  release.verification!.tests[0].verdict = "fail";
  const [draft] = proposePlans([release]);
  assert.equal(draft.retests.length, 3);
  assert.equal(draft.retests[0].verdict, "fail");
  assert.equal(draft.readyToClose, false);
  assert.equal(draft.acceptance, "proposed");
  assert.equal(draft.closureConfirmed, false);
});

test("export writes an accepted draft as open and omits a proposed-only draft", () => {
  const releases = mergeStoredReleases([receivedRetest()]);
  const [draft] = proposePlans(releases);
  const untouched = buildBinderDocuments(releases, null, now);
  assert.equal(poamBody(untouched)["poam-items"], undefined);
  assert.equal(JSON.stringify(untouched.poam).includes("runAsUser"), false);

  const proposed = buildBinderDocuments(releases, null, now, [draft]);
  assert.equal(poamBody(proposed)["poam-items"], undefined);

  const accepted = applyDecision(draft, decisionFromProposal(draft, {
    acceptance: "accepted",
    riskStatement: "Edited risk from the recorded finding.",
    officialId: "",
  }));
  const documents = buildBinderDocuments(releases, null, now, [accepted]);
  assert.deepEqual(validateBinderDocuments(documents), []);
  const validated = validatePlanOfAction(documents.poam);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
  const body = poamBody(documents);
  assert.equal(body["poam-items"]?.length, 1);
  assert.equal(body.risks?.[0].status, "open");
  assert.match(body["poam-items"]?.[0].description ?? "", /Edited risk|10001|KSV-0020/);
  assert.match(JSON.stringify(body), /Edited risk from the recorded finding/);
  assert.match(JSON.stringify(body), /10001/);
  assert.match(JSON.stringify(documents.poam), /Configuration rescan no longer reports KSV-0020 or KSV-0021/);
  assert.equal(JSON.stringify(documents.poam).includes("official-poam-id"), false);
  assert.equal(JSON.stringify(documents.poam).includes('"status":"closed"'), false);
  assert.match(body["poam-items"]?.[0].remarks ?? "", /Closure is not confirmed/);
  assert.equal(body.risks?.[0].props?.some((prop) => prop.name === "ready-to-close" && prop.value === "true"), true);
  assert.equal(body.risks?.[0].props?.some((prop) => prop.name === "person-closure-confirmed" && prop.value === "false"), true);

  const confirmed = applyDecision(draft, decisionFromProposal(draft, { acceptance: "accepted", closureConfirmed: true, closure: {name: "Test reviewer", reason: "Reviewed all passing measurements", at: now.toISOString()} }));
  const confirmedDocs = buildBinderDocuments(releases, null, now, [confirmed]);
  const confirmedBody = poamBody(confirmedDocs);
  assert.equal(confirmedBody.risks?.[0].status, "closed");
  assert.equal(JSON.stringify(confirmedDocs.poam).includes("official-poam-id"), false);
  assert.equal(confirmedBody.risks?.[0].props?.some((prop) => prop.name === "person-closure-confirmed" && prop.value === "true"), true);
});

test("a person-typed plan remains the exported item when a proposal targets the same control", () => {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("missing review item");
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-rollup", "2026-10-03T12:00:00.000Z");
  const [draft] = proposePlans([receivedRetest()]);
  const accepted = applyDecision(draft, decisionFromProposal(draft, { acceptance: "accepted", riskStatement: "Edited risk from the recorded finding." }));
  const documents = buildBinderDocuments(mergeStoredReleases([receivedRetest()]), plan, now, [accepted]);
  assert.equal(poamBody(documents)["poam-items"]?.length, 1);
  assert.equal(JSON.stringify(poamBody(documents)).includes("Edited risk from the recorded finding"), false);
});

test("stored decisions cannot invent closure or a malformed proposal", () => {
  const other = structuredClone(CCM_EXAMPLE);
  other.pipelineUrl = "https://gitlab.com/other/project/-/pipelines/42";
  other.pipelineId = "42";
  const [open] = proposePlans([other]);
  const saved = decisionFromProposal(open, { closureConfirmed: true, officialId: "POAM-1" });
  const merged = applyDecision(open, saved);
  assert.equal(merged.closureConfirmed, false);
  assert.equal(merged.readyToClose, false);
  assert.equal(merged.officialId, "POAM-1");
  assert.equal(normalizePlanDecision({ ...saved, acceptance: "closed" }), null);
  assert.equal(normalizePlanDecision({ ...saved, officialId: "x".repeat(201) }), null);
  assert.equal(normalizePlanDecision(saved)?.officialId, "POAM-1");
});

test("an unconfigured preview stores the accepted draft in the session and exports it open", async () => {
  const previousData = process.env.AEGIS_DATA_DIR;
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;
  delete process.env.AEGIS_DATA_DIR;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.VERCEL = "1";
  try {
    const session = Session.create("cd".repeat(16));
    const draft = proposePlans([CCM_EXAMPLE])[0];
    const decision = decisionFromProposal(draft, { acceptance: "accepted", riskStatement: "Edited risk from the recorded finding." });
    await runWithSession(session, async () => {
      const saved = await putRemediation(new Request("http://localhost/api/remediation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "binder.plan-proposals.v1:podinfo", assessment: null, assessments: {}, plans: [], proposals: [decision] }),
      }));
      assert.equal(saved.status, 200);
      const cookie = saved.headers.getSetCookie().map((item) => item.split(";")[0]).find((item) => item.startsWith("aegis_remediation_v2_"));
      assert.ok(cookie);
      const loaded = await getRemediation(new Request("http://localhost/api/remediation?key=binder.plan-proposals.v1:podinfo", { headers: { cookie } }));
      assert.equal(loaded.status, 200);
      const record = await loaded.json() as { record?: { proposals?: Array<{ acceptance: string }> } };
      assert.equal(record.record?.proposals?.[0]?.acceptance, "accepted");
      const exported = await getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(decision.id)}`), cookie);
      assert.equal(exported.status, 200);
      const body = await exported.json() as Record<string, unknown>;
      assert.equal(validatePlanOfAction(body).ok, true);
      const text = JSON.stringify(body);
      assert.match(text, /Edited risk from the recorded finding/);
      assert.match(text, /2908682168/);
      assert.equal(text.includes("official-poam-id"), false);
      assert.equal(text.includes('"status":"closed"'), false);
      assert.match(text, /Closure is not confirmed/);
    });
  } finally {
    if (previousData === undefined) delete process.env.AEGIS_DATA_DIR;
    else process.env.AEGIS_DATA_DIR = previousData;
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test("confirmed closure keeps passing proof and closes the internal exported risk with reviewer and date", () => {
  const releases = mergeStoredReleases();
  const draft = proposePlans(releases)[0];
  for (const officialId of ["", "POAM-39"]) {
    const confirmed = applyDecision(draft, decisionFromProposal(draft, { acceptance: "accepted", closureConfirmed: true, closure: {name: "Test reviewer", reason: "Reviewed all passing measurements", at: now.toISOString()}, officialId }));
    const docs = buildBinderDocuments(releases, null, now, [confirmed]);
    assert.deepEqual(validateBinderDocuments(docs), []);
    const body = poamBody(docs);
    assert.equal(body.risks?.[0].status, "closed");
    assert.equal(confirmed.readyToClose, false);
    assert.match(body["poam-items"]![0].remarks!, /passes every required check/);
    assert.doesNotMatch(JSON.stringify(docs.poam), /not a passing proof|has not recorded closure|Closure is not confirmed/);
    assert.match(proposalStatus(confirmed), officialId ? /official plan id POAM-39/ : /official plan id blank/);
    assert.equal(body["poam-items"]![0].props!.some(p => p.name === "poam-id" && p.value === officialId), !!officialId);
    if (officialId) assert.doesNotMatch(body["poam-items"]![0].remarks!, /Official plan id is not recorded/);
  }
});

test("draft exports exclude other accepted controls, including when the binder is handed those proposals", async () => {
  const original = structuredClone(CCM_EXAMPLE);
  original.reviewItems!.push({ ...structuredClone(original.reviewItems![0]), id: "second", description: "Second recorded finding", scope: { ...original.reviewItems![0].scope!, title: "Second control", controls: ["SC-7"] } });
  const plan = newPlan(CCM_EXAMPLE, CCM_EXAMPLE.reviewItems![0].description, illustrativeScopedAssessment(CCM_EXAMPLE.reviewItems![0].scope!), "DRAFT-scope", now.toISOString());
  const proposals = proposePlans([original]).map(d => applyDecision(d, decisionFromProposal(d, { acceptance: "accepted" })));
  assert.equal(proposals.some(p => p.controlId === "SC-7"), true);
  const documents = buildBinderDocuments(mergeStoredReleases([original]), plan, now, proposals);
  assert.equal(poamBody(documents)["poam-items"]!.length, 1);
  assert.equal(poamBody(documents)["poam-items"]![0].props!.find(p => p.name === "control-id")!.value, "CM-6");
  const previous = process.env.AEGIS_DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "pr39-scope-"));
  process.env.AEGIS_DATA_DIR = dir;
  try {
    const draft = proposePlans([CCM_EXAMPLE])[0];
    const accepted = decisionFromProposal(draft, { acceptance: "accepted" });
    const session = Session.create("ef".repeat(16));
    await runWithSession(session, async () => {
      await putRemediation(new Request("http://localhost/api/remediation", { method: "PUT", body: JSON.stringify({ key: "scope", assessment: null, assessments: {}, plans: [plan], proposals: proposals.map(p => decisionFromProposal(p)) }) }));
      const downloaded = await getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?id=${plan.id}`));
      assert.equal((await downloaded.json())["plan-of-action-and-milestones"]["poam-items"].length, 1);
      const proposalFile = await getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(accepted.id)}`));
      assert.equal((await proposalFile.json())["plan-of-action-and-milestones"]["poam-items"].length, 1);
      await putRemediation(new Request("http://localhost/api/remediation", { method: "PUT", body: JSON.stringify({ key: "scope", assessment: null, assessments: {}, plans: [plan], proposals: [{ ...accepted, acceptance: "proposed" }] }) }));
      await assert.rejects(getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(accepted.id)}`)), /Accept the draft/);
    });
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing preview cookie key keeps acceptance in the tab and still exports it", async () => {
  const previous = {
    node: process.env.NODE_ENV,
    data: process.env.AEGIS_DATA_DIR,
    blob: process.env.BLOB_READ_WRITE_TOKEN,
    vercel: process.env.VERCEL,
    remediation: process.env.AEGIS_REMEDIATION_COOKIE_KEY,
    demo: process.env.AEGIS_DEMO_COOKIE_KEY,
  };
  const draft = proposePlans([CCM_EXAMPLE])[0];
  const decision = decisionFromProposal(draft, { acceptance: "accepted" });
  const key = "binder.plan-proposals.v1:podinfo";
  const planning = { "x-aegis-workspace": "sa1-demo" };
  function remember(response: Response, jar: Map<string, string>) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  try {
    Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1" });
    delete process.env.AEGIS_DATA_DIR;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.AEGIS_REMEDIATION_COOKIE_KEY;
    delete process.env.AEGIS_DEMO_COOKIE_KEY;
    assert.equal(proposalKeptInTab(new RemediationSaveError("Browser-session draft storage is not configured on this host.", "SESSION_CONFIGURATION", true)), true);
    assert.equal(proposalKeptInTab(new RemediationSaveError("Configured storage failed.", "STORE_UNAVAILABLE", false)), false);

    const jar = new Map<string, string>();
    const loaded = await getRemediationRoute(new Request(`http://localhost/api/remediation?key=${encodeURIComponent(key)}`, { headers: planning }));
    assert.equal(loaded.status, 200, await loaded.clone().text());
    assert.equal((await loaded.json()).record, null);
    remember(loaded, jar);
    const blocked = await withSession(new Request("http://localhost/api/package", { headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...planning } }), () => Response.json({ ok: true }));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, "DEMO_CONFIGURATION");

    const saved = await putRemediationRoute(new Request("http://localhost/api/remediation", {
      method: "PUT",
      headers: { ...planning, "content-type": "application/json", cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
      body: JSON.stringify({ key, assessment: null, assessments: {}, plans: [], proposals: [decision] }),
    }));
    assert.equal(saved.status, 503, await saved.clone().text());
    const failure = await saved.json() as { error: { code: string; details: { storageUnset: boolean } } };
    assert.equal(failure.error.code, "SESSION_CONFIGURATION");
    assert.equal(failure.error.details.storageUnset, true);

    const url = `http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(decision.id)}`;
    const missing = await getOscalRoute(new Request(url, { headers: planning }));
    assert.equal(missing.status, 503);
    const exported = await postOscalRoute(new Request(url, {
      method: "POST",
      headers: { ...planning, "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }));
    assert.equal(exported.status, 200, await exported.clone().text());
    const file = (await exported.json())["plan-of-action-and-milestones"];
    assert.equal(file.risks[0].status, "open");
    assert.equal(file["system-id"]["identifier-type"], "urn:aegis:system-id:internal");
    assert.equal(JSON.stringify(file).includes("official-poam-id"), false);
    const proposed = await postOscalRoute(new Request(url, {
      method: "POST",
      headers: { ...planning, "content-type": "application/json" },
      body: JSON.stringify({ decision: { ...decision, acceptance: "proposed" } }),
    }));
    assert.equal(proposed.status, 409);
    const dir = mkdtempSync(path.join(tmpdir(), "preview-accept-block-"));
    process.env.AEGIS_DATA_DIR = dir;
    try {
      const blockedExport = await postOscalRoute(new Request(url, {
        method: "POST",
        headers: { ...planning, "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      }));
      assert.equal(blockedExport.status, 409);
    } finally {
      delete process.env.AEGIS_DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }

    const standard = await getRemediationRoute(new Request(`http://localhost/api/remediation?key=${encodeURIComponent(key)}`));
    assert.equal((await standard.json()).record, null);
  } finally {
    if (previous.node === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous.node });
    if (previous.data === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous.data;
    if (previous.blob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = previous.blob;
    if (previous.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
    if (previous.remediation === undefined) delete process.env.AEGIS_REMEDIATION_COOKIE_KEY; else process.env.AEGIS_REMEDIATION_COOKIE_KEY = previous.remediation;
    if (previous.demo === undefined) delete process.env.AEGIS_DEMO_COOKIE_KEY; else process.env.AEGIS_DEMO_COOKIE_KEY = previous.demo;
  }
});

test("a remediation cookie still round-trips when only the demo snapshot key is missing", async () => {
  const previous = {
    node: process.env.NODE_ENV,
    data: process.env.AEGIS_DATA_DIR,
    blob: process.env.BLOB_READ_WRITE_TOKEN,
    vercel: process.env.VERCEL,
    remediation: process.env.AEGIS_REMEDIATION_COOKIE_KEY,
    demo: process.env.AEGIS_DEMO_COOKIE_KEY,
  };
  const draft = proposePlans([CCM_EXAMPLE])[0];
  const decision = decisionFromProposal(draft, { acceptance: "accepted" });
  const key = "binder.plan-proposals.v1:podinfo";
  const planning = { "x-aegis-workspace": "sa1-demo" };
  const jar = new Map<string, string>();
  function remember(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  try {
    Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", AEGIS_REMEDIATION_COOKIE_KEY: "ab".repeat(32) });
    delete process.env.AEGIS_DATA_DIR;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.AEGIS_DEMO_COOKIE_KEY;
    const saved = await putRemediationRoute(new Request("http://localhost/api/remediation", {
      method: "PUT",
      headers: { ...planning, "content-type": "application/json" },
      body: JSON.stringify({ key, assessment: null, assessments: {}, plans: [], proposals: [decision] }),
    }));
    assert.equal(saved.status, 200, await saved.clone().text());
    remember(saved);
    assert.equal([...jar.keys()].some((name) => name.startsWith("aegis_remediation_v2_")), true);
    assert.equal([...jar.keys()].includes("aegis_sa1_sid"), true);
    const loaded = await getRemediationRoute(new Request(`http://localhost/api/remediation?key=${encodeURIComponent(key)}`, { headers: { ...planning, cookie: cookie() } }));
    assert.equal(loaded.status, 200, await loaded.clone().text());
    assert.equal((await loaded.json()).record.proposals[0].acceptance, "accepted");
    const standard = await getRemediationRoute(new Request(`http://localhost/api/remediation?key=${encodeURIComponent(key)}`, { headers: { cookie: cookie() } }));
    assert.equal((await standard.json()).record, null);
    const exported = await getOscalRoute(new Request(`http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(decision.id)}`, { headers: { ...planning, cookie: cookie() } }));
    assert.equal(exported.status, 200, await exported.clone().text());
    assert.equal((await exported.json())["plan-of-action-and-milestones"].risks[0].status, "open");
  } finally {
    if (previous.node === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous.node });
    if (previous.data === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous.data;
    if (previous.blob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = previous.blob;
    if (previous.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
    if (previous.remediation === undefined) delete process.env.AEGIS_REMEDIATION_COOKIE_KEY; else process.env.AEGIS_REMEDIATION_COOKIE_KEY = previous.remediation;
    if (previous.demo === undefined) delete process.env.AEGIS_DEMO_COOKIE_KEY; else process.env.AEGIS_DEMO_COOKIE_KEY = previous.demo;
  }
});


test("two findings on the same control and asset retain separate drafts, proof, and exports", () => {
  const original = structuredClone(CCM_EXAMPLE);
  original.reviewItems!.push({
    id: "configuration-second-test-finding", description: "Independent configuration finding in the unit test.",
    scope: { ...original.reviewItems![0].scope, title: "Independent test finding", verification: ["Rescan no longer reports the second test finding"] },
  });
  const drafts = proposePlans([original, { ...receivedRetest(), reviewItems: [] }]);
  assert.equal(drafts.length, 2);
  const first = drafts.find(d => d.id.endsWith("configuration-KSV-0020-0021"))!;
  const second = drafts.find(d => d.id.endsWith("configuration-second-test-finding"))!;
  assert.equal(first.retests.length, 3);
  assert.equal(first.readyToClose, true);
  assert.equal(second.retests.length, 0);
  assert.equal(second.readyToClose, false);
  assert.equal(second.correctiveReleaseId, "");
  assert.doesNotMatch(second.action, /10001/);
  const accepted = drafts.map(d => applyDecision(d, decisionFromProposal(d, { acceptance: "accepted" })));
  const docs = buildBinderDocuments(mergeStoredReleases([original, { ...receivedRetest(), reviewItems: [] }]), null, now, accepted);
  assert.deepEqual(validateBinderDocuments(docs), []);
  assert.equal(validatePlanOfAction(docs.poam).ok, true);
  const file = poamBody(docs);
  assert.equal(file.risks!.length, 2);
  assert.equal(file["poam-items"]!.length, 2);
  assert.equal(file.risks!.every(r => r.status === "open"), true);
  assert.equal(new Set(file.risks!.map(r => (r as { uuid?: string }).uuid)).size, 2);
});

test("a corrective release's separate open finding does not inherit the original finding's passing proof", () => {
  const retest = receivedRetest();
  retest.reviewItems = [{ id: "remaining-test-finding", description: "A remaining configuration finding from this retest, for unit testing.", scope: { ...CCM_EXAMPLE.reviewItems![0].scope, title: "Remaining test finding", verification: ["New scan proves this remaining finding absent"] } }];
  const drafts = proposePlans([retest]);
  assert.equal(drafts.length, 2);
  const remaining = drafts.find(d => d.sourceReleaseId === retest.pipelineId)!;
  assert.equal(remaining.retests.length, 0);
  assert.equal(remaining.readyToClose, false);
  assert.equal(remaining.correctiveReleaseId, "");
  assert.doesNotMatch(remaining.action, /10001/);
  const accepted = applyDecision(remaining, decisionFromProposal(remaining, { acceptance: "accepted" }));
  const docs = buildBinderDocuments(mergeStoredReleases([retest]), null, now, [accepted]);
  assert.deepEqual(validateBinderDocuments(docs), []);
  assert.equal(poamBody(docs).risks!.length, 1);
  assert.match(poamBody(docs)["poam-items"]![0].description, /remaining configuration finding/);
});

test("an independently scoped finding remains visible when the older verification source is missing", () => {
  const retest = receivedRetest();
  retest.pipelineUrl = retest.pipelineUrl.replace("podinfo-gsa-evidence-0928", "independent-unit-project");
  retest.verification!.sourcePipelineUrl = retest.verification!.sourcePipelineUrl.replace("podinfo-gsa-evidence-0928", "independent-unit-project");
  retest.reviewItems = [{ id: "remaining-unit-record", description: "A separately recorded finding for the unit project.", scope: { ...CCM_EXAMPLE.reviewItems![0].scope, title: "Separate test finding", verification: ["Measure a new fix"] } }];
  const [proposal] = proposePlans([retest]);
  assert.equal(proposal.sourceReleaseId, retest.pipelineId);
  assert.equal(proposal.readyToClose, false);
  assert.equal(proposal.retests.length, 0);
});


test("the captured remaining KSV-0125 gets its own open draft and OSCAL risk alongside the UID/GID retest", () => {
  const drafts = proposePlans([receivedRetest()]);
  assert.equal(drafts.length, 2);
  const earlier = drafts.find(d => d.sourceReleaseId === "2894050908")!;
  const remaining = drafts.find(d => d.id.endsWith("configuration-KSV-0125"))!;
  assert.equal(earlier.retests.length, 3);
  assert.equal(earlier.readyToClose, true);
  assert.equal(remaining.sourceReleaseId, "2908682168");
  assert.equal(remaining.correctiveReleaseId, "");
  assert.equal(remaining.retests.length, 0);
  assert.equal(remaining.readyToClose, false);
  assert.deepEqual(remaining.provingChecks, ["Configuration rescan no longer reports KSV-0125"]);
  assert.match(remaining.finding, /does not identify the exact affected object or its policy disposition/);
  assert.doesNotMatch(remaining.action, /10001/);
  const accepted = drafts.map(d => applyDecision(d, decisionFromProposal(d, {acceptance: "accepted"})));
  const documents = buildBinderDocuments(mergeStoredReleases(), null, now, accepted);
  assert.deepEqual(validateBinderDocuments(documents), []);
  const file = poamBody(documents);
  assert.equal(file.risks!.length, 2);
  assert.equal(file.risks!.every(r => r.status === "open"), true);
  assert.equal(file["poam-items"]!.length, 2);
  const remainingItem = file["poam-items"]!.find(item => item.description.includes("KSV-0125"))!;
  assert.ok(remainingItem);
  assert.doesNotMatch(JSON.stringify(remainingItem), /10001|Actual application process UID/);
  assert.equal(JSON.stringify(file).includes('"official-poam-id"'), false);
  assert.equal(JSON.stringify(documents).includes('"agency-system-id"'), false);
});


test("accepting the remaining recorded finding survives durable reload and exports only its open risk", async () => {
  const previous = process.env.AEGIS_DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "remaining-finding-store-"));
  process.env.AEGIS_DATA_DIR = dir;
  try {
    const draft = proposePlans(mergeStoredReleases()).find(item => item.id.endsWith("configuration-KSV-0125"))!;
    const accepted = decisionFromProposal(draft, {acceptance: "accepted"});
    const session = Session.create("98".repeat(16));
    await runWithSession(session, async () => {
      const saved = await putRemediation(new Request("http://localhost/api/remediation", {method: "PUT", body: JSON.stringify({key: "remaining-recorded-finding", assessment: null, assessments: {}, plans: [], proposals: [accepted]})}));
      assert.equal(saved.status, 200);
      const loaded = await getRemediation(new Request("http://localhost/api/remediation?key=remaining-recorded-finding"));
      assert.equal((await loaded.json()).record.proposals[0].acceptance, "accepted");
      const response = await getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?proposal=${encodeURIComponent(accepted.id)}`));
      assert.equal(response.status, 200);
      const file = await response.json();
      assert.equal(validatePlanOfAction(file).ok, true);
      const body = file["plan-of-action-and-milestones"];
      assert.equal(body.risks.length, 1);
      assert.equal(body.risks[0].status, "open");
      assert.equal(body["poam-items"].length, 1);
      assert.match(body["poam-items"][0].description, /KSV-0125/);
      assert.doesNotMatch(JSON.stringify(body["poam-items"][0]), /10001|Actual application process UID/);
    });
  } finally {
    if (previous === undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});
