import type {PipelineCheck} from "../../aegis/pipeline-evidence";
import type {EvidenceFact} from "../types";
export class ScannerParseError extends Error { constructor(public scanner:string){super(`Invalid ${scanner} scanner output.`);} }
type Json = Record<string,unknown>;
const object=(x:unknown):Json=>x&&typeof x==="object"&&!Array.isArray(x)?x as Json:{};
const list=(x:unknown):unknown[]=>Array.isArray(x)?x:[];
const safe=(x:unknown,fallback:string)=>typeof x==="string"&&/^[\w./:@-]{1,180}$/.test(x)?x:fallback;
const fact=(key:string,value:number|boolean|string,field:string,line=1,failed=false):EvidenceFact=>({key,value,field,line:Math.max(1,line),content:`${field} = ${value}`,...(failed?{outcome:"fail" as const}:{})});
export type ScanResult = {check:PipelineCheck;facts:EvidenceFact[]};
/** Keep only typed counts, rule identifiers and safe locations. Never retain secret matches or source excerpts. */
export function parseScanner(id:string,input:unknown,artifact:string):ScanResult {
 const body=object(input);if(body.unavailable===true)return {check:{id,status:"unknown",findings:null,blockingCount:null,artifact},facts:[]};
 let findings:{id:string;path:string;line:number;key:string;blocking:boolean}[]=[], facts:EvidenceFact[]=[],count=0,blocking=0,status="pass";
 const add=(raw:unknown,key:string,index:number,defaultPath:string)=>{const r=object(raw),location=object(object(r.CauseMetadata).Code),rule=safe(r.ID??r.VulnerabilityID??r.ruleId??r.RuleID,`finding-${index+1}`),path=safe(r.Target??r.File??r.path,defaultPath),line=Number(location.StartLine??r.StartLine??r.line??1);const severity=String(r.Severity??r.severity??"UNKNOWN").toUpperCase();findings.push({id:rule,path,line:Number.isSafeInteger(line)?line:1,key:id==="configuration"&&/KSV-002[01]/.test(rule)?"non-root":key,blocking:["HIGH","CRITICAL","ERROR"].includes(severity)});};
 if(id==="semgrep"){
  if(!Array.isArray(body.results)||!Array.isArray(body.errors)||body.errors.length||!Array.isArray(object(body.paths).scanned)||!list(object(body.paths).scanned).length)throw new ScannerParseError(id);
  for(const entry of body.results){const r=object(entry),extra=object(r.extra),metadata=object(extra.metadata);add({ruleId:r.check_id,path:r.path,line:object(r.start).line,severity:extra.severity},metadata.aegis_fact_key==="secrets-scan"?"secrets-scan":"sast-scan",findings.length,"source");}
 }else if(id==="checkov"){
  const results=object(body.results);
  if(!Array.isArray(results.failed_checks)||!Array.isArray(results.passed_checks)||list(results.parsing_errors).length||!Number.isInteger(object(body.summary).failed)||!list(results.failed_checks).length&&!list(results.passed_checks).length)throw new ScannerParseError(id);
  for(const entry of results.failed_checks){const r=object(entry);add({ruleId:r.check_id,path:typeof r.repo_file_path==="string"?r.repo_file_path.replace(/^\//, ""):typeof r.file_path==="string"?r.file_path.replace(/^\//, ""):undefined,line:list(r.file_line_range)[0],severity:"HIGH"},"configuration-scan",findings.length,"scan");}
 }else if(["configuration","image","dependencies"].includes(id)){
  if(!Array.isArray(body.Results))throw new ScannerParseError(id);
  for(const result of body.Results){const r=object(result);for(const finding of list(id==="configuration"?r.Misconfigurations:r.Vulnerabilities))add(finding,id==="configuration"?"configuration-scan":"vulnerability-scan",findings.length,safe(r.Target,"scan"));}
 }else if(id==="sast"){
  if(!Array.isArray(body.runs))throw new ScannerParseError(id);
  for(const run of body.runs)for(const finding of list(object(run).results)){const f=object(finding),physical=object(object(list(f.locations)[0]).physicalLocation);add({...f,path:object(physical.artifactLocation).uri,line:object(physical.region).startLine,severity:f.level==="error"?"HIGH":"MEDIUM"},"sast-scan",findings.length,"source");}
 }else if(id==="secrets"){
  if(!Array.isArray(input))throw new ScannerParseError(id);
  input.forEach((f,i)=>add({...object(f),Severity:"HIGH"},"secrets-scan",i,"source"));
 }else if(id==="sbom"){
  if(body.bomFormat!=="CycloneDX"||!Array.isArray(body.components))throw new ScannerParseError(id);
  facts=[fact("sbom",body.components.length,"components.count")];
 }else if(id.endsWith("signature")){
  if(!Array.isArray(input))throw new ScannerParseError(id);
  status=input.length?"pass":"unknown";facts=input.length?[fact("signature",input.length,"signatures.count")]:[];
 }else if(id==="runtime"){
  if(typeof body.healthy!=="boolean"||!Number.isSafeInteger(body.podCount)||!Number.isSafeInteger(body.readyCount))throw new ScannerParseError(id);
  status=body.healthy?"pass":"fail";count=body.healthy?0:1;blocking=count;facts=[fact("runtime-probe",body.healthy,"probe.healthy",1,!body.healthy),fact("runtime-probe",Number(body.podCount),"pods.count"),fact("runtime-probe",Number(body.readyCount),"pods.ready")];
 }else throw new ScannerParseError(id);
 // Semgrep can report several locations for one rule/target criterion. The shared
 // finding identity is rule + path, so normalize that count and retain raw occurrences separately.
 if(id==="semgrep")findings=findings.filter((f,i,all)=>all.findIndex(other=>other.id===f.id&&other.path===f.path&&other.key===f.key)===i);
 if(findings.length){count=findings.length;blocking=findings.filter(f=>f.blocking).length;status=blocking?"fail":"pass";facts=findings.slice(0,id==="configuration"?400:50).map(f=>({
  ...fact(f.key,"fail",`finding.${f.id}/${f.path}`.slice(0,1000),f.line,true),
  // Retain only explicit nested repository-relative locations. Basenames/absolute/image targets remain unknown.
  ...(id!=="image" && /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/.test(f.path) && !f.path.split("/").some(p=>p==="."||p==="..") ? {fixPaths:[f.path]} : {}),
 }));}
 if(id==="semgrep")facts.push(fact("scan-findings",list(body.results).length,"findings.occurrences"));
 const scannedKey:Record<string,string>={semgrep:"sast-scan",checkov:"configuration-scan",configuration:"configuration-scan",dependencies:"vulnerability-scan",image:"vulnerability-scan",sast:"sast-scan",secrets:"secrets-scan"};
 if(scannedKey[id])facts.push(fact(scannedKey[id],true,"scanner.completed"));
 facts.unshift(fact("scan-findings",count,"findings.count"),fact("scan-blocking",blocking,"findings.blocking"));
 return {check:{id,status,findings:count,blockingCount:blocking,artifact},facts};
}
