import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { findRepoRoot } from "../lib/aegis/paths";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { buildPlanOfAction, REMEDIATION_NAMESPACE, validatePlanOfAction } from "../lib/aegis/poam";
import { applyRetestPacket, closureProblems, illustrativeScopedAssessment, newPlan, normalizeStoredPlan, type RemediationPlan } from "../lib/aegis/remediation";
import { readRemediation, remediationBlobPath, writeRemediationRecord } from "../lib/aegis/remediation-store";
import { setBlobIoForTests, type BlobIo } from "../lib/durable";
import { Session, runWithSession } from "../lib/aegis/store";
import { getPlanOfActionFile, putRemediation } from "../lib/server/remediation-draft";

const root = findRepoRoot();
const support = path.join(path.dirname(fileURLToPath(import.meta.url)), "support");
const sessionId = "ab".repeat(16);

function identityPlan(): RemediationPlan {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const packet = JSON.parse(readFileSync(path.join(root, "public/samples/remediation/podinfo-identity-retest.json"), "utf8")) as unknown;
  return applyRetestPacket(
    newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-identity", "2026-10-03T12:00:00.000Z"),
    packet,
  );
}

function documentOf(plan: RemediationPlan): Record<string, unknown> {
  return buildPlanOfAction(plan, new Date("2026-10-03T18:00:00.000Z"));
}

function poam(document: Record<string, unknown>): Record<string, unknown> {
  return document["plan-of-action-and-milestones"] as Record<string, unknown>;
}

test("open draft exports one schema-valid plan and leaves agency identifiers blank", () => {
  const plan = identityPlan();
  const document = documentOf(plan);
  const validated = validatePlanOfAction(document);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
  const body = poam(document);
  const metadata = body.metadata as { "oscal-version": string };
  const risks = body.risks as { status: string; remediations: { tasks: { title: string }[] }[] }[];
  const items = body["poam-items"] as { title: string; props: { name: string; value: string }[] }[];
  const observations = body.observations as { "relevant-evidence": { href?: string; description: string }[] }[];
  assert.equal(metadata["oscal-version"], "1.1.2");
  assert.equal(body["poam-items"] && (body["poam-items"] as unknown[]).length, 1);
  assert.equal(Object.hasOwn(body, "findings"), false);
  assert.match((body["system-id"] as {id:string}).id, /^[0-9a-f-]{36}$/);
  assert.equal((body["system-id"] as {"identifier-type":string})["identifier-type"], "urn:aegis:system-id:internal");
  assert.equal(risks[0].status, "open");
  assert.equal(JSON.stringify(document).includes('"closed"'), false);
  assert.equal(items[0].title, "Application UID/GID hardening");
  assert.equal(items[0].props.some((prop) => prop.name === "control-id" && prop.value === "CM-6"), true);
  assert.equal(items[0].props.some((prop) => prop.name === "owner" && prop.value.includes("cmsanchezm")), true);
  assert.equal(items[0].props.some((prop) => prop.name === "poam-id"), false);
  assert.deepEqual(risks[0].remediations[0].tasks.map((task) => task.title), [
    "Commit application UID/GID correction",
    "Rescan and verify signed release artifacts",
    "Deploy vendor test and capture process identity and health",
  ]);
  const hrefs = observations[0]["relevant-evidence"].map((item) => item.href);
  assert.equal(hrefs.some((href) => href?.includes("16910084348") && href.includes("identity-verification.json")), true);
  assert.match(JSON.stringify(items[0]), /2908682168/);
  assert.match(JSON.stringify(body), /Agency system identifier is not recorded/);
  assert.match((observations[0] as { description?: string }).description ?? "", /KSV-0020/);
  assert.match((body.risks as { statement: string }[])[0].statement, /hardening criterion/);
});

