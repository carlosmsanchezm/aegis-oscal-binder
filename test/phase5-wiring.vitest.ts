import {it,expect,vi,afterEach} from "vitest";
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {accountTarget,assertTargetCaller,GOVCLOUD_TARGET} from "../lib/collector/aws/account";
import {ingestProwler} from "../lib/collector/aws/ingest";
import {prowlerCommand,stsCommand} from "../lib/collector/aws/run";
import {readCollectedArtifact} from "../lib/collector/read";
import {verifyRecord} from "../lib/collector/aws/scan-record";
import {workerConfigs,startWorkers} from "../scripts/demo/launcher";
import {parseScanner} from "../lib/collector/scanners";
afterEach(()=>vi.unstubAllEnvs());
it("commercial intake uses the shared envelope/artifacts/events and refuses cross-account/partition/region",()=>{
 const target=accountTarget({partition:"aws",allowedAccountIds:["111111111111"],regions:["us-east-1"]});
 const caller={Account:target.allowedAccountIds[0],Arn:`arn:aws:sts::${target.allowedAccountIds[0]}:assumed-role/demo/fixture`,UserId:"fixture"};
 const findings:any[]=JSON.parse(readFileSync("fixtures/aws/empty-account/prowler.ocsf.json","utf8"));
 for(const f of findings){f.cloud.region="us-east-1";f.cloud.partition="aws";f.cloud.account.uid=caller.Account;for(const r of f.resources??[])r.uid=r.uid.replace("arn:aws-us-gov:","arn:aws:").replace(/\d{12}/g,caller.Account);}
 const input={target,findings,caller,capturedAt:"2026-10-31T19:00:00Z",now:new Date("2026-10-31T19:00:00Z"),trigger:"fixture" as const,gitCommit:"a".repeat(40)};
 const result=ingestProwler(input);verifyRecord(result.record);expect(result.record.target.partition).toBe("aws");expect(result.artifacts.every(a=>a.source.kind==="aws-account"&&a.source.partition==="aws"&&!!readCollectedArtifact(a))).toBe(true);expect(result.events.length).toBeGreaterThan(0);expect(result.artifacts[0].limitations.join(" ")).toContain("SYNTHETIC FIXTURE");
 expect(()=>assertTargetCaller({...caller,Account:"222222222222"},target)).toThrow(/boundary/);
 expect(()=>assertTargetCaller({...caller,Arn:caller.Arn.replace("arn:aws:","arn:aws-us-gov:")},target)).toThrow(/boundary/);
 expect(()=>accountTarget({...target,regions:["us-gov-west-1"]})).toThrow(/partition/);
 expect(()=>accountTarget({...GOVCLOUD_TARGET,regions:["us-east-1"]})).toThrow(/partition/);
 const wrong=structuredClone(findings);wrong[0].cloud.partition="aws-us-gov";expect(()=>ingestProwler({...input,findings:wrong})).toThrow(/partition/);
 const cross=structuredClone(findings);cross[0].cloud.account.uid="222222222222";expect(()=>ingestProwler({...input,findings:cross})).toThrow(/target/);
 expect(stsCommand("demo",target).args).toContain("https://sts.us-east-1.amazonaws.com");expect(prowlerCommand({profile:"demo",regions:target.regions,outDir:"/tmp/demo",target}).env.PROWLER_AWS_PARTITION).toBe("aws");
});
it("native scanner parser retains only safe scoped facts and refuses incomplete scans",()=>{
 const native={results:[{check_id:"DEMO-CODE-01",path:"src/recommendationservice/recommendation_server.py",start:{line:80},extra:{severity:"ERROR",lines:"DO NOT RETAIN"}}],errors:[],paths:{scanned:["src/recommendationservice/recommendation_server.py"]}};
 const scan=parseScanner("semgrep",native,"sast.json");expect(scan.facts.find(f=>f.outcome)?.fixPaths).toEqual([native.results[0].path]);expect(JSON.stringify(scan)).not.toContain("DO NOT RETAIN");expect(()=>parseScanner("semgrep",{...native,errors:[{}]},"sast.json")).toThrow();
 expect(()=>parseScanner("checkov",{results:{failed_checks:[],passed_checks:[],parsing_errors:[]},summary:{failed:0}},"configuration.json")).toThrow();
});
it("launcher honors configured cap, refuses missing workers and unsafe credential files",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"phase5-launch-"));try{
 const token=path.join(dir,"token"),config=path.join(dir,"workers.json");writeFileSync(token,"synthetic-agent-token",{mode:0o600});const worker={command:process.execPath,args:["-e","process.exit(1)"],cwd:dir,tokenFile:token};writeFileSync(config,JSON.stringify(Array.from({length:6},(_,i)=>{const cwd=path.join(dir,String(i));mkdirSync(cwd);return {...worker,cwd};})),{mode:0o600});
 expect(workerConfigs(config)).toHaveLength(5);expect(()=>workerConfigs(config,6)).toThrow(/cap/);vi.stubEnv("AEGIS_FIX_RUNNER_LIMIT","8");expect(workerConfigs(config,6)).toHaveLength(6);expect(()=>workerConfigs(config,7)).toThrow(/required/);expect(()=>workerConfigs(config,0)).toThrow();
 writeFileSync(config,JSON.stringify([worker]),{mode:0o600});expect(()=>workerConfigs(config)).toThrow(/required/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("a process exit cannot fake a registered provider PR",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"phase5-worker-"));try{
 const token=path.join(dir,"token");writeFileSync(token,"synthetic-agent-token",{mode:0o600});
 const workers=startWorkers([{command:process.execPath,args:["-e","process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],cwd:dir,tokenFile:token}],"http://localhost:3000","synthetic-connection");
 await new Promise(resolve=>workers.children[0].on("exit",resolve));expect(()=>workers.assertRegistered([])).toThrow(/registered/);workers.stop();
 const bad=startWorkers([{command:process.execPath,args:["-e","process.exit(1)"],cwd:dir,tokenFile:token}],"http://localhost:3000","synthetic-connection");await new Promise(resolve=>bad.children[0].on("exit",resolve));expect(()=>bad.assertHealthy()).toThrow(/failed/);bad.stop();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("connected preflight rejects public targets, absent workers, permissive cookies and invalid timeouts",async()=>{
 const {connectedConfig}=await import("../scripts/demo/connected-config");const dir=mkdtempSync(path.join(tmpdir(),"phase5-preflight-"));try{
 const token=path.join(dir,"token"),cookie=path.join(dir,"cookie"),file=path.join(dir,"workers.json");
 writeFileSync(token,"synthetic-agent-token",{mode:0o600});writeFileSync(cookie,"synthetic-cookie",{mode:0o600});writeFileSync(file,JSON.stringify(Array.from({length:5},(_,i)=>{const cwd=path.join(dir,String(i));mkdirSync(cwd);return {command:process.execPath,args:[],cwd,tokenFile:token};})),{mode:0o600});
 const env={NODE_ENV:"test" as const,AEGIS_DEMO_URL:"https://demo.example.invalid",AEGIS_DEMO_ACK_SYNTHETIC:"true",AEGIS_DEMO_REPO:"carlosmsanchezm/aegis-boutique-demo-private",AEGIS_DEMO_COOKIE_FILE:cookie,AEGIS_DEMO_WORKERS_FILE:file};
 expect(connectedConfig(env).workers).toHaveLength(5);expect(()=>connectedConfig({...env,AEGIS_DEMO_REPO:"carlosmsanchezm/microservices-demo"})).toThrow(/private/);expect(()=>connectedConfig({...env,AEGIS_DEMO_WORKERS_FILE:undefined})).toThrow(/required/);expect(()=>connectedConfig({...env,AEGIS_DEMO_TIMEOUT_MS:"NaN"})).toThrow(/Timeout/);expect(()=>connectedConfig({...env,AEGIS_DEMO_URL:"https://user:secret@example.invalid"})).toThrow(/origin/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("take proof rejects gate denial, override, stale success and missing release receipt",async()=>{
 const {headGateProgress,releaseTakeReady}=await import("../scripts/demo/take-proof");const ids=Array.from({length:5},(_,i)=>String(i));const prs=ids.map((id,i)=>({poamItemId:id,prNumber:i+1,headSha:String(i).repeat(40)}));
 const trace=prs.map(pr=>({body:{reason_code:"poam_gate_evaluated",commit:pr.headSha,items:[pr.poamItemId],summary:{conclusion:"success",reason:"Linked POA&M, current-head CI and server-collected retest verified. Human closure remains required."}}}));
 expect(headGateProgress(prs,trace,ids).green).toBe(true);
 const denial={...trace[0],body:{...trace[0].body,summary:{conclusion:"failure",reason:"Controlled paths require a linked open POA&M item."}}};expect(headGateProgress(prs,[...trace,denial],ids)).toMatchObject({green:false,rejected:true});
 const override={...denial,body:{...denial.body,summary:{conclusion:"success",reason:"Named human emergency override recorded"}}};expect(headGateProgress(prs,[...trace,override],ids).green).toBe(false);
 const jobs=ids.map(()=>({readyForClosureReview:true})),bundle={rangeStatus:"verified",items:ids.map(id=>({poamItemId:id,retestResult:"pass",retestReceiptId:"a".repeat(64)}))};expect(releaseTakeReady(jobs,bundle,ids)).toBe(true);bundle.items[0].retestReceiptId="";expect(releaseTakeReady(jobs,bundle,ids)).toBe(false);
});
it("connected collection selects all five current heads and shipped runs without repeated or unrelated receipts",async()=>{
 const {currentTakeRuns}=await import("../scripts/demo/take-proof");
 const prs=Array.from({length:5},(_,i)=>({headSha:String(i+1).repeat(40)}));
 const run=(databaseId:number,headSha:string,headBranch="fix")=>({databaseId,headSha,headBranch,status:"completed",conclusion:"success"});
 const baseline=run(1,"a".repeat(40),"protected"),heads=prs.map((pr,i)=>run(i+2,pr.headSha));
 const unrelated=run(90,"b".repeat(40)),pending={...run(91,"c".repeat(40),"protected"),status:"in_progress"},failed={...run(92,"d".repeat(40),"protected"),conclusion:"failure"};
 const duplicate=run(20,prs[0].headSha),shipped=run(30,"f".repeat(40),"protected");
 const runs=[shipped,duplicate,...heads.toReversed(),unrelated,pending,failed,baseline];
 const selected=currentTakeRuns(runs,prs,"protected",new Set(["1"]));
 expect(new Set(selected.map(r=>r.headSha))).toEqual(new Set([...prs.map(pr=>pr.headSha),shipped.headSha]));
 expect(selected).toHaveLength(6);expect(selected.some(r=>r.databaseId===2)).toBe(false);
 expect(currentTakeRuns(runs,prs,"protected",new Set(["1",...selected.map(r=>String(r.databaseId))]))).toEqual([]);
});
it("resume reuses only fresh owned native history and cannot promote uploaded, stale or unrelated runs",async()=>{
 const {retainedNativeRuns}=await import("../scripts/demo/take-proof"),now=Date.parse("2026-11-03T18:00:00Z"),repo="example/private";
 const native={id:"a".repeat(64),artifacts:[{name:"native.json",source_label:{kind:"server-collected"}}],subject:{id:`https://github.com/${repo}`},
  run:{id:"42",producer:"GitHub Actions",observedAt:new Date(now-1000).toISOString()},
  checks:["semgrep","checkov"].map(engine=>({description:`${engine} scanner result`,verdict:"fail",validUntil:new Date(now+1000).toISOString()}))};
 expect(retainedNativeRuns([native,native],repo,now)).toEqual(["42"]);
 const {sourcedBuilderBundle}=await import("../lib/server/builder-observation");
 const serialized=sourcedBuilderBundle({id:native.id,receivedAt:new Date(now).toISOString(),event:{subject:native.subject,run:native.run,checks:native.checks,limitations:[],artifacts:[{name:"native.json",mediaType:"text/plain",sha256:"b".repeat(64)}]}} as any,{kind:"server-collected"});
 expect(retainedNativeRuns([serialized],repo,now)).toEqual(["42"]);
 const invalid=[{...native,artifacts:[{name:"native.json",source_label:{kind:"person",identity_verification:"unverified"}}]},{...native,artifacts:[]},
  {...native,source_label:{kind:"server-collected"},artifacts:[{name:"native.json"}]},{...native,subject:{id:"https://github.com/other/repo"}},
  {...native,run:{...native.run,producer:"Aegis source collector v1"}},
  {...native,checks:native.checks.map(c=>({...c,validUntil:new Date(now-1).toISOString()}))},
  {...native,run:{...native.run,observedAt:new Date(now+300_001).toISOString()}},
  {...native,run:{...native.run,id:"untrusted"}},{...native,checks:native.checks.slice(0,1)}];
 expect(retainedNativeRuns(invalid,repo,now)).toEqual([]);
});
