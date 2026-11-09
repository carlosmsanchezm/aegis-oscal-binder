import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {collectorEvents} from "../../lib/collector/events";
import {sealCollectedArtifact} from "../../lib/collector/seal";
import {parseEvidenceEvent} from "../../lib/builder/evidence";
import type {EvidenceFact} from "../../lib/collector/types";
import {DEMO_GAPS} from "./gaps";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export type ScannerRunner=(file:string,args:string[],cwd:string)=>string;
const execute:ScannerRunner=(file,args,cwd)=>{
 try{return execFileSync(file,args,{cwd,encoding:"utf8",maxBuffer:16_000_000,timeout:180000,stdio:["ignore","pipe","pipe"],env:{...process.env,SEMGREP_SEND_METRICS:"off",CHECKOV_SKIP_DOWNLOAD:"true"}});}
 catch{throw new Error("Scanner invocation failed or timed out; no complete receipt emitted.");}
};
/** Real scanner engines over local planted bytes. Local output never impersonates server collection. */
export function scanDemo(target:string,runner:ScannerRunner=execute){
 const git=(...args:string[])=>execFileSync("git",["-C",target,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 const repo="https://github.com/carlosmsanchezm/aegis-boutique-demo-private";
 if(git("branch","--show-current")!=="codex/phase4-synthetic"&&!git("branch","--show-current").startsWith("codex/phase5-")&&!git("branch","--show-current").startsWith("codex/phase7-"))throw new Error("Use a dedicated private demo branch.");
 const semgrep=process.env.AEGIS_SEMGREP_BIN??"semgrep",checkov=process.env.AEGIS_CHECKOV_BIN??"checkov";
 const semgrepVersion=runner(semgrep,["--version"],target).trim(),checkovVersion=runner(checkov,["--version"],target).trim();
 if(semgrepVersion!=="1.183.0"||checkovVersion!=="3.4.0")throw new Error("Install the pinned scanner versions in scripts/demo/scanner/requirements.txt.");
 const sast=JSON.parse(runner(semgrep,["scan","--config",path.join(root,"scripts/demo/scanner/semgrep.yml"),"--json","--quiet","--metrics=off","--disable-version-check","--no-rewrite-rule-ids","src/recommendationservice/recommendation_server.py","src/emailservice/email_server.py",".github/workflows/aegis-synthetic-demo.yml"],target));
 const iac=JSON.parse(runner(checkov,["-d","infra/aegis-demo/modules/gaps","--config-file",path.join(root,"scripts/demo/scanner/checkov.yml"),"--output","json","--soft-fail"],target));
 if(!Array.isArray(sast.results)||!Array.isArray(sast.errors)||sast.errors.length||!iac.results||!Array.isArray(iac.results.failed_checks)||!Array.isArray(iac.results.passed_checks)||iac.results.parsing_errors?.length)throw new Error("Incomplete scanner result; fail closed.");
 const at=new Date().toISOString(),commit=git("rev-parse","HEAD");
 const remaining:string[]=[];
 const artifacts=DEMO_GAPS.map(g=>{
  const code=g.id.startsWith("DEMO-CODE")||g.id==="DEMO-CI-01";
  const policy=g.id==="DEMO-IAC-01"?"CKV_AWS_21":"CKV_AWS_24";
  const matches=code?sast.results.filter((f:any)=>f.check_id===g.id&&f.path===g.path):iac.results.failed_checks.filter((f:any)=>f.check_id===policy&&`infra/aegis-demo/modules/gaps${f.file_path}`===g.path);
  if(!code&&!matches.length&&!iac.results.passed_checks.some((f:any)=>f.check_id===policy&&`infra/aegis-demo/modules/gaps${f.file_path}`===g.path))throw new Error("Expected IaC policy was not evaluated.");
  if(code&&!sast.paths?.scanned?.includes(g.path))throw new Error("Expected code target was not scanned.");
  const failed=matches.length>0;if(failed)remaining.push(g.id);
  const facts:EvidenceFact[]=[{key:"scan-findings",field:"findings.count",value:matches.length,line:1,content:`findings.count = ${matches.length}`},{key:g.key,field:"scanner.completed",value:true,line:1,content:"scanner.completed = true"},...(failed?[{key:g.key,field:`finding.${g.id}/${g.path}`,value:"fail",line:Math.max(1,Number(matches[0].start?.line??matches[0].file_line_range?.[0]??1)),content:`finding.${g.id}/${g.path} = fail`,outcome:"fail" as const,fixPaths:[g.path],resourceIds:[g.resource]}]:[])];
  const source=readFileSync(path.join(target,g.path),"utf8");
  return sealCollectedArtifact({schema:"aegis.collected-artifact.v1",name:`source-${hash(g.id).slice(0,24)}.json`,type:code?"Semgrep code scan":"Checkov IaC scan",source:{kind:"scan-result",repo,commit,path:`demo-scans/${g.id}.json`,sha256:hash(source)},capturedAt:at,sha256:"0".repeat(64),facts,limitations:["SYNTHETIC planted system; real Semgrep/Checkov local execution. No live AWS observation.","Local working-tree capture, not a trusted server GitHub collection receipt. No authorization or human closure.",`Scanner ${code?"Semgrep "+semgrepVersion:"Checkov "+checkovVersion}; policy ${code?g.id:policy}; normalized output hash ${hash(JSON.stringify(code?sast:iac))}`]});
 });
 const event=JSON.parse(collectorEvents(artifacts)[0].rawEvent);
 event.run={id:`local-${Date.now()}`,producer:"Semgrep + Checkov local",observedAt:at};
 event.limitations=["SYNTHETIC planted system; real local engines; server collection and live AWS unverified."];
 return {event:parseEvidenceEvent(event),remaining,versions:{semgrep:semgrepVersion,checkov:checkovVersion}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [target,out]=process.argv.slice(2);if(!target||!out)throw new Error("Usage: scan.ts <private-demo-clone> <output-event.json>");
 const result=scanDemo(path.resolve(target));writeFileSync(out,JSON.stringify(result.event,null,2),{mode:0o600});console.log(JSON.stringify({stage:"real_local_scan",at:new Date().toISOString(),remaining:result.remaining,versions:result.versions,output:path.resolve(out),trustedCollectorReceipt:false,noLiveAwsApply:true}));
}
