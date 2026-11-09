import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { buildAssessmentResults, validateAssessmentResults } from "../lib/aegis/assessment-results";
import { findRepoRoot } from "../lib/aegis/paths";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { applyRetestPacket, closureProblems, illustrativeScopedAssessment, newPlan, type RemediationPlan } from "../lib/aegis/remediation";
import { readRemediation, writeRemediationRecord } from "../lib/aegis/remediation-store";
import { setBlobIoForTests, type BlobIo } from "../lib/durable";
import { Session, runWithSession } from "../lib/aegis/store";
import { getAssessmentResultsFile } from "../lib/server/remediation-draft";
import { resolveContextDocument, validateContextDocument } from "../lib/aegis/assessment-context";

const root = findRepoRoot();
const CHECKS = [
  "Configuration rescan no longer reports KSV-0020 or KSV-0021",
  "Actual application process UID and GID match the corrected manifest",
  "Corrected workload remains ready and /healthz succeeds",
];

function uidPlan(): RemediationPlan {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-identity", "2026-10-03T12:00:00.000Z");
  plan.owner = "cmsanchezm";
  plan.risk = "open";
  plan.action = "Corrective release 2908682168";
  plan.releaseUrl = "https://gitlab.com/enbuild-staging/enbuild-deployments/podinfo-gsa-evidence-0928/-/pipelines/2908682168";
  return plan;
}

function recordedPlan(): RemediationPlan {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("identity review item is missing");
  const packet = JSON.parse(readFileSync(path.join(root, "public/samples/remediation/podinfo-identity-retest.json"), "utf8")) as unknown;
  return applyRetestPacket(
    newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-identity", "2026-10-03T12:00:00.000Z"),
    packet,
  );
}

function documentOf(plan: RemediationPlan): Record<string, unknown> {
  return buildAssessmentResults(plan, new Date("2026-10-03T18:00:00.000Z"));
}

function results(document: Record<string, unknown>): Record<string, unknown> {
  return document["assessment-results"] as Record<string, unknown>;
}

function resultOf(document: Record<string, unknown>): {
  props: { name: string; value: string }[];
  links: { href: string; text: string }[];
  observations: { description: string; methods: string[]; "relevant-evidence": { description: string }[] }[];
  findings: { title: string; description: string; target: { "target-id": string; status: { state: string } } }[];
  risks: { status: string; props: { name: string; value: string }[]; remediations?: { props?: { name: string; value: string }[] }[] }[];
  "reviewed-controls": { "control-selections": { "include-controls": { "control-id": string }[] }[] };
} {
  return (results(document).results as Record<string, unknown>[])[0] as ReturnType<typeof resultOf>;
}

test("uid/gid draft exports a schema-valid open assessment results file for the recorded item", () => {
  const document = documentOf(uidPlan());
  const validated = validateAssessmentResults(document);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
  const body = results(document);
  const metadata = body.metadata as { "oscal-version": string };
  const result = resultOf(document);
  assert.equal(metadata["oscal-version"], "1.1.2");
  assert.equal((body.results as unknown[]).length, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, "Application UID/GID hardening");
  assert.match(result.findings[0].description, /KSV-0020/);
  assert.match(result.findings[0].description, /KSV-0021/);
  assert.match(result.findings[0].description, /UID/);
  assert.match(result.findings[0].description, /GID/);
  assert.doesNotMatch(result.findings[0].description, /Illustrative reviewer decision/);
  assert.doesNotMatch(result.findings[0].description, /KSV-0125/);
  assert.equal(result.observations[0].methods.includes("EXAMINE"), true);
  assert.equal(result.observations[0].methods.includes("UNKNOWN"), false);
  assert.equal(result["reviewed-controls"]["control-selections"][0]["include-controls"][0]["control-id"], "aegis-context-cm-6");
  assert.match(result.findings[0].target["target-id"], /^aegis-objective-/);
  assert.equal(result.findings[0].target.status.state, "not-satisfied");
  for (const check of CHECKS) {
    assert.equal(JSON.stringify(result.risks[0].remediations).includes(check), true, check);
  }
  assert.equal(Object.hasOwn(result.observations[0], "relevant-evidence"), false);
  assert.equal(result.observations[0].methods.includes("TEST"), false);
  assert.equal(result.props.some((prop) => prop.name === "source-pipeline-id" && prop.value === "2894050908"), true);
  assert.equal(result.links.some((link) => link.href.includes("/pipelines/2894050908")), true);
  assert.equal(result.props.some((prop) => prop.name === "corrective-release" && prop.value === "2908682168"), true);
  assert.equal(result.links.some((link) => link.href.includes("/pipelines/2908682168")), true);
  assert.equal(result.risks[0].status, "open");
  assert.equal(JSON.stringify(document).includes('"closed"'), false);
  assert.equal(result.risks[0].props.some((prop) => prop.name.startsWith("external-decision")), false);
  assert.equal(result.props.some((prop) => prop.name === "official-poam-id"), false);
  assert.equal(result.props.some((prop) => prop.name === "repository"), false);
  assert.equal(JSON.stringify(document).includes("system-id"), false);
  assert.equal(JSON.stringify(document).includes("binder.remediation-draft.v1"), false);
  assert.equal(JSON.stringify(document).includes('"base64"'), true);
  assert.equal(Object.hasOwn(document, "plan-of-action-and-milestones"), false);
});