test("uid/gid draft writes the finding, risk statement, and retest checks into the OSCAL body", () => {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-identity", "2026-10-03T12:00:00.000Z");
  plan.owner = "cmsanchezm";
  plan.risk = "open";
  plan.action = "Corrective release 2908682168";
  plan.releaseUrl = "https://gitlab.com/enbuild-staging/enbuild-deployments/podinfo-gsa-evidence-0928/-/pipelines/2908682168";
  const document = documentOf(plan);
  const validated = validatePlanOfAction(document);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
  const body = poam(document);
  const observations = body.observations as { description: string; methods: string[]; "relevant-evidence": { description: string; remarks?: string }[] }[];
  const risks = body.risks as { description: string; statement: string; status: string; remediations: { lifecycle: string; description: string; links?: { href: string }[]; props?: { name: string; value: string }[] }[] }[];
  const items = body["poam-items"] as { remarks: string; links: { href: string }[]; props: { name: string; value: string }[] }[];
  assert.match(observations[0].description, /KSV-0020/);
  assert.match(observations[0].description, /KSV-0021/);
  assert.doesNotMatch(observations[0].description, /Illustrative reviewer decision/);
  assert.equal(observations[0].methods.includes("UNKNOWN"), false);
  assert.equal(observations[0].methods.includes("EXAMINE"), true);
  assert.notEqual(risks[0].description.trim().toLowerCase(), "open");
  assert.notEqual(risks[0].statement.trim().toLowerCase(), "open");
  assert.match(risks[0].statement, /KSV-0020/);
  assert.match(risks[0].statement, /application UID and primary GID > 10000/);
  assert.match(risks[0].statement, /Agency risk acceptance is not recorded/);
  assert.equal(risks[0].status, "open");
  assert.equal(JSON.stringify(document).includes('"closed"'), false);
  const checks = [
    "Configuration rescan no longer reports KSV-0020 or KSV-0021",
    "Actual application process UID and GID match the corrected manifest",
    "Corrected workload remains ready and /healthz succeeds",
  ];
  for (const check of checks) {
    assert.equal(JSON.stringify(risks[0].remediations).includes(check), true, check);
    assert.equal(items[0].remarks.includes(check), true, check);
  }
  const bodyWithoutRemarks = structuredClone(body) as typeof body;
  delete (bodyWithoutRemarks["poam-items"] as { remarks?: string }[])[0].remarks;
  assert.equal(Object.hasOwn(observations[0], "relevant-evidence"), false);
  assert.equal(observations[0].methods.includes("TEST"), false);
  const rest = JSON.stringify(bodyWithoutRemarks);
  for (const check of checks) assert.equal(rest.includes(check), true, check);
  assert.match(rest, /KSV-0020/);
  const hrefs = items[0].links.map((link) => link.href);
  assert.equal(hrefs.some((href) => href.includes("/pipelines/2894050908")), true);
  assert.equal(hrefs.some((href) => href.includes("configuration.json")), true);
  assert.equal(hrefs.some((href) => href.includes("manifests.yaml")), true);
  assert.equal(hrefs.some((href) => href.includes("/pipelines/2908682168")), true);
  assert.match(JSON.stringify(risks[0].remediations[0]), /2908682168/);
  assert.equal(risks[0].remediations[0].lifecycle, "planned");
  assert.equal(risks[0].remediations[0].props?.some((prop) => prop.name === "corrective-release" && prop.value === "2908682168"), true);
  assert.equal(items[0].props.some((prop) => prop.name === "poam-id"), false);
  assert.equal(Object.hasOwn(body, "system-id"), true);
  assert.equal(Object.hasOwn(body, "findings"), false);
});

function closedPlan(): RemediationPlan {
  const ready = identityPlan();
  ready.engineeringComplete = true;
  ready.validation = "demonstrated";
  ready.validationNote = "Illustrative ISSE review of the scoped recorded tests.";
  ready.validator = "Illustrative ISSE";
  ready.validationDate = "2026-10-03";
  ready.validationRecorded = true;
  ready.readyForReview = true;
  ready.repository = "Illustrative designated repository";
  ready.officialId = "ILLUSTRATIVE-POAM-ID";
  ready.protectionDisposition = "Illustrative disposition: maintain protection for remaining scope.";
  ready.closure = { reference:"Illustrative external decision", approver:"Illustrative external approver", date:"2026-10-03", officialId:ready.officialId, recorded:true };
  assert.deepEqual(closureProblems(ready), []);
  return ready;
}

