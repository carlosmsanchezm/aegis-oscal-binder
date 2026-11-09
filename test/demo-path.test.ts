import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { D6_TEXT } from "../lib/aegis/constants";
import { AegisError } from "../lib/aegis/errors";
import {
  addEvidence,
  assertReadOnlyCatalog,
  changesFor,
  emptyPersisted,
  exportOscal,
  findRepoRoot,
  firstIncompleteControlId,
  getPackageState,
  loadFixture,
  renderWord,
  renderWordExcel,
  saveControl,
  updateBaseline,
  updateControl,
  updateEvidence,
  validateOscal,
} from "../lib/aegis";
import type { Ctx, PersistedState } from "../lib/aegis/types";

const root = findRepoRoot();

function fresh(): { ctx: Ctx & { outDir: string }; state: PersistedState } {
  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-test-"));
  const ctx = { root, outDir, now: () => new Date("2026-09-23T14:12:00.000Z") };
  return { ctx, state: loadFixture(emptyPersisted(), "gold", ctx) };
}

const AC2 = "Accounts provisioned via the IdP with manager approval; inactive accounts disabled after 35 days.";
const CM6 = "Configuration settings are enforced from the signed baseline; deviations require a recorded exception.";

function passPackage(state: PersistedState, ctx: Ctx): PersistedState {
  let next = updateControl(state, "AC-2", { implementation: AC2, responsibleRole: "CSP IAM Administrator" }, ctx);
  next = addEvidence(next, "AC-2", {
    title: "Quarterly account review",
    type: "Document",
    href: "evidence/ac-2/iam-review-2026-08.pdf",
  }, ctx);
  next = addEvidence(next, "AU-2", {
    title: "SIEM logging standard",
    type: "Document",
    href: "evidence/au-2/event-logging-standard-2026-08.pdf",
  }, ctx);
  next = updateControl(next, "CM-6", { implementation: CM6 }, ctx);
  return next;
}

test("D6 disclaimer is the design string", () => {
  const { ctx, state } = fresh();
  const pkg = getPackageState(state, ctx);
  assert.equal(pkg.disclaimer.id, "D6");
  assert.equal(pkg.disclaimer.text, D6_TEXT);
  assert.equal(
    D6_TEXT,
    "CSP side tooling demo. Subset only. Harness not LLM. Aegis is not FedRAMP authorized / not IL ATO / not a cleared facility / not 8(a).",
  );
});

test("gold fixture loads the read-only boundary and fails 3 of 12", () => {
  const { ctx, state } = fresh();
  const pkg = getPackageState(state, ctx);
  assert.equal(pkg.workspaceName, "Gold fixture CSP boundary");
  assert.equal(pkg.boundaryId, "bnd-gold-0001");
  assert.equal(pkg.catalogPin, "fedramp-rev5-subset@2026.09");
  assert.equal(pkg.catalogReadOnly, true);
  assert.equal(pkg.inScopeCount, 12);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.gate.incomplete, 3);
  assert.equal(pkg.gate.label, "3 of 12 incomplete");
  assert.deepEqual(pkg.gate.incompleteControlIds, ["AC-2", "AU-2", "CM-6"]);
  assert.equal(firstIncompleteControlId(pkg.controls), "AC-2");
  assert.deepEqual(pkg.controls.find((control) => control.id === "AC-2")?.missing, ["implementation", "responsibleRole", "evidence"]);
  assert.deepEqual(pkg.controls.find((control) => control.id === "AU-2")?.missing, ["evidence"]);
  assert.deepEqual(pkg.controls.find((control) => control.id === "CM-6")?.missing, ["implementation"]);
  assert.equal(pkg.families.find((family) => family.id === "AC")?.label, "1/3 open");
  assert.equal(pkg.families.find((family) => family.id === "IA")?.label, "ok");
  assert.equal(pkg.pipeline.oscal.status, "ready");
  assert.equal(pkg.pipeline.oscal.filename, "exp-0001-package-oscal.xml");
  assert.equal(pkg.pipeline.baseline.id, null);
  assert.equal(pkg.future.liveConnections, 0);
});

test("unknown fixture and catalog writes are rejected", () => {
  const { ctx } = fresh();
  assert.throws(() => loadFixture(emptyPersisted(), "silver", ctx), (error: unknown) => {
    return error instanceof AegisError && error.code === "UNKNOWN_FIXTURE";
  });
  assert.throws(() => assertReadOnlyCatalog({ catalogPin: "other" }), (error: unknown) => {
    return error instanceof AegisError && error.code === "READ_ONLY";
  });
});

