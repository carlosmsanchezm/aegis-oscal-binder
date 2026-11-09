import {releasesAtSnapshot} from "../aegis/control-rollup";
import { currentBinderSummary } from "../aegis/binder-summary";
import {
  artifactSourceKey,
  currentArtifactSources,
} from "../aegis/artifact-sources";
import {
  proposeArtifactMappings,
  reviewedArtifactDecision,
} from "../aegis/artifact-mapping";
import type { ArtifactMappingDecision, CatalogId } from "../aegis/types";
import type { PipelineEvidence } from "../aegis/pipeline-evidence";
import type { PlanProposal } from "../aegis/plan-proposal";

/** Use the same retained source batches for the evidence card and footprint. */
export function evidenceInventoryRecords(record:PipelineEvidence,records:PipelineEvidence[]=[]):PipelineEvidence[]{
 return record.schema === "aegis.evidence-event.v1" && records.length ? [...new Map(releasesAtSnapshot(records,record).map(item=>[item.releaseSha256,item])).values()] : [record];
}

/** Index the current inventory by control without promoting suggestions to evidence. */
export function evidenceByControl(
  records: PipelineEvidence[],
  controlIds: string[],
  catalogId: CatalogId = "fedramp-rev5",
  decisions: ArtifactMappingDecision[] = [],
) {
  const rows = currentBinderSummary(records, controlIds, catalogId, decisions);
  const sources = currentArtifactSources(records);
  const proposals = new Map(
    records.map((record) => [
      record,
      new Map(
        proposeArtifactMappings(record, controlIds, [], catalogId).map(
          (proposal) => [proposal.artifact, proposal],
        ),
      ),
    ]),
  );
  const files = rows.map((row) => {
    const source = sources.get(row.key)!;
    const proposal = proposals.get(source)?.get(row.name);
    return {
      ...row,
      source,
      proposal,
      decision: proposal
        ? reviewedArtifactDecision(source, decisions, proposal)
        : undefined,
    };
  });
  const ids = [
    ...new Set(
      files.flatMap((file) => [
        ...file.linked,
        ...file.approved,
        ...file.proposed,
      ]),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    files,
    controls: ids.map((id) => ({
      id,
      evidence: files.filter(
        (file) => file.linked.includes(id) || file.approved.includes(id),
      ),
      suggested: files
        .filter((file) => file.proposed.includes(id))
        .sort(
          (a, b) => Number(Boolean(b.collected)) - Number(Boolean(a.collected)),
        ),
    })),
  };
}

export function planNeedsDecision(plan: PlanProposal): boolean {
  return (
    !plan.closureConfirmed &&
    (plan.readyToClose || plan.acceptance !== "accepted")
  );
}