test("closure status requires the full engineering, verification and external-reference gates", () => {
  const ready = closedPlan();
  const closed = documentOf(ready);
  assert.equal(validatePlanOfAction(closed).ok, true);
  assert.equal((poam(closed).risks as { status: string }[])[0].status, "closed");
  ready.closure.recorded = false;
  assert.equal((poam(documentOf(ready)).risks as { status: string }[])[0].status, "open");
  const breakGate: ((p:RemediationPlan)=>void)[] = [
    p => { p.engineeringComplete=false; }, p => { p.milestones[0].status="Not started"; },
    p => { p.tests[0].evidence=""; }, p => { p.tests[0].verdict="fail"; },
    p => { p.validationRecorded=false; }, p => { p.validator=""; }, p => { p.validationNote=""; },
    p => { p.readyForReview=false; }, p => { p.repository=""; }, p => { p.officialId=""; },
    p => { p.protectionDisposition=""; }, p => { p.closure.reference=""; }, p => { p.closure.approver=""; },
    p => { p.closure.date="2026-02-30"; }, p => { p.closure.officialId="wrong-ID"; },
  ];
  for (const change of breakGate) {
    const plan = closedPlan();
    change(plan);
    const exported = documentOf(plan);
    assert.equal(validatePlanOfAction(exported).ok, true);
    assert.equal((poam(exported).risks as { status:string }[])[0].status,"open",change.toString());
    assert.equal(normalizeStoredPlan(plan)?.closure.recorded,false);
  }
});

test("export preserves review provenance, multiline rationale and real versus illustrative evidence", () => {
  const plan = closedPlan();
  plan.asset = "AFFECTED-ASSET-MARKER";
  plan.assessment.requirement = "APPLICABLE-REQUIREMENT-MARKER\nSecond requirement line";
  plan.assessment.reference = "ASSESSMENT-REFERENCE-MARKER";
  plan.validator = "REVIEWER-PROVENANCE-MARKER";
  plan.validationNote = "VERIFICATION-RATIONALE-MARKER\nSecond rationale line";
  plan.resources = "RESOURCES-MARKER";
  plan.protection = "INTERIM-PROTECTION-MARKER";
  plan.source.releaseSha256 = "f".repeat(64);
  plan.receivedVerification = { pipelineUrl:plan.releaseUrl,commit:"e".repeat(40),releaseSha256:"d".repeat(64) };
  plan.tests[0].artifactSha256 = "c".repeat(64);
  plan.tests[0].verdict = "pass";
  plan.history.push({at:"2026-10-03T12:00:00Z",action:"Record review history"});
  const document = documentOf(plan);
  const validated = validatePlanOfAction(document);
  assert.equal(validated.ok,true,validated.ok ? "" : validated.errors.join("\n"));
  for (const marker of [plan.asset,plan.assessment.reference,plan.validator,plan.resources,plan.protection,plan.source.releaseSha256,plan.closure.reference,plan.closure.approver,plan.receivedVerification.commit]) assert.ok(JSON.stringify(document).includes(marker),marker);
  const body = poam(document);
  const observations = body.observations as { props:{name:string;value:string;ns:string;remarks?:string}[]; "relevant-evidence":{props:{name:string;value:string;ns:string}[]}[] }[];
  const requirement = observations[0].props.find(p=>p.name==="applicable-requirement");
  assert.equal(requirement?.remarks,plan.assessment.requirement);
  assert.equal(requirement?.ns,REMEDIATION_NAMESPACE);
  assert.equal(observations[0].props.find(p=>p.name==="illustrative-assessment")?.value,"true");
  assert.equal(observations[0]["relevant-evidence"][0].props.find(p=>p.name==="illustrative")?.value,"false");
  assert.equal(observations[0]["relevant-evidence"][0].props.find(p=>p.name==="artifact-sha256")?.value,plan.tests[0].artifactSha256);
  const resources = (body["back-matter"] as {resources:{uuid:string;base64?:{value:string};rlinks?:{href:string;hashes:{algorithm:string;value:string}[]}[]}[]}).resources;
  const record = JSON.parse(Buffer.from(resources[0].base64!.value,"base64").toString("utf8"));
  assert.deepEqual(record,normalizeStoredPlan(plan));
  assert.equal(resources[1].rlinks?.[0].hashes[0].value,plan.tests[0].artifactSha256);
  assert.ok(JSON.stringify(body["poam-items"]).includes(`#${resources[0].uuid}`));
  assert.equal(Object.hasOwn(body,"system-id"),true);
});

function memoryBlob(): { io: BlobIo; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    io: {
      async put(pathname, body, allowOverwrite) {
        if (!allowOverwrite && objects.has(pathname)) throw new Error("exists");
        objects.set(pathname, body);
      },
      async get(pathname) {
        return objects.get(pathname) ?? null;
      },
      async list(prefix) {
        return [...objects.keys()].filter((key) => key.startsWith(prefix));
      },
    },
  };
}

