import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { POST as saveRoute } from "../app/api/controls/[controlId]/save/route";
import { GET as getOscal } from "../app/api/artifacts/oscal/route";
import { POST as ingestOscal } from "../app/api/oscal/ingest/route";
import { POST as exportRoute } from "../app/api/oscal/export/route";
import { POST as selectCatalog } from "../app/api/catalogs/select/route";
import { POST as loadFixtureRoute } from "../app/api/fixtures/load/route";
import { AegisError } from "../lib/aegis/errors";
import {
  emptyPersisted,
  exportedOscalXml,
  exportOscal,
  findRepoRoot,
  getPackageState,
  ingestOscalPackage,
  loadFixture,
  saveControl,
} from "../lib/aegis";
import { dataDir } from "../lib/aegis/paths";
import { dropCachedSession } from "../lib/aegis/store";
import { getStorage } from "../lib/storage";
import type { Ctx, PersistedState } from "../lib/aegis/types";

const root = findRepoRoot();
const SESSION_LOST = "This browser's package was not found on the server. Reload the page, or upload the package again.";

function ctxFor(outDir: string): Ctx & { outDir: string } {
  return { root, outDir, now: () => new Date("2026-09-23T14:12:00.000Z") };
}

function loadSample(outDir: string): { ctx: Ctx & { outDir: string }; state: PersistedState } {
  const ctx = ctxFor(outDir);
  const text = readFileSync(path.join(root, "public/samples/sample-oscal-ssp-rev5.json"), "utf8");
  const state = ingestOscalPackage({
    text,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx);
  return { ctx, state };
}

function au2Block(xml: string): string {
  const parts = xml.split("<implemented-requirement");
  const block = parts.find((part) => part.startsWith(' control-id="au-2"'));
  assert.ok(block, "AU-2 implemented requirement missing");
  return block.slice(0, block.indexOf("</implemented-requirement>"));
}

test("sample partial save keeps the gate FAIL and a full fix opens it", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-sample-save-"));
  const { ctx, state } = loadSample(outDir);
  const loaded = getPackageState(state, ctx);
  assert.equal(loaded.gate.status, "FAIL");
  assert.equal(loaded.gate.label, "1 of 12 incomplete");
  assert.deepEqual(loaded.gate.incompleteControlIds, ["AU-2"]);
  const before = loaded.controls.find((control) => control.id === "AU-2");
  assert.ok(before);
  assert.equal(before.implementation.trim().length > 0, true);
  assert.deepEqual(before.missing, ["responsibleRole", "evidence"]);
  assert.equal(before.complete, false);

  assert.throws(() => saveControl(state, "AU-2", {
    implementation: before.implementation,
    responsibleRole: "System Owner",
    evidence: { title: "Broken", type: "Link", href: "http://insecure.example/au-2" },
  }, ctx), (error: unknown) => error instanceof AegisError && error.code === "EVIDENCE_REJECTED");
  assert.equal(getPackageState(state, ctx).controls.find((control) => control.id === "AU-2")?.responsibleRoleId, "");

  const partial = saveControl(state, "AU-2", {
    implementation: before.implementation,
    responsibleRole: "System Owner",
  }, ctx);
  const saved = getPackageState(partial, ctx);
  const au2 = saved.controls.find((control) => control.id === "AU-2");
  assert.ok(au2);
  assert.equal(au2.responsibleRole, "System Owner");
  assert.equal(au2.responsibleRoleId, "system-owner");
  assert.equal(au2.complete, false);
  assert.deepEqual(au2.missing, ["evidence"]);
  assert.equal(saved.gate.status, "FAIL");
  assert.equal(saved.gate.incomplete, 1);
  assert.equal(saved.gate.label, "1 of 12 incomplete");
  assert.deepEqual(saved.gate.incompleteControlIds, ["AU-2"]);
  assert.equal(saved.families.find((family) => family.id === "AU")?.open, 1);

  const wip = exportOscal(partial, ctx);
  assert.equal(wip.packageState.gate.status, "FAIL");
  assert.match(wip.filename, /^exp-\d+-package-oscal\.xml$/);
  const wipBlock = au2Block(wip.xml);
  assert.match(wipBlock, /<responsible-role role-id="system-owner"\/>/);
  assert.doesNotMatch(wipBlock, /<link rel="evidence"/);
  assert.doesNotMatch(wip.xml, /https:\/\/evidence\.example\/au-2-review/);

  const passed = saveControl(partial, "AU-2", {
    implementation: before.implementation,
    responsibleRole: "System Owner",
    evidence: { title: "Quarterly event review", type: "Link", href: "https://evidence.example/au-2-review" },
  }, ctx);
  const done = getPackageState(passed, ctx);
  const fixed = done.controls.find((control) => control.id === "AU-2");
  assert.ok(fixed);
  assert.equal(fixed.complete, true);
  assert.deepEqual(fixed.missing, []);
  assert.equal(fixed.validEvidenceCount, 1);
  assert.equal(done.gate.status, "PASS");
  assert.equal(done.gate.incomplete, 0);
  assert.equal(done.gate.complete, 12);
  assert.equal(done.gate.label, "12 of 12 complete · gate open");
  assert.equal(done.families.find((family) => family.id === "AU")?.open, 0);

  const exported = exportOscal(passed, ctx);
  assert.equal(exported.packageState.gate.status, "PASS");
  assert.equal(exported.packageState.gate.label, "12 of 12 complete · gate open");
  const block = au2Block(exported.xml);
  assert.match(block, /<responsible-role role-id="system-owner"\/>/);
  assert.match(block, /<link rel="evidence" href="#[0-9a-f-]{36}"\/>/);
  assert.match(exported.xml, /<resource [^>]*title="Quarterly event review">/);
  assert.match(exported.xml, /<rlink href="https:\/\/evidence\.example\/au-2-review"\/>/);

  getStorage().remove(exported.filePath);
  assert.equal(getStorage().exists(exported.filePath), false);
  assert.equal(exportedOscalXml(exported.state, ctx), exported.xml);
  rmSync(outDir, { recursive: true, force: true });
});

