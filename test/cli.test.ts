import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyPersisted,
  exportOscal,
  findRepoRoot,
  loadFixture,
  updateControl,
  addEvidence,
} from "../lib/aegis";
import type { PersistedState } from "../lib/aegis/types";

const root = findRepoRoot();
const require = createRequire(path.join(root, "package.json"));
const tsx = require.resolve("tsx/cli");

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, path.join(root, "bin/aegis-oscal.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("stock gold export writes a WIP artifact while completeness stays FAIL", () => {
  const validated = run(["validate", "--fixture", "gold"]);
  assert.equal(validated.status, 1);
  assert.match(validated.stderr, /completeness FAIL · 3 of 12 incomplete/);
  assert.match(validated.stderr, /missing required IR fields/);
  assert.match(validated.stderr, /not an authorization result/);
  assert.match(validated.stderr, /AC-2, AU-2, CM-6/);
  assert.match(validated.stderr, /Re export before validation/);
  assert.doesNotMatch(validated.stderr, /no artifacts written/);
  assert.doesNotMatch(validated.stderr, /authorization failed/i);

  const out = mkdtempSync(path.join(tmpdir(), "aegis-cli-"));
  const exported = run(["export", "--fixture", "gold", "--out", out]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stderr, /completeness FAIL/);
  assert.match(exported.stdout, /exp-0001-package-oscal\.xml/);
  assert.match(exported.stdout, /gate FAIL · WIP export written/);
  assert.doesNotMatch(`${exported.stderr}\n${exported.stdout}`, /no artifacts written/);
  assert.equal(existsSync(path.join(out, "exp-0001-package-oscal.xml")), true);
  assert.equal(existsSync(path.join(out, "package-oscal.xml")), false);
});

test("CLI reads a PASS workspace without modifying it", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "aegis-cli-pass-"));
  const ctx = { root, outDir, now: () => new Date("2026-09-23T14:12:00.000Z") };
  let state = loadFixture(emptyPersisted(), "gold", ctx);
  state = updateControl(state, "AC-2", {
    implementation: "Accounts provisioned via the IdP with manager approval; inactive accounts disabled after 35 days.",
    responsibleRole: "CSP IAM Administrator",
  }, ctx);
  state = addEvidence(state, "AC-2", {
    title: "Quarterly account review",
    type: "Document",
    href: "evidence/ac-2/iam-review-2026-08.pdf",
  }, ctx);
  state = addEvidence(state, "AU-2", {
    title: "SIEM logging standard",
    type: "Document",
    href: "evidence/au-2/event-logging-standard-2026-08.pdf",
  }, ctx);
  state = updateControl(state, "CM-6", {
    implementation: "Configuration settings are enforced from the signed baseline; deviations require a recorded exception.",
  }, ctx);
  const exported = exportOscal(state, ctx);
  const file = path.join(outDir, "workspace.json");
  writeFileSync(file, JSON.stringify(exported.state));
  const before = readFileSync(file, "utf8");

  const green = run(["validate", "--fixture", "gold", "--state", file]);
  assert.equal(green.status, 0, green.stderr + green.stdout);
  assert.match(green.stdout, /validator GREEN/);
  assert.match(green.stdout, /session not modified/);

  const red = run(["validate", "--fixture", "gold", "--state", file, "--scenario", "red"]);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /E1\tSchema\tRequired element last-modified is missing/);
  assert.match(red.stdout, /role-id iam-admin has no matching role/);
  assert.match(red.stdout, /back-matter resource uuid is not a valid UUID/);

  const out = mkdtempSync(path.join(tmpdir(), "aegis-cli-out-"));
  const again = run(["export", "--fixture", "gold", "--state", file, "--out", out]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(existsSync(path.join(out, "exp-0002-package-oscal.xml")), true);
  assert.match(again.stdout, /gate PASS/);
  assert.equal(readFileSync(file, "utf8"), before);
  const persisted = JSON.parse(before) as PersistedState;
  assert.equal(persisted.baseline, null);
});
