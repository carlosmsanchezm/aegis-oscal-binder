import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { emptyPersisted, findRepoRoot, getPackageState, ingestOscalPackage } from "../lib/aegis";
import { loadFixture } from "../lib/aegis/operations";
import {
  CARD_GAP,
  CARD_MARGIN,
  CONTROL_H,
  FAMILY_GAP,
  FAMILY_HEADER_GAP,
  FAMILY_PAD,
  evidenceCardSpot,
  evidenceTextWidth,
  familyHeaderWidth,
  nextStageSize,
  roleCardSpot,
  stageFillHeight,
} from "../lib/aegis/map-layout";
import { buildLayout } from "../lib/aegis/map-placement";
import type { Ctx } from "../lib/aegis/types";

const root = findRepoRoot();

function ctx(): Ctx {
  return { root, now: () => new Date("2026-09-25T15:00:00.000Z") };
}

function load(file: string, text?: string) {
  if (file === GOLD) return getPackageState(loadFixture({ ...emptyPersisted(), catalogId: "fedramp-rev5" } as never, "gold", ctx()), ctx());
  text ??= readFileSync(path.join(root, file), "utf8");
  return getPackageState(ingestOscalPackage({ text, filename: path.basename(file), catalogId: "fedramp-rev5" }, ctx()), ctx());
}

const SAMPLE = "public/samples/sample-oscal-ssp-rev5.json";
const PACKAGE_A = "fixtures/audit/package-a.json";
const PACKAGE_B = "fixtures/audit/package-b.json";
const RETEST = "fixtures/audit/package-retest.json";
const GOLD = "gold";

test("the stage size update keeps state when the measurement repeats", () => {
  const floor = { width: 720, height: 570 };
  const first = nextStageSize({ width: 1280, height: 570, gutter: 0 }, { width: 1110.5, height: 626.4, gutter: 15 }, floor);
  assert.deepEqual(first, { width: 1095, height: 626, gutter: 15 });
  assert.equal(nextStageSize(first, { width: 1110.5, height: 626.4, gutter: 15 }, floor), first, "same input, same object");
  assert.equal(nextStageSize(first, { width: 1110.9, height: 626.9, gutter: 15.2 }, floor), first, "sub-pixel jitter floors to the same size");
  assert.deepEqual(nextStageSize(first, { width: 600, height: 300, gutter: 0 }, floor), { width: 720, height: 570, gutter: 0 });
  assert.equal(stageFillHeight(first, 1095), 626);
  assert.equal(stageFillHeight(first, 1400), 611, "a canvas that scrolls sideways leaves room for its scrollbar");
});

type Layout = ReturnType<typeof buildLayout>;

function assertTightBoxes(layout: Layout, label: string) {
  const bands = [...new Set(layout.lanes.map((lane) => lane.band))];
  for (const band of bands) {
    const row = layout.lanes.filter((lane) => lane.band === band);
    assert.equal(new Set(row.map((lane) => lane.h)).size, 1, `${label} band ${band} one box height`);
    row.forEach((lane, index) => {
      const members = layout.controls.filter((control) => control.family === lane.id);
      assert.ok(members.length > 0, `${label} ${lane.id} has controls`);
      const left = Math.min(...members.map((control) => control.x));
      const right = Math.max(...members.map((control) => control.x + control.w));
      const top = Math.min(...members.map((control) => control.y));
      const bottom = Math.max(...members.map((control) => control.y + control.h));
      assert.ok(Math.abs(left - lane.x - FAMILY_PAD) < 0.02, `${label} ${lane.id} left padding ${left - lane.x}`);
      assert.ok(Math.abs(lane.x + lane.w - right - FAMILY_PAD) < 0.02, `${label} ${lane.id} right padding ${lane.x + lane.w - right}`);
      assert.ok(Math.abs(lane.y + lane.h - bottom - FAMILY_PAD) < 0.02, `${label} ${lane.id} bottom padding ${lane.y + lane.h - bottom}`);
      assert.equal(top, lane.y + FAMILY_PAD + lane.headerH + FAMILY_HEADER_GAP, `${label} ${lane.id} header to controls`);
      assert.ok(lane.w - 2 * FAMILY_PAD >= familyHeaderWidth(lane, Boolean(lane.baselineLines[1])) - 0.01, `${label} ${lane.id} header fits`);
      if (index > 0) {
        const previous = row[index - 1];
        assert.ok(Math.abs(lane.x - (previous.x + previous.w) - FAMILY_GAP) < 0.02, `${label} gap before ${lane.id}`);
      }
    });
    const lines = new Set(row.map((lane) => `${lane.titleLines[1] || row.every((other) => !other.titleLines[1]) ? 2 : 1}|${lane.baselineLines[1] ? 2 : 1}`));
    assert.ok(lines.size <= 2, `${label} band ${band} header line counts`);
  }
  const firstTop = Math.min(...layout.lanes.map((lane) => lane.y));
  for (const role of layout.roles) assert.ok(role.y + role.h <= firstTop, `${label} role ${role.id} above the boxes`);
  for (const box of layout.evidence) {
    const bandBottom = Math.max(...layout.lanes.filter((lane) => lane.band === box.band).map((lane) => lane.y + lane.h));
    assert.ok(box.y >= bandBottom, `${label} evidence ${box.id} below its band`);
  }
}

