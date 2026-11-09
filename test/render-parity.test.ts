import assert from "node:assert/strict";
import test from "node:test";
import { renderExcelSheets, renderWordXml, spotCheckParity } from "../lib/aegis/render";
import type { ControlView } from "../lib/aegis/types";

function control(id: string, implementation: string, roleId: string, role: string): ControlView {
  return {
    id,
    oscalId: id.toLowerCase(),
    title: `${id} title`,
    family: id.split("-")[0],
    implementation,
    responsibleRoleId: roleId,
    responsibleRole: role,
    responsibleRoleIds: roleId ? [roleId] : [],
    roleLabels: role ? [role] : [],
    evidence: [],
  } as unknown as ControlView;
}

function oscalFor(controls: ControlView[]): string {
  return controls.map((item) => `<implemented-requirement control-id="${item.oscalId}">
  <responsible-role role-id="${item.responsibleRoleId}"/>
  <description><p>${item.implementation}</p></description>
</implemented-requirement>`).join("\n");
}

function parity(controls: ControlView[]) {
  return spotCheckParity({
    irHash: "ir-test",
    controls,
    oscalXml: oscalFor(controls),
    wordXml: renderWordXml(controls, "Parity test"),
    excelControlsXml: renderExcelSheets(controls, "Parity test").controls,
  });
}

test("parity reads AC-2 from its own Excel row when it is not the first control", () => {
  const controls = [
    control("AC-1", "Policy owned by the ISSO", "isso", "Information System Security Officer"),
    control("AC-2", "Accounts provisioned via the IdP", "iam-admin", "Identity and Access Administrator"),
    control("CM-6", "Baselines enforced by config management", "config-mgr", "Configuration Manager"),
  ];
  const report = parity(controls);
  assert.equal(report.sampled, 3);
  assert.equal(report.matched, 3);
  const [implementation, role, cm6] = report.samples;
  assert.equal(implementation.field, "AC-2 · implementation");
  assert.equal(implementation.excel.cell, "Controls!D4");
  assert.equal(role.field, "AC-2 · responsibleRole");
  assert.equal(role.excel.cell, "Controls!E4");
  assert.equal(role.excel.match, true);
  assert.equal(cm6.excel.cell, "Controls!D5");
});

test("parity catches an AC-2 role that differs only in Excel", () => {
  const controls = [
    control("AC-1", "Policy owned by the ISSO", "isso", "Information System Security Officer"),
    control("AC-2", "Accounts provisioned via the IdP", "iam-admin", "Identity and Access Administrator"),
  ];
  const excel = renderExcelSheets(controls, "Parity test").controls.replace("Identity and Access Administrator", "Someone else");
  const report = spotCheckParity({
    irHash: "ir-test",
    controls,
    oscalXml: oscalFor(controls),
    wordXml: renderWordXml(controls, "Parity test"),
    excelControlsXml: excel,
  });
  const role = report.samples.find((sample) => sample.field === "AC-2 · responsibleRole");
  assert.equal(role?.excel.cell, "Controls!E4");
  assert.equal(role?.excel.match, false);
});

test("parity skips the AC-2 checks cleanly when the package has no AC-2", () => {
  const controls = [
    control("AC-1", "Policy owned by the ISSO", "isso", "Information System Security Officer"),
    control("CM-6", "Baselines enforced by config management", "config-mgr", "Configuration Manager"),
  ];
  const report = parity(controls);
  assert.equal(report.sampled, 1);
  assert.equal(report.matched, 1);
  assert.deepEqual(report.samples.map((sample) => sample.field), ["CM-6 · implementation"]);
  assert.equal(report.samples[0].excel.cell, "Controls!D4");
});
