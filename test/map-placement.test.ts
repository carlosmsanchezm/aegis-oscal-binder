import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { emptyPersisted, findRepoRoot, getPackageState, ingestOscalPackage } from "../lib/aegis";
import {
  EVIDENCE_COLUMN_HEADER,
  EVIDENCE_H,
  evidenceTextWidth,
  evidenceWidth,
  faceLines,
  packRow,
  placeCardColumn,
} from "../lib/aegis/map-layout";
import { buildLayout } from "../lib/aegis/map-placement";
import { bundleCountBadge, evidenceColumnKicker, itemEvidenceLinks, scopeChip, subsetBaselineNote } from "../lib/aegis/map-view";
import type { Ctx } from "../lib/aegis/types";

const root = findRepoRoot();

function ctx(): Ctx {
  return { root, now: () => new Date("2026-09-24T15:00:00.000Z") };
}

function loadAudit(name: string) {
  const text = readFileSync(path.join(root, "fixtures", "audit", name), "utf8");
  const state = ingestOscalPackage({ text, filename: name, catalogId: "fedramp-rev5" }, ctx());
  return getPackageState(state, ctx());
}

function shuffleSsp(text: string, seed: number): string {
  const doc = JSON.parse(text) as {
    "system-security-plan": { "control-implementation": { "implemented-requirements": unknown[] } };
  };
  const list = doc["system-security-plan"]["control-implementation"]["implemented-requirements"];
  let state = seed >>> 0;
  for (let index = list.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const held = list[index];
    list[index] = list[swap];
    list[swap] = held;
  }
  return JSON.stringify(doc);
}

type Box = { x: number; y: number; w: number; h: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
}

function assertClear(name: string, width: number) {
  const pkg = loadAudit(name);
  const layout = buildLayout(pkg, width, false);
  for (let i = 0; i < layout.controls.length; i += 1) {
    for (let j = i + 1; j < layout.controls.length; j += 1) {
      assert.equal(overlaps(layout.controls[i], layout.controls[j]), false, `${width} controls ${layout.controls[i].id} ${layout.controls[j].id}`);
    }
  }
  for (let i = 0; i < layout.pills.length; i += 1) {
    for (let j = i + 1; j < layout.pills.length; j += 1) {
      assert.equal(overlaps(layout.pills[i], layout.pills[j]), false, `${width} pills ${layout.pills[i].controlId} ${layout.pills[j].controlId}`);
    }
  }
  for (const control of layout.controls) {
    const lane = layout.lanes.find((item) => item.memberIds.includes(control.id));
    assert.ok(lane, control.id);
    assert.ok(control.x >= lane.x - 0.5, `${control.id} left of ${lane.id}`);
    assert.ok(control.x + control.w <= lane.x + lane.w + 0.5, `${control.id} spills ${lane.id} at ${width}`);
  }
  for (const pill of layout.pills) {
    const control = layout.controls.find((item) => item.id === pill.controlId);
    const lane = layout.lanes.find((item) => item.id === control?.family);
    assert.ok(lane, pill.controlId);
    assert.ok(pill.x >= lane.x - 0.5, `${pill.label} left`);
    assert.ok(pill.x + pill.w <= lane.x + lane.w + 0.5, `${pill.label} spills ${lane.id} at ${width}`);
  }
  return layout;
}

test("shuffled SSPs of the same controls share one layout", () => {
  for (const name of ["package-a.json", "package-b.json"]) {
    const text = readFileSync(path.join(root, "fixtures", "audit", name), "utf8");
    const first = getPackageState(ingestOscalPackage({ text, filename: name, catalogId: "fedramp-rev5" }, ctx()), ctx());
    const second = getPackageState(ingestOscalPackage({
      text: shuffleSsp(text, 99),
      filename: name,
      catalogId: "fedramp-rev5",
    }, ctx()), ctx());
    assert.equal(JSON.stringify(buildLayout(first, 1440, false)), JSON.stringify(buildLayout(second, 1440, false)));
    assert.equal(JSON.stringify(buildLayout(first, 1100, true)), JSON.stringify(buildLayout(second, 1100, true)));
  }
});