test("family boxes wrap their header and controls with 12px padding and 8px gaps", () => {
  for (const file of [SAMPLE, GOLD, PACKAGE_A, PACKAGE_B, RETEST]) {
    const pkg = load(file);
    for (const [width, panelOpen] of [[1440, false], [1425, false], [1100, false], [1110, true], [1095, true]] as const) {
      assertTightBoxes(buildLayout(pkg, width, panelOpen), `${path.basename(file)} ${width}${panelOpen ? " panel" : ""}`);
    }
  }
});

test("the sample keeps one row that fits the view with and without the panel", () => {
  const pkg = load(SAMPLE);
  for (const [width, panelOpen] of [[1440, false], [1425, false], [1110, true], [1095, true]] as const) {
    const layout = buildLayout(pkg, width, panelOpen);
    assert.equal(layout.width, width, `${width} does not scroll sideways`);
    assert.equal(new Set(layout.controls.map((control) => control.y)).size, 1, `${width} one control row`);
    assert.equal(layout.controls.length, 12);
  }
});

test("shuffled SSPs give the same family box rects", () => {
  for (const file of [PACKAGE_A, PACKAGE_B, SAMPLE]) {
    const text = readFileSync(path.join(root, file), "utf8");
    const doc = JSON.parse(text) as { "system-security-plan": { "control-implementation": { "implemented-requirements": unknown[] } } };
    doc["system-security-plan"]["control-implementation"]["implemented-requirements"].reverse();
    const first = load(file);
    const second = load(file, JSON.stringify(doc));
    for (const [width, panelOpen] of [[1440, false], [1100, false], [1110, true]] as const) {
      const a = buildLayout(first, width, panelOpen);
      const b = buildLayout(second, width, panelOpen);
      const rects = (layout: Layout) => layout.lanes.map((lane) => [lane.id, lane.x, lane.y, lane.w, lane.h].join(":"));
      assert.deepEqual(rects(a), rects(b), `${file} ${width}`);
      assert.equal(JSON.stringify(a), JSON.stringify(b), `${file} ${width} whole layout`);
      assert.equal(JSON.stringify(a), JSON.stringify(buildLayout(first, width, panelOpen)), `${file} ${width} twice`);
    }
  }
});

