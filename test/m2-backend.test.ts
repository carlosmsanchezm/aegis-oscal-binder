import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as measurementRoute } from "../app/api/measurements/323/route";
import { POST as selectCatalog } from "../app/api/catalogs/select/route";
import { PUT as putPart, GET as getPart } from "../app/api/controls/[controlId]/parts/[statementId]/route";
import { GET as getParts } from "../app/api/controls/[controlId]/parts/route";
import { POST as saveRoute } from "../app/api/controls/[controlId]/save/route";
import { GET as gateRoute } from "../app/api/gate/route";
import { POST as compareRoute } from "../app/api/oscal/compare/route";
import { GET as importSummaryRoute } from "../app/api/oscal/import-summary/route";
import { GET as importReportRoute } from "../app/api/oscal/ingest/report/route";
import { POST as ingestRoute } from "../app/api/oscal/ingest/route";
import { GET as roundTripRoute } from "../app/api/oscal/round-trip/route";
import { GET as schemaReportRoute } from "../app/api/oscal/schema/report/route";
import { POST as schemaRoute } from "../app/api/oscal/schema/route";
import {
  AegisError,
  buildPackageSsp,
  emptyPersisted,
  exportOscal,
  findRepoRoot,
  getPackageState,
  ingestOscalPackage,
  loadFixture,
  saveControl,
} from "../lib/aegis";
import { allSspSchemaErrors, SSP_SCHEMA_PATH } from "../lib/aegis/ssp-export";
import { profileControlCounts } from "../lib/aegis/profile-counts";
import { rev5ProfilePath } from "../lib/aegis/map-graph";
import { readMeasurementText } from "../lib/aegis/measurement";
import { roundTripPackage } from "../lib/aegis/round-trip";
import { sspSchemaReport } from "../lib/aegis/ssp-schema-report";
import { saveStatementPart } from "../lib/aegis/statement-parts";
import { STATEMENT_PART_RULE } from "../lib/aegis/completeness";
import { dataDir } from "../lib/aegis/paths";
import { dropCachedSession } from "../lib/aegis/store";
import { reportBlobKey } from "../lib/storage-key";
import { getStorage } from "../lib/storage";
import type { Ctx, PersistedState } from "../lib/aegis/types";

const root = findRepoRoot();
const moderatePath = path.join(root, "public/samples/sample-oscal-ssp-rev5-moderate.json");
const moderateText = readFileSync(moderatePath, "utf8");

function ctx(): Ctx {
  return { root, now: () => new Date("2026-10-15T12:00:00.000Z") };
}

function loadModerate(): PersistedState {
  return ingestOscalPackage({
    text: moderateText,
    filename: "sample-oscal-ssp-rev5-moderate.json",
    catalogId: "fedramp-rev5",
  }, ctx());
}

function countsFromProfileFile(): { total: number; base: number; enhancements: number } {
  const file = JSON.parse(readFileSync(rev5ProfilePath(root), "utf8")) as {
    profile?: { imports?: Array<{ "include-controls"?: Array<{ "with-ids"?: string[] }> }> };
  };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of file.profile?.imports ?? []) {
    for (const include of entry["include-controls"] ?? []) {
      for (const id of include["with-ids"] ?? []) {
        const trimmed = id.trim().toLowerCase();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        ids.push(trimmed);
      }
    }
  }
  let base = 0;
  let enhancements = 0;
  for (const id of ids) {
    if (id.includes(".")) enhancements += 1;
    else base += 1;
  }
  return { total: ids.length, base, enhancements };
}

type SspDocument = {
  "system-security-plan": {
    metadata: { title?: string };
    "control-implementation": { "implemented-requirements": Array<Record<string, unknown>> };
  };
};

function breakUuids(document: SspDocument, count: number): SspDocument {
  const copy = structuredClone(document);
  for (let index = 0; index < count; index += 1) {
    copy["system-security-plan"]["control-implementation"]["implemented-requirements"][index]!.uuid = "not-a-uuid";
  }
  return copy;
}

function cookieHeader(id?: string): Headers {
  const headers = new Headers();
  if (id) headers.set("cookie", `aegis_sid=${id}`);
  return headers;
}