test("recorded retest keeps the same finding, checks, source pipeline and corrective release", () => {
  const document = documentOf(recordedPlan());
  const validated = validateAssessmentResults(document);
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("\n"));
  const result = resultOf(document);
  assert.match(result.findings[0].description, /KSV-0020/);
  assert.match(result.findings[0].description, /KSV-0021/);
  assert.equal(result.observations[0].methods.includes("EXAMINE"), true);
  assert.equal(result["reviewed-controls"]["control-selections"][0]["include-controls"].some((item) => item["control-id"] === "aegis-context-cm-6"), true);
  for (const check of CHECKS) {
    assert.equal(result.observations[0]["relevant-evidence"].some((entry) => entry.description.includes(check)), true, check);
  }
  assert.match(JSON.stringify(result), /2894050908/);
  assert.match(JSON.stringify(result), /2908682168/);
  assert.equal(result.risks[0].status, "open");
  assert.equal(result.findings.length, 1);
  assert.equal(JSON.stringify(document).includes('"base64"'), true);
});

test("a draft without a corrective release does not invent one, and closure stays blank", () => {
  const plan = uidPlan();
  plan.action = "Set the application user and group.";
  plan.releaseUrl = "";
  const document = documentOf(plan);
  assert.equal(validateAssessmentResults(document).ok, true);
  const encoded = JSON.stringify(document);
  assert.equal(encoded.includes("2908682168"), false);
  assert.match(encoded, /2894050908/);
  assert.equal(resultOf(document).risks[0].status, "open");
  assert.equal(resultOf(document).props.some((prop) => prop.name === "corrective-release"), false);
  plan.readyForReview = true;
  plan.closure.recorded = true;
  const forced = documentOf(plan);
  assert.equal(validateAssessmentResults(forced).ok, true);
  assert.equal(resultOf(forced).risks[0].status, "open");
  assert.equal(JSON.stringify(forced).includes('"closed"'), false);
});