test("package B fits inside its lanes at 1440 and 1100", () => {
  assertClear("package-b.json", 1440);
  assertClear("package-b.json", 1100);
});

test("catalog titles and subset copy follow the ingested package", () => {
  const pkg = loadAudit("package-a.json");
  const cp2 = pkg.controls.find((control) => control.id === "CP-2");
  assert.equal(cp2?.title, "Contingency Plan");
  assert.deepEqual(faceLines("CP-2", cp2?.title ?? ""), ["Contingency", "Plan"]);
  assert.equal(pkg.map.subsetMatch, false);
  assert.equal(pkg.inScopeCount, 8);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.gate.incomplete, 5);
  assert.equal(scopeChip(pkg.map.subsetMatch, pkg.inScopeCount), "FedRAMP Rev5 · 8 controls");
  assert.equal(subsetBaselineNote(pkg.map.subsetMatch, pkg.inScopeCount).includes("12"), false);
  assert.equal(/subset of 12/i.test(subsetBaselineNote(pkg.map.subsetMatch, pkg.inScopeCount)), false);
  const wide = loadAudit("package-b.json");
  assert.equal(wide.map.subsetMatch, false);
  assert.equal(wide.inScopeCount, 40);
  assert.equal(wide.gate.incomplete, 16);
  assert.equal(scopeChip(wide.map.subsetMatch, wide.inScopeCount).includes("12"), false);
  const shared = buildLayout(pkg, 1440, false).evidence.find((item) => item.controlIds.includes("AC-2") && item.controlIds.includes("CM-3"));
  assert.ok(shared, "evidence merged on resource uuid");
  assert.equal(buildLayout(pkg, 1440, false).evidence.length, 4);
});

function pathEnds(d: string): Array<{ x: number; y: number }> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return [
    { x: nums[0], y: nums[1] },
    { x: nums[nums.length - 2], y: nums[nums.length - 1] },
  ];
}