function sessionId(response: Response): string {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = /^aegis_sid=([a-f0-9]{32})\b/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  throw new Error("session cookie missing");
}

async function callJson(
  route: (req: Request) => Promise<Response> | Response,
  url: string,
  method: string,
  body: unknown,
  id?: string,
): Promise<Response> {
  const headers = cookieHeader(id);
  headers.set("content-type", "application/json");
  return route(new Request(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) }));
}

function forgetSession(id: string): void {
  dropCachedSession(id);
  rmSync(path.join(dataDir(root), "sessions", id), { recursive: true, force: true });
  rmSync(path.join(dataDir(root), "aegis", "orgs", "default", "sessions", id), { recursive: true, force: true });
}

async function openModerateSession(): Promise<string> {
  const selected = await callJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", "POST", { catalog: "fedramp-rev5" });
  const id = sessionId(selected);
  const ingested = await callJson(ingestRoute, "http://127.0.0.1/api/oscal/ingest", "POST", {
    document: moderateText,
    filename: "sample-oscal-ssp-rev5-moderate.json",
    catalog: "fedramp-rev5",
  }, id);
  assert.equal(ingested.status, 200);
  return id;
}

test("profile base and enhancement counts are read from the profile file", () => {
  const fromFile = countsFromProfileFile();
  const fromHelper = profileControlCounts(root);
  assert.deepEqual(fromHelper, fromFile);
  assert.equal(fromHelper.total, fromHelper.base + fromHelper.enhancements);
  const loaded = getPackageState(loadModerate(), ctx());
  assert.equal(loaded.gate.profile?.resolved, true);
  assert.equal(loaded.gate.profile?.total, fromFile.total);
  assert.equal(loaded.gate.profile?.base, fromFile.base);
  assert.equal(loaded.gate.profile?.enhancements, fromFile.enhancements);
  assert.equal(loaded.gate.profile?.reason, null);
  const familyBase = (loaded.gate.families ?? []).reduce((sum, family) => sum + (family.base ?? 0), 0);
  const familyEnhancements = (loaded.gate.families ?? []).reduce((sum, family) => sum + (family.enhancements ?? 0), 0);
  assert.equal(familyBase, fromFile.base);
  assert.equal(familyEnhancements, fromFile.enhancements);
  assert.equal(loaded.controls.length, fromFile.total);
  const subsetSample = ingestOscalPackage({
    text: readFileSync(path.join(root, "fixtures/upload/ssp-rev5.json"), "utf8"),
    filename: "ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const subset = getPackageState(subsetSample, ctx());
  assert.equal(subset.gate.profile?.resolved, false);
  assert.equal(subset.gate.profile?.total, null);
  assert.equal(subset.gate.label, "1 of 12 incomplete");
  assert.equal(subset.gate.blank, undefined);
  const gold = getPackageState(loadFixture(emptyPersisted(), "gold", ctx()), ctx());
  assert.equal(gold.gate.blank, undefined);
  assert.equal(gold.gate.profile?.resolved, false);
  assert.equal(gold.gate.label, "3 of 12 incomplete");
});

test("the Moderate sample gate counts the file, and saveControl flips PASS then FAIL", () => {
  const loaded = loadModerate();
  const before = getPackageState(loaded, ctx());
  const fileCounts = countsFromProfileFile();
  assert.equal(before.gate.status, "FAIL");
  assert.equal(before.gate.total, fileCounts.total);
  assert.equal(before.gate.complete, 1);
  assert.equal(before.gate.incomplete, fileCounts.total - 1);
  assert.equal(before.gate.blank, fileCounts.total - 2);
  assert.equal(before.gate.partial, 1);
  assert.equal(before.gate.label, `${before.gate.incomplete} of ${before.gate.total} incomplete`);
  const ac2 = before.gate.controlReasons?.find((row) => row.id === "AC-2");
  const ac1 = before.gate.controlReasons?.find((row) => row.id === "AC-1");
  const au2 = before.gate.controlReasons?.find((row) => row.id === "AU-2");
  assert.equal(ac2?.status, "complete");
  assert.deepEqual(ac2?.reasons, []);
  assert.equal(ac1?.status, "blank");
  assert.deepEqual(ac1?.reasons, ["missing implementation", "missing role", "missing evidence"]);
  assert.equal(au2?.status, "partial");
  assert.deepEqual(au2?.reasons, ["missing role", "missing evidence"]);
  assert.deepEqual(
    before.gate.nextIncompleteControlIds,
    before.controls.filter((control) => !control.complete).map((control) => control.id),
  );
  const role = loaded.roles[0]?.title ?? "";
  assert.ok(role);
  let completed = loaded;
  for (const control of before.controls) {
    if (control.complete) continue;
    completed = saveControl(completed, control.id, {
      implementation: control.implementation.trim() || `Implementation recorded for ${control.id}.`,
      responsibleRole: role,
      evidence: control.validEvidenceCount > 0 ? null : {
        title: `Evidence ${control.id}`,
        type: "Link",
        href: `https://evidence.example/${control.oscalId}/record`,
      },
    }, ctx());
  }
  const passed = getPackageState(completed, ctx());
  assert.equal(passed.gate.status, "PASS");
  assert.equal(passed.gate.incomplete, 0);
  assert.equal(passed.gate.complete, fileCounts.total);
  assert.equal(passed.gate.blank, undefined);
  assert.equal(passed.gate.partial, 0);
  assert.equal(passed.gate.label, `${fileCounts.total} of ${fileCounts.total} complete · gate open`);
  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-m2-pass-"));
  try {
    const exported = exportOscal(completed, { ...ctx(), outDir });
    assert.equal(exported.packageState.gate.status, "PASS");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  const document = buildPackageSsp(completed, new Date("2026-10-15T12:00:00.000Z"));
  const report = sspSchemaReport(document, "2026-10-15T12:00:00.000Z");
  assert.equal(report.valid, true);
  assert.equal(report.totalErrors, 0);
  assert.equal(report.truncated, false);
  assert.equal(report.shown, 0);
  const cleared = saveControl(completed, "AC-1", { responsibleRole: "" }, ctx());
  const failed = getPackageState(cleared, ctx());
  assert.equal(failed.gate.status, "FAIL");
  assert.equal(failed.gate.incomplete, 1);
  assert.deepEqual(failed.gate.incompleteControlIds, ["AC-1"]);
  assert.deepEqual(failed.gate.nextIncompleteControlIds, ["AC-1"]);
  const named = failed.gate.controlReasons?.find((row) => row.id === "AC-1");
  assert.equal(named?.status, "partial");
  assert.deepEqual(named?.reasons, ["missing role"]);
});

test("statement part b of CM-6 survives export and reimport", () => {
  let state = loadModerate();
  const before = state.controls.find((control) => control.id === "CM-6");
  assert.ok(before);
  state = saveStatementPart(state, "CM-6", "CM-6_SMT.B", {
    implementation: "Baseline configuration is reviewed each quarter.",
    evidence: { title: "CM-6 part b record", type: "Link", href: "https://evidence.example/cm-6/part-b" },
  }, ctx());
  const saved = state.controls.find((control) => control.id === "CM-6");
  assert.equal(saved?.implementation, before.implementation);
  assert.deepEqual(saved?.responsibleRoleIds ?? [], before.responsibleRoleIds ?? []);
  const view = getPackageState(state, ctx());
  const control = view.controls.find((item) => item.id === "CM-6");
  assert.equal(control?.complete, false);
  const part = view.gate.parts?.find((item) => item.statementId === "cm-6_smt.b");
  assert.equal(part?.status, "complete");
  assert.deepEqual(part?.reasons, []);
  const document = buildPackageSsp(state, new Date("2026-10-15T12:00:00.000Z"));
  const again = ingestOscalPackage({
    text: JSON.stringify(document),
    filename: "cm-6-part.json",
    catalogId: "fedramp-rev5",
  }, ctx());
  const restored = (again.controls.find((item) => item.id === "CM-6")?.itemStatements ?? []).find((item) => item.statementId === "cm-6_smt.b");
  assert.equal(restored?.description, "Baseline configuration is reviewed each quarter.");
  const evidence = again.controls.find((item) => item.id === "CM-6")?.evidence.find((item) => restored?.evidenceUuids.includes(item.uuid));
  assert.equal(evidence?.title, "CM-6 part b record");
  assert.equal(evidence?.href, "https://evidence.example/cm-6/part-b");
  assert.throws(
    () => saveStatementPart(state, "CM-6", "cm-6_smt.z", { implementation: "no" }, ctx()),
    (error: unknown) => error instanceof AegisError && error.code === "BAD_STATEMENT_ID" && Array.isArray((error.details as { validPartIds?: string[] }).validPartIds)
      && (error.details as { validPartIds: string[] }).validPartIds.join(",") === "cm-6_smt.a,cm-6_smt.b,cm-6_smt.c,cm-6_smt.d",
  );
  assert.match(STATEMENT_PART_RULE, /direct catalog statement item/);
  assert.match(STATEMENT_PART_RULE, /Part status does not change that control result/);
});

test("round trip of the Moderate sample is identical, and a changed file differs", () => {
  const state = loadModerate();
  const same = roundTripPackage(state, ctx());
  assert.equal(same.status, "identical");
  assert.deepEqual(same.lost, []);
  assert.deepEqual(same.changed, []);
  assert.equal(same.compared.elements, countsFromProfileFile().total);
  assert.ok(same.namedInAdvance.some((item) => item.path === "/system-security-plan/metadata/last-modified"));
  const document = buildPackageSsp(state, new Date("2026-10-15T12:00:00.000Z")) as SspDocument;
  const edited = structuredClone(document);
  const requirement = edited["system-security-plan"]["control-implementation"]["implemented-requirements"].find((item) => item["control-id"] === "ac-2");
  assert.ok(requirement);
  const components = requirement["by-components"] as Array<{ description: string }>;
  components[0]!.description = "Changed on purpose.";
  const diff = roundTripPackage(state, ctx(), edited);
  assert.equal(diff.status, "differs");
  assert.ok(diff.changed.some((change) => change.after === "Changed on purpose."));
});

test("schema validation caps errors at 32 and a missing schema is not valid", () => {
  const document = buildPackageSsp(loadModerate(), new Date("2026-10-15T12:00:00.000Z")) as SspDocument;
  const clean = sspSchemaReport(document, "2026-10-15T12:00:00.000Z");
  assert.equal(clean.valid, true);
  assert.equal(clean.totalErrors, 0);
  assert.equal(clean.cap, 32);
  assert.equal(clean.schema, "oscal-1.1.2-ssp-json");
  assert.equal(clean.scope, "json-ssp");
  const below = sspSchemaReport(breakUuids(document, 3), "2026-10-15T12:00:00.000Z");
  assert.equal(below.valid, false);
  assert.equal(below.totalErrors, 3);
  assert.equal(below.shown, 3);
  assert.equal(below.truncated, false);
  assert.equal(below.errors[0]?.controlId, "ac-1");
  assert.match(below.errors[0]?.path ?? "", /implemented-requirements\/0\/uuid/);
  const at = sspSchemaReport(breakUuids(document, 32), "2026-10-15T12:00:00.000Z");
  assert.equal(at.totalErrors, 32);
  assert.equal(at.shown, 32);
  assert.equal(at.truncated, false);
  const above = sspSchemaReport(breakUuids(document, 40), "2026-10-15T12:00:00.000Z");
  assert.equal(above.totalErrors, 40);
  assert.equal(above.shown, 32);
  assert.equal(above.errors.length, 32);
  assert.equal(above.truncated, true);
  assert.ok(above.groups.some((group) => group.countShown === 0 && group.count > 0));
  const missingTitle = structuredClone(document);
  delete missingTitle["system-security-plan"].metadata.title;
  const required = sspSchemaReport(missingTitle, "2026-10-15T12:00:00.000Z");
  const titleError = required.errors.find((error) => error.keyword === "required" && error.path.includes("metadata"));
  assert.ok(titleError);
  assert.match(titleError.fix ?? "", /^Add the required property title at /);
  const missingRoot = path.join(tmpdir(), "aegis-no-schema");
  assert.throws(
    () => allSspSchemaErrors(document, missingRoot),
    (error: unknown) => error instanceof AegisError && error.code === "SCHEMA_UNAVAILABLE" && error.status === 503,
  );
  const corruptRoot = mkdtempSync(path.join(tmpdir(), "aegis-bad-schema-"));
  const schemaDir = path.join(corruptRoot, ...SSP_SCHEMA_PATH.slice(0, -1));
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(path.join(schemaDir, SSP_SCHEMA_PATH.at(-1)!), "{");
  try {
    assert.throws(
      () => allSspSchemaErrors(document, corruptRoot),
      (error: unknown) => error instanceof AegisError && error.code === "SCHEMA_UNAVAILABLE",
    );
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
  }
  const still = sspSchemaReport(document, "2026-10-15T12:00:00.000Z");
  assert.equal(still.valid, true);
});

test("measurement text refuses a bad digest and the route returns the recorded file", async () => {
  assert.deepEqual(readMeasurementText(null), { measurement: null, reason: "NO_MEASUREMENT" });
  const broken = readMeasurementText("{");
  assert.equal(broken.measurement, null);
  if (broken.measurement == null) assert.equal(broken.reason, "MEASUREMENT_UNREADABLE");
  const incomplete = readMeasurementText("{\"payload\":{},\"digest\":\"abc\"}");
  assert.equal(incomplete.measurement, null);
  if (incomplete.measurement == null) assert.equal(incomplete.reason, "MEASUREMENT_UNREADABLE");
  const raw = readFileSync(path.join(root, "fixtures/measurements/323.json"), "utf8");
  const recorded = readMeasurementText(raw);
  assert.ok(recorded.measurement);
  if (!recorded.measurement) return;
  assert.equal(recorded.measurement.runs >= 5, true);
  assert.equal(recorded.measurement.samples.import.runs.length, recorded.measurement.runs);
  for (const item of Object.values(recorded.measurement.samples)) {
    assert.equal(item.min <= item.median && item.median <= item.max, true);
  }
  const tampered = JSON.parse(raw) as { payload: unknown; digest: string };
  tampered.digest = "0".repeat(64);
  const mismatched = readMeasurementText(JSON.stringify(tampered));
  assert.equal(mismatched.measurement, null);
  if (mismatched.measurement == null) assert.equal(mismatched.reason, "DIGEST_MISMATCH");
  const selected = await callJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", "POST", { catalog: "fedramp-rev5" });
  const id = sessionId(selected);
  try {
    const response = await measurementRoute(new Request("http://127.0.0.1/api/measurements/323", { headers: cookieHeader(id) }));
    const body = await response.json() as { ok: boolean; measurement: { commit: string; runs: number } | null; digest?: string; reason?: string };
    assert.equal(response.status, 200);
    assert.equal(body.measurement?.commit, recorded.measurement.commit);
    assert.equal(body.digest, recorded.digest);
  } finally {
    forgetSession(id);
  }
});

test("trial import, parts, schema report, round trip, and compare use the routes", async () => {
  const id = await openModerateSession();
  try {
    const ingested = await callJson(ingestRoute, "http://127.0.0.1/api/oscal/ingest", "POST", {
      document: moderateText,
      filename: "sample-oscal-ssp-rev5-moderate.json",
      catalog: "fedramp-rev5",
    }, id);
    const ingestedBody = await ingested.json() as {
      packageState: { gate: { status: string; label: string; incomplete: number; total: number; profile?: { total: number | null } }; irHash: string };
      importSummary: { bytes: number; controlsFound: number; statements: number; components: number; resolvedControls: number; namedInAdvance: unknown[] };
    };
    assert.equal(ingested.status, 200);
    const fileCounts = countsFromProfileFile();
    assert.equal(ingestedBody.packageState.gate.status, "FAIL");
    assert.equal(ingestedBody.packageState.gate.incomplete, fileCounts.total - 1);
    assert.equal(ingestedBody.packageState.gate.profile?.total, fileCounts.total);
    assert.equal(ingestedBody.importSummary.bytes, Buffer.byteLength(moderateText));
    assert.equal(ingestedBody.importSummary.controlsFound, 3);
    assert.equal(ingestedBody.importSummary.resolvedControls, fileCounts.total);
    assert.ok(ingestedBody.importSummary.namedInAdvance.length > 0);
    const summary = await importSummaryRoute(new Request("http://127.0.0.1/api/oscal/import-summary", { headers: cookieHeader(id) }));
    const summaryBody = await summary.json() as { importSummary: { bytes: number; file: string } };
    assert.equal(summaryBody.importSummary.bytes, ingestedBody.importSummary.bytes);
    assert.equal(summaryBody.importSummary.file, "sample-oscal-ssp-rev5-moderate.json");

    const examples = { part: { implementation: "Baseline configuration is reviewed each quarter." }, roundTrip: { status: "identical" }, schemaMany: { totalErrors: 40 } };
    const parts = await getParts(new Request("http://127.0.0.1/api/controls/CM-6/parts", { headers: cookieHeader(id) }), {
      params: Promise.resolve({ controlId: "CM-6" }),
    });
    const partsBody = await parts.json() as { parts: { controlId: string; validPartIds: string[]; parts: Array<{ statementId: string }> } };
    assert.deepEqual(partsBody.parts.validPartIds, ["cm-6_smt.a", "cm-6_smt.b", "cm-6_smt.c", "cm-6_smt.d"]);
    const bad = await putPart(new Request("http://127.0.0.1/api/controls/CM-6/parts/cm-6_smt.z", {
      method: "PUT",
      headers: (() => {
        const headers = cookieHeader(id);
        headers.set("content-type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({ implementation: "no" }),
    }), { params: Promise.resolve({ controlId: "CM-6", statementId: "cm-6_smt.z" }) });
    const badBody = await bad.json() as { ok: boolean; error?: { code: string; details?: { validPartIds?: string[] } } };
    assert.equal(bad.status, 400);
    assert.equal(badBody.error?.code, "BAD_STATEMENT_ID");
    assert.deepEqual(badBody.error?.details?.validPartIds, ["cm-6_smt.a", "cm-6_smt.b", "cm-6_smt.c", "cm-6_smt.d"]);

    const savedPart = await putPart(new Request("http://127.0.0.1/api/controls/CM-6/parts/cm-6_smt.b", {
      method: "PUT",
      headers: (() => {
        const headers = cookieHeader(id);
        headers.set("content-type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({
        implementation: examples.part.implementation,
        evidence: { title: "CM-6 part b record", type: "Link", href: "https://evidence.example/cm-6/part-b" },
      }),
    }), { params: Promise.resolve({ controlId: "CM-6", statementId: "cm-6_smt.b" }) });
    assert.equal(savedPart.status, 200);
    const readPart = await getPart(new Request("http://127.0.0.1/api/controls/CM-6/parts/cm-6_smt.b", { headers: cookieHeader(id) }), {
      params: Promise.resolve({ controlId: "CM-6", statementId: "cm-6_smt.b" }),
    });
    const readBody = await readPart.json() as { part: { statementId: string; implementation: string; status: string; evidence: Array<{ title: string }> } };
    assert.equal(readBody.part.statementId, "cm-6_smt.b");
    assert.equal(readBody.part.implementation, examples.part.implementation);
    assert.equal(readBody.part.status, "complete");
    assert.equal(readBody.part.evidence[0]?.title, "CM-6 part b record");
    const cm6 = await saveRoute(new Request("http://127.0.0.1/api/controls/CM-6/save", {
      method: "POST",
      headers: (() => {
        const headers = cookieHeader(id);
        headers.set("content-type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ controlId: "CM-6" }) });
    const cm6Body = await cm6.json() as { packageState: { controls: Array<{ id: string; complete: boolean; implementation: string }> } };
    assert.equal(cm6Body.packageState.controls.find((control) => control.id === "CM-6")?.complete, false);

    const round = await roundTripRoute(new Request("http://127.0.0.1/api/oscal/round-trip", { headers: cookieHeader(id) }));
    const roundBody = await round.json() as { roundTrip: { status: string; lost: unknown[]; changed: unknown[] } };
    assert.equal(round.status, 200);
    assert.equal(roundBody.roundTrip.status, "identical");
    assert.equal(examples.roundTrip.status, "identical");

    const schema = await callJson(schemaRoute, "http://127.0.0.1/api/oscal/schema", "POST", {}, id);
    const schemaBody = await schema.json() as { schemaReport: { valid: boolean; totalErrors: number; artifact: { objectKey: string } | null } };
    assert.equal(schema.status, 200);
    assert.equal(schemaBody.schemaReport.valid, true);
    assert.equal(schemaBody.schemaReport.totalErrors, 0);
    assert.ok(schemaBody.schemaReport.artifact?.objectKey);
    const downloaded = await schemaReportRoute(new Request("http://127.0.0.1/api/oscal/schema/report", { headers: cookieHeader(id) }));
    const downloadedBody = await downloaded.json() as { valid: boolean; totalErrors: number };
    assert.equal(downloaded.status, 200);
    assert.equal(downloadedBody.valid, true);
    const snapshot = JSON.parse(readFileSync(path.join(dataDir(root), "sessions", id, "state.json"), "utf8")) as {
      state: { schemaReport?: { filePath: string; sha256: string } };
    };
    const reportPath = snapshot.state.schemaReport?.filePath ?? "";
    assert.match(reportPath, new RegExp(reportBlobKey(id, "ssp-schema-report.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    getStorage().write(reportPath, Buffer.from("{\"tampered\":true}"));
    const refused = await schemaReportRoute(new Request("http://127.0.0.1/api/oscal/schema/report", { headers: cookieHeader(id) }));
    const refusedBody = await refused.json() as { ok: boolean; error?: { code: string } };
    assert.equal(refused.status, 409);
    assert.equal(refusedBody.error?.code, "DIGEST_MISMATCH");

    const manyDocument = breakUuids(buildPackageSsp(loadModerate(), new Date("2026-10-15T12:00:00.000Z")) as SspDocument, 40);
    const many = await callJson(schemaRoute, "http://127.0.0.1/api/oscal/schema", "POST", { document: JSON.stringify(manyDocument) }, id);
    const manyBody = await many.json() as { schemaReport: { totalErrors: number; shown: number; truncated: boolean; cap: number; errors: unknown[] } };
    assert.equal(manyBody.schemaReport.totalErrors, examples.schemaMany.totalErrors);
    assert.equal(manyBody.schemaReport.shown, 32);
    assert.equal(manyBody.schemaReport.truncated, true);
    assert.equal(manyBody.schemaReport.cap, 32);
    assert.equal(manyBody.schemaReport.errors.length, 32);
    const manyDownload = await schemaReportRoute(new Request("http://127.0.0.1/api/oscal/schema/report", { headers: cookieHeader(id) }));
    const manyDownloadBody = await manyDownload.json() as { errors: unknown[]; totalErrors: number; shown: number };
    assert.equal(manyDownloadBody.errors.length, 32);
    assert.equal(manyDownloadBody.totalErrors, manyBody.schemaReport.totalErrors);

    const sameCompare = await callJson(compareRoute, "http://127.0.0.1/api/oscal/compare", "POST", {
      document: moderateText,
      filename: "sample-oscal-ssp-rev5-moderate.json",
    }, id);
    const sameBody = await sameCompare.json() as { compare: { dryRun: boolean; replaces: boolean; counts: { changed: number } } };
    assert.equal(sameBody.compare.dryRun, true);
    assert.equal(sameBody.compare.replaces, false);
    const edited = JSON.parse(moderateText) as { "system-security-plan": { "control-implementation": { "implemented-requirements": Array<Record<string, unknown>> } } };
    const ac2 = edited["system-security-plan"]["control-implementation"]["implemented-requirements"].find((item) => item["control-id"] === "ac-2");
    assert.ok(ac2);
    ac2.statements = [{ "statement-id": "ac-2_smt", uuid: "33333333-3333-4333-8333-333333333201", description: "Changed on purpose." }];
    const diff = await callJson(compareRoute, "http://127.0.0.1/api/oscal/compare", "POST", { document: JSON.stringify(edited), filename: "edited.json" }, id);
    const diffBody = await diff.json() as { compare: { dryRun: boolean; replaces: boolean; changed: Array<{ id: string }> } };
    assert.equal(diffBody.compare.dryRun, true);
    assert.equal(diffBody.compare.replaces, false);
    assert.ok(diffBody.compare.changed.some((row) => row.id === "AC-2"));
    const gate = await gateRoute(new Request("http://127.0.0.1/api/gate", { headers: cookieHeader(id) }));
    const gateBody = await gate.json() as { gate: { label: string } };
    assert.equal(gateBody.gate.label, ingestedBody.packageState.gate.label);
  } finally {
    forgetSession(id);
  }
});

test("a bad SSP is rejected with the first 32 problems and the loaded package stays", async () => {
  const id = await openModerateSession();
  try {
    const before = await gateRoute(new Request("http://127.0.0.1/api/gate", { headers: cookieHeader(id) }));
    const beforeBody = await before.json() as { gate: { label: string; total: number } };
    const problems = readFileSync(path.join(root, "fixtures/upload/m2-import-problems.json"), "utf8");
    const rejected = await callJson(ingestRoute, "http://127.0.0.1/api/oscal/ingest", "POST", {
      document: problems,
      filename: "m2-import-problems.json",
      catalog: "fedramp-rev5",
    }, id);
    const body = await rejected.json() as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        details: {
          total: number;
          shown: number;
          truncated: boolean;
          cap: number;
          stored: boolean;
          workspaceUnchanged: boolean;
          problems: unknown[];
          groups: Array<{ key: string; count: number; countShown: number }>;
        };
      };
    };
    assert.equal(rejected.status, 400);
    assert.equal(body.error.code, "IMPORT_REJECTED");
    assert.match(body.error.message, /No package was stored/);
    assert.equal(body.error.details.cap, 32);
    assert.equal(body.error.details.shown, 32);
    assert.equal(body.error.details.problems.length, 32);
    assert.equal(body.error.details.truncated, true);
    assert.ok(body.error.details.total > 32);
    assert.equal(body.error.details.stored, false);
    assert.equal(body.error.details.workspaceUnchanged, true);
    assert.ok(body.error.details.groups.some((group) => group.count > group.countShown));
    const after = await gateRoute(new Request("http://127.0.0.1/api/gate", { headers: cookieHeader(id) }));
    const afterBody = await after.json() as { gate: { label: string } };
    assert.equal(afterBody.gate.label, beforeBody.gate.label);
    const report = await importReportRoute(new Request("http://127.0.0.1/api/oscal/ingest/report", { headers: cookieHeader(id) }));
    const reportBody = await report.json() as { total: number; shown: number };
    assert.equal(report.status, 200);
    assert.equal(reportBody.total, body.error.details.total);
    assert.equal(reportBody.shown, 32);
    const snapshot = JSON.parse(readFileSync(path.join(dataDir(root), "sessions", id, "state.json"), "utf8")) as {
      state: { importReport?: { filePath: string } };
    };
    assert.match(snapshot.state.importReport?.filePath ?? "", /aegis\/orgs\/default\/sessions\/[a-f0-9]{32}\/reports\/import-report\.json/);

    const selected = await callJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", "POST", { catalog: "fedramp-rev5" });
    const other = sessionId(selected);
    try {
      const mismatch = await callJson(ingestRoute, "http://127.0.0.1/api/oscal/ingest", "POST", {
        document: readFileSync(path.join(root, "fixtures/upload/ssp-20x.json"), "utf8"),
        filename: "ssp-20x.json",
        catalog: "fedramp-rev5",
      }, other);
      const mismatchBody = await mismatch.json() as { error: { code: string; details: { groups: Array<{ key: string }> } } };
      assert.equal(mismatch.status, 400);
      assert.equal(mismatchBody.error.code, "CATALOG_MISMATCH");
      assert.ok(mismatchBody.error.details.groups.some((group) => group.key === "unsupported profile"));
    } finally {
      forgetSession(other);
    }
  } finally {
    forgetSession(id);
  }
});
