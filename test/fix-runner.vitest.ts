import {beforeEach, afterEach, it, expect, vi} from "vitest";
import {mkdtempSync, rmSync, appendFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomBytes, generateKeyPairSync, createHash} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createMcpServer} from "../lib/agent/mcp-server";
import {createAgentToken} from "../lib/agent/agent-token";
import {agentAction, connectionRecords} from "../lib/agent/service";
import {Session, dropCachedSession} from "../lib/aegis/store";
import {createPullConnection, retainEvent} from "../lib/server/builder-store";
import {saveInstallation} from "../lib/github/store";
import {writeObjectOnce, readLog, appendLogComputed} from "../lib/immutable-log";
import {storageKey} from "../lib/storage-key";
import {performIssueAction} from "../lib/server/issue-actions";
import {enqueueFixes, claimFix, getFixRunner, refreshFixRunner, abandonFix, retryRejectedOpen, assertFixFiles, runnerLimit, scopesOverlap, type RunnerRecord} from "../lib/agent/fix-runner";
import {proposeFixPr, applyPrWebhook, pullRequestLinks} from "../lib/github/pull-requests";
import {publishPoamGate} from "../lib/github/poam-gate";
import {collectedProposal} from "../lib/aegis/collected-closure";
import {formReleaseEvidence} from "../lib/server/release-evidence";
import {releaseFixedControls} from "../lib/aegis/release-evidence";
import {exportConnectionBundle} from "../lib/oscal/connection-export";
import {verifyManifest} from "../lib/manifest/manifest";
import {demoEvent} from "../scripts/demo/fixtures";
import {DEMO_GAPS} from "../scripts/demo/gaps";
import {readCollectedArtifact} from "../lib/collector/read";
import type {PlanProposal} from "../lib/aegis/plan-proposal";
import type {EvidenceEvent} from "../lib/builder/evidence";
import {POST as runnerPost} from "../app/api/remediation/fix-runner/route";