test("gold and package A use the same partial save path", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-other-save-"));
  const ctx = ctxFor(outDir);
  const gold = loadFixture(emptyPersisted(), "gold", ctx);
  const goldBefore = getPackageState(gold, ctx);
  assert.equal(goldBefore.gate.status, "FAIL");
  assert.equal(goldBefore.gate.label, "3 of 12 incomplete");
  assert.deepEqual(goldBefore.gate.incompleteControlIds, ["AC-2", "AU-2", "CM-6"]);
  const goldPartial = saveControl(gold, "AC-2", { responsibleRole: "CSP IAM Administrator" }, ctx);
  const goldSaved = getPackageState(goldPartial, ctx);
  const ac2 = goldSaved.controls.find((control) => control.id === "AC-2");
  assert.ok(ac2);
  assert.equal(ac2.responsibleRoleId, "csp-iam-administrator");
  assert.equal(ac2.complete, false);
  assert.deepEqual(ac2.missing, ["implementation", "evidence"]);
  assert.equal(goldSaved.gate.status, "FAIL");
  assert.equal(goldSaved.gate.label, "3 of 12 incomplete");
  assert.deepEqual(goldSaved.gate.incompleteControlIds, ["AC-2", "AU-2", "CM-6"]);
  const goldXml = exportOscal(goldPartial, ctx).xml;
  assert.match(goldXml, /<implemented-requirement control-id="ac-2">\s*<responsible-role role-id="csp-iam-administrator"\/>/);

  const packageA = ingestOscalPackage({
    text: readFileSync(path.join(root, "fixtures/audit/package-a.json"), "utf8"),
    filename: "package-a.json",
    catalogId: "fedramp-rev5",
  }, ctx);
  const packageBefore = getPackageState(packageA, ctx);
  assert.equal(packageBefore.gate.status, "FAIL");
  assert.equal(packageBefore.gate.label, "5 of 8 incomplete");
  assert.deepEqual(packageBefore.gate.incompleteControlIds, ["CP-2", "CP-9", "RA-3", "RA-5", "SI-4"]);
  const cp2 = packageBefore.controls.find((control) => control.id === "CP-2");
  assert.ok(cp2);
  const edited = `${cp2.implementation} Partial note.`;
  const packagePartial = saveControl(packageA, "CP-2", { implementation: edited }, ctx);
  const packageSaved = getPackageState(packagePartial, ctx);
  const cp2Saved = packageSaved.controls.find((control) => control.id === "CP-2");
  assert.ok(cp2Saved);
  assert.equal(cp2Saved.implementation, edited.trim());
  assert.equal(cp2Saved.complete, false);
  assert.deepEqual(cp2Saved.missing, ["evidence"]);
  assert.equal(packageSaved.gate.status, "FAIL");
  assert.equal(packageSaved.gate.label, "5 of 8 incomplete");
  const packageXml = exportOscal(packagePartial, ctx).xml;
  assert.match(packageXml, /Partial note\./);
  rmSync(outDir, { recursive: true, force: true });
});

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

