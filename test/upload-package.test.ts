import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findRepoRoot, getPackageState, ingestOscalPackage } from "../lib/aegis";
import { buildLayout } from "../lib/aegis/map-placement";
import type { Ctx } from "../lib/aegis/types";
import {
  FIXED_SEEDS,
  SAMPLE_CONTROL_IDS,
  SAMPLE_FAMILIES,
  SAMPLE_ROLE_IDS,
  UPLOAD_FIXTURE,
  UPLOAD_PUBLIC,
  annotateSeed,
  describePackage,
  generatePackage,
  packageText,
  type PackageFacts,
} from "../tests/fixtures/randomPackage";

const root = findRepoRoot();

function ctx(): Ctx {
  return { root, now: () => new Date("2026-09-25T16:00:00.000Z") };
}

function assertLayer(label: string, text: string, filename: string, facts: PackageFacts) {
  try {
    const state = ingestOscalPackage({ text, filename, catalogId: "fedramp-rev5" }, ctx());
    const pkg = getPackageState(state, ctx());
    assert.equal(pkg.loaded, true, label);
    assert.equal(pkg.workspaceName, facts.systemName, label);
    assert.equal(pkg.boundaryId, facts.boundaryId, label);
    assert.equal(pkg.gate.label, facts.gateLabel, label);
    assert.equal(pkg.gate.incomplete, facts.incomplete, label);
    assert.deepEqual(pkg.families.map((family) => family.id), facts.families, label);
    assert.deepEqual(pkg.controls.map((control) => control.id), facts.controls.map((control) => control.id), label);
    assert.deepEqual(
      pkg.controls.map((control) => ({
        id: control.id,
        implementation: control.implementation,
        roleIds: control.responsibleRoleIds,
        evidence: control.evidence.map((item) => item.uuid),
        complete: control.complete,
      })),
      facts.controls.map((control) => ({
        id: control.id,
        implementation: control.implementation,
        roleIds: control.roleIds,
        evidence: control.evidenceUuids,
        complete: control.complete,
      })),
      label,
    );
    assert.deepEqual(
      pkg.roles.map((role) => ({ id: role.id, title: role.title, shortName: role.shortName ?? "" })),
      facts.roles.map((role) => ({ id: role.id, title: role.title, shortName: role.shortName })),
      label,
    );
    const packageIds = new Set(facts.controls.map((control) => control.id));
    for (const edge of pkg.map.edges) {
      assert.equal(packageIds.has(edge.fromId), true, `${label} related ${edge.fromId}`);
      assert.equal(packageIds.has(edge.toId), true, `${label} related ${edge.toId}`);
    }
    const sampleSet = SAMPLE_CONTROL_IDS.map((id) => id.toLowerCase());
    const loaded = new Set(facts.controls.map((control) => control.id.toLowerCase()));
    const subset = loaded.size === sampleSet.length && sampleSet.every((id) => loaded.has(id));
    assert.equal(pkg.map.subsetMatch, subset, label);
    for (const width of [1440, 1280]) {
      const layout = buildLayout(pkg, width, false);
      assert.equal(layout.lanes.length, facts.families.length, `${label} families @${width}`);
      assert.deepEqual(layout.lanes.map((lane) => lane.id), facts.families, `${label} family ids @${width}`);
      assert.equal(layout.controls.length, facts.controls.length, `${label} controls @${width}`);
      assert.equal(layout.roles.length, facts.roles.length, `${label} roles @${width}`);
      for (const role of facts.roles) {
        const box = layout.roles.find((item) => item.id === role.id);
        assert.ok(box, `${label} missing role ${role.id} @${width}`);
        assert.equal(box.label, role.label, label);
        assert.equal(box.title, role.title, label);
      }
      assert.equal(layout.evidence.length, facts.evidence.length, `${label} evidence @${width}`);
      for (const item of facts.evidence) {
        const box = layout.evidence.find((entry) => entry.uuid === item.uuid);
        assert.ok(box, `${label} missing evidence ${item.id} @${width}`);
        assert.deepEqual(box.controlIds, item.controlIds, label);
        assert.equal(box.title, item.title, label);
      }
    }
  } catch (error) {
    throw annotateSeed(label, error);
  }
}

