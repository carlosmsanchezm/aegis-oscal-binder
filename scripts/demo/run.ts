import {appendFileSync,readFileSync,writeFileSync,mkdtempSync} from "node:fs";
import {spawnSync,execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {readBundleZip} from "../../lib/manifest/bundle";
import {verifyManifest} from "../../lib/manifest/manifest";
import {headGateProgress,releaseTakeReady,currentTakeRuns,retainedNativeRuns} from "./take-proof";
import {connectedConfig} from "./connected-config";
import {startWorkers} from "./launcher";
import {connectedRequest} from "./connected-request";
import {assertResumableTake} from "./resume-proof";
const logDir=mkdtempSync(path.join(tmpdir(),"aegis-phase5-take-"));
const logPath=path.join(logDir,`stages-${new Date().toISOString().replace(/[:.]/g,"-")}.jsonl`);
console.log(JSON.stringify({stage:"log_opened",path:logPath,timezone:"UTC"}));
let activeOperation="configuration";
const mark=(stage:string,details:Record<string,unknown>={})=>{const line=JSON.stringify({stage,at:new Date().toISOString(),timezone:"UTC",...details});appendFileSync(logPath,line+"\n",{mode:0o600});console.log(line);};
async function run(){
 if(process.argv.includes("--fixtures")&&process.argv.includes("--connected"))throw new Error("Select exactly one mode.");
 if(process.argv.includes("--fixtures")){
  const out=mkdtempSync(path.join(tmpdir(),"aegis-phase4-demo-"));
  const transcript=path.join(out,"stages.jsonl"),report=path.join(out,"report.json");
  const child=spawnSync("pnpm",["exec","vitest","run","test/fix-runner.vitest.ts","-t","fixture demo:"],{env:{...process.env,AEGIS_PHASE4_TRANSCRIPT:transcript,AEGIS_PHASE4_REPORT:report},encoding:"utf8",maxBuffer:4_000_000});
  if(child.status!==0)throw new Error("Synthetic fixture smoke failed; run pnpm exec vitest run test/fix-runner.vitest.ts for diagnostics.");
  const stages=readFileSync(transcript,"utf8");process.stdout.write(stages);appendFileSync(logPath,stages,{mode:0o600});mark("fixture_receipt",{mode:"SYNTHETIC — local adapters, no live agents/provider writes",report,noLiveAwsApply:true});return;
 }
 if(!process.argv.includes("--connected"))throw new Error("Use --fixtures or --connected.");
 const config=connectedConfig();
 const resume=process.argv.includes("--resume");
 if(resume&&(!config.sourceRun||!process.env.AEGIS_DEMO_ITEMS_FILE))throw new Error("Resume requires the original exact source run and selected item file.");
 const {address,repo,cookie,workers}=config,[owner,name]=repo.split("/");
 const gh=(args:string[])=>{try{return execFileSync("gh",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:60000});}catch{throw new Error("Private scanner workflow operation failed.");}};
 const metadata=JSON.parse(gh(["api",`repos/${repo}`]));
 if(metadata.private!==true||metadata.full_name!==repo)throw new Error("Private repository identity check failed.");
 if(process.argv.includes("--dry-run")){mark("connected_preflight_only",{repo,workers:workers.length,private:true,networkWrites:false,liveTakeCompleted:false});return;}
 mark("wall_clock_start",{mode:"CONNECTED — real private demo/provider/scanners/workers",noLiveAwsApply:true});
 let sourceRun=config.sourceRun;
 if(!sourceRun){
  const existingRuns=new Set(JSON.parse(gh(["run","list","--repo",repo,"--workflow","aegis-release-evidence.yml","--limit","20","--json","databaseId"])).map((r:any)=>r.databaseId));
  if(!/^codex\/(phase4-synthetic|phase5-[a-z0-9-]+)$/.test(config.ref))throw new Error("Invalid private demo ref.");
  gh(["workflow","run","aegis-release-evidence.yml","--repo",repo,"--ref",config.ref]);mark("scan_requested");
  const scanDeadline=Date.now()+config.timeout;
  while(Date.now()<scanDeadline){
   const runs=JSON.parse(gh(["run","list","--repo",repo,"--workflow","aegis-release-evidence.yml","--branch",config.ref,"--event","workflow_dispatch","--limit","10","--json","databaseId,createdAt,status,conclusion"])).filter((r:any)=>!existingRuns.has(r.databaseId));
   if(runs.length>1)throw new Error("Ambiguous concurrent scanner dispatch; pin AEGIS_DEMO_SOURCE_RUN.");
   if(runs[0]?.status==="completed"){if(runs[0].conclusion!=="success")throw new Error("Real scanner workflow failed.");sourceRun=runs[0].databaseId;break;}
   await new Promise(resolve=>setTimeout(resolve,10000));
  }
  if(!sourceRun)throw new Error("Scanner workflow timed out.");
 }
 const headers={cookie,"content-type":"application/json",origin:address.origin,"x-aegis-workspace":"sa1-demo"};
 async function request(route:string,body?:unknown){activeOperation=route.split("?")[0];return connectedRequest(address,route,headers,body,(attempt,httpStatus)=>mark("service_retry",{operation:activeOperation,httpStatus,attempt}));}
 const json=async(route:string,body?:unknown)=>(await request(route,body)).json();
 const collected=await json("/api/pipeline/github/collect",{owner,repo:name,runId:sourceRun}),connectionId=collected.connectionId;
 if(!connectionId)throw new Error("Collection did not return a connection.");mark("connected",{connectionId});
 const initial=await json(`/api/builder/evidence/${collected.receipt}?connection=${connectionId}`);
 // The server collector must have interpreted native engine output, never a local injected event.
 if(initial.source_label?.kind!=="server-collected"||!["semgrep","checkov"].every(engine=>initial.event?.checks.some((c:any)=>c.description===`${engine} scanner result`)))throw new Error("The collected release lacks native scanner provenance.");
 mark("scan_done_map_red",{receipt:collected.receipt,sourceRun});
 const issues=await json(`/api/remediation/issues?connection=${connectionId}`);
 const configuredItems=process.env.AEGIS_DEMO_ITEMS_FILE?JSON.parse(readFileSync(process.env.AEGIS_DEMO_ITEMS_FILE,"utf8")):null;
 const ids=configuredItems??issues.poam_items.filter((p:any)=>!p.closureConfirmed&&!p.readyToClose&&p.sourceReleaseId===collected.receipt.slice(0,32)).slice(0,5).map((p:any)=>p.id);
 if(!Array.isArray(ids)||ids.length!==5||ids.some(id=>typeof id!=="string"))throw new Error("Select exactly five open synthetic POA&M items in AEGIS_DEMO_ITEMS_FILE.");
 const enqueued=await json("/api/remediation/fix-runner",{operation:"enqueue",connectionId,poamItemIds:ids});
 const resumed=enqueued.assignments.filter((j:any)=>ids.includes(j.poamItemId)&&j.prNumber&&!["expired","abandoned"].includes(j.state));
 if(resumed.length)mark("existing_prs_resumed",{count:resumed.length,prNumbers:resumed.map((j:any)=>j.prNumber),newProviderCreation:false});
 let launched:ReturnType<typeof startWorkers>|undefined;
 if(resume){
  const prs=(await json(`/api/remediation/pull-requests?connection=${connectionId}`)).pullRequests;
  const audit:any[]=[];let cursor:string|null=null;
  for(let page=0;page<50;page++){const result=await json(`/api/agent/audit?connection=${connectionId}&limit=200${cursor?"&since="+encodeURIComponent(cursor):""}`);audit.push(...result.entries);cursor=result.next_cursor;if(!cursor)break;}
  if(cursor)throw new Error("Resume audit exceeds bounded history.");
  assertResumableTake(enqueued.assignments,prs,audit,ids,collected.receipt);
  mark("worker_stage_resumed",{previouslyCompletedWorkers:5,newWorkersLaunched:0,proof:"server assignment, PR identity, owning-worker claim/open/retest audit"});
 }else launched=startWorkers(workers,address.origin,connectionId);
 try {
 if(launched)mark("fan_out_5",{transport:"Connected workers claim_fix via Aegis MCP"});
 const deadline=Date.now()+config.timeout;let first=false,gated=false,headsGreen=false,done=false;
 const collectedRuns=new Set([String(sourceRun)]);let resumedReceipts=false;
 while(Date.now()<deadline){
  activeOperation="workers/health";launched?.assertHealthy();
  const state=await json("/api/remediation/fix-runner",{operation:"refresh",connectionId});
  const jobs=state.assignments.filter((j:any)=>ids.includes(j.poamItemId)&&!["expired","abandoned"].includes(j.state));
  if(launched?.completed.size===workers.length){activeOperation="workers/registration";launched.assertRegistered(jobs);}
  if(!first&&jobs.some((j:any)=>j.prNumber)){mark("first_pr_open");first=true;}
  const prs=(await json(`/api/remediation/pull-requests?connection=${connectionId}`)).pullRequests.filter((p:any)=>ids.includes(p.poamItemId));
  const trace:any[]=[];let cursor:string|null=null;
  for(let page=0;page<50;page++) {const result=await json(`/api/timeline?connection=${connectionId}&limit=200${cursor?"&since="+encodeURIComponent(cursor):""}`);trace.push(...result.entries);cursor=result.next_cursor;if(!cursor)break;}
  if(cursor)throw new Error("Timeline exceeds the bounded demo history; use a fresh connection.");
  const gates=headGateProgress(prs,trace,ids);
  if(gates.rejected)throw new Error("A required gate rejected the connected take.");
  if(!gated&&gates.evaluated){mark("all_prs_gated");gated=true;}
  if(!headsGreen&&gates.green){mark("all_head_retests_green");mark("awaiting_human_merges",{pullRequests:prs.map((p:any)=>p.prUrl),scriptCanMerge:false});headsGreen=true;}
  const builder=await json("/api/builder"),c=builder.connections.find((c:any)=>c.id===connectionId),bundle=c?.releaseEvidence?.at(-1);
  if(resume&&!resumedReceipts){
   const reused=retainedNativeRuns(c?.history??[],repo).filter(id=>!collectedRuns.has(id));
   reused.forEach(id=>collectedRuns.add(id));resumedReceipts=true;
   mark("native_collection_receipts_reused",{runIds:reused,proof:"Fresh session-owned server-collected native history; scheduling only, gate and release proof unchanged"});
  }
  if(gated&&headsGreen&&releaseTakeReady(jobs,bundle,ids)){mark("all_release_retests_green_tiles_green");mark("release_evidence_ready",{release:bundle.releaseId});done=true;break;}
  // Collect every current head, then shipped commits. "Latest run" alone can
  // repeatedly collect just one of five independent PRs and starve the others.
  // Provider run metadata selects inputs; only the server reader grants proof.
  const runs=JSON.parse(gh(["run","list","--repo",repo,"--workflow","aegis-release-evidence.yml","--limit","100","--json","databaseId,headSha,headBranch,status,conclusion"]));
  for(const run of currentTakeRuns(runs,prs,config.ref,collectedRuns)) {
   await json("/api/pipeline/github/collect",{owner,repo:name,runId:run.databaseId});
   collectedRuns.add(String(run.databaseId));mark("retest_collected",{runId:run.databaseId,commit:run.headSha});
  }
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 if(!done){activeOperation="take/deadline";throw new Error("Demo timed out awaiting connected workers, human merges, and fresh collected release proof. No closure was recorded.");}
 const exported=await request(`/api/oscal/bundle?connection=${connectionId}`),bytes=new Uint8Array(await exported.arrayBuffer()),bundle=readBundleZip(bytes),verified=verifyManifest(bundle.manifest,bundle.files);
 if(verified.status!=="valid"||bundle.manifest.signing.status!=="signed")throw new Error("Configure the server manifest signer; unsigned export does not complete the demo.");
 const expectedKey=process.env.AEGIS_DEMO_EXPECTED_KEY_ID;
 if(expectedKey&&bundle.manifest.signing.keyId!==expectedKey)throw new Error("Manifest signer does not match the operator-pinned key.");
 const out=process.env.AEGIS_DEMO_EXPORT??path.join(mkdtempSync(path.join(tmpdir(),"aegis-phase4-export-")),"synthetic-evidence.zip");writeFileSync(out,bytes,{mode:0o600});mark("export_done",{path:out,signing:"signed",keyId:bundle.manifest.signing.keyId,humanClosureRequired:true,noLiveAwsApply:true});
 } finally {launched?.stop();}
}
run().catch(error=>{mark("demo_failed",{operation:activeOperation,errorType:["Error","TimeoutError","AbortError","TypeError","SyntaxError"].includes(error?.name)?error.name:"Error",...(Number.isInteger(error?.httpStatus)?{httpStatus:error.httpStatus}:{}),message:"Demo did not complete. Check docs/demo/RUNBOOK.md, configuration and authenticated app; credentials and response bodies are intentionally omitted."});process.exitCode=1;});
