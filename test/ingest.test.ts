import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CATALOG_20X_PIN,
  CATALOG_20X_STUB_NOTE,
  CATALOG_PIN,
  addEvidence,
  addEvidenceFile,
  emptyPersisted,
  findRepoRoot,
  firstIncompleteControlId,
  getPackageState,
  ingestCsvPackage,
  ingestOscalPackage,
  loadCatalog,
  loadFixture,
  selectCatalog,
  serializeOscal,
  updateControl,
  validateOscalXml,
} from "../lib/aegis";
import { AegisError } from "../lib/aegis/errors";
import { resolveEvidenceHref } from "../lib/aegis/paths";
import type { Ctx, PersistedState } from "../lib/aegis/types";

const root = findRepoRoot();
const AC2 = "Accounts provisioned via the IdP with manager approval; inactive accounts disabled after 35 days.";
const CM6 = "Configuration settings are enforced from the signed baseline; deviations require a recorded exception.";

function ctx(): Ctx {
  return { root, now: () => new Date("2026-09-23T14:12:00.000Z") };
}

function readUpload(name: string): string {
  return readFileSync(path.join(root, "fixtures", "upload", name), "utf8");
}

function passPackage(state: PersistedState): PersistedState {
  const current = ctx();
  let next = updateControl(state, "AC-2", { implementation: AC2, responsibleRole: "CSP IAM Administrator" }, current);
  next = addEvidence(next, "AC-2", {
    title: "Quarterly account review",
    type: "Document",
    href: "evidence/ac-2/iam-review-2026-08.pdf",
  }, current);
  next = addEvidence(next, "AU-2", {
    title: "SIEM logging standard",
    type: "Document",
    href: "evidence/au-2/event-logging-standard-2026-08.pdf",
  }, current);
  next = updateControl(next, "CM-6", { implementation: CM6 }, current);
  return next;
}

test("catalog baselines keep Rev5 live and 20x as a separate stub", () => {
  const rev5 = loadCatalog(root, "fedramp-rev5");
  const stub = loadCatalog(root, "fedramp-20x");
  assert.equal(rev5.pin, CATALOG_PIN);
  assert.equal(rev5.status, "live");
  assert.ok(rev5.controls.length > 12);
  assert.equal(rev5.controls[0]?.id, "AC-1");
  assert.equal(rev5.controls.find((control) => control.id === "AC-2")?.title, "Account Management");
  assert.equal(rev5.controls.find((control) => control.id === "CP-2")?.title, "Contingency Plan");
  assert.equal(stub.id, "fedramp-20x");
  assert.equal(stub.pin, CATALOG_20X_PIN);
  assert.notEqual(stub.pin, rev5.pin);
  assert.equal(stub.status, "stub");
  assert.equal(stub.note, CATALOG_20X_STUB_NOTE);
  assert.match(stub.note, /not vendored/);
  assert.equal(stub.controls.length, 4);
  assert.equal(stub.controls[0]?.id, "KSI-IAM");
  const pkg = getPackageState(emptyPersisted(), ctx());
  assert.equal(pkg.catalog.id, null);
  assert.equal(pkg.catalog.status, "unselected");
  assert.equal(pkg.catalog.bound, false);
  assert.equal(pkg.catalogPin, null);
  assert.equal(emptyPersisted().catalogId, null);
  assert.deepEqual(pkg.catalogChoices.map((item) => item.pin), [CATALOG_PIN, CATALOG_20X_PIN]);
  assert.notEqual(CATALOG_PIN, CATALOG_20X_PIN);
  assert.throws(() => ingestOscalPackage({
    text: readUpload("ssp-rev5.json"),
    filename: "ssp-rev5.json",
    catalogId: "",
  }, ctx()), (error: unknown) => error instanceof AegisError && error.code === "CATALOG_REQUIRED");
});

