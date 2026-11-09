import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  AegisError,
  CATALOG_PIN,
  addEvidence,
  buildPackageSsp,
  emptyPersisted,
  exportOscal,
  findRepoRoot,
  firstIncompleteControlId,
  getPackageState,
  ingestOscalPackage,
  loadFixture,
  referencesModerateProfile,
  renderWord,
  updateControl,
  validatePackageSsp,
} from "../lib/aegis";
import {
  MODERATE_BASELINE_BASE_COUNT,
  MODERATE_BASELINE_COUNT,
  MODERATE_BASELINE_ENHANCEMENT_COUNT,
  MODERATE_PROFILE_VERSION,
  moderateControls,
} from "../lib/aegis/moderate-baseline";
import type { Ctx } from "../lib/aegis/types";

const root = findRepoRoot();
const PROFILE_HREF = "fixtures/rev5/fedramp-rev5-moderate-profile.json";

function ctx(): Ctx {
  return { root, now: () => new Date("2026-10-15T12:00:00.000Z") };
}

function moderateUpload(): string {
  const document = JSON.parse(readFileSync(path.join(root, "fixtures", "upload", "ssp-rev5.json"), "utf8")) as {
    "system-security-plan": { "import-profile": { href: string } };
  };
  document["system-security-plan"]["import-profile"].href = PROFILE_HREF;
  return JSON.stringify(document);
}

test("profile reference matches the vendored Moderate profile only", () => {
  assert.equal(referencesModerateProfile(PROFILE_HREF), true);
  assert.equal(referencesModerateProfile(MODERATE_PROFILE_VERSION), true);
  assert.equal(referencesModerateProfile("2b52ae35-a912-4549-94db-5a43b6607f86"), true);
  assert.equal(referencesModerateProfile(CATALOG_PIN), false);
  assert.equal(referencesModerateProfile("https://fedramp.gov/baselines/rev5/moderate"), false);
  assert.equal(referencesModerateProfile(""), false);
});

