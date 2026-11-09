import type {PipelineEvidence,SystemObservationEvidence} from "../aegis/pipeline-evidence";
import {scannerFindingId} from "./derive-review-items";
import {AWS_DEPLOYMENT_PRODUCER,collectedFindingId} from "./aws/deployment-criteria";
/** Compare the same scanner criteria on distinct pinned revisions. Absence in a partial result never proves a fix. */
export function scannerRetestDiff(before:PipelineEvidence,after:PipelineEvidence,now=Date.now()){
 const fixed:string[]=[],remaining:string[]=[],unverified:string[]=[];
 if(before.schema!=="aegis.evidence-event.v1"||after.schema!=="aegis.evidence-event.v1"||before.observation.subject.id!==after.observation.subject.id||before.observation.subject.kind!==after.observation.subject.kind||before.observation.producer!==after.observation.producer||before.commitSha===after.commitSha||Date.parse(after.createdAt)<=Date.parse(before.createdAt))return {fixed,remaining,unverified,comparable:false};
 if (before.observation.producer===AWS_DEPLOYMENT_PRODUCER) return awsRetestDiff(before,after,now);
 for(const artifact of before.collectedArtifacts??[]){
  const failures=artifact.facts.filter(f=>f.outcome==="fail"),original=before.observation.checks.find(c=>c.artifacts.includes(artifact.name));
  if(!failures.length||!original)continue;
  const check=after.observation.checks.find(c=>c.id===original.id&&c.version===original.version&&JSON.stringify(c.requirement)===JSON.stringify(original.requirement));
  const current=after.collectedArtifacts?.find(a=>a.source.path===artifact.source.path&&check?.artifacts.includes(a.name));
  const count=current?.facts.find(f=>f.key==="scan-findings")?.value,failed=current?.facts.filter(f=>f.outcome==="fail")??[];
  const complete=!!check&&check.verdict!=="unknown"&&Date.parse(check.validUntil)>now&&Date.parse(after.createdAt)<=now+300_000&&typeof count==="number"&&count===failed.length;
  for(const fact of failures){const id=scannerFindingId(artifact.source.path,fact.field);if(!complete)unverified.push(id);else if(failed.some(f=>f.field===fact.field))remaining.push(id);else fixed.push(id);}
 }
 return {fixed,remaining,unverified,comparable:true};
}

/** Require explicit PASS for every originally bound account/partition/region, including
 * targets that already passed. Missing, stale, manual and errored checks are unavailable. */
function awsRetestDiff(before:SystemObservationEvidence,after:SystemObservationEvidence,now:number){
 const fixed:string[]=[],remaining:string[]=[],unverified:string[]=[];
 const failures=new Set((before.collectedArtifacts??[]).flatMap(a=>a.facts.filter(f=>f.outcome==="fail").map(f=>collectedFindingId(a,f,scannerFindingId))));
 for (const id of failures) {
  let complete=true,failed=false,targets=0;
  for (const artifact of before.collectedArtifacts??[]) for (const fact of artifact.facts) {
   if(collectedFindingId(artifact,fact,scannerFindingId)!==id)continue;
   targets++;
   const source=artifact.source;
   if(source.kind!=="aws-account"){complete=false;continue;}
   const original=before.observation.checks.find(c=>c.id===fact.field&&c.artifacts.includes(artifact.name));
   const check=after.observation.checks.find(c=>c.id===original?.id&&c.version===original.version&&JSON.stringify(c.requirement)===JSON.stringify(original.requirement));
   const matches=after.collectedArtifacts?.filter(a=>a.source.kind==="aws-account"&&a.source.account===source.account&&a.source.partition===source.partition&&a.source.region===source.region&&a.source.path===source.path&&check?.artifacts.includes(a.name))??[];
   const current=matches.length===1?matches[0]:undefined;
   const result=current?.facts.find(f=>f.field===fact.field&&collectedFindingId(current!,f,scannerFindingId)===id);
   if(result?.value==="fail")failed=true;
   if(!check||check.verdict==="unknown"||Date.parse(check.validUntil)<=now||Date.parse(after.createdAt)>now+300_000||!current||Date.parse(current.capturedAt)<=Date.parse(artifact.capturedAt)||!result||!["pass","fail"].includes(String(result.value))||((result.value==="fail")!==(result.outcome==="fail")))complete=false;
  }
  if(!complete||!targets)unverified.push(id);else if(failed)remaining.push(id);else fixed.push(id);
 }
 return {fixed,remaining,unverified,comparable:true};
}
