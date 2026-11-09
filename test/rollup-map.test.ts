import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RollupMap, PipelineControlPanel } from "../components/binder/RollupMap";
import { buildLayout } from "../lib/aegis/map-placement";
import { rollupControlResults } from "../lib/aegis/control-rollup";
import { applyReleaseRollup } from "../lib/aegis/rollup-package";
import { moderateRollupShell } from "../lib/aegis/rollup-shell";
import { findRepoRoot } from "../lib/aegis/paths";
import { receivedRetest } from "./support/received-retest";

const history = mergeStoredReleases([receivedRetest()]);
const pkg = applyReleaseRollup(moderateRollupShell(findRepoRoot()), history);
const packageIds = ["AC-2", "AC-3", "AC-6", "AU-2", "AU-6", "CM-2", "CM-6", "IA-2", "IA-5", "SC-7", "SC-8", "SI-2"];

test("compact family map preserves the full rollup, empty families and linked controls without spilling blanks", () => {
  const before = JSON.stringify(pkg);
  const visible = new Set([...packageIds, ...pkg.controls.filter(c => c.rollupState === "recorded").map(c => c.id)]);
  const layout = buildLayout(pkg, 950, true, visible, false);
  assert.equal(layout.lanes.length, 18);
  assert.equal(layout.controls.length, 22);
  assert.equal(layout.controls.some(c => c.id === "AT-1"), false);
  assert.equal(layout.lanes.find(l => l.id === "AT")?.baselineText, "0 linked · 6 blank");
  assert.equal(layout.lanes.find(l => l.id === "CM")?.baselineText, "2 linked · 25 blank");
  assert.equal(layout.lanes.find(l => l.id === "AT")?.memberIds.length, 0);
  assert.equal(layout.bands.length, 2);
  assert.equal(layout.lanes[9].y, layout.lanes[0].y + layout.lanes[0].h + 22);
  assert.deepEqual(layout.controls.filter(c => c.family === "AU").map(c => c.id), ["AU-2", "AU-3", "AU-6", "AU-9", "AU-12"]);
  assert.ok(layout.width >= 950);
  assert.ok(layout.lanes.every(l => l.x >= 28 && l.x+l.w <= layout.width-28+0.01));
  assert.ok(layout.bundles.length > 0);
  assert.ok(layout.height <= 1000);
  for (const control of layout.controls) {
    const family = layout.lanes.find(l => l.id === control.family)!;
    assert.ok(control.y + control.h <= family.y + family.h);
    assert.ok(control.h >= 76);
  }
  assert.deepEqual(layout.lanes.find(l => l.id === "SC")?.titleLines, ["System &", "Comms Prot."]);
  assert.equal(JSON.stringify(pkg), before);
  assert.equal(pkg.controls.length, 323);
  assert.equal(pkg.controls.find(c => c.id === "AC-6")?.rollupReleaseId, "2894050908");
});

test("CM-6 panel shows the current remaining finding and its own unverified plan without an SSP form", () => {
  const control = pkg.controls.find(c => c.id === "CM-6")!;
  const result = rollupControlResults(history).find(c => c.id === control.id)!.result;
  const markup = renderToStaticMarkup(createElement(PipelineControlPanel, { pkg, control, result, history, level2: true, onClose() {}, onExpand() {} }));
  assert.match(markup, /#2908682168/);
  assert.match(markup, /16910084348\/artifacts\/file\/evidence\/configuration.json/);
  const [current, separate] = markup.split('<details class="panel-block">');
  assert.ok(separate);
  assert.match(separate, /Separate finding.*Application UID\/GID/);
  assert.match(separate, /A pass does not resolve another finding on CM-6/);
  assert.equal((separate.match(/<li>/g) ?? []).length, 3);
  assert.equal((current.match(/<li>/g) ?? []).length, 0);
  assert.match(markup, /one remaining finding: KSV-0125/);
  assert.match(markup, /Plan of action/);
  assert.match(markup, /Loading saved plan decisions/);
  assert.match(markup, /<button[^>]*disabled[^>]*>Loading saved plan/);
  assert.doesNotMatch(markup, /Proposed · not accepted|Edit and accept/);
  assert.doesNotMatch(current, /Retest attached|ready to close/);
  assert.match(separate, /Retest attached from #2908682168/);
  const selectedMarkup = renderToStaticMarkup(createElement(PipelineControlPanel, { pkg, control, result, history, level2:false, onClose() {}, onExpand() {} }));
  assert.match(selectedMarkup, /AU-2/);
  assert.match(selectedMarkup, /RA-5/);
  assert.match(selectedMarkup, /Next action/);
  assert.match(selectedMarkup, /Application UID\/GID hardening/);
  assert.match(selectedMarkup, /Remaining configuration finding/);
  assert.match(selectedMarkup, /disabled[^>]*>Loading saved plan/);
  assert.match(markup, /Statements/);
  assert.match(markup, /not mapped/);
  assert.match(markup, /coverage only/);
  assert.doesNotMatch(markup, /SSP evidence|<textarea|<input|<form|official plan id blank/);
});


test("stored-release map can focus CM-6 with no uploaded package or statement-level scanner mapping", () => {
  const markup = renderToStaticMarkup(createElement(RollupMap, { pkg, history, record: receivedRetest(), packageControlIds: [], initialControlId: "CM-6", initialLevel2: true, onRecordChange() {}, onRelease() {} }));
  assert.match(markup, /data-testid="rollup-map-workspace"/);
  assert.match(markup, /CM-6/);
  assert.match(markup, /configuration.json/);
  assert.match(markup, /Plan of action/);
  assert.match(markup, /not mapped/);
  assert.doesNotMatch(markup, /Empty workspace|Load planning example/);
});

test("accordion header distinguishes unaccepted proposals from retained linked evidence", () => {
  const control = pkg.controls.find(c => c.id === "CM-6")!;
  const linked = rollupControlResults(history).find(c => c.id === control.id)!.result!;
  for (const state of [
    {result: {...linked, mappingStatus: "proposed" as const}, proposalCount: 1, proposed: true},
    {result: null, proposalCount: 2, proposed: true},
    {result: linked, proposalCount: 2, proposed: false},
    {result: null, proposalCount: 0, proposed: false},
  ]) {
    const markup = renderToStaticMarkup(createElement(PipelineControlPanel, {pkg, control, history, level2: false, ...state, onClose() {}, onExpand() {}}));
    const header = markup.split("</header>")[0];
    if (state.proposed) {
      assert.match(header, /class="pill warn"[^>]*>◌ Proposed mapping · not accepted/);
      assert.doesNotMatch(header, /Evidence linked|pill pass/);
    } else if (state.result) {
      assert.match(header, /class="pill pass"[^>]*>● Evidence linked/);
    } else {
      assert.match(header, /No evidence yet/);
      assert.doesNotMatch(header, /Evidence linked|pill pass|Proposed mapping/);
    }
  }
});