test("addEvidence rejects invalid URL, missing file, and duplicate title", () => {
  const { ctx, state } = fresh();
  const started = updateControl(state, "AC-2", { implementation: AC2, responsibleRole: "csp-iam-administrator" }, ctx);
  const withEvidence = addEvidence(started, "AC-2", {
    title: "Quarterly account review",
    type: "Document",
    href: "evidence/ac-2/iam-review-2026-08.pdf",
  }, ctx);
  assert.equal(withEvidence.controls[0]?.evidence[0]?.id, "EV-AC2-01");

  assert.throws(() => addEvidence(withEvidence, "AC-2", {
    title: "Quarterly account review",
    type: "Document",
    href: "htps//drive.example/iam-review",
  }, ctx), (error: unknown) => {
    assert.ok(error instanceof AegisError);
    const details = error.details as Array<{ message: string }>;
    const messages = details.map((item) => item.message);
    assert.ok(messages.includes("Duplicate title · already used by EV-AC2-01"));
    assert.ok(messages.includes("Invalid URL · use https:// or an evidence/ path"));
    return error.code === "EVIDENCE_REJECTED";
  });

  assert.throws(() => addEvidence(started, "AC-2", {
    title: "Missing review",
    type: "Document",
    href: "evidence/ac-2/does-not-exist.pdf",
  }, ctx), (error: unknown) => {
    assert.ok(error instanceof AegisError);
    const details = error.details as Array<{ message: string }>;
    assert.ok(details.some((item) => item.message === "Missing file · nothing at this path"));
    return true;
  });

  assert.throws(() => addEvidence(started, "AC-2", {
    title: "Traversal",
    type: "Document",
    href: "evidence/../fixture.json",
  }, ctx), (error: unknown) => error instanceof AegisError);

  const linked = addEvidence(started, "AC-2", {
    title: "Remote review",
    type: "Link",
    href: "https://drive.example/iam-review",
  }, ctx);
  assert.equal(linked.controls[0]?.evidence[0]?.href, "https://drive.example/iam-review");
  assert.equal(getPackageState(withEvidence, ctx).controls[0]?.evidence.length, 1);
});

test("invalid evidence does not save the control", () => {
  const { ctx, state } = fresh();
  assert.throws(() => saveControl(state, "AC-2", {
    implementation: AC2,
    responsibleRole: "CSP IAM Administrator",
    evidence: { title: "Quarterly account review", type: "Document", href: "evidence/ac-2/missing.pdf" },
  }, ctx));
  assert.equal(state.controls[0]?.implementation, "");
});

