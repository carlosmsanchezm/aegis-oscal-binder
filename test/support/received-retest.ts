import { readFileSync } from "node:fs";
import { parseStoredPipelineEvidence } from "../../lib/aegis/pipeline-inbound";
import type { LegacyPipelineEvidence } from "../../lib/aegis/pipeline-evidence";

// Non-secret public receipt captured 4 Oct 2026. Test-only; never injected by production code.
export function receivedRetest(): LegacyPipelineEvidence {
  return parseStoredPipelineEvidence(JSON.parse(readFileSync(new URL("../fixtures/podinfo-received-retest.json",import.meta.url),"utf8")));
}
export function retestEvent() {
  const r = receivedRetest();
  return {
    ...r, schema: "aegis.pipeline-event.v1", artifactRef: r.artifactJobId,
    pipeline: { id: r.pipelineId, url: r.pipelineUrl, commit: r.commitSha, createdAt: r.createdAt },
    approval: { ...r.approval, commit: r.approval.commitSha },
  };
}
