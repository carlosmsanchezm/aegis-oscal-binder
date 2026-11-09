import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import assert from "node:assert/strict";
import test from "node:test";
import { findRepoRoot } from "../lib/aegis/paths";
import { CCM_EXAMPLE, controlsForArtifact, type PipelineEvidence } from "../lib/aegis/pipeline-evidence";
import { applyReleaseRollup, releaseSystemName, rollupPackageCounts } from "../lib/aegis/rollup-package";
import { moderateRollupShell } from "../lib/aegis/rollup-shell";
import { subsetBaselineNote } from "../lib/aegis/map-view";
import { receivedRetest } from "./support/received-retest";

test("package projection uses the same current result as the release rollup", () => {
  const shell = moderateRollupShell(findRepoRoot());
  const pkg = applyReleaseRollup(shell, mergeStoredReleases([receivedRetest()]));
  const counts = rollupPackageCounts(pkg);
  const byId = new Map(pkg.controls.map((control) => [control.id, control]));
  assert.equal(counts.total, 323);
  assert.equal(pkg.map.families.length, 18);
  assert.equal(counts.recorded, 15);
  assert.equal(counts.blank, 308);
  assert.equal(pkg.controls.some((control) => control.complete), false);
  assert.equal(byId.get("AT-1")?.rollupState, "blank");
  assert.equal(byId.get("AT-1")?.evidence.length, 0);
  assert.equal(byId.get("AC-1")?.rollupState, "blank");
  assert.equal(byId.get("CM-6")?.rollupState, "recorded");
  assert.equal(byId.get("CM-6")?.rollupReleaseId, "2908682168");
  assert.equal(byId.get("AC-6")?.rollupReleaseId, "2894050908");
  assert.equal(byId.get("CM-6")?.evidence.some((item) => item.title === "configuration.raw.json"), true);
  assert.equal(pkg.families.find((family) => family.id === "AT")?.summary, "Blank");
  assert.match(pkg.families.find((family) => family.id === "CM")?.summary ?? "", /recorded/);
  assert.equal(pkg.gate.status, "FAIL");
  assert.match(pkg.gate.label, /15 recorded · 308 blank/);
  assert.match(subsetBaselineNote(false, pkg.inScopeCount), /Moderate baseline/);
  assert.doesNotMatch(subsetBaselineNote(false, pkg.inScopeCount), /not the full/);
  assert.equal(pkg.workspaceName, "podinfo-gsa-evidence-0928");
});

test("a newer release for any system replaces only the controls it records", () => {
  const shell = moderateRollupShell(findRepoRoot());
  const uploaded: PipelineEvidence = {
    ...CCM_EXAMPLE,
    pipelineId: "4242",
    pipelineUrl: "https://gitlab.com/groups/other-system/-/pipelines/4242",
    createdAt: "2026-11-01T00:00:00.000Z",
    families: [{ family: "AT", controls: ["AT-2"], coverage: "Training record from the uploaded system.", evidence: ["training.json"] }],
    reviewItems: [],
    recordedChecks: [],
    checks: [],
    artifacts:["training.json"],
  };
  const pkg = applyReleaseRollup(shell, mergeStoredReleases([uploaded],uploaded.pipelineUrl));
  const byId = new Map(pkg.controls.map((control) => [control.id, control]));
  assert.equal(releaseSystemName(mergeStoredReleases([uploaded],uploaded.pipelineUrl)), "other-system");
  assert.equal(pkg.workspaceName, "other-system");
  assert.equal(byId.get("AT-2")?.rollupState, "recorded");
  assert.equal(byId.get("AT-2")?.rollupReleaseId, "4242");
  assert.match(byId.get("AT-2")?.implementation ?? "", /uploaded system/);
  assert.equal(byId.get("AT-1")?.rollupState, "blank");
  assert.equal(byId.get("CM-6")?.rollupReleaseId, "");
  assert.equal(byId.get("AC-6")?.rollupReleaseId, "");
  assert.equal(rollupPackageCounts(pkg).recorded, 1);
  assert.equal(rollupPackageCounts(pkg).blank, 322);
  assert.equal(controlsForArtifact(CCM_EXAMPLE, "configuration.json").length, 6);
  assert.equal(controlsForArtifact(CCM_EXAMPLE, "runtime.json").length, 4);
  assert.equal(controlsForArtifact(CCM_EXAMPLE, "approval.json").length, 2);
});