test("WIP export writes while completeness stays FAIL, then PASS still exports", () => {
  const { ctx, state: loaded } = fresh();
  const wip = exportOscal(loaded, ctx);
  assert.equal(wip.packageState.gate.status, "FAIL");
  assert.equal(wip.exportId, "exp-0001");
  assert.equal(wip.filename, "exp-0001-package-oscal.xml");
  assert.equal(existsSync(wip.filePath), true);
  assert.equal(existsSync(path.join(ctx.outDir, "package-oscal.xml")), false);
  assert.match(readFileSync(wip.filePath, "utf8"), /<system-security-plan/);
  assert.equal(wip.state.baseline, null);
  const checked = validateOscal(wip.state, ctx, "current");
  assert.equal(checked.packageState.gate.status, "FAIL");
  assert.equal(checked.packageState.pipeline.oscal.filename, "exp-0001-package-oscal.xml");
  assert.throws(
    () => renderWord(checked.state, ctx),
    (error: unknown) => error instanceof AegisError && error.code === "GATE_FAIL",
  );

  let state = passPackage(wip.state, ctx);
  let pkg = getPackageState(state, ctx);
  assert.equal(pkg.gate.status, "PASS");
  assert.equal(pkg.gate.label, "12 of 12 complete · gate open");
  assert.doesNotMatch(pkg.gate.label, /0 of \d+ incomplete/);
  assert.equal(pkg.pipeline.oscal.status, "ready");

  assert.throws(() => renderWord(state, ctx), (error: unknown) => error instanceof AegisError && error.code === "VALIDATOR_LOCKED");
  assert.throws(() => updateBaseline(state, ctx), (error: unknown) => error instanceof AegisError && error.code === "VALIDATOR_LOCKED");

  const exported = exportOscal(state, ctx);
  state = exported.state;
  assert.equal(exported.exportId, "exp-0002");
  assert.equal(exported.filename, "exp-0002-package-oscal.xml");
  assert.equal(state.baseline, null);
  const xml = readFileSync(exported.filePath, "utf8");
  assert.match(xml, /<last-modified>2026-09-23T14:12:00.000Z<\/last-modified>/);
  assert.match(xml, /bnd-gold-0001/);
  assert.match(xml, /fedramp-rev5-subset@2026\.09/);
  assert.match(xml, new RegExp(AC2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const red = validateOscal(state, ctx, "red");
  assert.equal(red.validation.status, "RED");
  assert.equal(red.validation.errors.length, 3);
  assert.deepEqual(
    red.validation.errors.map((error) => [error.id, error.check, error.message, error.oscalPath, error.sourceInIr]),
    [
      ["E1", "Schema", "Required element last-modified is missing", "metadata/last-modified", "Workspace metadata"],
      ["E2", "Schema", "role-id iam-admin has no matching role", "…/implemented-requirement[ac-2]/responsible-role/@role-id", "AC-2 · responsibleRole"],
      ["E3", "Profile", "back-matter resource uuid is not a valid UUID", "back-matter/resource/@uuid", "AC-2 · EV-AC2-01"],
    ],
  );
  assert.equal(red.packageState.pipeline.word.status, "locked");
  assert.equal(red.packageState.pipeline.excel.status, "locked");
  assert.equal(red.packageState.pipeline.baseline.enabled, false);
  assert.doesNotMatch(readFileSync(exported.filePath, "utf8"), /not-a-uuid/);
  assert.match(readFileSync(exported.filePath, "utf8"), /<last-modified>/);

  const green = validateOscal(red.state, ctx, "current");
  state = green.state;
  assert.equal(green.validation.status, "GREEN");
  assert.equal(green.validation.errors.length, 0);
  assert.equal(green.packageState.pipeline.word.status, "ready");
  assert.equal(state.baseline, null);

  const rendered = renderWordExcel(state, ctx);
  state = rendered.state;
  const parity = rendered.packageState.pipeline.parity;
  assert.ok(parity);
  assert.equal(parity.matched, 3);
  assert.equal(parity.sampled, 3);
  assert.equal(parity.samples[0]?.excel.cell, "Controls!D3");
  assert.equal(parity.samples[1]?.excel.cell, "Controls!E3");
  assert.match(readFileSync(rendered.wordPath).toString("utf8"), /Accounts provisioned via the IdP/);
  assert.match(readFileSync(rendered.excelPath).toString("utf8"), /<c r="D3"/);

  const baseline = updateBaseline(state, ctx);
  state = baseline.state;
  assert.equal(baseline.baselineId, "bl-0001");
  assert.equal(state.baseline?.exportId, "exp-0002");

  state = updateEvidence(state, "AC-2", "EV-AC2-01", {
    title: "Quarterly account review",
    type: "Document",
    href: "evidence/ac-2/iam-review-2026-09.pdf",
  }, ctx);
  const changes = changesFor(state, ctx);
  assert.equal(changes.summary.changed, 1);
  assert.equal(changes.summary.unchanged, 11);
  assert.equal(changes.deltas.length, 1);
  const delta = changes.deltas[0];
  assert.equal(delta?.label, "Evidence · Modified");
  assert.equal(delta?.controlId, "AC-2");
  assert.equal(delta?.controlTitle, "Account Management");
  assert.equal(delta?.evidenceId, "EV-AC2-01");
  assert.equal(delta?.before, "evidence/ac-2/iam-review-2026-08.pdf");
  assert.equal(delta?.after, "evidence/ac-2/iam-review-2026-09.pdf");
  assert.deepEqual(
    delta?.affects.map((item) => [item.artifact, item.status, item.detail]),
    [
      ["package-oscal.xml", "Stale", "back-matter resource EV-AC2-01"],
      ["Word render", "Stale", "Evidence table · AC-2"],
      ["Excel render", "Stale", "Evidence sheet · EV-AC2-01"],
    ],
  );

  const again = exportOscal(state, ctx);
  assert.equal(again.exportId, "exp-0003");
  assert.equal(again.filename, "exp-0003-package-oscal.xml");
  assert.equal(again.state.baseline?.id, "bl-0001");
  assert.equal(again.state.baseline?.exportId, "exp-0002");
  assert.notEqual(again.state.baseline?.irHash, again.packageState.irHash);
});
