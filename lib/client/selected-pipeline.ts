import {RECORDED_EVIDENCE} from "../aegis/recorded-evidence";
import { mergeStoredReleases } from "../aegis/control-rollup";
import type { LegacyPipelineEvidence, PipelineEvidence } from "../aegis/pipeline-evidence";

/** Restore measured retests from retained records, never from browser-supplied verification. */
export function restoreSelectedPipeline(summary: LegacyPipelineEvidence, history: PipelineEvidence[] = []): LegacyPipelineEvidence {
  const retained = mergeStoredReleases([...RECORDED_EVIDENCE, ...history], summary.pipelineUrl).find(record =>
    record.schema === "ccm.application-evidence.v1" && record.pipelineUrl === summary.pipelineUrl
    && record.commitSha === summary.commitSha && record.releaseSha256 === summary.releaseSha256,
  );
  return retained?.schema === "ccm.application-evidence.v1" && retained.verification ? retained : summary;
}