test("selecting a catalog is refused after a package is loaded", () => {
  const loaded = loadFixture(emptyPersisted(), "gold", ctx());
  const pending = selectCatalog(emptyPersisted(), "fedramp-20x");
  assert.equal(pending.catalogId, "fedramp-20x");
  assert.equal(pending.catalogPin, CATALOG_20X_PIN);
  assert.equal(pending.loaded, false);
  const rev5 = selectCatalog(pending, "fedramp-rev5");
  assert.equal(rev5.catalogPin, CATALOG_PIN);
  const gold = loadFixture(pending, "gold", ctx());
  assert.equal(gold.boundaryId, "bnd-gold-0001");
  assert.equal(gold.catalogId, "fedramp-rev5");
  assert.equal(gold.catalogPin, CATALOG_PIN);
  assert.throws(() => selectCatalog(loaded, "fedramp-20x"), (error: unknown) => {
    return error instanceof AegisError && error.code === "READ_ONLY";
  });
  assert.throws(() => selectCatalog(emptyPersisted(), "rev4"), (error: unknown) => {
    return error instanceof AegisError && error.code === "UNKNOWN_CATALOG";
  });
});

test("OSCAL JSON upload builds the workspace from the package", () => {
  const state = ingestOscalPackage({
    text: readUpload("ssp-rev5.json"),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const pkg = getPackageState(state, ctx());
  assert.equal(pkg.loaded, true);
  assert.equal(pkg.workspaceName, "Upload sample CSP");
  assert.equal(pkg.boundaryId, "bnd-upload-rev5");
  assert.equal(pkg.catalogPin, CATALOG_PIN);
  assert.equal(pkg.catalog.id, "fedramp-rev5");
  assert.equal(pkg.catalog.status, "live");
  assert.equal(pkg.catalog.bound, true);
  assert.equal(pkg.ingestKind, "oscal");
  assert.equal(pkg.sourceFilename, "ssp-rev5.json");
  assert.equal(pkg.inScopeCount, 12);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.gate.label, "1 of 12 incomplete");
  assert.deepEqual(pkg.gate.incompleteControlIds, ["AU-2"]);
  assert.equal(firstIncompleteControlId(pkg.controls), "AU-2");
  assert.deepEqual(pkg.controls.map((control) => control.id), [
    "AC-2", "AC-3", "AC-6", "AU-2", "AU-6", "CM-2", "CM-6", "IA-2", "IA-5", "SC-7", "SC-8", "SI-2",
  ]);
  const ac2 = pkg.controls.find((control) => control.id === "AC-2");
  assert.equal(ac2?.title, "Account Management");
  assert.equal(ac2?.family, "AC");
  assert.equal(ac2?.implementation, "Accounts are reviewed each quarter.");
  assert.equal(ac2?.responsibleRole, "Identity and Access Administrator");
  assert.equal(ac2?.complete, true);
  assert.equal(ac2?.evidence[0]?.id, "EV-AC2-01");
  assert.equal(ac2?.evidence[0]?.href, "https://evidence.example/ac-2/account-review.pdf");
  const au2 = pkg.controls.find((control) => control.id === "AU-2");
  assert.equal(au2?.title, "Event Logging");
  assert.equal(au2?.implementation, "Security events ship to the SIEM.");
  assert.equal(au2?.complete, false);
  const si2 = pkg.controls.find((control) => control.id === "SI-2");
  assert.equal(si2?.title, "Flaw Remediation");
  assert.equal(si2?.family, "SI");
  assert.equal(si2?.complete, true);
  assert.equal(si2?.evidence[0]?.href, "https://evidence.example/si-2/patch-sla.pdf");
  assert.equal(pkg.controls.filter((control) => control.complete).length, 11);
});

test("OSCAL XML upload accepts the harness serializer and a short NIST-style plan", () => {
  const xml = serializeOscal(passPackage(loadFixture(emptyPersisted(), "gold", ctx())), {
    now: new Date("2026-09-23T14:12:00.000Z"),
  });
  const roundTrip = ingestOscalPackage({ text: xml, filename: "package-oscal.xml", catalogId: "fedramp-rev5" }, ctx());
  assert.equal(roundTrip.controls.length, 12);
  assert.equal(roundTrip.boundaryId, "bnd-gold-0001");
  assert.equal(roundTrip.catalogPin, CATALOG_PIN);
  const ac2 = roundTrip.controls.find((control) => control.id === "AC-2");
  assert.equal(ac2?.implementation, AC2);
  assert.equal(ac2?.responsibleRoleId, "csp-iam-administrator");
  assert.equal(ac2?.evidence[0]?.href, "evidence/ac-2/iam-review-2026-08.pdf");
  assert.equal(ac2?.evidence[0]?.id, "EV-AC2-01");

  const nist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<system-security-plan xmlns="http://csrc.nist.gov/ns/oscal/1.0" uuid="12121212-1212-4121-8121-121212121212">',
    "  <metadata>",
    "    <title>XML upload</title>",
    "    <last-modified>2026-09-23T12:00:00.000Z</last-modified>",
    "    <version>1.0.0</version>",
    "    <oscal-version>1.1.3</oscal-version>",
    "    <roles><role id=\"sysadmin\"><title>System Administrator</title></role></roles>",
    "  </metadata>",
    "  <import-profile href=\"https://fedramp.gov/baselines/rev5/moderate\"/>",
    "  <system-characteristics>",
    "    <system-id identifier-type=\"https://ietf.org/rfc/rfc4122\">bnd-xml-0001</system-id>",
    "    <system-name>XML upload</system-name>",
    "    <description><p>Parsed from XML.</p></description>",
    "    <security-sensitivity-level>moderate</security-sensitivity-level>",
    "    <status state=\"operational\"/>",
    "    <authorization-boundary><description>XML boundary.</description></authorization-boundary>",
    "  </system-characteristics>",
    "  <control-implementation>",
    "    <description>Requirements.</description>",
    "    <implemented-requirement control-id=\"ac-3\">",
    "      <responsible-role role-id=\"sysadmin\"/>",
    "      <statement statement-id=\"ac-3_smt\"><description>Access is denied by default.</description></statement>",
    "    </implemented-requirement>",
    "  </control-implementation>",
    "</system-security-plan>",
    "",
  ].join("\n");
  const ingested = ingestOscalPackage({ text: nist, filename: "plan.xml", catalogId: "fedramp-rev5" }, ctx());
  assert.equal(ingested.workspaceName, "XML upload");
  assert.equal(ingested.boundaryId, "bnd-xml-0001");
  assert.equal(ingested.catalogPin, CATALOG_PIN);
  assert.equal(ingested.sourceProfileHref, "https://fedramp.gov/baselines/rev5/moderate");
  assert.equal(ingested.controls[0]?.id, "AC-3");
  assert.equal(ingested.controls[0]?.title, "Access Enforcement");
  assert.equal(ingested.controls[0]?.implementation, "Access is denied by default.");
  assert.equal(ingested.controls[0]?.responsibleRoleId, "sysadmin");
});

