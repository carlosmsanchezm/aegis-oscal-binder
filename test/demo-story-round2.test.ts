import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {rollupControlResults} from "../lib/aegis/control-rollup";
import {resultsMapPackage} from "../lib/aegis/results-map";
import {binderSummary} from "../lib/aegis/binder-summary";
import {proposeArtifactMappings, mappingDecision} from "../lib/aegis/artifact-mapping";
import {BinderSummary} from "../components/binder/BinderSummary";
import {PipelineControlPanel} from "../components/binder/RollupMap";
const pkg = applyReleaseRollup(moderateRollupShell(process.cwd()), [CCM_EXAMPLE]);
const ids = pkg.controls.map(control => control.id);

test("side panel exposes independent finding actions with a neutral evidence status", () => {
  const row = rollupControlResults([CCM_EXAMPLE]).find(row => row.result?.finding)!;
  const control = pkg.controls.find(control => control.id === row.id)!;
  const html = renderToStaticMarkup(React.createElement(PipelineControlPanel, {pkg, control, result: row.result, level2: false, history: [CCM_EXAMPLE], planStateLabel: "Closed · 1 open", onClose() {}, onExpand() {}}));
  const header = html.match(/<header[\s\S]*?<\/header>/)![0];
  assert.match(header, /Evidence linked/);
  assert.match(html, /Next action/);
  assert.match(html, /Application UID\/GID hardening/);
  assert.doesNotMatch(header, /Needs review/);
});

test("retained artifacts show their complete count without a new load request", () => {
  const html = renderToStaticMarkup(React.createElement(BinderSummary, {record: CCM_EXAMPLE, controlIds: ids}));
  assert.match(html, /28 files collected · complete/);
  assert.doesNotMatch(html, /loading recorded files/);
});

test("results-first projection includes proposal-only controls without creating linked evidence", () => {
  const target = pkg.controls.find(control => control.rollupState === "blank" && !pkg.controls.some(peer => peer.family === control.family && peer.rollupState === "recorded"))!;
  const projected = resultsMapPackage(pkg, null, true, false, new Map([[target.id, 2]]));
  const proposed = projected.controls.find(control => control.id === target.id);
  assert.ok(proposed, "a proposal-only control must be visible before acceptance");
  assert.equal(proposed.rollupState, "blank");
  assert.deepEqual(proposed.evidence, []);
  assert.equal(proposed.validEvidenceCount, 0);
  assert.ok(projected.map.families.some(family => family.id === target.family));
  assert.ok(projected.controls.every(control => control.rollupState === "recorded" || control.id === target.id));
});

test("summary distinguishes producer, reviewer-approved and pending mappings without retaining resolved alternatives", () => {
  const proposal = proposeArtifactMappings(CCM_EXAMPLE, ids).find(proposal => proposal.artifact === "publisher-manifest.json")!;
  const chosen = proposal.candidates[0].controlId;
  const accepted = mappingDecision(CCM_EXAMPLE, proposal, "accepted", "2026-10-09T06:00:00Z", [chosen], "Regression reviewer");
  const row = binderSummary(CCM_EXAMPLE, ids, "fedramp-rev5", [accepted]).find(row => row.name === proposal.artifact)!;
  assert.deepEqual(row.approved, [chosen]);
  assert.deepEqual(row.proposed, []);
  const rejected = mappingDecision(CCM_EXAMPLE, proposal, "rejected", accepted.decidedAt, [chosen], "Regression reviewer");
  const rejectedRow = binderSummary(CCM_EXAMPLE, ids, "fedramp-rev5", [rejected]).find(row => row.name === proposal.artifact)!;
  assert.deepEqual(rejectedRow.proposed, []);
  assert.deepEqual(rejectedRow.approved, []);
});