describe("saved remediation draft survives a new process", { concurrency: false }, () => {
  test("API normalizes forged closure flags and exports old stored records safely", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const {io} = memoryBlob();
    setBlobIoForTests(io);
    delete process.env.AEGIS_DATA_DIR;
    try {
      const session = Session.create("ea".repeat(16));
      const plan = identityPlan();
      plan.readyForReview = true;
      plan.closure.recorded = true;
      await runWithSession(session,async()=>{
        const response = await putRemediation(new Request("http://localhost/api/remediation",{method:"PUT",body:JSON.stringify({key:"draft",assessment:plan.assessment,assessments:{identity:plan.assessment},plans:[plan]})}));
        assert.equal(response.status,200);
        const stored = await readRemediation(session.id);
        assert.equal((stored?.records[0].plans[0] as RemediationPlan).closure.recorded,false);
        // Also cover legacy records saved before server normalization existed.
        await writeRemediationRecord(session.id,{key:"draft",assessment:plan.assessment,assessments:{},plans:[plan]});
        const exported = await getPlanOfActionFile(new URL(`http://localhost/api/remediation/oscal?id=${plan.id}`));
        assert.equal(exported.status,200);
        const body = await exported.json();
        assert.equal(validatePlanOfAction(body).ok,true);
        assert.equal(poam(body).risks && (poam(body).risks as {status:string}[])[0].status,"open");
        await assert.rejects(()=>putRemediation(new Request("http://localhost/api/remediation",{method:"PUT",body:JSON.stringify({key:"draft",plans:[{...plan,tests:[null]}]})})), /draft is invalid/);
      });
    } finally {
      setBlobIoForTests(null);
      if(previousData===undefined) delete process.env.AEGIS_DATA_DIR;
      else process.env.AEGIS_DATA_DIR=previousData;
    }
  });

  test("writer process exit leaves the draft readable and the export schema-valid", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const dir = mkdtempSync(path.join(os.tmpdir(), "aegis-poam-"));
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", path.join(support, "write-remediation-draft.ts")], {
        cwd: root,
        env: { ...process.env, AEGIS_DATA_DIR: dir, SESSION_ID: sessionId },
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.notEqual(child.pid, process.pid);
      process.env.AEGIS_DATA_DIR = dir;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const stored = await readRemediation(sessionId);
      const plan = stored?.records[0]?.plans[0] as { weakness?: string; owner?: string; control?: string; releaseRef?: string } | undefined;
      assert.equal(plan?.weakness, "Application UID/GID hardening");
      assert.equal(plan?.control, "CM-6");
      assert.match(plan?.owner ?? "", /cmsanchezm/);
      assert.match(plan?.releaseRef ?? "", /2908682168/);
      assert.equal(existsSync(path.join(os.tmpdir(), "aegis-data", "sessions", sessionId, "remediation.json")), false);
      const document = JSON.parse(readFileSync(path.join(dir, "poam-export.json"), "utf8")) as Record<string, unknown>;
      const validated = validatePlanOfAction(document);
      assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
      assert.equal(Object.hasOwn(poam(document), "system-id"), true);
      assert.equal(Object.hasOwn(poam(document), "findings"), false);
    } finally {
      if (previousData === undefined) delete process.env.AEGIS_DATA_DIR;
      else process.env.AEGIS_DATA_DIR = previousData;
      if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with AEGIS_DATA_DIR unset the draft is stored in the blob client", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    const previousVercel = process.env.VERCEL;
    const { io, objects } = memoryBlob();
    setBlobIoForTests(io);
    try {
      delete process.env.AEGIS_DATA_DIR;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.VERCEL;
      const plan = identityPlan();
      await writeRemediationRecord(sessionId, { key: "draft", assessment: plan.assessment, assessments: {}, plans: [plan] });
      const key = remediationBlobPath(sessionId);
      assert.equal(objects.has(key), true);
      assert.match(objects.get(key) ?? "", /Application UID\/GID hardening/);
      assert.equal(existsSync(path.join(root, ".data", "sessions", sessionId, "remediation.json")), false);
      assert.equal(existsSync(path.join(os.tmpdir(), "aegis-data", "sessions", sessionId, "remediation.json")), false);
      const stored = await readRemediation(sessionId);
      assert.equal((stored?.records[0]?.plans[0] as { id?: string } | undefined)?.id, "DRAFT-identity");
    } finally {
      setBlobIoForTests(null);
      if (previousData === undefined) delete process.env.AEGIS_DATA_DIR;
      else process.env.AEGIS_DATA_DIR = previousData;
      if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
  });
});
