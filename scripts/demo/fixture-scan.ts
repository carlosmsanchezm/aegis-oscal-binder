import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {parse} from "yaml";
import {DEMO_GAPS} from "./gaps";
import {demoEvent} from "./fixtures";
import {sealCollectedArtifact} from "../../lib/collector/seal";
/** OFFLINE CI ONLY. Intentionally narrow rules for the five documented fixtures. Not a general SAST/CSPM claim. */
export function plantedGapPresent(id:string,content:string){
 if(id==="DEMO-CODE-01")return !/if\s+principal\s+is\s+None\s*:[\s\S]*?raise\s+PermissionError/.test(content);
 if(id==="DEMO-CODE-02")return /DEMO_CREDENTIAL\s*=\s*["']SYNTHETIC-NONFUNCTIONAL-EXAMPLE["']/.test(content);
 if(id==="DEMO-CI-01"){const workflow=parse(content);return workflow.permissions!=="read-all"&&workflow.permissions?.contents!=="read"||Object.values(workflow.jobs??{}).some((j:any)=>(j.steps??[]).some((s:any)=>s.uses&&!/@[a-f0-9]{40}$/.test(s.uses)));}
 if(id==="DEMO-IAC-01")return !/status\s*=\s*"Enabled"/.test(content);
 if(id==="DEMO-IAC-02")return /cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/.test(content)&&/from_port\s*=\s*22/.test(content);
 throw new Error("Unknown synthetic gap.");
}
export function scanFixtureDemo(target:string){
 const git=(...args:string[])=>execFileSync("git",["-C",target,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 if(git("branch","--show-current")!=="codex/phase4-synthetic")throw new Error("Use the dedicated synthetic branch.");
 const fixtureGaps=DEMO_GAPS.map((g,i)=>({...g,path:i===0?"src/aegis-demo/auth.py":i===1?"src/aegis-demo/config.py":g.path}));
 const commit=git("rev-parse","HEAD"),contents=fixtureGaps.map(g=>readFileSync(path.join(target,g.path),"utf8"));
 const remaining=fixtureGaps.filter((g,i)=>plantedGapPresent(g.id,contents[i])).map(g=>g.id);
 const at=new Date().toISOString(),event=demoEvent("https://github.com/carlosmsanchezm/microservices-demo",commit,at,"synthetic-local",remaining);
 event.run={id:"synthetic-local",producer:"Synthetic local scanner",observedAt:at};
 event.limitations=["SYNTHETIC local working-tree fixture; hashes describe local bytes, not a trusted GitHub collector receipt.","Five narrow planted rules only. No live AWS observation, compliance determination or processing authorization."];
 for(const [i,a] of event.artifacts.entries()){
  const artifact=JSON.parse(Buffer.from(a.contentBase64,"base64").toString("utf8"));
  for(const f of artifact.facts){
   f.field=f.field.replace(DEMO_GAPS[i].path,fixtureGaps[i].path);f.content=`${f.field} = ${f.value}`;
   if(f.fixPaths)f.fixPaths=[fixtureGaps[i].path];
  }
  artifact.source.sha256=createHash("sha256").update(contents[i]).digest("hex");
  artifact.limitations=event.limitations;
  const raw=JSON.stringify(sealCollectedArtifact(artifact));a.contentBase64=Buffer.from(raw).toString("base64");a.sha256=createHash("sha256").update(raw).digest("hex");
 }
 return {event,remaining};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const target=process.argv[2],out=process.argv[3];if(!target||!out)throw new Error("Usage: scan.ts <local-synthetic-clone> <output-event.json>");
 const result=scanFixtureDemo(path.resolve(target));writeFileSync(out,JSON.stringify(result.event,null,2),{mode:0o600});
 console.log(JSON.stringify({stage:"synthetic_local_scan",at:new Date().toISOString(),remaining:result.remaining,output:path.resolve(out),trustedCollectorReceipt:false,noLiveAwsApply:true}));
}
