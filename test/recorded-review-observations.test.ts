import assert from "node:assert/strict";
import test from "node:test";
import { withRecordedReviewObservations } from "../lib/aegis/recorded-review-observations";
import { receivedRetest } from "./support/received-retest";

test("curated remaining observation binds to the exact source identity, measurement and inventory", () => {
  const record = receivedRetest();
  const enriched = withRecordedReviewObservations(record);
  assert.equal(enriched.reviewItems![0].id, "configuration-KSV-0125");
  assert.equal(record.reviewItems, undefined);
  assert.deepEqual({...enriched, reviewItems: undefined}, {...record, reviewItems: undefined});
  for (const change of [
    (r: typeof record) => {r.pipelineUrl = r.pipelineUrl.replace("podinfo", "different");},
    (r: typeof record) => {r.commitSha = "ab".repeat(20);},
    (r: typeof record) => {r.releaseSha256 = "ab".repeat(32);},
    (r: typeof record) => {r.verification!.tests[0].result = "No remaining finding";},
    (r: typeof record) => {r.verification!.tests[0].artifactSha256 = "ab".repeat(32);},
    (r: typeof record) => {r.artifacts = r.artifacts!.filter(name => name !== "configuration.raw.json");},
  ]) {
    const other = receivedRetest(); change(other);
    assert.equal(withRecordedReviewObservations(other), other);
    assert.equal(other.reviewItems, undefined);
  }
  const explicit = {...record, reviewItems: []};
  assert.equal(withRecordedReviewObservations(explicit), explicit);
});
