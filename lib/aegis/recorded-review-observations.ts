import type { PipelineEvidence } from "./pipeline-evidence";
import { pipelineArtifactNames } from "./pipeline-evidence";
import { parseReviewObservations } from "./review-context";
import captured from "../../test/fixtures/podinfo-remaining-observation.json";

/** Curated observations from explicit recorded measurements, bound to their exact source. */
export function withRecordedReviewObservations(record: PipelineEvidence): PipelineEvidence {
  if (record.reviewItems != null) return record;
  const source = captured.source;
  if (record.pipelineUrl !== source.pipelineUrl || record.commitSha !== source.commitSha || record.releaseSha256 !== source.releaseSha256) return record;
  const measured = record.verification?.tests.find(test => test.description === source.measurement.description && test.artifact === source.measurement.artifact && test.artifactSha256 === source.measurement.artifactSha256 && test.result === source.measurement.result);
  if (!measured) return record;
  const inventory = pipelineArtifactNames(record);
  if (captured.reviewItems.some(item => item.scope.artifacts.some(name => !inventory.includes(name)))) return record;
  const reviewItems = parseReviewObservations(captured.reviewItems, inventory);
  return { ...record, reviewItems };
}