test("bundle endpoints stay on the lane center unless a missing chip covers that point", () => {
  const sample = readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8");
  const sampleLayout = buildLayout(getPackageState(ingestOscalPackage({
    text: sample,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx()), 1440, false);
  const centers = new Map(sampleLayout.lanes.map((lane) => [lane.id, lane.x + lane.w / 2]));
  for (const bundle of sampleLayout.bundles) {
    for (const end of pathEnds(bundle.d)) {
      const atCenter = [bundle.left, bundle.right].some((id) => Math.abs(end.x - (centers.get(id) ?? -1)) < 0.6);
      assert.equal(atCenter, true, `${bundle.left}-${bundle.right} ${end.x}`);
    }
  }
  const layout = buildLayout(loadAudit("package-a.json"), 1440, false);
  const si = layout.controls.find((control) => control.id === "SI-4");
  assert.ok(si);
  const chips = layout.pills.filter((pill) => pill.controlId === "SI-4" && pill.y > si.y);
  assert.ok(chips.length >= 2);
  const siBundles = layout.bundles.filter((bundle) => bundle.left === "SI" || bundle.right === "SI");
  assert.ok(siBundles.length > 0);
  for (const bundle of siBundles) {
    for (const end of pathEnds(bundle.d)) {
      const throughChip = chips.some((chip) => chip.x - 4 < end.x && end.x < chip.x + chip.w + 4 && Math.abs(end.y - chip.y) < 40);
      assert.equal(throughChip, false, `${bundle.left}-${bundle.right} ends in a SI-4 chip`);
    }
  }
});

test("a bundle count badge is omitted for one relationship and shown for two or more", () => {
  assert.equal(bundleCountBadge(1), null);
  assert.equal(bundleCountBadge(0), null);
  assert.equal(bundleCountBadge(2), "2");
  assert.equal(bundleCountBadge(6), "6");
  const packageA = buildLayout(loadAudit("package-a.json"), 1440, false);
  assert.ok(packageA.bundles.length > 0);
  assert.equal(packageA.bundles.every((bundle) => bundle.pairs === 1 && bundle.countLabel === null), true);
  const packageB = buildLayout(loadAudit("package-b.json"), 1440, false);
  const singles = packageB.bundles.filter((bundle) => bundle.pairs === 1);
  const grouped = packageB.bundles.filter((bundle) => bundle.pairs >= 2);
  assert.ok(singles.length > 0);
  assert.ok(grouped.length > 0);
  for (const bundle of singles) assert.equal(bundle.countLabel, null);
  for (const bundle of grouped) assert.equal(bundle.countLabel, String(bundle.pairs));
  const sample = readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8");
  const sampleLayout = buildLayout(getPackageState(ingestOscalPackage({
    text: sample,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx()), 1440, false);
  assert.equal(sampleLayout.bundles.some((bundle) => bundle.pairs === 1 && bundle.countLabel === null), true);
  assert.equal(sampleLayout.bundles.some((bundle) => bundle.pairs >= 2 && bundle.countLabel === String(bundle.pairs)), true);
});

function hostLaneId(layout: ReturnType<typeof buildLayout>, box: { x: number; w: number; band?: number }): string | null {
  const center = box.x + box.w / 2;
  return layout.lanes.find((lane) => (box.band == null || lane.band === box.band) && center >= lane.x - 0.01 && center <= lane.x + lane.w + 0.01)?.id ?? null;
}

/** Evidence rows: unshrunk boxes, no overlap, every box centered over a family it serves. */
function assertEvidenceRows(layout: ReturnType<typeof buildLayout>, label: string, panelOpen = false) {
  assert.ok(layout.evidence.length > 0, label);
  for (const box of layout.evidence) {
    assert.equal(box.y, layout.bands[box.band].evidenceY + box.row * (EVIDENCE_H + 8), `${label} ${box.id} row`);
    if (box.placement !== "gap") {
      const host = hostLaneId(layout, box);
      assert.ok(host && box.families.has(host), `${label} ${box.id} center is over ${host}, not a family it serves`);
    }
    assert.equal(box.h, EVIDENCE_H, `${label} ${box.id} height`);
    assert.ok(box.w >= evidenceWidth(panelOpen) || box.placement !== "gap", `${label} ${box.id} gap evidence keeps the minimum width`);
    assert.ok(box.w >= evidenceTextWidth(box), `${label} ${box.id} narrower than its text`);
    assert.ok(box.x >= 16 - 0.5 && box.x + box.w <= layout.width - 16 + 0.5, `${label} ${box.id} off the canvas`);
    if (box.families.size > 1 && box.placement !== "gap") {
      const lane = hostLaneId(layout, box);
      assert.ok(lane && box.families.has(lane), `${label} shared ${box.id} center is in ${lane}`);
    }
  }
  for (let i = 0; i < layout.evidence.length; i += 1) {
    for (let j = i + 1; j < layout.evidence.length; j += 1) {
      assert.equal(overlaps(layout.evidence[i], layout.evidence[j]), false, `${label} ${layout.evidence[i].id} ${layout.evidence[j].id}`);
    }
  }
}

test("evidence column kickers follow item links and stay below the header", () => {
  const pkg = loadAudit("package-retest.json");
  const ac17 = pkg.controls.find((control) => control.id === "AC-17");
  const ac2 = pkg.controls.find((control) => control.id === "AC-2");
  const ra5 = pkg.controls.find((control) => control.id === "RA-5");
  assert.ok(ac17 && ac2 && ra5);
  assert.equal(ac17.title, "Remote Access");
  assert.equal(itemEvidenceLinks(ac17).length, 0);
  assert.equal(evidenceColumnKicker(itemEvidenceLinks(ac17).length), "Evidence · not mapped to items");
  assert.equal(itemEvidenceLinks(ra5).length, 0);
  assert.equal(evidenceColumnKicker(0), "Evidence · not mapped to items");
  assert.equal(itemEvidenceLinks(ac2).length, 1);
  assert.equal(evidenceColumnKicker(itemEvidenceLinks(ac2).length), "Evidence · mapped to items");
  const cardH = 52;
  const gap = 18;
  const count = 6;
  const stack = EVIDENCE_COLUMN_HEADER + Math.max(0, count - 1) * (cardH + gap) + cardH;
  const placed = placeCardColumn(
    Array.from({ length: count }, (_, index) => ({ id: `EV-${index}`, ideal: index * 2 })),
    cardH,
    gap,
    { top: EVIDENCE_COLUMN_HEADER, bottom: Math.max(stack, 400) },
  );
  assert.equal(placed.length, count);
  const tops = placed.map((card) => card.top).sort((a, b) => a - b);
  for (const top of tops) assert.ok(top >= EVIDENCE_COLUMN_HEADER, String(top));
  for (let index = 1; index < tops.length; index += 1) {
    assert.ok(tops[index] >= tops[index - 1] + cardH + gap - 0.5);
  }
});

test("shared evidence stays in a lane it serves", () => {
  const pkg = loadAudit("package-retest.json");
  assert.equal(pkg.gate.status, "PASS");
  assert.equal(pkg.gate.label, "8 of 8 complete · gate open");
  assert.equal(pkg.map.subsetMatch, false);
  assert.equal(pkg.inScopeCount, 8);
  assert.equal(scopeChip(pkg.map.subsetMatch, pkg.inScopeCount).includes("12"), false);
  const layout = buildLayout(pkg, 1440, false);
  assertEvidenceRows(layout, "retest");
  assertEvidenceRows(buildLayout(pkg, 1110, true), "retest panel", true);
  const scan = layout.evidence.find((item) => item.id === "EV-SCAN-01");
  assert.ok(scan);
  assert.deepEqual(scan.controlIds, ["RA-5", "SI-4"]);
  const host = hostLaneId(layout, scan);
  assert.ok(host === "RA" || host === "SI", host ?? "none");
  const sample = readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8");
  const sampleLayout = buildLayout(getPackageState(ingestOscalPackage({
    text: sample,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx()), 1440, false);
  const idp = sampleLayout.evidence.find((item) => item.id === "EV-IDP-01");
  assert.ok(idp);
  assertEvidenceRows(sampleLayout, "sample");
  assertEvidenceRows(buildLayout(getPackageState(ingestOscalPackage({
    text: sample,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx()), 1110, true), "sample panel", true);
  const idpLane = hostLaneId(sampleLayout, idp);
  assert.equal(idp.families.has("AC") && idp.families.has("IA"), true);
  assert.ok(idpLane === "AC" || idpLane === "IA", idpLane ?? "none");
  assertEvidenceRows(buildLayout(loadAudit("package-b.json"), 1440, false), "package B");
  assertEvidenceRows(buildLayout(loadAudit("package-b.json"), 1100, false), "package B narrow");
});

function loadSample() {
  const text = readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8");
  return getPackageState(ingestOscalPackage({ text, filename: "sample-oscal-ssp-rev5.json", catalogId: "fedramp-rev5" }, ctx()), ctx());
}

test("evidence boxes keep their width and spill along the row instead of shrinking", () => {
  const sample = loadSample();
  const open = buildLayout(sample, 1440, false);
  assert.equal(open.width, 1440);
  assertEvidenceRows(open, "sample 1440");
  assert.deepEqual(open.evidence.filter((box) => box.w !== 124).map((box) => [box.id, box.w]), [["EV-SI2-01", 108]], "unselected sample boxes are even except where a one-control outer family narrows its box");
  assert.equal(hostLaneId(open, open.evidence.find((box) => box.id === "EV-IDP-01")!), "AC", "EV-IDP-01 links AC and IA twice each, so it sits under AC, first in family order");
  const panel = buildLayout(sample, 1110, true);
  assert.equal(panel.width, 1110, "the AC-2 panel view does not scroll sideways");
  assertEvidenceRows(panel, "sample 1110 panel", true);
  for (const name of ["package-retest.json", "package-a.json"]) {
    const pkg = loadAudit(name);
    for (const [width, panelOpen] of [[1440, false], [1110, true], [900, false]] as const) {
      const layout = buildLayout(pkg, width, panelOpen);
      assertEvidenceRows(layout, `${name} ${width}`, panelOpen);
    }
  }
  const wide = loadAudit("package-b.json");
  for (const [width, panelOpen] of [[1440, false], [1110, true]] as const) {
    const layout = buildLayout(wide, width, panelOpen);
    assert.equal(layout.evidence.length, 43);
    assertEvidenceRows(layout, `package B ${width}`, panelOpen);
    if (!panelOpen) assert.equal(layout.width, width, "40 controls fit the 1440 view");
    for (const lane of layout.lanes) {
      const members = layout.controls.filter((control) => control.family === lane.id);
      for (const control of members) assert.ok(control.x >= lane.x - 0.5 && control.x + control.w <= lane.x + lane.w + 0.5, control.id);
    }
    assert.equal(JSON.stringify(layout), JSON.stringify(buildLayout(wide, width, panelOpen)), "deterministic");
  }
});

test("the row solver keeps order and gaps, and spills a crowded run both ways", () => {
  const lefts = packRow(
    [{ w: 100, target: 200 }, { w: 100, target: 200 }, { w: 100, target: 200 }],
    { left: 0, right: 1000 },
    8,
  );
  assert.deepEqual(lefts, [92, 200, 308]);
  const clamped = packRow([{ w: 100, target: -50 }, { w: 100, target: 950 }], { left: 16, right: 1000 }, 8);
  assert.deepEqual(clamped, [16, 900]);
  const heavy = packRow([{ w: 100, target: 300 }, { w: 100, target: 300, weight: 16 }], { left: 0, right: 1000 }, 8);
  assert.ok(Math.abs(heavy[1] - 300) < 8, String(heavy));
  assert.ok(Math.abs(heavy[1] - heavy[0] - 108) < 0.02);
});

test("the 12-control sample stays FAIL 1 of 12 with AU-2 only", () => {
  const text = readFileSync(path.join(root, "public", "samples", "sample-oscal-ssp-rev5.json"), "utf8");
  const pkg = getPackageState(ingestOscalPackage({
    text,
    filename: "sample-oscal-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  assert.equal(pkg.map.subsetMatch, true);
  assert.equal(pkg.gate.status, "FAIL");
  assert.equal(pkg.gate.label, "1 of 12 incomplete");
  assert.deepEqual(pkg.gate.incompleteControlIds, ["AU-2"]);
  assert.equal(scopeChip(pkg.map.subsetMatch, pkg.inScopeCount), "FedRAMP Rev5 · 12-control subset");
  assert.equal(subsetBaselineNote(true, 12), "Subset of 12 controls, not the full Moderate baseline");
  assert.deepEqual(faceLines("AC-2", "Account Management"), ["Account", "Mgmt"]);
  assert.notDeepEqual(faceLines("AC-2", "Access Control Policy and Procedures"), ["Account", "Mgmt"]);
  const packageB = buildLayout(loadAudit("package-b.json"), 1440, false);
  for (const [left, right] of [["IR", "SI"], ["AU", "IR"]] as const) {
    const bundle = packageB.bundles.find((item) => (
      (item.left === left && item.right === right) || (item.left === right && item.right === left)
    ));
    assert.ok(bundle, `${left}-${right} bundle`);
    const mid = (bundle.run[0].x + bundle.run.at(-1)!.x) / 2;
    assert.ok(Math.abs(bundle.px - mid) <= 2, `${left}-${right} chip ${bundle.px} vs chord ${mid}`);
  }
  const layout = buildLayout(pkg, 1440, false);
  assert.equal(layout.controls.every((control) => control.y === layout.controlY), true);
  assert.equal(emptyPersisted().loaded, false);
});

test("wrapped upload fixture has eight or more families and more than one band at 1440", () => {
  const text = readFileSync(path.join(root, "public", "upload", "upload-test-wrapped-ssp-rev5.json"), "utf8");
  const pkg = getPackageState(ingestOscalPackage({
    text,
    filename: "upload-test-wrapped-ssp-rev5.json",
    catalogId: "fedramp-rev5",
  }, ctx()), ctx());
  const families = new Set(pkg.controls.map((control) => control.family));
  assert.ok(families.size >= 8, `families ${families.size}`);
  assert.ok(families.has("MA"));
  const layout = buildLayout(pkg, 1440, false);
  assert.ok(layout.bands.length > 1, `bands ${layout.bands.length}`);
});