test("upload test package is distinct from the sample and passes ingest", () => {
  const fixture = readFileSync(path.join(root, UPLOAD_FIXTURE), "utf8");
  const published = readFileSync(path.join(root, UPLOAD_PUBLIC), "utf8");
  assert.equal(published, fixture);
  const facts = describePackage(JSON.parse(fixture));
  assert.equal(facts.systemName, "Harbor upload test CSP");
  assert.equal(facts.boundaryId, "bnd-harbor-upload-test");
  assert.equal(facts.controls.length, 12);
  assert.equal(facts.roles.length, 5);
  assert.ok(facts.families.length >= 4);
  assert.ok(facts.families.some((family) => !SAMPLE_FAMILIES.includes(family as (typeof SAMPLE_FAMILIES)[number])));
  assert.equal(facts.incomplete > 0, true, facts.gateLabel);
  assert.equal(facts.evidence.filter((item) => item.span === "adjacent").length, 1);
  assert.equal(facts.evidence.filter((item) => item.span === "non-adjacent").length, 1);
  assert.ok(facts.evidence.some((item) => item.span === "single"));
  for (const id of SAMPLE_ROLE_IDS) assert.equal(facts.roles.some((role) => role.id === id), false, id);
  for (const id of SAMPLE_CONTROL_IDS) assert.equal(facts.controls.some((control) => control.id === id), false, id);
  assert.deepEqual(facts.roles.map((role) => role.label), ["Steward", "Boundary", "Clerk", "Captain", "Recovery"]);
  assertLayer("upload-test", fixture, "upload-test-ssp-rev5.json", facts);
});

test("generated packages stay inside the generator bounds and match the map data layer", () => {
  const seeds = [...new Set([...FIXED_SEEDS, ...Array.from({ length: 40 }, (_, index) => index + 1)])];
  const seen = { families: new Set<number>(), roles: new Set<number>(), evidence: new Set<number>() };
  for (const seed of seeds) {
    const first = generatePackage(seed);
    const second = generatePackage(seed);
    assert.equal(packageText(first.document), packageText(second.document), `seed ${seed} drifted`);
    const facts = describePackage(first.document);
    assert.ok(facts.families.length >= 1 && facts.families.length <= 6, `seed ${seed} families ${facts.families.length}`);
    assert.ok(facts.roles.length >= 1 && facts.roles.length <= 7, `seed ${seed} roles ${facts.roles.length}`);
    const perFamily = new Map<string, number>();
    for (const control of facts.controls) perFamily.set(control.family, (perFamily.get(control.family) ?? 0) + 1);
    for (const [family, count] of perFamily) {
      assert.ok(count >= 1 && count <= 5, `seed ${seed} ${family} has ${count} controls`);
    }
    for (const id of SAMPLE_ROLE_IDS) assert.equal(facts.roles.some((role) => role.id === id), false, `seed ${seed} ${id}`);
    assert.equal(facts.controls.length > 0, true, `seed ${seed}`);
    seen.families.add(facts.families.length);
    seen.roles.add(facts.roles.length);
    seen.evidence.add(facts.evidence.length);
    assertLayer(String(seed), packageText(first.document), `generated-ssp-${seed}.json`, facts);
  }
  assert.equal(seen.families.has(1), true);
  assert.equal(seen.families.has(6), true);
  assert.equal(seen.roles.has(1), true);
  assert.equal(seen.roles.has(7), true);
  assert.equal(seen.evidence.has(0), true);
  for (const seed of FIXED_SEEDS) assert.equal(seeds.includes(seed), true);
});

test("annotateSeed keeps the seed on a failure", () => {
  const error = annotateSeed(19, new Error("layout moved"));
  assert.match(error.message, /seed 19/);
  assert.match(error.message, /layout moved/);
});