test("cards sit beside the row they point at and clamp inside the canvas", () => {
  const box = { x: 700, y: 456, w: 124, h: 48 };
  const spot = evidenceCardSpot(box, 504, 1440, 320, 110);
  assert.equal(spot.top, 504 + CARD_GAP);
  assert.equal(spot.left + 160, 762, "centered under the box");
  assert.equal(spot.caretX, 160);
  const edge = evidenceCardSpot({ x: 20, y: 456, w: 100, h: 48 }, 504, 1440, 320, 110);
  assert.equal(edge.left, CARD_MARGIN);
  assert.equal(edge.caretX, 70 - CARD_MARGIN);
  const right = evidenceCardSpot({ x: 1340, y: 456, w: 90, h: 48 }, 504, 1440, 320, 110);
  assert.equal(right.left + 320, 1440 - CARD_MARGIN);
  const chip = { x: 300, y: 68, w: 150, h: 40 };
  const free = roleCardSpot(chip, 1440, 320, 166, []);
  assert.equal(free.top, 108 + CARD_GAP, "12px under the role chip");
  assert.equal(free.left + 160, 375, "centered under the chip when nothing it links to is in the way");
  assert.equal(free.maxHeight, null);
  assert.equal(free.caretX, 160);
  assert.equal(free.leader, null);
  const linked = [{ x: 330, y: 218, w: 88, h: 72 }, { x: 424, y: 218, w: 88, h: 72 }];
  const slid = roleCardSpot(chip, 1440, 320, 166, linked);
  for (const control of linked) {
    const hit = slid.left < control.x + control.w + 2 && slid.left + 320 > control.x - 2;
    assert.equal(hit, false, "slides clear of every linked control");
  }
  assert.equal(slid.maxHeight, null);
  assert.equal(slid.left + slid.caretX, 375, "the caret stays centered on the chip while the body slides");
  assert.equal(slid.leader, slid.caretX < 0 ? "left" : "right", "a leader joins the caret to a body that no longer spans it");
  const everywhere = Array.from({ length: 16 }, (_, index) => ({ x: 16 + index * 88, y: 218, w: 80, h: 72 }));
  const capped = roleCardSpot(chip, 1440, 320, 166, everywhere);
  assert.ok(capped.maxHeight != null && capped.top + capped.maxHeight <= 218 - 2, "caps its height above the linked controls when no spot clears them");
  const lower = evidenceCardSpot(box, 504, 1440, 320, 110, [{ x: 640, y: 512, w: 124, h: 48 }]);
  assert.ok(lower.left >= 764 || lower.left + 320 <= 640 || lower.top >= 560 + CARD_GAP, "the card clears a box on the row below");
  assert.ok(lower.caretX >= 16 && lower.caretX <= 304, "the caret still points at the clicked box");
});

test("a family whose header is wider than its controls widens its controls", () => {
  const layout = buildLayout(load(PACKAGE_A), 1440, false);
  const sc = layout.lanes.find((lane) => lane.id === "SC")!;
  const sc13 = layout.controls.find((control) => control.id === "SC-13")!;
  assert.ok(Math.abs(sc13.w - (sc.w - 2 * FAMILY_PAD)) < 0.02, "SC-13 fills the SC box less its padding");
  for (const control of layout.controls) assert.equal(control.h, CONTROL_H);
});

test("the map fits the 1440 and 1100 views for the sample, gold, Package A, Package B and the retest package", () => {
  for (const file of [SAMPLE, GOLD, PACKAGE_A, PACKAGE_B, RETEST]) {
    const pkg = load(file);
    for (const width of [1440, 1425, 1100, 1085]) {
      const layout = buildLayout(pkg, width, false);
      assert.equal(layout.width, width, `${file} at ${width} scrolls sideways`);
      for (const box of [...layout.controls, ...layout.evidence, ...layout.roles, ...layout.pills]) {
        assert.ok(box.x >= 0 && box.x + box.w <= width, `${file} ${width} clips a box at ${box.x}`);
      }
    }
  }
});

test("count chips overlap no pill, other chip, control, evidence box or family box", () => {
  type Box = { x: number; y: number; w: number; h: number };
  const area = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (const file of [SAMPLE, GOLD, PACKAGE_A, PACKAGE_B, RETEST]) {
    const pkg = load(file);
    const views: Array<[number, boolean]> = [[1095, true], [1021, true], [935, true]];
    for (let width = 900; width <= 1905; width += 5) views.push([width, false]);
    for (const [width, panelOpen] of views) {
      const layout = buildLayout(pkg, width, panelOpen);
      const chips = layout.bundles.filter((bundle) => bundle.countLabel)
        .map((bundle) => ({ id: `${bundle.left}-${bundle.right}`, x: bundle.px - bundle.pw / 2, y: bundle.py - 7.5, w: bundle.pw, h: 15 }));
      chips.forEach((chip, index) => {
        const others = [...chips.slice(index + 1), ...layout.pills, ...layout.controls, ...layout.evidence, ...layout.lanes];
        for (const other of others) {
          assert.equal(area(chip, other), 0, `${file} ${width}${panelOpen ? " panel" : ""} chip ${chip.id} overlaps ${JSON.stringify(other).slice(0, 80)}`);
        }
      });
    }
  }
});