const mocks=vi.hoisted(()=>({get:vi.fn(),files:vi.fn(),paginate:vi.fn(),list:vi.fn(),create:vi.fn(),checks:vi.fn(),checkWrite:vi.fn(),compare:vi.fn(),scan:vi.fn()}));
vi.mock("../lib/github/auth",()=>({
  withPrInstallation:async(_id:number,_repo:string,_cap:string,run:Function)=>run({octokit:{rest:{pulls:{get:mocks.get,listFiles:mocks.files,list:mocks.list,create:mocks.create},checks:{listForRef:mocks.checks,create:mocks.checkWrite,update:mocks.checkWrite}},paginate:mocks.paginate}}),
  withScanInstallation:async(id:number,repo:string,run:Function)=>{mocks.scan(id,repo);return run({octokit:{rest:{repos:{compareCommitsWithBasehead:mocks.compare}}}});},
}));
const g={installationId:42,owner:"carlosmsanchezm",repo:"microservices-demo"}, repository="https://github.com/"+g.owner+"/"+g.repo;
const sourceSha="a".repeat(40), ship="f".repeat(40);
let dir:string,sid:string,prStates:Map<number,{state:"open"|"closed"|"merged";head:string;merge:string;files:string[];ci:string}>,clients:Client[];
const itemIds=(n:number)=>Array.from({length:n},(_,i)=>i<5?DEMO_GAPS[i].id:DEMO_GAPS[i%5].id+"-"+i);
beforeEach(()=>{
 dir=mkdtempSync(path.join(tmpdir(),"phase4-runner-"));sid=randomBytes(16).toString("hex");clients=[];prStates=new Map();
 vi.stubEnv("AEGIS_DATA_DIR",dir);vi.stubEnv("AEGIS_FIX_RUNNER","true");vi.stubEnv("AEGIS_FIX_RUNNER_LIMIT","5");vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");vi.stubEnv("AEGIS_GITHUB_PR_WRITE","");vi.stubEnv("GITHUB_APP_ID","12345");
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-30T17:00:00Z"));
 mocks.get.mockImplementation(async({pull_number:n})=>{const p=prStates.get(n)!;if(!p)throw new Error("Unknown fixture PR");return {data:{number:n,changed_files:p.files.length,state:p.state==="open"?"open":"closed",merged:p.state==="merged",merge_commit_sha:p.state==="merged"?p.merge:null,head:{sha:p.head},base:{sha:sourceSha,repo:{full_name:g.owner+"/"+g.repo}}}};});
 mocks.paginate.mockImplementation(async(fn,args)=>fn===mocks.files?prStates.get(args.pull_number)!.files.map(filename=>({filename})):[{id:90,html_url:repository+"/actions/runs/90/job/9",name:"tests",status:"completed",conclusion:[...prStates.values()].find(p=>(p.state==="merged"?p.merge:p.head)===args.ref)?.ci??"success"}]);
 mocks.list.mockResolvedValue({data:[]});mocks.create.mockImplementation(async({head})=>({data:{number:Number(head.replace("fix-",""))}}));
 mocks.checks.mockResolvedValue({data:{check_runs:[]}});mocks.checkWrite.mockResolvedValue({data:{id:1}});
 mocks.compare.mockImplementation(async({basehead,page=1})=>{const current=basehead.split("...")[1];const commits=[...prStates.values()].filter(p=>p.state==="merged").map(p=>({sha:p.merge}));if(!commits.some(c=>c.sha===current))commits.push({sha:current});return {data:{status:"ahead",total_commits:commits.length,commits:page===1?commits:[],files:[{filename:DEMO_GAPS[0].path}]}};});
});
afterEach(async()=>{await Promise.all(clients.map(c=>c.close()));dropCachedSession(sid);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
async function collect(connectionId:string,event:EvidenceEvent){
 const b=await retainEvent(connectionId,JSON.stringify(event),undefined,"browser-owner",true);
 // Explicit test adapter only. There is no production endpoint that mints these receipts.
 await writeObjectOnce(storageKey(["collector-receipts",sid,connectionId+"-"+b.id+".json"]),{sessionId:sid,connectionId,receiptId:b.id,runId:event.run.id,commit:event.subject.revision,collectedAt:new Date().toISOString()});
 return b;
}
async function setup(n=5,overlap=false){
 const session=Session.create(sid);session.commit(session.state);await session.flush();const owner=randomBytes(32).toString("hex");
 const c=await createPullConnection("SYNTHETIC Phase 4 demo",owner,undefined,g);
 await saveInstallation("session:"+sid,{...g,accountLogin:g.owner,accountType:"User",repos:[{owner:g.owner,name:g.repo,private:true}],suspended:false,connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const event=demoEvent(repository,sourceSha,new Date(Date.now()-10000).toISOString(),"100",itemIds(n),n);
 if(overlap){const a=JSON.parse(Buffer.from(event.artifacts[1].contentBase64,"base64").toString());a.facts.find((f:any)=>f.outcome==="fail").fixPaths=[DEMO_GAPS[0].path];const {sealCollectedArtifact}=await import("../lib/collector/seal");const {createHash}=await import("node:crypto");const raw=JSON.stringify(sealCollectedArtifact(a));event.artifacts[1].contentBase64=Buffer.from(raw).toString("base64");event.artifacts[1].sha256=createHash("sha256").update(raw).digest("hex");}
 await collect(c.id,event);
 const source=(await connectionRecords({connectionId:c.id,ownerHash:c.ownerHash})).find(r=>r.artifactJobId==="100")!;
 const proposals:PlanProposal[]=[];
 for(const issue of source.reviewItems!){
  const result=await performIssueAction({sessionId:sid,connectionId:c.id,receiptId:source.releaseSha256,issueId:issue.id,actor:"agent:"+"a".repeat(32),at:new Date().toISOString(),action:"draft",draft:{risk:"Synthetic gap for a governed demonstration.",action:"Correct only the explicitly reserved synthetic target.",verification:issue.scope.verification.join(" ")}}) as {proposal:PlanProposal};proposals.push(result.proposal);
 }
 for(let i=0;i<n;i++)prStates.set(i+1,{state:"open",head:(i+1).toString(16).repeat(40),merge:(i+6).toString(16).repeat(40),files:[overlap&&i===1?DEMO_GAPS[0].path:i<5?DEMO_GAPS[i].path:`synthetic/item-${i}.py`],ci:"success"});
 return {c,owner,source,proposals};
}
async function mcp(c:string,owner:string){
 const a=await createAgentToken(c,owner,sid,["read_findings","propose_fix_pr","request_retest","request_closure_review"]);
 const server=createMcpServer(()=>a.token),client=new Client({name:"synthetic-phase4-worker",version:"1"}),[left,right]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(left),client.connect(right)]);clients.push(client);
 const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});return {error:r.isError===true,body:JSON.parse((r.content as {text:string}[])[0].text)};};
 return {a,call};
}
it("sixth item queues at five; eight in flight is configurable and bad values fail closed",async()=>{
 const s=await setup(8),r=await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 expect(r.assignments.filter(j=>j.state==="reserved")).toHaveLength(5);expect(r.assignments.filter(j=>j.waitReason==="capacity")).toHaveLength(3);
 vi.stubEnv("AEGIS_FIX_RUNNER_LIMIT","8");await refreshFixRunner(sid,s.c.id);
 expect((await getFixRunner(sid,s.c.id)).assignments.filter(j=>j.state==="reserved")).toHaveLength(8);
 vi.stubEnv("AEGIS_FIX_RUNNER_LIMIT","10oops");expect(()=>runnerLimit()).toThrow(/integer/);
},30000);
it("unchanged polling does not grow the verified runner journal, while actual configuration changes do",async()=>{
 const s=await setup(1);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 const key=storageKey(["fix-runner",createHash("sha256").update(`${g.installationId}:${g.owner.toLowerCase()}/${g.repo.toLowerCase()}`).digest("hex")])+"/";
 const before=(await readLog<RunnerRecord>(key)).length;
 vi.setSystemTime(new Date(Date.now()+1000));await refreshFixRunner(sid,s.c.id);
 vi.setSystemTime(new Date(Date.now()+1000));await refreshFixRunner(sid,s.c.id);
 expect(await readLog(key)).toHaveLength(before);
 vi.stubEnv("AEGIS_FIX_RUNNER_LIMIT","6");await refreshFixRunner(sid,s.c.id);
 expect(await readLog(key)).toHaveLength(before+1);
 expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("reserved");
});
it.each(["closed","merged"] as const)("overlap waits until authoritative PR is %s, then dispatches",async(state)=>{
 const s=await setup(2,true),r=await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));expect(r.assignments[1].waitReason).toBe("overlap");
 const job=(await claimFix(sid,s.c.id,"worker")).assignment!;await proposeFixPr(sid,s.c.id,"agent:worker",{poamItemId:job.poamItemId,runnerAssignmentId:job.id,prNumber:1});
 prStates.get(1)!.state=state;await refreshFixRunner(sid,s.c.id);
 expect((await getFixRunner(sid,s.c.id)).assignments[1].state).toBe("reserved");
},30000);
it("resource locks, directory overlap and unknown scope are conservative",()=>{
 expect(scopesOverlap({paths:["src"],resources:[]},{paths:["src/a.ts"],resources:[]})).toBe(true);
 expect(scopesOverlap({paths:["a"],resources:["arn:aws:s3:::demo"]},{paths:["b"],resources:["arn:aws:s3:::demo"]})).toBe(true);
 expect(scopesOverlap({paths:["**"],resources:[]},{paths:["b"],resources:[]})).toBe(true);
 expect(()=>assertFixFiles({paths:["a"]},["b"])).toThrow(/reserved scope/);
});
it("concurrent MCP claims are unique; agents cannot bypass queue, token ownership, human batching or file scope",async()=>{
 const s=await setup(6);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));const agent=await mcp(s.c.id,s.owner);
 const calls=await Promise.all(Array.from({length:6},()=>agent.call("claim_fix")));const jobs=calls.flatMap(r=>r.body.assignment?[r.body.assignment]:[]);expect(jobs).toHaveLength(5);expect(new Set(jobs.map(j=>j.id)).size).toBe(5);
 const queued=(await getFixRunner(sid,s.c.id)).assignments.find(j=>j.state==="queued")!;
 await expect(agentAction(agent.a.record,"propose_fix_pr",{poamItemId:queued.poamItemId,runnerAssignmentId:queued.id,prNumber:6})).rejects.toMatchObject({code:"scope"});
 await expect(proposeFixPr(sid,s.c.id,"agent:other",{poamItemId:jobs[0].poamItemId,runnerAssignmentId:jobs[0].id,prNumber:1})).rejects.toMatchObject({code:"scope"});
 await expect(proposeFixPr(sid,s.c.id,"agent:"+agent.a.record.id,{poamItemId:jobs[0].poamItemId,prNumber:1})).rejects.toThrow(/dispatched assignment/);
 const response=await runnerPost(new Request("https://binder.example/api/remediation/fix-runner",{method:"POST",headers:{authorization:"Bearer "+agent.a.token,"content-type":"application/json"},body:JSON.stringify({connectionId:s.c.id,operation:"enqueue",poamItemIds:[queued.poamItemId]})}));expect(response.status).toBe(403);
 prStates.get(1)!.files=["outside/reserved.ts"];
 await expect(proposeFixPr(sid,s.c.id,"agent:"+agent.a.record.id,{poamItemId:jobs[0].poamItemId,runnerAssignmentId:jobs[0].id,prNumber:1})).rejects.toThrow(/reserved scope/);
 await expect(abandonFix(sid,s.c.id,jobs[0].id)).rejects.toThrow(/provider PR/);
},60000);
it("compare-and-create recomputes reservations across racing writers; other sessions cannot see jobs",async()=>{
 const key=storageKey(["test-runner-race"])+"/";
 await Promise.all(Array.from({length:10},(_,i)=>appendLogComputed<{id:number;count:number}>(key,rows=>({id:i,count:(rows.at(-1)?.body.count??0)+1}),b=>b.id===i)));
 expect((await readLog<{count:number}>(key)).at(-1)?.body.count).toBe(10);
 const s=await setup(2);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));expect((await getFixRunner("b".repeat(32),s.c.id)).assignments).toHaveLength(0);
},30000);
it("explicit scope survives whitelist/seal and rejects traversal or malformed resources",()=>{
 const event=demoEvent(repository,sourceSha,new Date().toISOString(),"100");const a=JSON.parse(Buffer.from(event.artifacts[0].contentBase64,"base64").toString());
 expect(readCollectedArtifact(a)!.facts.find(f=>f.outcome==="fail")!.fixPaths).toEqual([DEMO_GAPS[0].path]);
 a.facts.find((f:any)=>f.outcome==="fail").fixPaths=["../outside"];expect(()=>readCollectedArtifact(a)).toThrow(/path scope/);
});
it("fixture demo: MCP fans out five, gates until collected head retests, release tiles green, signed export; closure remains human",async()=>{
 const stages:{stage:string;at:string;mode:string}[]=[];const mark=(stage:string)=>{const row={stage,at:new Date(vi.getRealSystemTime()).toISOString(),mode:"SYNTHETIC FIXTURE — isolated test adapters"};stages.push(row);if(process.env.AEGIS_PHASE4_TRANSCRIPT)appendFileSync(process.env.AEGIS_PHASE4_TRANSCRIPT,JSON.stringify(row)+"\n");};
 mark("wall_clock_start");const s=await setup();mark("connected");expect(s.source.reviewItems).toHaveLength(5);mark("scan_done_map_red");
 await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));mark("fan_out_5");const a=await mcp(s.c.id,s.owner);
 const jobs=[];for(let i=0;i<5;i++){const r=await a.call("claim_fix");expect(r.error).toBe(false);jobs.push(r.body.assignment);}
 for(let i=0;i<5;i++){const r=await a.call("propose_fix_pr",{poamItemId:jobs[i].poamItemId,runnerAssignmentId:jobs[i].id,prNumber:i+1});expect(r.error).toBe(false);if(i===0)mark("first_pr_open");}
 vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
 for(let i=0;i<5;i++)expect((await publishPoamGate(g,i+1))!.conclusion).toBe("failure");mark("all_prs_gated");
 for(let i=0;i<5;i++){
  vi.setSystemTime(new Date(Date.now()+1000));await collect(s.c.id,demoEvent(repository,prStates.get(i+1)!.head,new Date().toISOString(),String(200+i),[]));
  expect((await publishPoamGate(g,i+1))!.conclusion).toBe("success");
 }
 mark("all_head_retests_green");
 // Human/provider merges are simulated by the provider adapter, never by MCP or Aegis.
 for(let i=0;i<5;i++){prStates.get(i+1)!.state="merged";await applyPrWebhook("pull_request",{installation:{id:42},repository:{owner:{login:g.owner},name:g.repo},pull_request:{number:i+1}});}
 vi.setSystemTime(new Date(Date.now()+1000));await collect(s.c.id,demoEvent(repository,ship,new Date().toISOString(),"300",[]));
 const bundle=(await formReleaseEvidence(sid,s.c.id))!;expect(bundle.rangeStatus).toBe("verified");expect(bundle.items).toHaveLength(5);expect(bundle.items.every(i=>i.retestResult==="pass")).toBe(true);
 expect(releaseFixedControls(bundle).size).toBeGreaterThan(0);await refreshFixRunner(sid,s.c.id);mark("all_release_retests_green_tiles_green");
 const runner=await getFixRunner(sid,s.c.id);expect(runner.assignments.every(j=>j.readyForClosureReview)).toBe(true);
 for(const p of s.proposals){const ready=await collectedProposal(sid,p,s.c.id);expect(ready.workflowState).toBe("ready-for-closure-review");expect(ready.closureConfirmed).toBe(false);expect(ready.acceptance).toBe("proposed");}
 mark("release_evidence_ready");const keys=generateKeyPairSync("ed25519");vi.stubEnv("AEGIS_MANIFEST_SIGNING_KEY",Buffer.from(keys.privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"));vi.stubEnv("AEGIS_MANIFEST_PUBLIC_KEY",Buffer.from(keys.publicKey.export({type:"spki",format:"pem"})).toString("base64"));
 const exported=await exportConnectionBundle(s.c.id,sid);expect(exported.manifest.signing.status).toBe("signed");expect(verifyManifest(exported.manifest,exported.files).status).toBe("valid");mark("export_done");
 if(process.env.AEGIS_PHASE4_REPORT){const artifactPath=path.join(path.dirname(process.env.AEGIS_PHASE4_REPORT),"synthetic-signed-evidence.zip");writeFileSync(artifactPath,exported.bytes,{mode:0o600});writeFileSync(process.env.AEGIS_PHASE4_REPORT,JSON.stringify({artifactPath,synthetic:true,noLiveAwsApply:true,humanClosureRequired:true,stages,items:bundle.items.length,signing:exported.manifest.signing.status},null,2));}
 expect(await pullRequestLinks(sid,s.c.id)).toHaveLength(5);
},120000);
it("stopwatch follows the latest batch and current release proof, including invalidation",async()=>{
 const s=await setup(2);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 const {fixProgress}=await import("../lib/aegis/fix-progress"),jobs=(await getFixRunner(sid,s.c.id)).assignments.map((j,i)=>({...j,prNumber:i+1}));
 expect(fixProgress(jobs,[])?.finishedAt).toBeNull();
 const release:any={rangeStatus:"verified",releaseSha256:"a".repeat(64),collectedAt:new Date().toISOString(),items:jobs.map(j=>({poamItemId:j.poamItemId,prNumber:j.prNumber,retestResult:"pass",retestReceiptId:"a".repeat(64)}))};
 expect(fixProgress(jobs,[release])?.verified).toBe(2);expect(fixProgress(jobs,[release])?.finishedAt).toBe(release.collectedAt);
 expect(fixProgress(jobs,[release,{...release,rangeStatus:"unverified"}])?.finishedAt).toBeNull();
 expect(fixProgress([],[])).toBeNull();
},30000);
it("cloud stopwatch requires the separately retained passing proof on the same commit and uses its later time",async()=>{
 const s=await setup(1);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 const {fixProgress}=await import("../lib/aegis/fix-progress"),{AWS_DEPLOYMENT_PRODUCER}=await import("../lib/collector/aws/deployment-criteria");
 const jobs=(await getFixRunner(sid,s.c.id)).assignments.map(j=>({...j,prNumber:8}));
 const capturedAt=new Date(Date.now()+1_000).toISOString(),receipt="b".repeat(64),commit="c".repeat(40);
 const release:any={rangeStatus:"verified",releaseSha256:"a".repeat(64),commitSha:commit,collectedAt:new Date().toISOString(),items:[{poamItemId:jobs[0].poamItemId,prNumber:8,retestResult:"pass",retestReceiptId:receipt}]};
 const cloud:any={releaseSha256:receipt,commitSha:commit,createdAt:capturedAt,observation:{producer:AWS_DEPLOYMENT_PRODUCER,checks:[{verdict:"pass",validUntil:new Date(Date.now()+60_000).toISOString()}]}};
 expect(fixProgress(jobs,[release])?.verified).toBe(0);
 expect(fixProgress(jobs,[release],[cloud])).toMatchObject({verified:1,finishedAt:capturedAt});
 for(const bad of [{...cloud,commitSha:"d".repeat(40)},{...cloud,releaseSha256:"e".repeat(64)},{...cloud,createdAt:new Date(Date.now()-1).toISOString()},{...cloud,observation:{...cloud.observation,producer:"GitHub Actions"}},{...cloud,observation:{...cloud.observation,checks:[{verdict:"unknown",validUntil:capturedAt}]}},{...cloud,observation:{...cloud.observation,checks:[{verdict:"pass",validUntil:new Date(Date.now()-1).toISOString()}]}}])expect(fixProgress(jobs,[release],[bad])).toMatchObject({verified:0,finishedAt:null});
 expect(fixProgress(jobs,[{...release,rangeStatus:"unverified"}],[cloud])?.finishedAt).toBeNull();
 expect(fixProgress(jobs,[{...release,items:[{...release.items[0],retestResult:"unverified"}]}],[cloud])?.finishedAt).toBeNull();
},30000);
it("runner requires the existing gate, preflights open-PR scope, and retains uncertain locks",async()=>{
 const s=await setup(1);vi.stubEnv("AEGIS_GITHUB_POAM_GATE","");await expect(enqueueFixes(sid,s.c.id,[s.proposals[0].id])).rejects.toThrow(/Enable the POA&M gate/);
 vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");await enqueueFixes(sid,s.c.id,[s.proposals[0].id]);const job=(await claimFix(sid,s.c.id,"worker")).assignment!;
 vi.stubEnv("AEGIS_GITHUB_PR_WRITE","true");mocks.compare.mockResolvedValue({data:{status:"ahead",files:[{filename:"outside/scope.ts"}]}});
 await expect(proposeFixPr(sid,s.c.id,"agent:worker",{poamItemId:job.poamItemId,runnerAssignmentId:job.id,operation:"open",head:"fix-1",base:"main",title:"Correct synthetic gap"})).rejects.toThrow(/reserved scope/);expect(mocks.create).not.toHaveBeenCalled();
 expect(mocks.scan).toHaveBeenCalledWith(g.installationId,g.repo);
 expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("proposing");
 await expect(abandonFix(sid,s.c.id,job.id)).rejects.toThrow(/provider PR/);
 // Registration is the safe recovery path; it does not create a second PR or discard the lock.
 await proposeFixPr(sid,s.c.id,"agent:worker",{poamItemId:job.poamItemId,runnerAssignmentId:job.id,prNumber:1});
 expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("pr-open");
},30000);
it("two connection batches for the same repository share reservations without exposing each other's jobs",async()=>{
 const s=await setup(2),second=await setup(2);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 const queued=await enqueueFixes(sid,second.c.id,second.proposals.map(p=>p.id));expect(queued.assignments.every(j=>j.waitReason==="overlap")).toBe(true);expect(queued.assignments).toHaveLength(2);
 expect((await getFixRunner(sid,s.c.id)).assignments).toHaveLength(2);
},30000);
it("concurrent disjoint enqueue batches cannot reserve more than the shared cap",async()=>{
 const s=await setup(8);
 await Promise.all([enqueueFixes(sid,s.c.id,s.proposals.slice(0,4).map(p=>p.id)),enqueueFixes(sid,s.c.id,s.proposals.slice(4).map(p=>p.id))]);
 const jobs=(await getFixRunner(sid,s.c.id)).assignments;
 expect(jobs).toHaveLength(8);expect(jobs.filter(j=>j.state==="reserved")).toHaveLength(5);expect(jobs.filter(j=>j.state==="queued")).toHaveLength(3);
},30000);
it("a lost PR projection can register the same reserved PR after the journal attachment",async()=>{
 const s=await setup(1);await enqueueFixes(sid,s.c.id,[s.proposals[0].id]);const job=(await claimFix(sid,s.c.id,"worker")).assignment!;
 const store=await import("../lib/aegis/remediation-store"),write=vi.spyOn(store,"updateRemediationRecord").mockRejectedValueOnce(new Error("Simulated projection write unavailable"));
 await expect(proposeFixPr(sid,s.c.id,"agent:worker",{poamItemId:job.poamItemId,runnerAssignmentId:job.id,prNumber:1})).rejects.toThrow(/projection write/);write.mockRestore();
 expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("pr-open");expect(await pullRequestLinks(sid,s.c.id)).toHaveLength(0);
 await proposeFixPr(sid,s.c.id,"agent:worker",{poamItemId:job.poamItemId,runnerAssignmentId:job.id,prNumber:1});expect(await pullRequestLinks(sid,s.c.id)).toHaveLength(1);
},30000);
it("lease expiry releases queued overlap atomically and stale workers cannot propose",async()=>{
 const s=await setup(2,true);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));
 const old=(await claimFix(sid,s.c.id,"old-worker")).assignment!;
 vi.setSystemTime(new Date(Date.now()+901000));
 const next=await getFixRunner(sid,s.c.id);
 expect(next.assignments[0].state).toBe("expired");expect(next.assignments[1].state).toBe("reserved");
 await expect(proposeFixPr(sid,s.c.id,"agent:old-worker",{poamItemId:old.poamItemId,runnerAssignmentId:old.id,prNumber:1})).rejects.toThrow(/assignment|queued/);
 const results=await Promise.all([claimFix(sid,s.c.id,"new-a"),claimFix(sid,s.c.id,"new-b")]);expect(results.filter(r=>r.assignment)).toHaveLength(1);
},30000);
it("only owning progress renews a lease; reads do not renew and uncertain provider ops never expire",async()=>{
 const {renewFix,reserveFixProposal}=await import("../lib/agent/fix-runner");
 const s=await setup(2,true);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));const job=(await claimFix(sid,s.c.id,"owner")).assignment!;
 vi.setSystemTime(new Date(Date.now()+800000));
 await expect(renewFix(sid,s.c.id,"other",job.id)).rejects.toThrow(/claiming worker/);
 await renewFix(sid,s.c.id,"owner",job.id);
 vi.setSystemTime(new Date(Date.now()+800000));expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("claimed");
 await reserveFixProposal(sid,s.c.id,"agent:owner",job.poamItemId,job.id);
 vi.setSystemTime(new Date(Date.now()+10000000));const held=await getFixRunner(sid,s.c.id);expect(held.assignments[0].state).toBe("proposing");expect(held.assignments[1].waitReason).toBe("overlap");
},30000);
it("abandon before PR remains available with leases and releases the queued scope",async()=>{
 const s=await setup(2,true);await enqueueFixes(sid,s.c.id,s.proposals.map(p=>p.id));const job=(await claimFix(sid,s.c.id,"owner")).assignment!;
 const result=await abandonFix(sid,s.c.id,job.id);expect(result.assignments[0].state).toBe("abandoned");expect(result.assignments[1].state).toBe("reserved");
},30000);
it("owner recovery requires a retained definitive rejection and official absence of any matching provider PR",async()=>{
 const s=await setup(1),tokenId="a".repeat(32);await enqueueFixes(sid,s.c.id,[s.proposals[0].id]);const job=(await claimFix(sid,s.c.id,tokenId)).assignment!;
 vi.stubEnv("AEGIS_GITHUB_PR_WRITE","true");const {GithubRequestError}=await import("../lib/github/config");
 mocks.create.mockRejectedValue(new GithubRequestError(422));
 await expect(proposeFixPr(sid,s.c.id,"agent:"+tokenId,{poamItemId:job.poamItemId,runnerAssignmentId:job.id,operation:"open",head:"fix-1",base:"main",title:"Correct synthetic gap"})).rejects.toThrow(/422/);
 await expect(retryRejectedOpen(sid,s.c.id,job.id)).rejects.toThrow(/retained definitive/);
 const {appendAgentActivity}=await import("../lib/agent/audit");
 const activity={tokenId,tool:"propose_fix_pr",inputs:{runnerAssignmentId:job.id,operation:"open",head:"fix-1",base:"main"},result:"error",refusalCode:"operation_failed" as const};
 await appendAgentActivity(s.c.id,{...activity,refusalReason:"GitHub request failed with HTTP 500."});
 await expect(retryRejectedOpen(sid,s.c.id,job.id)).rejects.toThrow(/uncertain/);
 await appendAgentActivity(s.c.id,{...activity,refusalReason:"GitHub request failed with HTTP 422."});
 mocks.list.mockResolvedValue({data:[{number:7}]});await expect(retryRejectedOpen(sid,s.c.id,job.id)).rejects.toThrow(/provider PR exists/);
 expect((await getFixRunner(sid,s.c.id)).assignments[0].state).toBe("proposing");
 mocks.list.mockResolvedValue({data:[]});const recovered=await retryRejectedOpen(sid,s.c.id,job.id);
 expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({head:g.owner+":fix-1",base:"main",state:"all",per_page:1}));
 expect(recovered.assignments[0]).toMatchObject({state:"claimed",tokenId});expect(recovered.assignments[0].prNumber).toBeUndefined();
 await expect(retryRejectedOpen(sid,s.c.id,job.id)).rejects.toThrow(/Only a rejected/);
},30000);
