import {createHash} from "node:crypto";
import {moderateControls} from "../../lib/aegis/moderate-baseline";
import {parseCcmSummary} from "../../lib/aegis/pipeline-evidence";
import type {LegacyPipelineEvidence} from "../../lib/aegis/pipeline-evidence";
import {readFileSync} from "node:fs";
import type {CollectedArtifact} from "../../lib/collector/types";
export type FixtureSize="tiny"|"medium"|"huge"|"random";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export function generatedMapFixture(seed:number,size:FixtureSize) {
 let state=seed>>>0;
 const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
 const all=moderateControls(),families=[...new Set(all.map(c=>c.family))];
 const selected=size==="tiny"?all.filter(c=>c.family===families[0]).slice(0,2):size==="huge"?all:size==="medium"?all.filter(c=>families.slice(0,8).includes(c.family)).filter(()=>random()<.35):all.filter(()=>random()<.14);
 const ids=new Set(selected.map(c=>c.id));
 const count=size==="huge"?2160:size==="tiny"?3:size==="medium"?160:89;
 const name=`Service ${digest(String(seed)).slice(0,9)}`;
 const pipeline=`https://gitlab.com/synthetic/system-${digest(String(seed)).slice(0,9)}`;
 const artifacts:CollectedArtifact[]=Array.from({length:count},(_,i)=>{
  const hash=digest(`${seed}:${i}`),field="measurements.sample",value=i%5!==0;
  return {schema:"aegis.collected-artifact.v1",name:`source-${hash.slice(0,24)}.json`,type:"Fixture observation",source:{repo:`https://github.com/synthetic/service${seed}`,commit:digest(String(seed)).slice(0,40),path:`measurements/sample-${i}.txt`,sha256:hash},capturedAt:"2026-10-09T00:00:00.000Z",sha256:hash,facts:[{key:"sample-value",value,line:1,field,content:`${field} = ${value}`}],limitations:["Synthetic fixture only"]};
 });
 const records:LegacyPipelineEvidence[]=[];
 for(let start=0;start<artifacts.length;start+=720){
  const batch=artifacts.slice(start,start+720),index=records.length;
  const familyData=families.flatMap(family=>{
   const members=selected.filter(c=>c.family===family);
   return Array.from({length:Math.ceil(members.length/40)},(_,i)=>({family,controls:members.slice(i*40,i*40+40).map(c=>c.id),coverage:"Synthetic selected objective evidence",evidence:["fixture.json"]}));
  });
  const hash=digest(`${seed}:release:${index}`),commit=digest(`${seed}:commit:${index}`).slice(0,40),createdAt=`2026-10-09T0${index}:00:00.000Z`;
  records.push(parseCcmSummary({data:{schema:"ccm.application-evidence.v1",subject:{pipelineId:String(100+index),pipelineUrl:`${pipeline}/-/pipelines/${100+index}`,commitSha:commit,image:`${name.toLowerCase().replaceAll(" ","/")}:synthetic`,createdAt},releaseSha256:hash,policyVerdict:"pass",signatureStatus:"unknown",signatureScope:"Synthetic fixture only",deploymentVerdict:"unknown",approval:{actor:"Synthetic reviewer",commitSha:commit,releaseSha256:hash,approvedAt:createdAt,mode:"vendor-test"},runtime:{checkedAt:createdAt,functionalProbe:"unknown",observations:[],mTLS:"unknown"},checks:[],controlFamilies:familyData,findingCount:0,evidenceGaps:["Synthetic fixture only"],artifacts:["fixture.json"],collectedArtifacts:batch,sourceInventoryHref:`/api/collector/references/${digest(`${seed}:${index}:inventory`).slice(0,40)}`},provenance:{pipelineId:String(100+index),jobId:String(200+index)}}));
 }
 // Dense synthetic relationships supplement the actual catalog in component tests.
 const edges=selected.flatMap((control,i)=>Array.from({length:Math.min(12,selected.length-1)},(_,j)=>{
  const other=selected[(i+j+1)%selected.length];
  return {fromId:control.id,toId:other.id,mutual:false,citation:"Synthetic fixture"};
 }));
 const ssp=JSON.parse(readFileSync(new URL("../../public/samples/sample-oscal-ssp-rev5.json",import.meta.url),"utf8"))["system-security-plan"];
 const uuid=(value:string)=>{const hash=digest(value);return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;};
 const selectedFamilies=families.filter(family=>selected.some(control=>control.family===family));
 ssp.metadata.title=name;ssp.metadata.remarks=`Synthetic layout fixture with ${selected.length} controls`;ssp["control-implementation"].description=ssp.metadata.remarks;ssp["system-characteristics"]["system-name"]=name;
 ssp.metadata.roles=selectedFamilies.map(family=>({id:`owner-${family}`,title:`${family} Owner`,"short-name":`${family} Owner`}));
 ssp["system-implementation"].users=selectedFamilies.map(family=>({uuid:uuid(`user:${family}`),title:`${family} Owner`,"role-ids":[`owner-${family}`]}));
 ssp["back-matter"]={resources:selectedFamilies.map(family=>({uuid:uuid(`evidence:${family}`),title:`${family} review`,props:[{name:"type",value:"Document"}],rlinks:[{href:`https://example.com/synthetic/${family.toLowerCase()}`}]}))};
 ssp["control-implementation"]["implemented-requirements"]=selected.map(control=>({uuid:uuid(control.id),"control-id":control.id.toLowerCase(),description:"Synthetic control implementation for layout verification",links:[{href:`#${uuid(`evidence:${control.family}`)}`,rel:"evidence"}], "responsible-roles":[{"role-id":`owner-${control.family}`}],"by-components":[{"component-uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",uuid:uuid(`component:${control.id}`),description:"Synthetic implementation",links:[{href:`#${uuid(`evidence:${control.family}`)}`,rel:"evidence"}]}]}));
 const document={"system-security-plan":ssp};
 return {seed,size,name,records,artifacts,ids,edges,document};
}