test("upload rejects malformed packages and a catalog pin mismatch", () => {
  const cases: Array<[string, string, string]> = [
    ["", "fedramp-rev5", "empty"],
    ["hello", "fedramp-rev5", "not OSCAL"],
    ["{}", "fedramp-rev5", "system-security-plan"],
    [readFileSync(path.join(root, "fixtures", "gold", "fixture.json"), "utf8"), "fedramp-rev5", "demo sample package"],
    ["<not-a-plan/>", "fedramp-rev5", "system-security-plan"],
    [readUpload("ssp-rev5.json"), "fedramp-20x", "FedRAMP Rev5"],
    [readUpload("ssp-20x.json"), "fedramp-rev5", "FedRAMP 20x"],
  ];
  for (const [text, catalogId, fragment] of cases) {
    assert.throws(() => ingestOscalPackage({ text, filename: "bad.txt", catalogId }, ctx()), (error: unknown) => {
      assert.ok(error instanceof AegisError);
      assert.match(error.message, new RegExp(fragment, "i"));
      return error.code === "INGEST_REJECTED" || error.code === "CATALOG_MISMATCH";
    });
  }
  const ssp = JSON.parse(readUpload("ssp-rev5.json")) as {
    "system-security-plan": { "control-implementation": { "implemented-requirements": unknown[] } };
  };
  ssp["system-security-plan"]["control-implementation"]["implemented-requirements"] = [];
  assert.throws(() => ingestOscalPackage({
    text: JSON.stringify(ssp),
    filename: "empty-reqs.json",
    catalogId: "fedramp-rev5",
  }, ctx()), (error: unknown) => error instanceof AegisError && error.code === "INGEST_REJECTED");
});

