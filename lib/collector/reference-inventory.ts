import podinfo from "../reference/podinfo-source.json" with { type: "json" };
import boutique from "../reference/online-boutique-source.json" with { type: "json" };
import { RECORDED_EVIDENCE } from "../aegis/recorded-evidence";
import { releaseProject } from "../aegis/control-rollup";
import type { PipelineEvidence } from "../aegis/pipeline-evidence";
import { readCollectedArtifact } from "./read";
import { withSourceInventories } from "./load-inventory";

const captures = [podinfo, boutique];
/** Match the browser's public inventory using only exact, shipped reference identities. */
export function referenceInventory(record: PipelineEvidence): PipelineEvidence {
  const known = RECORDED_EVIDENCE.find(
    (item) =>
      item.pipelineUrl === record.pipelineUrl &&
      item.commitSha === record.commitSha &&
      item.releaseSha256 === record.releaseSha256,
  );
  if (!known) return record;
  const inventories = RECORDED_EVIDENCE.filter(
    (item) =>
      releaseProject(item.pipelineUrl) === releaseProject(known.pipelineUrl),
  ).flatMap((item) => {
    const capture = captures.find(
      (capture) =>
        item.sourceInventoryHref ===
        `/api/collector/references/${capture.source.commit}`,
    );
    if (!capture) return [];
    const artifacts = capture.artifacts.map(readCollectedArtifact);
    if (artifacts.some((artifact) => !artifact))
      throw new Error("Invalid shipped source capture.");
    return [
      {
        ...item,
        collectedArtifacts: artifacts.filter((artifact) => artifact !== null),
      },
    ];
  });
  return withSourceInventories(known, inventories);
}
