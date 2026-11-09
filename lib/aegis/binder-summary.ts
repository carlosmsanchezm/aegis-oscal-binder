import {artifactSourceKey,currentArtifactSources} from "./artifact-sources";
import {artifactType, proposeArtifactMappings, reviewedArtifactDecision, restoreMappingDecision, applyAcceptedArtifactMappings} from "./artifact-mapping";
import {controlsForArtifact, pipelineArtifactNames, type PipelineEvidence} from "./pipeline-evidence";
import type {ArtifactMappingDecision, CatalogId} from "./types";

/** Inventory rows preserve producer links separately from agent proposals. */
export function binderSummary(record: PipelineEvidence, controlIds: string[], catalogId: CatalogId = "fedramp-rev5", decisions: ArtifactMappingDecision[] = []) {
  const proposals = proposeArtifactMappings(record, controlIds, [], catalogId).filter(proposal => {
    const decision = reviewedArtifactDecision(record, decisions, proposal);
    return !decision?.profile || !restoreMappingDecision(decision, record, decision.profile.controlIds, catalogId);
  });
  const mapped = applyAcceptedArtifactMappings(record, decisions);
  return pipelineArtifactNames(record).map(name => {
    const linked = controlsForArtifact(record, name);
    const additional = proposals.find(p => p.artifact === name)?.candidates.map(c => c.controlId) ?? [];
    const approved = controlsForArtifact(mapped, name).filter(id => !linked.includes(id));
    const proposed = [...new Set(additional)].filter(id => !linked.includes(id) && !approved.includes(id));
    const collected = record.collectedArtifacts?.find(a=>a.name===name);
    return {name, type: collected?.type ?? artifactType(name), capturedAt: collected?.capturedAt ?? record.createdAt, collected, checks: record.checks.filter(c => c.artifact === name), linked, approved, proposed,
      families: [...new Set([...linked, ...approved, ...proposed].map(id => id.split("-")[0]))].sort()};
  });
}

/** Counts pending artifact suggestions; never adds evidence or changes a control verdict. */
export function proposedControlCounts(records: PipelineEvidence[], controlIds: string[], catalogId: CatalogId = "fedramp-rev5", decisions: ArtifactMappingDecision[] = []): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const unique = [...new Map(records.map(item => [item.releaseSha256,item])).values()];
  const sources = currentArtifactSources(unique);
  for (const record of unique)
    for (const row of binderSummary(record, controlIds, catalogId, decisions))
      if (sources.get(artifactSourceKey(record,row.name)) === record)
        for (const id of row.proposed) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** Current file inventory dedupes historical versions; receipts remain in history. */
export function currentBinderSummary(records:PipelineEvidence[],controlIds:string[],catalogId:CatalogId="fedramp-rev5",decisions:ArtifactMappingDecision[]=[]){
 const unique=[...new Map(records.map(record=>[record.releaseSha256,record])).values()];
 const sources=currentArtifactSources(unique);
 return unique.flatMap(record=>binderSummary(record,controlIds,catalogId,decisions)
  .filter(row=>sources.get(artifactSourceKey(record,row.name))===record)
  .map(row=>({...row,key:artifactSourceKey(record,row.name)})));
}

/** Keep earlier suggestion membership when a later version changes its candidate set. */
export function retainedProposedControlCounts(records:PipelineEvidence[],controlIds:string[],catalogId:CatalogId="fedramp-rev5",decisions:ArtifactMappingDecision[]=[]):ReadonlyMap<string,number>{
 const counts=new Map<string,number>();
 for(const record of records)for(const [id,count] of proposedControlCounts([record],controlIds,catalogId,decisions))counts.set(id,Math.max(counts.get(id)??0,count));
 return counts;
}

/** Restore loaded facts for a retained receipt without crossing source identity. */
export function completeRetainedSources(receipts:PipelineEvidence[],loaded:PipelineEvidence[]):PipelineEvidence[]{
 return receipts.map(receipt=>loaded.filter(record=>record.pipelineUrl===receipt.pipelineUrl && record.commitSha===receipt.commitSha && record.releaseSha256===receipt.releaseSha256)
  .sort((a,b)=>(b.collectedArtifacts?.length??0)-(a.collectedArtifacts?.length??0))[0]??receipt);
}