test("profile validation follows the active catalog pin", () => {
  const now = new Date("2026-09-23T14:12:00.000Z");
  const rev5 = ingestOscalPackage({
    text: readUpload("ssp-rev5.json"),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const rev5Xml = serializeOscal(rev5, { now });
  assert.match(rev5Xml, new RegExp(CATALOG_PIN));
  assert.equal(validateOscalXml(rev5Xml, rev5).some((error) => error.oscalPath === "import-profile/@href"), false);

  const twenty = ingestOscalPackage({
    text: readUpload("ssp-20x.json"),
    filename: "ssp-20x.json",
    catalogId: "fedramp-20x",
  }, ctx());
  const xml = serializeOscal(twenty, { now });
  assert.match(xml, new RegExp(CATALOG_20X_PIN));
  assert.equal(xml.includes(CATALOG_PIN), false);
  assert.equal(validateOscalXml(xml, twenty).some((error) => error.oscalPath === "import-profile/@href"), false);
  const swapped = xml.replaceAll(CATALOG_20X_PIN, CATALOG_PIN);
  const mismatch = validateOscalXml(swapped, twenty);
  assert.ok(mismatch.some((error) => error.check === "Profile" && error.message.includes(CATALOG_20X_PIN)));
  const drifted = { ...twenty, catalogPin: CATALOG_PIN };
  const drift = validateOscalXml(xml, drifted);
  assert.ok(drift.some((error) => error.check === "Profile" && error.message.includes("fedramp-20x")));
});

test("FedRAMP 20x upload uses the stub catalog and does not rename Rev5", () => {
  const state = ingestOscalPackage({
    text: readUpload("ssp-20x.json"),
    filename: "ssp-20x.json",
    catalogId: "fedramp-20x",
  }, ctx());
  const pkg = getPackageState(state, ctx());
  assert.equal(pkg.catalog.id, "fedramp-20x");
  assert.equal(pkg.catalogPin, CATALOG_20X_PIN);
  assert.equal(pkg.catalog.status, "stub");
  assert.match(pkg.catalog.note, /not vendored/);
  assert.equal(pkg.controls.length, 1);
  assert.equal(pkg.controls[0]?.id, "KSI-IAM");
  assert.equal(pkg.controls[0]?.title, "Identity and access (stub)");
  assert.equal(pkg.controls[0]?.family, "KSI");
  assert.equal(pkg.controls[0]?.complete, true);
  assert.equal(pkg.families[0]?.id, "KSI");
  assert.equal(pkg.map.available, false);
  assert.match(pkg.map.note, /not invented/);
  assert.equal(pkg.map.edges.length, 0);
  const gold = getPackageState(loadFixture(emptyPersisted(), "gold", ctx()), ctx());
  assert.equal(gold.map.available, true);
  assert.equal(gold.map.subsetMatch, true);
  assert.equal(gold.map.directedInSubset, 45);
  assert.equal(gold.map.edges.length, 45);
});

test("CSV ingest builds controls on the selected catalog", () => {
  const state = ingestCsvPackage({
    text: readUpload("controls.csv"),
    filename: "controls.csv",
    catalogId: "fedramp-rev5",
  }, ctx());
  const pkg = getPackageState(state, ctx());
  assert.equal(pkg.ingestKind, "csv");
  assert.equal(pkg.boundaryId, "bnd-csv");
  assert.equal(pkg.catalogPin, CATALOG_PIN);
  assert.equal(pkg.controls[0]?.id, "AC-2");
  assert.equal(pkg.controls[0]?.title, "Account Management");
  assert.equal(pkg.controls[0]?.complete, true);
  assert.equal(pkg.controls[1]?.id, "AU-2");
  assert.equal(pkg.controls[1]?.complete, false);
  assert.throws(() => ingestCsvPackage({
    text: readUpload("ssp-rev5.json"),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), (error: unknown) => error instanceof AegisError && /Upload OSCAL/.test((error as AegisError).message));
});

test("the published Rev5 sample is accepted and a component definition is rejected", () => {
  const fixture = JSON.parse(readUpload("ssp-rev5.json")) as {
    "system-security-plan": { "system-characteristics": { description: string } };
  };
  const published = JSON.parse(readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8"));
  const published20x = JSON.parse(readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-20x.json"), "utf8"));
  assert.deepEqual(published, fixture);
  assert.deepEqual(published20x, JSON.parse(readUpload("ssp-20x.json")));
  assert.equal(
    readFileSync(path.join(root, "public", "samples", "sample-controls.csv"), "utf8"),
    readUpload("controls.csv"),
  );
  assert.match(fixture["system-security-plan"]["system-characteristics"].description, /not the full FedRAMP Rev5 baseline/);
  assert.match(fixture["system-security-plan"]["system-characteristics"].description, /12 in-scope controls/);

  const component = {
    "component-definition": {
      uuid: "11111111-1111-4111-8111-111111111111",
      metadata: {
        title: "Aegis Upload Sample CSP Component",
        version: "0.1.0",
        "oscal-version": "1.1.2",
      },
      components: [
        {
          uuid: "22222222-2222-4222-8222-222222222222",
          type: "software",
          title: "Sample CSP Boundary Component",
          description: "Minimal sample for UI Tester N11 upload smoke. Not authorization evidence.",
        },
      ],
    },
  };
  assert.throws(() => ingestOscalPackage({
    text: JSON.stringify(component),
    filename: "sample-oscal-component.json",
    catalogId: "fedramp-rev5",
  }, ctx()), (error: unknown) => {
    assert.ok(error instanceof AegisError);
    assert.equal(error.code, "INGEST_REJECTED");
    assert.match(error.message, /must contain a system-security-plan object/);
    return true;
  });

  const state = ingestOscalPackage({
    text: JSON.stringify(published),
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const pkg = getPackageState(state, ctx());
  assert.equal(pkg.loaded, true);
  assert.equal(pkg.ingestKind, "oscal");
  assert.equal(pkg.boundaryId, "bnd-upload-rev5");
  assert.equal(pkg.catalogPin, CATALOG_PIN);
  assert.equal(pkg.inScopeCount, 12);
  assert.equal(pkg.gate.status, "FAIL");
  assert.deepEqual(pkg.gate.incompleteControlIds, ["AU-2"]);
  assert.equal(firstIncompleteControlId(pkg.controls), "AU-2");
  assert.deepEqual(pkg.controls.map((control) => control.id), [
    "AC-2", "AC-3", "AC-6", "AU-2", "AU-6", "CM-2", "CM-6", "IA-2", "IA-5", "SC-7", "SC-8", "SI-2",
  ]);
  assert.equal(pkg.controls[0]?.title, "Account Management");
  assert.ok((pkg.controls[0]?.evidence.length ?? 0) > 0);
  assert.equal(pkg.map.subsetMatch, true);
  assert.equal(pkg.map.directedInSubset, 45);
  assert.equal(pkg.map.byControl["AC-2"]?.outOfSubset.includes("AC-3"), false);
});

test("an attached evidence file is stored on the control", () => {
  const loaded = loadFixture(emptyPersisted(), "gold", ctx());
  const next = addEvidenceFile(loaded, "AU-2", {
    filename: "audit-note.txt",
    bytes: Buffer.from("audit sample"),
    title: "Uploaded audit note",
    type: "Document",
  }, ctx());
  const evidence = next.controls.find((control) => control.id === "AU-2")?.evidence[0];
  assert.ok(evidence);
  assert.match(evidence.href, /^workspace-evidence\/AU-2\//);
  const resolved = resolveEvidenceHref(root, evidence.href);
  assert.ok(resolved);
  assert.equal(existsSync(resolved), true);
  assert.equal(readFileSync(resolved, "utf8"), "audit sample");
  const view = getPackageState(next, ctx()).controls.find((control) => control.id === "AU-2");
  assert.equal(view?.evidence[0]?.valid, true);
  assert.equal(view?.missing.includes("evidence"), false);
});