test("evidence sits where its links put it: one family, the gap of two adjacent families, or the family it links most", () => {
  for (const file of [SAMPLE, GOLD, PACKAGE_A, PACKAGE_B, RETEST]) {
    const pkg = load(file);
    for (const [width, panelOpen] of [[1440, false], [1425, false], [1100, false], [1110, true], [1095, true]] as const) {
      const layout = buildLayout(pkg, width, panelOpen);
      const index = new Map(layout.lanes.map((lane, i) => [lane.id, i]));
      for (const box of layout.evidence) {
        const label = `${file} ${width} ${box.id}`;
        const counts = new Map<string, number>();
        for (const id of box.controlIds) {
          const family = layout.controls.find((control) => control.id === id)!.family;
          counts.set(family, (counts.get(family) ?? 0) + 1);
        }
        const linked = [...counts.keys()].sort((a, b) => index.get(a)! - index.get(b)!);
        const center = box.x + box.w / 2;
        if (linked.length === 2 && index.get(linked[1])! === index.get(linked[0])! + 1) {
          assert.equal(box.placement, "gap", label);
          const [left, right] = linked.map((id) => layout.lanes[index.get(id)!]);
          assert.ok(Math.abs(center - (left.x + left.w + right.x) / 2) < 0.02, `${label} centers on the ${left.id}|${right.id} gap`);
          continue;
        }
        const host = linked.length === 1
          ? linked[0]
          : [...linked].sort((a, b) => counts.get(b)! - counts.get(a)!
            || layout.lanes[index.get(a)!].x - layout.lanes[index.get(b)!].x
            || index.get(a)! - index.get(b)!)[0];
        assert.equal(box.host, host, `${label} sits under the family it links most, ties to the leftmost`);
        assert.equal(box.placement, linked.length === 1 ? "family" : "most-links", label);
        const i = index.get(host)!;
        const lane = layout.lanes[i];
        const leftLimit = i === 0 ? lane.x + FAMILY_PAD : layout.lanes[i - 1].x + layout.lanes[i - 1].w;
        const rightLimit = i === layout.lanes.length - 1 ? lane.x + lane.w - FAMILY_PAD : layout.lanes[i + 1].x;
        const neighborLeft = i === 0 ? 16 : layout.lanes[i - 1].x + layout.lanes[i - 1].w;
        const neighborRight = i === layout.lanes.length - 1 ? layout.width - 16 : layout.lanes[i + 1].x;
        if (evidenceTextWidth(box) <= neighborRight - neighborLeft) {
          assert.ok(box.x >= neighborLeft - 0.02 && box.x + box.w <= neighborRight + 0.02, `${label} reaches into a neighbor of ${host}`);
        }
        if (layout.evidence.some((other) => other.host === box.host && other.row === box.row && evidenceTextWidth(other) > rightLimit - leftLimit)) continue;
        const group = layout.evidence.filter((other) => other.host === box.host && other.row === box.row && other.placement !== "gap");
        const groupCenter = (Math.min(...group.map((g) => g.x)) + Math.max(...group.map((g) => g.x + g.w))) / 2;
        const clamped = Math.min(Math.max(lane.x + lane.w / 2, leftLimit + (groupCenter - Math.min(...group.map((g) => g.x)))), rightLimit - (Math.max(...group.map((g) => g.x + g.w)) - groupCenter));
        assert.ok(Math.abs(groupCenter - clamped) < 0.02, `${label} group is centered under ${host}`);
      }
      for (let i = 0; i < layout.evidence.length; i += 1) {
        for (let j = i + 1; j < layout.evidence.length; j += 1) {
          const a = layout.evidence[i];
          const b = layout.evidence[j];
          const hit = a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
          assert.equal(hit, false, `${file} ${width} ${a.id} overlaps ${b.id}`);
        }
      }
    }
  }
});
