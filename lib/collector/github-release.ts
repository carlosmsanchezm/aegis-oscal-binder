import {createHash} from "node:crypto";
import {unzipSync,strFromU8} from "fflate";
import type {Octokit} from "@octokit/rest";
import {withReleaseInstallation} from "../github/auth";
import {assertRepoName} from "../github/client";
import {parseEvidenceEvent,type EvidenceEvent} from "../builder/evidence";
import {parseScanner} from "./scanners";
import {readCollectedArtifact} from "./read";
import type {CollectedArtifact} from "./types";
const sha=(x:Uint8Array|string)=>createHash("sha256").update(x).digest("hex");
function canonicalScannerArtifact(input:CollectedArtifact){
 const normalized=readCollectedArtifact(input);if(!normalized)throw new ReleaseReadError("Invalid safe scanner artifact.");
 const {sha256:_sourceDigest,...safe}=normalized;
 return {...safe,sha256:sha(JSON.stringify(safe))};
}
const FILES:Record<string,string>={sast:"sast.json",dependencies:"dependencies.json",image:"image.json",configuration:"configuration.json",secrets:"secrets.json",sbom:"sbom.cdx.json","publisher-signature":"publisher-signature.json","built-image-signature":"built-image-signature.json",runtime:"runtime.json"};
export class ReleaseReadError extends Error{}
export function verifyReleaseArchive(bytes:Uint8Array){
 if(bytes.length>30_000_000)throw new ReleaseReadError("Release archive is too large.");
 let total=0;const names=new Set<string>();
 const files=unzipSync(bytes,{filter:file=>{if(!/^[A-Za-z0-9_.-]{1,100}$/.test(file.name)||file.name.includes("..")||names.has(file.name)||file.originalSize>20_000_000)throw new ReleaseReadError("Invalid archive member.");names.add(file.name);total+=file.originalSize;if(total>80_000_000||names.size>50)throw new ReleaseReadError("Release archive exceeds intake limits.");return true;}});
 if(!files["manifest.json"])throw new ReleaseReadError("Release manifest is missing.");
 const manifest=JSON.parse(strFromU8(files["manifest.json"])) as Record<string,string>;
 if(!manifest||Array.isArray(manifest)||typeof manifest!=="object")throw new ReleaseReadError("Invalid release manifest.");
 for(const [name,digest] of Object.entries(manifest)){if(!files[name]||!/^[a-f0-9]{64}$/.test(digest)||sha(files[name])!==digest)throw new ReleaseReadError("Release artifact digest mismatch.");}
 if(Object.keys(files).some(name=>name!=="manifest.json"&&!Object.hasOwn(manifest,name)))throw new ReleaseReadError("Unmanifested artifact.");
 for(const name of ["summary.json",...Object.values(FILES)])if(!files[name]||!manifest[name])throw new ReleaseReadError("Required release artifact is missing.");
 return {files,manifest};
}
export function releaseEventFromArchive(bytes:Uint8Array,expected:{repository:string;runId:number;commit:string;observedAt:string}):EvidenceEvent {
 const {files,manifest}=verifyReleaseArchive(bytes),summary=JSON.parse(strFromU8(files["summary.json"])) as Record<string,unknown>;
 if(summary.repository!==expected.repository||String(summary.runId)!==String(expected.runId)||summary.commit!==expected.commit||summary.observedAt!==expected.observedAt)throw new ReleaseReadError("Release identity does not match the GitHub run.");
 const repo=`https://github.com/${expected.repository}`,url=`${repo}/actions/runs/${expected.runId}`,validUntil=new Date(Date.parse(expected.observedAt)+86400000).toISOString();
 const artifacts:EvidenceEvent["artifacts"]=[],checks:EvidenceEvent["checks"]=[];
 for(const [id,path] of Object.entries(FILES)){
  const format = (summary.scanners as Record<string, string> | undefined)?.[id] ?? id;
  if (format !== id && !((id === "sast" && format === "semgrep") || (id === "configuration" && format === "checkov"))) throw new ReleaseReadError("Unsupported scanner format.");
  const scan=parseScanner(format,JSON.parse(strFromU8(files[path])),path),digest=manifest[path];
  const name=`source-${sha(`${repo}\0${expected.commit}\0${path}`).slice(0,24)}.json`;
  const collected:CollectedArtifact={schema:"aegis.collected-artifact.v1",name,type:`${format} scanner result`,source:{kind:"scan-result",repo,commit:expected.commit,path,sha256:digest,url},sha256:digest,capturedAt:expected.observedAt,facts:scan.facts,limitations:[...(summary.synthetic === true ? ["Demo system with planted gaps; scanner evidence (Semgrep + Checkov). No live AWS capture is established by this repository scan."] : []),"Scanner observations only; applicability requires review.","Only safe derived facts are retained; the source digest identifies the original scanner bytes.",id==="configuration"?"At most four hundred configuration findings are retained; aggregate counts include the complete output.":"At most fifty individual findings per scanner are retained; aggregate counts include the complete output."]};
  const content=JSON.stringify(canonicalScannerArtifact(collected));
  artifacts.push({name,mediaType:"application/json",contentBase64:Buffer.from(content).toString("base64"),sha256:sha(content)});
  checks.push({id,version:"1.0.0",description:`${format} scanner result`,requirement:{framework:"Scanner policy",reference:id,objective:"No blocking findings in the collected scanner result"},verdict:scan.check.status as "pass"|"fail"|"unknown",artifacts:[name],validUntil});
 }
 // Image identities are summary facts and retain the summary's own source digest.
 if(summary.images && typeof summary.images === "object" && !Array.isArray(summary.images)){
  const images=Object.entries(summary.images as Record<string,unknown>);
  if(images.length>100||images.some(([name,digest])=>!/^[a-z][a-z0-9-]{0,60}\.digest$/.test(name)||typeof digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(digest)))throw new ReleaseReadError("Invalid built image identities.");
  const path="summary.json",digest=manifest[path],name=`source-${sha(`${repo}\0${expected.commit}\0${path}`).slice(0,24)}.json`;
  const values=[{key:"image-build",field:"images.count",value:images.length},...images.map(([key,value])=>({key:"image-build",field:`images.${key}`,value:String(value)}))];
  const collected:CollectedArtifact={schema:"aegis.collected-artifact.v1",name,type:"Built image identities",source:{kind:"release-asset",repo,commit:expected.commit,path,sha256:digest,url},sha256:digest,capturedAt:expected.observedAt,facts:values.map(v=>({...v,line:1,content:`${v.field} = ${v.value}`})),limitations:["Built image identities reported by the runner; no signature or deployment approval supplied."]};
  const content=JSON.stringify(canonicalScannerArtifact(collected));artifacts.push({name,mediaType:"application/json",contentBase64:Buffer.from(content).toString("base64"),sha256:sha(content)});checks.find(c=>c.id==="image")?.artifacts.push(name);
 }
 return parseEvidenceEvent({schema:"aegis.evidence-event.v1",run:{id:String(expected.runId),url,producer:"GitHub Actions",observedAt:expected.observedAt},subject:{kind:"code",id:repo,revision:expected.commit},checks,artifacts,limitations:["No deployment approval supplied","Producer identity is not established by artifact checksums.","Scanner mappings are suggestions until reviewed."]});
}
export async function readGithubRelease(client:Octokit,owner:string,repo:string,runId?:number){
 assertRepoName(owner);assertRepoName(repo);
 const run=runId?(await client.rest.actions.getWorkflowRun({owner,repo,run_id:runId})).data:(await client.rest.actions.listWorkflowRuns({owner,repo,workflow_id:"aegis-release-evidence.yml",status:"success",per_page:20})).data.workflow_runs[0];if(!run)throw new ReleaseReadError("Result unavailable: no successful evidence workflow run.");
 if(run.conclusion!=="success"||run.path?.split("@")[0]!==".github/workflows/aegis-release-evidence.yml")throw new ReleaseReadError("Expected successful evidence workflow.");
 if(run.repository.full_name!==`${owner}/${repo}`||!run.head_sha||!run.run_started_at)throw new ReleaseReadError("Invalid workflow identity.");
 const results=await client.rest.actions.listWorkflowRunArtifacts({owner,repo,run_id:run.id,per_page:100});
 const matches=results.data.artifacts.filter(a=>a.name==="aegis-evidence"&&!a.expired);if(matches.length!==1)throw new ReleaseReadError("Result unavailable: evidence artifact is missing or ambiguous.");
 const download=await client.rest.actions.downloadArtifact({owner,repo,artifact_id:matches[0].id,archive_format:"zip"});
 const event=releaseEventFromArchive(new Uint8Array(download.data as ArrayBuffer),{repository:`${owner}/${repo}`,runId:run.id,commit:run.head_sha,observedAt:run.run_started_at});
 return {event,runId:run.id,commit:run.head_sha};
}
export function collectGithubRelease(input:{installationId:number;owner:string;repo:string;runId?:number}){
 return withReleaseInstallation(input.installationId,input.repo,({octokit})=>readGithubRelease(octokit,input.owner,input.repo,input.runId));
}