test("closure fields appear only when the draft records a complete closure decision", () => {
  const ready = recordedPlan();
  ready.engineeringComplete = true;
  ready.validation = "demonstrated";
  ready.validationNote = "Recorded ISSE review of the scoped tests.";
  ready.validator = "Recorded ISSE";
  ready.validationDate = "2026-10-03";
  ready.validationRecorded = true;
  ready.readyForReview = true;
  ready.repository = "Designated repository";
  ready.officialId = "RECORDED-POAM-ID";
  ready.protectionDisposition = "Maintain the recorded protection for the remaining scope.";
  ready.closure = { reference: "Recorded external decision", approver: "Recorded approver", date: "2026-10-03", officialId: ready.officialId, recorded: true };
  assert.deepEqual(closureProblems(ready), []);
  const document = documentOf(ready);
  assert.equal(validateAssessmentResults(document).ok, true);
  const result = resultOf(document);
  assert.equal(result.risks[0].status, "closed");
  assert.equal(result.findings[0].target.status.state, "satisfied");
  assert.equal(result.props.some((prop) => prop.name === "official-poam-id" && prop.value === "RECORDED-POAM-ID"), true);
  assert.equal(result.props.some((prop) => prop.name === "repository" && prop.value === "Designated repository"), true);
  assert.equal(result.risks[0].props.some((prop) => prop.name === "external-decision-reference" && prop.value === "Recorded external decision"), true);
  assert.equal(JSON.stringify(document).includes("system-id"), false);
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

test("assessment plan, scoped SSP, catalog and finding objective resolve without external dependencies", () => {
  const plan=recordedPlan();
  const document=documentOf(plan);
  const body=results(document) as any;
  const ap=resolveContextDocument(body,body["import-ap"].href,"assessment-plan");
  const ssp=resolveContextDocument(ap["assessment-plan"],ap["assessment-plan"]["import-ssp"].href,"system-security-plan");
  const catalog=resolveContextDocument(ssp["system-security-plan"],ssp["system-security-plan"]["import-profile"].href,"catalog");
  assert.deepEqual(validateContextDocument(ap,"assessment-plan"),[]);
  assert.deepEqual(validateContextDocument(ssp,"system-security-plan"),[]);
  assert.deepEqual(validateContextDocument(catalog,"catalog"),[]);
  const objective=ap["assessment-plan"]["local-definitions"]["objectives-and-methods"][0];
  const part=objective.parts.find((p:any)=>p.name==="assessment-objective");
  assert.equal(part.prose,plan.assessment.requirement);
  assert.equal(body.results[0].findings[0].target["target-id"],part.id);
  assert.equal(objective["control-id"],catalog.catalog.controls[0].id);
  assert.equal(catalog.catalog.controls[0].props.find((p:any)=>p.name==="source-control-reference").value,"CM-6");
  assert.equal(ssp["system-security-plan"]["system-characteristics"]["system-ids"][0]["identifier-type"],"urn:aegis:system-id:internal");
  assert.equal(ssp["system-security-plan"]["system-characteristics"]["security-sensitivity-level"],undefined);
  for (const doc of [ap,ssp,catalog]) assert.equal(JSON.stringify(doc).includes("binder.remediation-draft.v1"),false);
});

test("assessment results reject title-only plans, wrong attachment types and unresolved objectives", () => {
  const mutations:((doc:any)=>void)[]=[
    d=>{delete d["assessment-results"]["back-matter"].resources[0].base64;},
    d=>{d["assessment-results"]["import-ap"].href="#00000000-0000-4000-8000-000000000000";},
    d=>{d["assessment-results"].results[0].findings[0].target["target-id"]="CM-6";},
    d=>{delete d["assessment-results"].results[0]["reviewed-controls"]["control-objective-selections"];},
    d=>{d["assessment-results"]["back-matter"].resources[0].base64.value=Buffer.from(JSON.stringify({catalog:{}})).toString("base64");},
    d=>{d["assessment-results"]["back-matter"].resources[0].base64.value=Buffer.from("not JSON").toString("base64");},
  ];
  for (const mutate of mutations) {
    const doc=documentOf(recordedPlan());
    mutate(doc);
    assert.equal(validateAssessmentResults(doc).ok,false,mutate.toString());
  }
});

test("local objective verification is independent of external risk closure",()=>{
  const plan=recordedPlan();
  plan.engineeringComplete=true;
  plan.validation="demonstrated";
  plan.validationNote="Scoped review of the recorded UID/GID tests only.";
  plan.validator="Illustrative ISSE";
  plan.validationDate="2026-10-03";
  plan.validationRecorded=true;
  const doc=documentOf(plan);
  assert.equal(validateAssessmentResults(doc).ok,true);
  assert.equal(resultOf(doc).findings[0].target.status.state,"satisfied");
  assert.equal(resultOf(doc).risks[0].status,"open");
  plan.validationRecorded=false;
  assert.equal(resultOf(documentOf(plan)).findings[0].target.status.state,"not-satisfied");
});

test("assessment context follows the saved requirement rather than a hard-coded control or objective",()=>{
  const plan=uidPlan();
  plan.control="SC-7";
  plan.assessment.requirement="Only the explicitly approved gateway path is allowed.";
  plan.assessment.scope!.controls=["SC-7"];
  plan.assessment.scope!.verification=["Verify the allowed gateway path"];
  plan.tests=[{id:"test-custom",description:"Verify the allowed gateway path",evidence:"",result:"",reviewer:"",date:"",illustrative:false}];
  const document=documentOf(plan);
  assert.equal(validateAssessmentResults(document).ok,true);
  const body=results(document) as any;
  const ap=resolveContextDocument(body,body["import-ap"].href,"assessment-plan");
  const obj=ap["assessment-plan"]["local-definitions"]["objectives-and-methods"][0];
  assert.equal(obj["control-id"],"aegis-context-sc-7");
  assert.equal(obj.parts[0].prose,plan.assessment.requirement);
  assert.match(obj.parts[2].parts[0].prose,/approved|gateway/);
});

describe("saved draft assessment results download", { concurrency: false }, () => {
  test("release storage failure blocks export instead of substituting examples", async()=>{
    const previousData=process.env.AEGIS_DATA_DIR;
    const {io}=memoryBlob();
    setBlobIoForTests(io);
    delete process.env.AEGIS_DATA_DIR;
    try {
      const session=Session.create("cd".repeat(16));
      const plan=recordedPlan();
      await runWithSession(session,async()=>{
        await writeRemediationRecord(session.id,{key:"draft",assessment:plan.assessment,assessments:{},plans:[plan]});
        setBlobIoForTests({...io,async list(){throw new Error("test release storage unavailable");}});
        await assert.rejects(()=>getAssessmentResultsFile(new URL(`http://localhost/api/remediation/assessment-results?id=${plan.id}`)),/storage unavailable/);
      });
    } finally {
      setBlobIoForTests(null);
      if(previousData===undefined) delete process.env.AEGIS_DATA_DIR; else process.env.AEGIS_DATA_DIR=previousData;
    }
  });
  test("the API returns the OSCAL file for the saved UID/GID draft", async () => {
    const previousData = process.env.AEGIS_DATA_DIR;
    const { io } = memoryBlob();
    setBlobIoForTests(io);
    delete process.env.AEGIS_DATA_DIR;
    try {
      const session = Session.create("ab".repeat(16));
      const plan = recordedPlan();
      await runWithSession(session, async () => {
        await writeRemediationRecord(session.id, { key: "draft", assessment: plan.assessment, assessments: {}, plans: [plan] });
        const stored = await readRemediation(session.id);
        assert.equal((stored?.records[0].plans[0] as RemediationPlan).weakness, "Application UID/GID hardening");
        const response = await getAssessmentResultsFile(new URL(`http://localhost/api/remediation/assessment-results?id=${plan.id}`));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-disposition") ?? "", /assessment-results\.json/);
        const document = await response.json() as Record<string, unknown>;
        assert.equal(validateAssessmentResults(document).ok, true);
        const result = resultOf(document);
        assert.match(result.findings[0].description, /KSV-0020/);
        assert.equal(result.observations.some((item) => item.methods.includes("EXAMINE")), true);
        const reviewed = result["reviewed-controls"]["control-selections"][0]["include-controls"].map((item) => item["control-id"]);
        assert.equal(reviewed.length, 323);
        assert.equal(reviewed.includes("cm-6"), true);
        assert.equal(reviewed.includes("ac-1"), true);
        assert.equal(result.findings.length, 1);
        for (const check of CHECKS) assert.equal(JSON.stringify(result).includes(check), true, check);
        assert.match(JSON.stringify(result), /2894050908/);
        assert.match(JSON.stringify(result), /2908682168/);
        assert.equal(result.risks[0].status, "open");
        assert.equal(Object.hasOwn(document, "schema"), false);
        assert.equal(JSON.stringify(document).includes('"base64"'), true);
      });
    } finally {
      setBlobIoForTests(null);
      if (previousData === undefined) delete process.env.AEGIS_DATA_DIR;
      else process.env.AEGIS_DATA_DIR = previousData;
    }
  });
});