async function postJson(
  route: (req: Request) => Promise<Response> | Response,
  url: string,
  body: unknown,
  id?: string,
): Promise<Response> {
  const headers = cookieHeader(id);
  headers.set("content-type", "application/json");
  return route(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

function forgetSession(id: string): void {
  dropCachedSession(id);
  rmSync(path.join(dataDir(root), "sessions", id), { recursive: true, force: true });
}

test("a missing session file still downloads, and a missing session is visible", async () => {
  const selected = await postJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", { catalog: "fedramp-rev5" });
  const id = sessionId(selected);
  const sample = readFileSync(path.join(root, "public/samples/sample-oscal-ssp-rev5.json"), "utf8");
  const ingested = await postJson(ingestOscal, "http://127.0.0.1/api/oscal/ingest", {
    document: sample,
    filename: "sample-oscal-ssp-rev5.json",
    catalog: "fedramp-rev5",
  }, id);
  assert.equal(ingested.status, 200);

  const exported = await postJson(exportRoute, "http://127.0.0.1/api/oscal/export", {}, id);
  const exportedBody = await exported.json() as { ok: boolean; xml: string; filename: string; packageState: { gate: { status: string } } };
  assert.equal(exported.status, 200);
  assert.equal(exportedBody.packageState.gate.status, "FAIL");
  assert.match(exportedBody.filename, /^exp-\d+-package-oscal\.xml$/);
  const snapshotPath = path.join(dataDir(root), "sessions", id, "state.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { state: { exports: Array<{ filePath: string }> } };
  const filePath = snapshot.state.exports.at(-1)?.filePath;
  assert.ok(filePath);
  getStorage().remove(filePath);
  assert.equal(getStorage().exists(filePath), false);
  const artifact = await getOscal(new Request("http://127.0.0.1/api/artifacts/oscal", { headers: cookieHeader(id) }));
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), exportedBody.xml);

  forgetSession(id);
  const lostSave = await saveRoute(
    new Request("http://127.0.0.1/api/controls/AU-2/save", {
      method: "POST",
      headers: (() => {
        const headers = cookieHeader(id);
        headers.set("content-type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({ responsibleRole: "System Owner" }),
    }),
    { params: Promise.resolve({ controlId: "AU-2" }) },
  );
  const lostSaveBody = await lostSave.json() as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(lostSave.status, 409);
  assert.equal(lostSaveBody.ok, false);
  assert.equal(lostSaveBody.error?.code, "SESSION_LOST");
  assert.equal(lostSaveBody.error?.message, SESSION_LOST);

  forgetSession(id);
  const lostExport = await postJson(exportRoute, "http://127.0.0.1/api/oscal/export", {}, id);
  const lostExportBody = await lostExport.json() as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(lostExport.status, 409);
  assert.equal(lostExportBody.error?.code, "SESSION_LOST");
  assert.equal(lostExportBody.error?.message, SESSION_LOST);
  forgetSession(id);
});

test("gold load counts stay fail closed", async () => {
  const selected = await postJson(selectCatalog, "http://127.0.0.1/api/catalogs/select", { catalog: "fedramp-rev5" });
  const id = sessionId(selected);
  const loaded = await postJson(loadFixtureRoute, "http://127.0.0.1/api/fixtures/load", { fixture: "gold" }, id);
  const body = await loaded.json() as { packageState: { gate: { status: string; label: string; incompleteControlIds: string[] } } };
  assert.equal(loaded.status, 200);
  assert.equal(body.packageState.gate.status, "FAIL");
  assert.equal(body.packageState.gate.label, "3 of 12 incomplete");
  assert.deepEqual(body.packageState.gate.incompleteControlIds, ["AC-2", "AU-2", "CM-6"]);
  forgetSession(id);
});
