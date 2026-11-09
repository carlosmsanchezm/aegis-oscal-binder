import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { validateAssessmentResults } from "../lib/aegis/assessment-results";
import { buildBinderDocuments } from "../lib/aegis/baseline-binder";
import { rollupControlResults } from "../lib/aegis/control-rollup";
import { MODERATE_BASELINE_COUNT, MODERATE_BASELINE_SOURCE, moderateControls, moderateFamilies } from "../lib/aegis/moderate-baseline";
import { findRepoRoot } from "../lib/aegis/paths";
import { validatePlanOfAction } from "../lib/aegis/poam";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { illustrativeScopedAssessment, newPlan } from "../lib/aegis/remediation";
import { validateContextDocument } from "../lib/aegis/assessment-context";
import { PipelineEvidenceView } from "../components/binder/PipelineEvidenceView";
import { receivedRetest } from "./support/received-retest";

const SCANNER_IDS = ["sast", "dependencies", "image", "configuration", "secrets", "publisher-signature", "built-image-signature", "sbom"];

test("vendored FedRAMP Rev 5 Moderate profile is the baseline and is not a 12-control subset", () => {
  const profile = JSON.parse(readFileSync(`${findRepoRoot()}/${MODERATE_BASELINE_SOURCE}`, "utf8")) as {
    profile: { imports?: Array<{ "include-controls"?: Array<{ "with-ids"?: string[] }> }> };
  };
  const selected = new Set<string>();
  for (const imported of profile.profile.imports ?? []) {
    for (const block of imported["include-controls"] ?? []) {
      for (const id of block["with-ids"] ?? []) selected.add(id.toLowerCase());
    }
  }
  const controls = moderateControls();
  assert.equal(controls.length, selected.size);
  assert.equal(MODERATE_BASELINE_COUNT, 323);
  assert.equal(controls.length, 323);
  assert.equal(moderateFamilies().length, 18);
  assert.equal(controls.filter((control) => control.enhancement).length, 142);
  assert.equal(controls.filter((control) => !control.enhancement).length, 181);
  assert.deepEqual(controls.map((control) => control.oscalId).sort(), [...selected].sort());
  assert.equal(controls.some((control) => control.id === "AC-1"), true);
  assert.equal(controls.some((control) => control.id === "AC-2.1"), true);
});

