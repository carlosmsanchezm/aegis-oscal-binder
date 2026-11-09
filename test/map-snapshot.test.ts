import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMapSnapshot } from "../lib/client/map-snapshot";
import { restoreSelectedPipeline } from "../lib/client/selected-pipeline";
import { CCM_EXAMPLE, parseCcmSummary, summaryForSession } from "../lib/aegis/pipeline-evidence";
import { PODINFO_RETEST_RECEIPT } from "../lib/aegis/control-rollup";
test("map snapshot restores None and an exact retained receipt without storing evidence", () => {
  assert.deepEqual(parseMapSnapshot('{"highlighted":false,"receipt":null}'), { highlighted: false, receipt: null });
  const choice = { highlighted: true, receipt: "ab".repeat(32) };
  assert.deepEqual(parseMapSnapshot(JSON.stringify(choice)), choice);
});
test("invalid map snapshot storage cannot restore arbitrary receipt references", () => {
  for (const value of [null, "broken", "null", "[]", '{"highlighted":"true","receipt":null}', '{"highlighted":true}', '{"highlighted":true,"receipt":"unknown"}']) assert.equal(parseMapSnapshot(value), null);
});

test("selected Podinfo retest restores measured verification from the exact retained receipt", () => {
  const summary = parseCcmSummary(summaryForSession(PODINFO_RETEST_RECEIPT));
  assert.equal(summary.verification, undefined);
  const restored = restoreSelectedPipeline(summary);
  assert.equal(restored.pipelineId, "2908682168");
  assert.equal(restored.source, "Inbound pipeline event");
  assert.deepEqual(restored.verification, PODINFO_RETEST_RECEIPT.verification);
  // A URL alone or a different commit/digest cannot attach that retest.
  for (const changed of [{ ...summary, releaseSha256: "cd".repeat(32) }, { ...summary, commitSha: "cd".repeat(20) }]) assert.equal(restoreSelectedPipeline(changed).verification, undefined);
});
test("restoration preserves an imported summary's own review observations", () => {
  const summary = { ...CCM_EXAMPLE, findingCount: 34, gaps: ["Imported review detail"] };
  assert.equal(restoreSelectedPipeline(summary), summary);
});
