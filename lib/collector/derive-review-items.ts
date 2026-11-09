import { factCandidates } from "./mappings";
import type {CollectedArtifact} from "./types";
import type {ReviewObservation} from "../aegis/review-context";
import {moderateControls} from "../aegis/moderate-baseline";
import {collectedFindingId} from "./aws/deployment-criteria";
/** Platform-found issues retain stable rule and asset identity; mappings remain proposals. */
export function deriveReviewItems(artifacts:CollectedArtifact[]):ReviewObservation[]{
 const allowed=new Set(moderateControls().map(c=>c.id));
 const items = artifacts.flatMap(artifact=>artifact.facts.filter(f=>f.outcome==="fail").flatMap(f=>{
  const candidates=factCandidates({...artifact,facts:[f]},allowed,"fedramp-rev5").sort((a,b)=>Number(b.controlId==="CM-6")-Number(a.controlId==="CM-6"));if(!candidates.length)return [];
  const id=collectedFindingId(artifact,f,scannerFindingId);
  return [{id,mappingStatus:"proposed" as const,description:`${f.field}: observed failure at line ${f.line}. Inspect the retained scanner result.`,scope:{...(f.fixPaths ? {fixPaths:f.fixPaths} : {}), ...(f.resourceIds ? {resourceIds:f.resourceIds} : {}), title:f.field.slice(0,200),asset:artifact.source.path,controls:candidates.map(c=>c.controlId),framework:"NIST SP 800-53 Rev 5",baseline:"Collector relevance proposal; applicability requires review.",artifacts:[artifact.name],verification:[`Rerun the same scanner and confirm ${f.field} is resolved.`],remainingScope:[]}}];
 }));
 if (!artifacts.some(a=>a.source.kind==="aws-account"&&a.type==="Operator-linked AWS deployment checks")) return items.slice(0,400);
 const grouped = new Map<string,ReviewObservation>();
 for (const item of items) {
  const prior = grouped.get(item.id);
  if (!prior) grouped.set(item.id,item);
  else prior.scope = {...prior.scope, artifacts:[...new Set([...prior.scope.artifacts,...item.scope.artifacts])],
   ...(item.scope.fixPaths ? {fixPaths:[...new Set([...(prior.scope.fixPaths??[]),...item.scope.fixPaths])]} : {}),
   ...(item.scope.resourceIds ? {resourceIds:[...new Set([...(prior.scope.resourceIds??[]),...item.scope.resourceIds])]} : {})};
 }
 return [...grouped.values()].slice(0,400);
}

export function scannerFindingId(path:string,field:string):string{
 const text=`${path}\0${field}`;let a=2166136261,b=2246822519;for(const char of text){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),3266489917);}return "scan-"+(a>>>0).toString(16).padStart(8,"0")+(b>>>0).toString(16).padStart(8,"0");
}
