import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addEvidence,
  changesFor,
  emptyPersisted,
  exportOscal,
  findRepoRoot,
  getPackageState,
  loadFixture,
  renderWordExcel,
  updateBaseline,
  updateControl,
  updateEvidence,
  validateOscal,
} from "../lib/aegis";

const root = findRepoRoot();
const outDir = mkdtempSync(path.join(tmpdir(), "aegis-demo-"));
const ctx = { root, outDir, now: () => new Date("2026-09-23T14:12:00.000Z") };

let state = loadFixture(emptyPersisted(), "gold", ctx);
let pkg = getPackageState(state, ctx);
console.log(`1 load gold · ${pkg.workspaceName} · ${pkg.boundaryId} · ${pkg.catalogPin}`);
console.log(`2 gate ${pkg.gate.status} · ${pkg.gate.label} · ${pkg.gate.incompleteControlIds.join(", ")}`);
if (pkg.gate.incomplete !== 3 || pkg.gate.total !== 12) throw new Error("expected 3 of 12");

const wip = exportOscal(state, ctx);
if (wip.packageState.gate.status !== "FAIL") throw new Error("WIP export should keep completeness FAIL");
if (wip.filename !== "exp-0001-package-oscal.xml") throw new Error(`unexpected WIP filename ${wip.filename}`);
state = wip.state;
console.log(`3 wip export ${wip.exportId} · ${wip.filename} · completeness still FAIL`);

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
pkg = getPackageState(state, ctx);
console.log(`4 edited · gate ${pkg.gate.status} · ${pkg.gate.label}`);
if (pkg.gate.status !== "PASS") throw new Error("expected PASS");

const exported = exportOscal(state, ctx);
if (exported.exportId !== "exp-0002") throw new Error(`expected exp-0002, got ${exported.exportId}`);
state = exported.state;
console.log(`5 wrote ${exported.exportId} · ${exported.filePath}`);

const red = validateOscal(state, ctx, "red");
console.log(`6 validator RED · ${red.validation.errors.map((error) => error.id).join(" ")}`);
if (red.validation.errors.length !== 3) throw new Error("expected 3 named errors");

const green = validateOscal(red.state, ctx, "current");
state = green.state;
console.log(`7 validator ${green.validation.status}`);
if (green.validation.status !== "GREEN") throw new Error("expected GREEN");

const rendered = renderWordExcel(state, ctx);
state = rendered.state;
console.log(`8 word + excel · parity ${rendered.packageState.pipeline.parity?.matched}/${rendered.packageState.pipeline.parity?.sampled}`);

const baseline = updateBaseline(state, ctx);
state = baseline.state;
console.log(`9 baseline ${baseline.baselineId} · explicit`);

state = updateEvidence(state, "AC-2", "EV-AC2-01", {
  title: "Quarterly account review",
  type: "Document",
  href: "evidence/ac-2/iam-review-2026-09.pdf",
}, ctx);
const changes = changesFor(state, ctx);
console.log(`10 delta · ${changes.deltas[0]?.label} · ${changes.deltas[0]?.controlId} · ${changes.deltas[0]?.evidenceId}`);
if (changes.summary.changed !== 1) throw new Error("expected one named delta");

const again = exportOscal(state, ctx);
if (again.exportId !== "exp-0003") throw new Error(`expected exp-0003, got ${again.exportId}`);
if (again.state.baseline?.id !== "bl-0001") throw new Error("re-export moved the baseline");
console.log(`11 re-export ${again.exportId} · baseline still ${again.state.baseline?.id}`);
console.log("demo loop ok");