test("a package loaded against the Moderate profile lists 323 controls and the gate counts only incomplete controls", () => {
  const started = performance.now();
  const loaded = ingestOscalPackage({
    text: moderateUpload(),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const importMs = performance.now() - started;

  const gateStarted = performance.now();
  const pkg = getPackageState(loaded, ctx());
  const gateMs = performance.now() - gateStarted;

  const baseline = moderateControls();
  assert.equal(pkg.controls.length, MODERATE_BASELINE_COUNT);
  assert.equal(pkg.inScopeCount, 323);
  assert.deepEqual(pkg.controls.map((control) => control.id), baseline.map((control) => control.id));
  assert.equal(baseline.filter((control) => !control.enhancement).length, MODERATE_BASELINE_BASE_COUNT);
  assert.equal(baseline.filter((control) => control.enhancement).length, MODERATE_BASELINE_ENHANCEMENT_COUNT);
  assert.equal(pkg.controls.filter((control, index) => baseline[index]?.enhancement).length, 142);
  assert.equal(pkg.controls.filter((control, index) => baseline[index] && !baseline[index]?.enhancement).length, 181);
  assert.equal(pkg.catalogPin, MODERATE_PROFILE_VERSION);

  const ac1 = pkg.controls.find((control) => control.id === "AC-1");
  const ac2 = pkg.controls.find((control) => control.id === "AC-2");
  const au2 = pkg.controls.find((control) => control.id === "AU-2");
  const enhancement = pkg.controls.find((control) => control.id === "AC-2.1");
  assert.equal(ac1?.blank, true);
  assert.equal(ac1?.complete, false);
  assert.equal(ac1?.implementation, "");
  assert.equal(enhancement?.blank, true);
  assert.equal(ac2?.complete, true);
  assert.equal(ac2?.blank, undefined);
  assert.equal(ac2?.implementation, "Accounts are reviewed each quarter.");
  assert.equal(au2?.complete, false);
  assert.equal(au2?.blank, undefined);
  assert.equal(pkg.controls.filter((control) => control.blank).length, 311);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.gate.incomplete, 312);
  assert.equal(pkg.gate.blank, 311);
  assert.equal(pkg.gate.complete, 11);
  assert.equal(pkg.gate.label, "312 of 323 incomplete");
  assert.equal(pkg.gate.incompleteControlIds.length, 312);
  assert.ok(pkg.gate.incompleteControlIds.includes("AU-2"));
  assert.ok(pkg.gate.incompleteControlIds.includes("AC-1"));
  assert.equal(firstIncompleteControlId(pkg.controls), "AC-1");

  const addressed = updateControl(loaded, "AC-1", {
    implementation: "Policy is reviewed each year.",
    responsibleRole: "Identity and Access Administrator",
  }, ctx());
  assert.equal(addressed.controls.find((control) => control.id === "AC-1")?.implementation, "Policy is reviewed each year.");

  const exportStarted = performance.now();
  const document = buildPackageSsp(loaded, new Date("2026-10-15T12:00:00.000Z"));
  const exportMs = performance.now() - exportStarted;
  const requirements = (document["system-security-plan"] as {
    "control-implementation": { "implemented-requirements": Array<{ "control-id": string; statements?: unknown; "by-components"?: unknown; remarks?: string }> };
  })["control-implementation"]["implemented-requirements"];
  assert.equal(requirements.length, 323);
  const blankExport = requirements.find((item) => item["control-id"] === "ac-1");
  const recordedExport = requirements.find((item) => item["control-id"] === "ac-2");
  assert.equal(blankExport?.["by-components"], undefined);
  assert.equal(blankExport?.statements, undefined);
  assert.match(blankExport?.remarks ?? "", /Uncovered/);
  assert.ok(recordedExport?.["by-components"]);

  const validateStarted = performance.now();
  const validated = validatePackageSsp(document);
  const validateMs = performance.now() - validateStarted;
  assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.map((error) => `${error.path} ${error.controlId ?? ""} ${error.message}`).join("\n"));

  const bad = structuredClone(document) as {
    "system-security-plan": { "control-implementation": { "implemented-requirements": Array<Record<string, unknown>> } };
  };
  const broken = bad["system-security-plan"]["control-implementation"]["implemented-requirements"].find((item) => item["control-id"] === "ac-2");
  assert.ok(broken);
  broken.uuid = "not-a-uuid";
  const rejected = validatePackageSsp(bad);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.errors.length > 0);
  assert.ok(rejected.errors.every((error) => typeof error.path === "string" && error.path.length > 0));
  const controlError = rejected.errors.find((error) => error.controlId === "ac-2");
  assert.ok(controlError, rejected.errors.map((error) => `${error.path} ${error.controlId}`).join("\n"));
  assert.match(controlError.path, /implemented-requirements/);

  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-ssp-"));
  try {
    const exported = exportOscal(loaded, { ...ctx(), outDir });
    assert.match(exported.filename, /package-oscal\.xml$/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  let completed = updateControl(loaded, "AU-2", { responsibleRole: "Identity and Access Administrator" }, ctx());
  completed = addEvidence(completed, "AU-2", {
    title: "Event logging standard",
    type: "Document",
    href: "https://evidence.example/au-2/event-logging.pdf",
  }, ctx());
  const partial = getPackageState(completed, ctx());
  assert.equal(partial.gate.status, "FAIL");
  assert.equal(partial.gate.incomplete, 311);
  assert.equal(partial.gate.complete, 12);
  assert.equal(partial.gate.blank, 311);
  assert.equal(partial.gate.label, "311 of 323 incomplete");
  assert.equal(partial.gate.incompleteControlIds.length, 311);
  assert.ok(partial.gate.incompleteControlIds.includes("AC-1"));
  assert.equal(partial.gate.incompleteControlIds.includes("AU-2"), false);
  assert.equal(partial.controls.find((control) => control.id === "AC-1")?.blank, true);
  assert.equal(partial.pipeline.word.status, "locked");
  assert.equal(partial.pipeline.excel.status, "locked");
  assert.equal(partial.pipeline.baseline.enabled, false);
  const lockedDir = mkdtempSync(path.join(tmpdir(), "aegis-ssp-lock-"));
  try {
    assert.throws(
      () => renderWord(completed, { ...ctx(), outDir: lockedDir }),
      (error: unknown) => error instanceof AegisError && error.code === "GATE_FAIL",
    );
  } finally {
    rmSync(lockedDir, { recursive: true, force: true });
  }

  const role = completed.roles[0]?.title ?? "";
  assert.ok(role);
  for (const control of getPackageState(completed, ctx()).controls) {
    if (control.complete) continue;
    const patch: { implementation?: string; responsibleRole?: string } = {};
    if (!control.implementation.trim()) patch.implementation = `Implementation recorded for ${control.id}.`;
    if (control.responsibleRoleIds.length === 0) patch.responsibleRole = role;
    if (patch.implementation !== undefined || patch.responsibleRole !== undefined) {
      completed = updateControl(completed, control.id, patch, ctx());
    }
    if (control.validEvidenceCount < 1) {
      completed = addEvidence(completed, control.id, {
        title: `Evidence ${control.id}`,
        type: "Document",
        href: `https://evidence.example/${control.oscalId}/record.pdf`,
      }, ctx());
    }
  }
  const passed = getPackageState(completed, ctx());
  assert.equal(passed.gate.status, "PASS");
  assert.equal(passed.gate.incomplete, 0);
  assert.equal(passed.gate.blank, undefined);
  assert.equal(passed.gate.complete, 323);
  assert.equal(passed.gate.label, "323 of 323 complete · gate open");
  assert.equal(passed.controls.every((control) => control.complete && !control.blank), true);
  const full = validatePackageSsp(buildPackageSsp(completed, new Date("2026-10-15T12:00:00.000Z")));
  assert.equal(full.ok, true, full.ok ? "" : full.errors.map((error) => `${error.path} ${error.controlId ?? ""} ${error.message}`).join("\n"));

  console.log(`profile package timing import=${importMs.toFixed(1)}ms gate=${gateMs.toFixed(1)}ms export=${exportMs.toFixed(1)}ms validate=${validateMs.toFixed(1)}ms`);
});

test("an upload control outside the Moderate profile is rejected", () => {
  const document = JSON.parse(moderateUpload()) as {
    "system-security-plan": { "control-implementation": { "implemented-requirements": Array<Record<string, unknown>> } };
  };
  document["system-security-plan"]["control-implementation"]["implemented-requirements"].push(
    { uuid: "99999999-9999-4999-8999-999999999991", "control-id": "zz-9" },
    { uuid: "99999999-9999-4999-8999-999999999992", "control-id": "qq-1" },
  );
  assert.throws(
    () => ingestOscalPackage({
      text: JSON.stringify(document),
      filename: "ssp-rev5.json",
      catalogId: "fedramp-rev5",
    }, ctx()),
    (error: unknown) => {
      assert.ok(error instanceof AegisError);
      assert.equal(error.code, "PROFILE_CONTROLS");
      assert.match(error.message, /QQ-1, ZZ-9/);
      return true;
    },
  );
});

test("the planning example and the 12-control subset stay on their existing control lists", () => {
  const gold = getPackageState(loadFixture(emptyPersisted(), "gold", ctx()), ctx());
  assert.equal(gold.inScopeCount, 12);
  assert.equal(gold.catalogPin, CATALOG_PIN);
  assert.equal(gold.gate.label, "3 of 12 incomplete");
  assert.deepEqual(gold.gate.incompleteControlIds, ["AC-2", "AU-2", "CM-6"]);
  assert.equal(gold.controls.some((control) => control.blank), false);

  const subset = getPackageState(ingestOscalPackage({
    text: readFileSync(path.join(root, "fixtures", "upload", "ssp-rev5.json"), "utf8"),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  assert.equal(subset.inScopeCount, 12);
  assert.equal(subset.gate.label, "1 of 12 incomplete");
  assert.equal(subset.controls.some((control) => control.blank), false);
});

test("the public Moderate sample counts blank controls incomplete and the 12-control sample stays 1 of 12", () => {
  const samplePath = path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json");
  const moderatePath = path.join(root, "public", "samples", "sample-oscal-ssp-rev5-moderate.json");
  const subsetSample = getPackageState(ingestOscalPackage({
    text: readFileSync(samplePath, "utf8"),
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  assert.equal(subsetSample.inScopeCount, 12);
  assert.equal(subsetSample.catalogPin, CATALOG_PIN);
  assert.equal(subsetSample.gate.status, "FAIL");
  assert.equal(subsetSample.gate.label, "1 of 12 incomplete");
  assert.deepEqual(subsetSample.gate.incompleteControlIds, ["AU-2"]);
  assert.equal(subsetSample.gate.blank, undefined);
  assert.equal(subsetSample.controls.some((control) => control.blank), false);
  assert.equal(subsetSample.controls.some((control) => control.id === "AC-1"), false);

  const document = JSON.parse(readFileSync(moderatePath, "utf8")) as {
    "system-security-plan": { "import-profile": { href: string }; "system-characteristics": { "system-name": string } };
  };
  const href = document["system-security-plan"]["import-profile"].href;
  assert.equal(href, PROFILE_HREF);
  assert.equal(referencesModerateProfile(href), true);
  assert.equal(document["system-security-plan"]["system-characteristics"]["system-name"], "Synthetic Moderate sample");

  const loaded = getPackageState(ingestOscalPackage({
    text: JSON.stringify(document),
    filename: "sample-oscal-ssp-rev5-moderate.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  assert.equal(loaded.inScopeCount, MODERATE_BASELINE_COUNT);
  assert.equal(loaded.catalogPin, MODERATE_PROFILE_VERSION);
  assert.equal(loaded.sourceProfileHref, PROFILE_HREF);
  assert.equal(loaded.workspaceName, "Synthetic Moderate sample");
  assert.equal(loaded.boundaryId, "bnd-moderate-sample");
  assert.equal(loaded.gate.status, "FAIL");
  assert.equal(loaded.gate.label, "322 of 323 incomplete");
  assert.equal(loaded.gate.incomplete, 322);
  assert.equal(loaded.gate.complete, 1);
  assert.equal(loaded.gate.blank, 321);
  assert.equal(loaded.controls.filter((control) => control.blank).length, 321);
  assert.equal(loaded.controls.filter((control) => control.blank && !control.complete).length, 321);

  const ac1 = loaded.controls.find((control) => control.id === "AC-1");
  const ac2 = loaded.controls.find((control) => control.id === "AC-2");
  const ac3 = loaded.controls.find((control) => control.id === "AC-3");
  const au2 = loaded.controls.find((control) => control.id === "AU-2");
  assert.equal(ac1?.blank, true);
  assert.equal(ac1?.complete, false);
  assert.equal(ac1?.implementation, "");
  assert.equal(ac3?.blank, true);
  assert.equal(ac3?.complete, false);
  assert.equal(ac2?.blank, undefined);
  assert.equal(ac2?.complete, true);
  assert.equal(au2?.blank, undefined);
  assert.equal(au2?.complete, false);
  assert.equal(au2?.implementation, "Security events ship to the SIEM.");
  assert.equal(firstIncompleteControlId(loaded.controls), "AC-1");
  assert.ok(loaded.gate.incompleteControlIds.includes("AC-1"));
  assert.ok(loaded.gate.incompleteControlIds.includes("AC-3"));
  assert.ok(loaded.gate.incompleteControlIds.includes("AU-2"));
  assert.equal(loaded.gate.incompleteControlIds.includes("AC-2"), false);

  const subsetHref = structuredClone(document);
  subsetHref["system-security-plan"]["import-profile"].href = CATALOG_PIN;
  const unresolved = getPackageState(ingestOscalPackage({
    text: JSON.stringify(subsetHref),
    filename: "sample-oscal-ssp-rev5-moderate.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  assert.equal(unresolved.inScopeCount, 3);
  assert.equal(unresolved.catalogPin, CATALOG_PIN);
  assert.equal(unresolved.gate.label, "2 of 3 incomplete");
  assert.equal(unresolved.gate.blank, undefined);
  assert.equal(unresolved.controls.some((control) => control.blank), false);
  assert.deepEqual(unresolved.controls.map((control) => control.id), ["AC-1", "AC-2", "AU-2"]);
});
