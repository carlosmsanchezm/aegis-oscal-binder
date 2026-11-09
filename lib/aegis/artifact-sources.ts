import {releaseProject} from './control-rollup';
import {artifactFilename,pipelineArtifactNames,type PipelineEvidence} from './pipeline-evidence';

/** Same logical file in one system; a changed collected source hash stays distinct. */
export function artifactSourceKey(record:PipelineEvidence,name:string):string {
 const file=artifactFilename(name),source=record.collectedArtifacts?.find(a=>a.name===file)?.source;
 if (!source) return JSON.stringify([releaseProject(record.pipelineUrl),...(record.schema === "aegis.evidence-event.v1" ? [record.observation.subject.kind,record.observation.subject.id] : []),file]);
 if (source.kind === "aws-account") return JSON.stringify(["aws-account", source.partition, source.account, source.region, source.path, source.sha256]);
 return JSON.stringify([source.repo, source.commit, source.path, source.sha256]);
}
/** Keep historical receipts immutable. Current inventory selects the newest file revision. */
export function currentArtifactSources(records:PipelineEvidence[]):Map<string,PipelineEvidence> {
 const latest=new Map<string,PipelineEvidence>();
 for(const record of [...records].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt) || a.releaseSha256.localeCompare(b.releaseSha256)))
  for(const name of pipelineArtifactNames(record))latest.set(artifactSourceKey(record,name),record);
 return latest;
}