test("newer stored release replaces only the controls it records", () => {
  const rows = rollupControlResults(mergeStoredReleases([receivedRetest()]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 323);
  assert.equal(byId.get("CM-6")?.result?.releaseId, "2908682168");
  assert.equal(byId.get("CM-6")?.result?.checks.length, 0);
  assert.match(byId.get("CM-6")?.result?.finding ?? "", /one remaining finding: KSV-0125/);
  assert.equal(byId.get("CM-6")?.result?.correctiveReleaseId, "");
  assert.equal(byId.get("AC-6")?.result?.releaseId, "2894050908");
  assert.equal(byId.get("SC-7")?.result?.releaseId, "2894050908");
  assert.equal(byId.get("AC-1")?.result, null);
  assert.equal(byId.get("AT-1")?.result, null);
  assert.equal(rows.filter((row) => row.result).length, 15);
  for (const id of SCANNER_IDS) assert.equal(byId.has(id.toUpperCase()), false);
  assert.equal(CCM_EXAMPLE.checks.length, 8);
  assert.notDeepEqual(CCM_EXAMPLE.checks.map((check) => check.id), byId.get("CM-6")?.result?.checks.map((check) => check.description));
});

test("three OSCAL files keep the full baseline, the CM-6 retest, and blank agency fields", () => {
  const item = CCM_EXAMPLE.reviewItems?.[0];
  if (!item?.scope) throw new Error("missing review item");
  const plan = newPlan(CCM_EXAMPLE, item.description, illustrativeScopedAssessment(item.scope), "DRAFT-rollup", "2026-10-03T12:00:00.000Z");
  const documents = buildBinderDocuments(mergeStoredReleases([receivedRetest()]), plan, new Date("2026-10-03T18:00:00.000Z"));
  const assessment = validateAssessmentResults(documents.assessmentResults);
  assert.equal(assessment.ok, true, assessment.ok ? "" : assessment.errors.join("\n"));
  const poam = validatePlanOfAction(documents.poam);
  assert.equal(poam.ok, true, poam.ok ? "" : poam.errors.join("\n"));
  const ssp = documents.ssp["system-security-plan"] as {
    "control-implementation": { "implemented-requirements": Array<{ "control-id": string; statements?: unknown; "implementation-status"?: unknown }> };
    "system-characteristics": { "system-ids": Array<{ "identifier-type": string }> };
  };
  assert.deepEqual(validateContextDocument(documents.ssp, "system-security-plan"), []);
  const requirements = ssp["control-implementation"]["implemented-requirements"];
  assert.equal(requirements.length, 323);
  const blank = requirements.find((item) => item["control-id"] === "ac-1");
  const recorded = requirements.find((item) => item["control-id"] === "cm-6");
  assert.equal(blank?.statements, undefined);
  assert.equal(JSON.stringify(blank).includes("implementation-status"), false);
  assert.equal(recorded?.statements, undefined);
  assert.equal(JSON.stringify(requirements).includes("implementation-status"), false);
  assert.equal(ssp["system-characteristics"]["system-ids"][0]["identifier-type"], "urn:aegis:system-id:internal");
  const encoded = JSON.stringify(documents);
  for (const field of ["official-poam-id", "accepted-risk", "agency-system-id"]) assert.equal(encoded.includes(`"${field}"`), false);
  assert.equal(encoded.includes('"owner"'), false);
  const result = (documents.assessmentResults["assessment-results"] as { results: Array<Record<string, unknown>> }).results[0];
  const findings = result.findings as Array<{ description: string; target: { status: { state: string } } }>;
  assert.equal(findings.length, 1);
  assert.match(findings[0].description, /KSV-0020/);
  assert.equal(findings[0].target.status.state, "not-satisfied");
  const evidence = JSON.stringify((result.observations as Array<Record<string, unknown>>).find((item) => JSON.stringify(item).includes("CM-6")));
  assert.match(evidence, /Configuration rescan no longer reports KSV-0020 or KSV-0021/);
  assert.match(evidence, /Actual application process UID and GID match the corrected manifest/);
  assert.match(evidence, /Corrected workload remains ready and \/healthz succeeds/);
  assert.match(JSON.stringify(result), /2908682168/);
  assert.equal((result.risks as Array<{ status: string }>)[0].status, "open");
  const reviewed = JSON.stringify(result["reviewed-controls"]);
  assert.match(reviewed, /ac-1/);
  assert.match(reviewed, /cm-6/);
  for (const id of SCANNER_IDS) assert.equal(reviewed.includes(`"${id}"`), false);
  const poamBody = documents.poam["plan-of-action-and-milestones"] as { "poam-items": unknown[]; risks: Array<{ status: string }> };
  assert.equal(poamBody["poam-items"].length, 1);
  assert.equal(poamBody.risks[0].status, "open");
});

test("release screen lists every Moderate family and leaves unproven controls blank", () => {
  const markup = renderToStaticMarkup(createElement(PipelineEvidenceView));
  assert.equal((markup.match(/data-family="[A-Z]{2}"/g) ?? []).length,18);
  assert.match(markup, /Awareness and Training/);
  assert.match(markup, /Physical and Environmental Protection/);
  assert.match(markup, /aria-label="AT · Awareness and Training · 0 with evidence · 0 suggested · 6 total"/);
  assert.match(markup, /aria-label="CM · Configuration Management · 2 with evidence · 0 suggested · 27 total"/);
  const expanded = renderToStaticMarkup(createElement(PipelineEvidenceView, { coverageNavigation: { expanded: true, family: null, filter: "all" } }));
  assert.match(expanded, /data-control="AT-1"[^>]*data-result="blank"/);
  assert.match(expanded, /data-control="AC-1"[^>]*data-result="blank"/);
  assert.match(expanded, /data-control="CM-6"[^>]*data-result="recorded"/);
  assert.match(expanded, /data-control="AC-6"[^>]*data-result="recorded"/);
  assert.match(markup, /#2894050908/);
  assert.match(markup, /SAST/);
  assert.doesNotMatch(markup, /KSI-/);
  assert.match(markup, /No FedRAMP authorization or agency ATO/);
});
