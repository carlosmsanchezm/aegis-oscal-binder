import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  emptyPersisted,
  findRepoRoot,
  getPackageState,
  loadFixture,
} from "../lib/aegis";
import { controlBlockHeight } from "../lib/aegis/map-layout";
import { round21Layout } from "../lib/aegis/round21-layout";
import { ReleaseSnapshot } from "../components/binder/RollupMap";
import { receivedRetest } from "./support/received-retest";

const ctx = {
  root: findRepoRoot(),
  now: () => new Date("2026-10-04T12:00:00Z"),
};
const gold = getPackageState(
  loadFixture({ ...emptyPersisted(), catalogId: "fedramp-rev5" }, "gold", ctx),
  ctx,
);
test("round 21 subset geometry retains the loaded package, role and evidence graph", () => {
  const before = JSON.stringify(gold);
  for (const [width, panel] of [
    [1280, false],
    [950, true],
  ] as const) {
    const layout = round21Layout(gold, width, panel, 522);
    assert.equal(layout.controls.length, 12);
    assert.equal(layout.lanes.length, 6);
    assert.equal(layout.roles.length, 6);
    assert.equal(layout.evidence.length, 10);
    assert.equal(new Set(layout.controls.map((c) => c.y)).size, 1);
    assert.ok(layout.roles.every((r) => r.y < layout.controlY));
    assert.ok(layout.evidence.every((e) => e.y > layout.controlY + 70));
    assert.ok(layout.lanes.every((l) => l.y === 24 && l.h === 474));
    assert.ok(layout.controls.every((c) => c.x >= 0 && c.x + c.w <= width));
    assert.ok(layout.bundles.length > 0);
  }
  assert.equal(JSON.stringify(gold), before);
  assert.equal(gold.gate.incomplete, 3);
});
test("the reference release menu offers None without discarding stored releases", () => {
  const history = mergeStoredReleases([receivedRetest()]);
  const markup = renderToStaticMarkup(
    createElement(ReleaseSnapshot, {
      history,
      record: history.at(-1)!,
      highlighted: false,
      onChange() {},
    }),
  );
  assert.match(markup, /Release snapshot None/);
  assert.match(markup, /current map · no release highlight/);
  assert.match(markup, /2894050908/);
  assert.match(markup, /2908682168/);
  assert.match(markup, /Latest result per control across stored releases/);
});

test("control blocks give dense statement sets additional proportional space", () => {
  assert.ok(controlBlockHeight(31, 54) > controlBlockHeight(4, 54));
  assert.ok(controlBlockHeight(31, 90) < controlBlockHeight(31, 54));
  assert.ok(controlBlockHeight(0, 54) >= 76);
});
