import {beforeEach, afterEach, it, expect, vi} from "vitest";
import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomBytes, createHmac} from "node:crypto";
import {Session, dropCachedSession} from "../lib/aegis/store";
import {createPullConnection, retainEvent, sha256} from "../lib/server/builder-store";
import {saveInstallation} from "../lib/github/store";
import {appendLog,writeObjectOnce} from "../lib/immutable-log";
import {storageKey} from "../lib/storage-key";
import {connectionRecords, agentAction} from "../lib/agent/service";
import {performIssueAction} from "../lib/server/issue-actions";
import {createAgentToken} from "../lib/agent/agent-token";
import {proposeFixPr, pullRequestLinks, applyPrWebhook, prRecordKey} from "../lib/github/pull-requests";
import {collectedScannerProof, collectedProposal} from "../lib/aegis/collected-closure";
import {readRemediation, writeRemediationRecord} from "../lib/aegis/remediation-store";
import {queryTimeline} from "../lib/timeline/store";
import {receiveGithubWebhook} from "../lib/github/connect";
import {POST as linkPost} from "../app/api/remediation/pull-requests/route";
import {POST as collectPost} from "../app/api/pipeline/github/collect/route";
import * as trusted from "../lib/collector/trusted-release";
import * as githubClient from "../lib/github/client";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
const mocks = vi.hoisted(() => ({get: vi.fn(), paginate: vi.fn(), create: vi.fn(), list: vi.fn(), listFiles: vi.fn(), checksList: vi.fn(), checksCreate: vi.fn(), checksUpdate: vi.fn()}));
vi.mock("../lib/github/auth", () => ({withPrInstallation: async (_id: number, _repo: string, _cap: string, run: Function) => run({octokit:{rest:{pulls:{get:mocks.get, create:mocks.create, list:mocks.list,listFiles:mocks.listFiles},checks:{listForRef:mocks.checksList,create:mocks.checksCreate,update:mocks.checksUpdate}},paginate:mocks.paginate}})}));
let folder: string, sid: string;
const g = {installationId: 42, owner:"carlosmsanchezm", repo:"microservices-demo"};
const repoUrl = `https://github.com/${g.owner}/${g.repo}`;
let state: "open"|"merged"|"closed", ci: string, head: string, merged: string;
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "pr-loop-")); sid = randomBytes(16).toString("hex");
  vi.stubEnv("AEGIS_DATA_DIR",folder); vi.stubEnv("AEGIS_GITHUB_PR_WRITE","");vi.stubEnv("AEGIS_GITHUB_POAM_GATE","");vi.stubEnv("AEGIS_GITHUB_BREAK_GLASS_USERS","");vi.stubEnv("AEGIS_GITHUB_CONTROLLED_PATHS","**");
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
  state="open";ci="success";head=retest.subject.revision;merged=retest.subject.revision;
  mocks.get.mockImplementation(async()=>({data:{number:7,changed_files:1,state:state==="open"?"open":"closed",merged:state==="merged",merge_commit_sha:state==="merged"?merged:null,head:{sha:head},base:{sha:original.subject.revision,repo:{full_name:`${g.owner}/${g.repo}`}}}}));
  mocks.paginate.mockImplementation(async(fn)=>fn===mocks.listFiles?[{filename:"src/control.ts"}]:[{name:"tests", status:ci==="pending"?"in_progress":"completed", conclusion:ci}]);
  mocks.checksList.mockResolvedValue({data:{check_runs:[]}});mocks.checksCreate.mockResolvedValue({data:{id:1}});
  mocks.create.mockResolvedValue({data:{number:7}}); mocks.list.mockResolvedValue({data:[]});
});
afterEach(()=>{dropCachedSession(sid);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(folder,{recursive:true,force:true});});
async function setup() {
  const session=Session.create(sid);session.commit(session.state);await session.flush();
  const owner=randomBytes(32).toString("hex"), connection=await createPullConnection("Online Boutique",owner,undefined,g);
  await saveInstallation(`session:${sid}`,{...g,accountLogin:g.owner,accountType:"User",repos:[{owner:g.owner,name:g.repo,private:true}],suspended:false,connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await collect(connection.id,original);
  const records=await connectionRecords({connectionId:connection.id,ownerHash:connection.ownerHash});
  const source=records.find(r=>r.artifactJobId===original.run.id)!,issue=source.reviewItems!.find(i=>/frontend.*KSV-0020|KSV-0020.*frontend/.test(i.description))!;
  const result=await performIssueAction({connectionId:connection.id,sessionId:sid,receiptId:source.releaseSha256,issueId:issue.id,actor:"agent:"+"a".repeat(32),at:new Date().toISOString(),action:"draft",draft:{risk:"Unrestricted workload",action:"Set a nonroot identity",verification:"Collect a full corrected scan"}}) as {proposal: import("../lib/aegis/plan-proposal").PlanProposal};
  return {owner,connection,source,issue,p:result.proposal};
}
async function collect(connectionId: string,event: typeof original) {
  const b=await retainEvent(connectionId,JSON.stringify(event),undefined,"browser-owner",true);
  await writeObjectOnce(storageKey(["collector-receipts",sid,connectionId+"-"+b.id+".json"]),{sessionId:sid,connectionId,receiptId:b.id,runId:event.run.id,commit:event.subject.revision,collectedAt:new Date().toISOString()});
}
const payload = ()=>({installation:{id:42},repository:{name:g.repo,owner:{login:g.owner}},pull_request:{number:7}});
it("registers a durable server-owned PR and emits shared collector artifacts, mappings and audit",async()=>{
  const s=await setup();const result=await proposeFixPr(sid,s.connection.id,"agent:unit-agent",{poamItemId:s.p.id,prNumber:7});
  expect(result.pullRequest.prUrl).toBe(repoUrl+"/pull/7");expect(await pullRequestLinks(sid,s.connection.id)).toHaveLength(1);
  expect((await queryTimeline(s.connection.id)).some(x=>x.body.reason_code==="fix_pr_register")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/tokenHash|ownerHash|PRIVATE KEY|ghs_/);
  expect((await connectionRecords({connectionId:s.connection.id,ownerHash:s.connection.ownerHash})).some(r=>r.collectedArtifacts?.some(a=>a.facts.some(f=>f.key==="change-control")))).toBe(true);
});
it("rejects cross connection, repository URLs, mutation operations, duplicate and merged replacement",async()=>{
  const s=await setup(); const other=await createPullConnection("Other",s.owner,undefined,g);
  await expect(proposeFixPr(sid,other.id,"agent:a",{poamItemId:s.p.id,prNumber:7})).rejects.toThrow(/open retained/);
  await expect(proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prUrl:"https://github.com/other/repo/pull/7"})).rejects.toThrow(/connected repository/);
  await expect(proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,operation:"merge",prNumber:7})).rejects.toThrow(/register or open/);
  state="merged";await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  await expect(proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:8})).rejects.toThrow(/cannot be replaced/);
});
it("requires propose_fix_pr through service and HTTP and refuses writes by default",async()=>{
  const s=await setup();const agent=await createAgentToken(s.connection.id,s.owner,sid,["read_findings"]);
  await expect(agentAction(agent.record,"propose_fix_pr",{poamItemId:s.p.id,prNumber:7})).rejects.toMatchObject({code:"scope"});
  const request=new Request("https://binder.example/api/remediation/pull-requests",{method:"POST",headers:{authorization:`Bearer ${agent.token}`,"content-type":"application/json"},body:JSON.stringify({connectionId:s.connection.id,poamItemId:s.p.id,prNumber:7})});
  expect((await linkPost(request)).status).toBe(403);
  await expect(proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,operation:"open",head:"fix",base:"main",title:"Correct workload"})).rejects.toThrow(/disabled/);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("opt-in opens only a PR on existing branches and records its link",async()=>{
  const s=await setup();vi.stubEnv("AEGIS_GITHUB_PR_WRITE","true");
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,operation:"open",head:"fix",base:"main",title:"Correct workload"});
  expect(mocks.create).toHaveBeenCalledOnce();expect((await pullRequestLinks(sid,s.connection.id))[0].state).toBe("open");
});
it("signed webhook refreshes authoritative PR and CI state; unrelated repos are ignored",async()=>{
  const s=await setup();await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  vi.spyOn(githubClient,"verifyWebhook").mockImplementation(async(body,sig)=>sig===`sha256=${createHmac("sha256","test-secret").update(body).digest("hex")}`);
  state="merged";ci="failure";
  const body=JSON.stringify(payload());const req=new Request("https://binder.example/api/github/webhook",{method:"POST",headers:{"x-github-event":"pull_request","x-hub-signature-256":`sha256=${createHmac("sha256","test-secret").update(body).digest("hex")}`},body});
  expect((await receiveGithubWebhook(req)).status).toBe(200);
  const link=(await pullRequestLinks(sid,s.connection.id))[0];expect(link.state).toBe("merged");expect(link.ciStatus.state).toBe("failure");
  ci="success";await applyPrWebhook("check_run",payload());expect((await pullRequestLinks(sid,s.connection.id))[0].ciStatus.state).toBe("success");
  mocks.get.mockClear();await applyPrWebhook("pull_request",{...payload(),repository:{name:"unconnected",owner:{login:g.owner}}});expect(mocks.get).not.toHaveBeenCalled();
  vi.stubEnv("GITHUB_APP_ID","12345");vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
  const self={...payload(),check_suite:{app:{id:12345},head_sha:head},check_run:{name:"aegis/poam-gate",app:{id:12345},head_sha:head}};
  const {poamGateWebhook}=await import("../lib/github/poam-gate");
  for(const event of ["check_suite","check_run"]){await applyPrWebhook(event,self);await poamGateWebhook(event,self);}
  expect(mocks.get).not.toHaveBeenCalled();expect(mocks.checksCreate).not.toHaveBeenCalled();
  await expect(receiveGithubWebhook(new Request("https://binder.example",{method:"POST",body}))).rejects.toMatchObject({status:401});
  await expect(receiveGithubWebhook(new Request("https://binder.example",{method:"POST",body:"x".repeat(1_000_001)}))).rejects.toMatchObject({status:413});
});
it("binds readiness to merged CI and exact collected commit, never confirms closure",async()=>{
  const s=await setup();await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  await collect(s.connection.id,retest);
  expect((await collectedScannerProof(sid,s.source.pipelineId,s.issue.id,s.connection.id)).ready).toBe(false);
  state="merged";merged="e".repeat(40);await applyPrWebhook("pull_request",payload());
  expect((await collectedScannerProof(sid,s.source.pipelineId,s.issue.id,s.connection.id)).ready).toBe(false);
  merged=retest.subject.revision;
  await expect(applyPrWebhook("pull_request",payload())).rejects.toThrow(/identity cannot change/);
});
it("refreshes CI freshness without duplicating unchanged facts, but retains state transitions",async()=>{
  const s=await setup();await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  const before=await queryTimeline(s.connection.id);
  const records=await connectionRecords({connectionId:s.connection.id,ownerHash:s.connection.ownerHash});
  vi.setSystemTime(new Date("2026-10-27T04:01:00Z"));
  await applyPrWebhook("check_suite",payload());
  expect((await pullRequestLinks(sid,s.connection.id))[0].ciStatus.checkedAt).toBe("2026-10-27T04:01:00.000Z");
  expect(await queryTimeline(s.connection.id)).toHaveLength(before.length);
  expect(await connectionRecords({connectionId:s.connection.id,ownerHash:s.connection.ownerHash})).toHaveLength(records.length);
  ci="failure";await applyPrWebhook("check_suite",payload());
  expect((await pullRequestLinks(sid,s.connection.id))[0].ciStatus.state).toBe("failure");
  expect((await queryTimeline(s.connection.id)).filter(x=>x.body.reason_code==="fix_pr_refresh")).toHaveLength(1);
  ci="success";await applyPrWebhook("check_suite",payload());
  expect((await queryTimeline(s.connection.id)).filter(x=>x.body.reason_code==="fix_pr_refresh")).toHaveLength(2);
  head="f".repeat(40);await applyPrWebhook("pull_request",payload());
  expect((await queryTimeline(s.connection.id)).filter(x=>x.body.reason_code==="fix_pr_refresh")).toHaveLength(3);
});
it("merged CI and collected retest yield review readiness without acceptance or closure", async()=>{
  const t=await setup();state="merged";
  await proposeFixPr(sid,t.connection.id,"agent:a",{poamItemId:t.p.id,prNumber:7});await collect(t.connection.id,retest);
  const proof=await collectedScannerProof(sid,t.source.pipelineId,t.issue.id,t.connection.id);expect(proof.ready).toBe(true);
  const p=await collectedProposal(sid,t.p,t.connection.id);expect(p.workflowState).toBe("ready-for-closure-review");expect(p.closureConfirmed).toBe(false);expect(p.acceptance).toBe("proposed");
  ci="failure";await applyPrWebhook("check_run",payload());expect((await collectedScannerProof(sid,t.source.pipelineId,t.issue.id,t.connection.id)).ready).toBe(false);
});
it("legacy saves cannot forge or erase server-owned PR links",async()=>{
  const s=await setup();await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  const record=(await readRemediation(sid))!.records.find(r=>r.key===prRecordKey(s.connection.id))!;
  await writeRemediationRecord(sid,{...record,pullRequests:[]});expect(await pullRequestLinks(sid,s.connection.id)).toHaveLength(1);
});
it.each(["microservices-demo","other-connected","r".repeat(100)])("collect accepts connected %s with owner/workspace checks",async(repo)=>{
  const s=await setup(); await saveInstallation(`session:${sid}`,{installationId:42,accountLogin:g.owner,accountType:"User",repos:[{owner:g.owner,name:repo,private:true}],suspended:false,connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const collectSpy=vi.spyOn(trusted,"collectAndRetainRelease").mockResolvedValue({id:"a".repeat(64),event:original} as never);
  vi.spyOn(githubClient,"scanPinnedRepository").mockResolvedValue({source:{repo:repoUrl,commit:head,capturedAt:new Date().toISOString()},artifacts:[],events:[],excluded:[]} as never);
  const req=(name:string)=>new Request("https://binder.example/api/pipeline/github/collect",{method:"POST",headers:{cookie:`aegis_sid=${sid}; aegis_builder_owner=${s.owner}`,"content-type":"application/json"},body:JSON.stringify({owner:g.owner,repo:name})});
  expect((await collectPost(req(repo))).status).toBe(200);expect(collectSpy).toHaveBeenCalledOnce();expect(collectSpy.mock.calls[0][2]).toMatchObject({owner:g.owner,repo});
  expect((await collectPost(req("unconnected"))).status).toBe(403);
});

it("scoped HTTP registration returns a link and records authenticated agent intent/outcome",async()=>{
  const s=await setup();const a=await createAgentToken(s.connection.id,s.owner,sid,["propose_fix_pr"]);
  const response=await linkPost(new Request("https://binder.example/api/remediation/pull-requests",{method:"POST",headers:{authorization:`Bearer ${a.token}`,"content-type":"application/json"},body:JSON.stringify({connectionId:s.connection.id,poamItemId:s.p.id,prNumber:7,state:"merged",closureConfirmed:true})}));
  expect(response.status).toBe(200);const body=await response.json();expect(body.pullRequest.state).toBe("open");expect(body.closureConfirmed).toBe(false);
  const {getAgentActivity}=await import("../lib/agent/audit");expect((await getAgentActivity(s.connection.id)).some(x=>x.body.tool==="propose_fix_pr"&&x.body.result==="recorded")).toBe(true);
});

it.each([
  [{controlled:false,linked:false,ciGreen:false,retestReady:false,override:false},"success"],
  [{controlled:true,linked:false,ciGreen:true,retestReady:true,override:false},"failure"],
  [{controlled:true,linked:true,ciGreen:false,retestReady:true,override:false},"failure"],
  [{controlled:true,linked:true,ciGreen:true,retestReady:false,override:false},"failure"],
  [{controlled:true,linked:true,ciGreen:true,retestReady:true,override:false},"success"],
  [{controlled:true,linked:false,ciGreen:false,retestReady:false,override:true},"success"],
])("gate decision matrix %j",async(input,expected)=>{
  const {gateDecision}=await import("../lib/github/poam-gate");expect(gateDecision(input).conclusion).toBe(expected);
});
it("posts a failing required check for unlinked controlled paths, and passes only with head CI plus collected retest",async()=>{
  const s=await setup();vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
  const {publishPoamGate}=await import("../lib/github/poam-gate");
  expect((await publishPoamGate(g,7))?.conclusion).toBe("failure");expect(mocks.checksCreate).toHaveBeenLastCalledWith(expect.objectContaining({name:"aegis/poam-gate",head_sha:head,conclusion:"failure"}));
  mocks.checksCreate.mockClear();
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  expect(mocks.checksCreate).toHaveBeenLastCalledWith(expect.objectContaining({name:"aegis/poam-gate",conclusion:"failure"}));
  expect((await publishPoamGate(g,7))?.conclusion).toBe("failure");
  await collect(s.connection.id,retest);
  expect((await publishPoamGate(g,7))?.conclusion).toBe("success");
  expect((await collectedProposal(sid,s.p,s.connection.id)).readyToClose).toBe(false);
  ci="failure";expect((await publishPoamGate(g,7))?.conclusion).toBe("failure");
  expect((await readRemediation(sid))!.records.flatMap(r=>r.issueDrafts??[]).every(p=>!(p as {closureConfirmed?:boolean}).closureConfirmed)).toBe(true);
});
it("gate fails closed on incomplete file inventory and literal path prefixes include renames",async()=>{
  const s=await setup();vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");const {publishPoamGate,touchesControlledPaths}=await import("../lib/github/poam-gate");
  vi.stubEnv("AEGIS_GITHUB_CONTROLLED_PATHS","infra,src/controlled");expect(touchesControlledPaths(["infrastructure/other.ts"])).toBe(false);expect(touchesControlledPaths(["infra/main.tf"])).toBe(true);
  mocks.paginate.mockImplementation(async fn=>fn===mocks.listFiles?[]:[{name:"tests",status:"completed",conclusion:"success"}]);
  await expect(publishPoamGate(g,7)).rejects.toThrow(/complete file inventory/);expect(mocks.checksCreate).toHaveBeenLastCalledWith(expect.objectContaining({status:"in_progress"}));
});
it("re-evaluates and writes repeated gates while retaining only changed decisions",async()=>{
  const s=await setup();await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});await collect(s.connection.id,retest);
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");const {publishPoamGate}=await import("../lib/github/poam-gate");
  expect((await publishPoamGate(g,7))?.conclusion).toBe("success");
  const before=await queryTimeline(s.connection.id),writes=mocks.checksCreate.mock.calls.length;
  vi.setSystemTime(new Date("2026-10-27T04:01:00Z"));
  expect((await publishPoamGate(g,7))?.conclusion).toBe("success");
  expect(mocks.checksCreate.mock.calls.length).toBeGreaterThan(writes);
  expect(await queryTimeline(s.connection.id)).toHaveLength(before.length);
  ci="failure";expect((await publishPoamGate(g,7))?.conclusion).toBe("failure");
  ci="success";expect((await publishPoamGate(g,7))?.conclusion).toBe("success");
  const decisions=(await queryTimeline(s.connection.id)).filter(x=>x.body.reason_code==="poam_gate_evaluated");
  expect(decisions.map(x=>x.body.summary.conclusion)).toEqual(["success","failure","success"]);
});
it("an unrelated proposal closure read cannot block the linked item's exact-head gate",async()=>{
  const s=await setup();
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  const unrelated=s.source.reviewItems!.find(issue=>issue.id!==s.issue.id)!;
  await performIssueAction({connectionId:s.connection.id,sessionId:sid,receiptId:s.source.releaseSha256,
    issueId:unrelated.id,actor:"agent:"+"b".repeat(32),at:new Date().toISOString(),action:"draft",
    draft:{risk:"Independent configuration risk",action:"Correct its scoped configuration",verification:"Collect a corrected native scan"}});
  const closure=await import("../lib/aegis/collected-closure"),compute=closure.collectedProposal;
  vi.spyOn(closure,"collectedProposal").mockImplementation(async(session,proposal,connection)=>{
    if(proposal.id!==s.p.id)throw new Error("Unrelated closure read unavailable.");
    return compute(session,proposal,connection);
  });
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
  const {publishPoamGate}=await import("../lib/github/poam-gate");
  expect(await publishPoamGate(g,7)).toMatchObject({conclusion:"failure",reason:"A fresh server-collected retest on the current PR head is required."});
  await collect(s.connection.id,retest);
  expect(await publishPoamGate(g,7)).toMatchObject({conclusion:"success",reason:"Linked POA&M, current-head CI and server-collected retest verified. Human closure remains required."});
});
it("reconciles multiple linked PRs once before independently evaluating their gates",async()=>{
  const s=await setup();
  mocks.get.mockImplementation(async({pull_number:number})=>({data:{number,changed_files:1,state:"open",merged:false,head:{sha:head},base:{sha:original.subject.revision,repo:{full_name:`${g.owner}/${g.repo}`}}}}));
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  const issue=s.source.reviewItems!.find(i=>i.id!==s.issue.id)!;
  const second=await performIssueAction({connectionId:s.connection.id,sessionId:sid,receiptId:s.source.releaseSha256,issueId:issue.id,actor:"agent:"+"b".repeat(32),at:new Date().toISOString(),action:"draft",draft:{risk:"Configuration risk",action:"Correct the scoped configuration",verification:"Collect a corrected native scan"}}) as {proposal:{id:string}};
  await proposeFixPr(sid,s.connection.id,"agent:b",{poamItemId:second.proposal.id,prNumber:8});
  const retestModule=await import("../lib/agent/retest"),runner=await import("../lib/agent/fix-runner");
  const retests=vi.spyOn(retestModule,"satisfyCollectedRetests"),refresh=vi.spyOn(runner,"refreshFixRunner");
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
  await (await import("../lib/github/poam-gate")).refreshConnectionGates(sid,s.connection.id);
  expect(retests).toHaveBeenCalledOnce();expect(refresh).toHaveBeenCalledOnce();
  expect((await queryTimeline(s.connection.id)).filter(x=>x.body.reason_code==="poam_gate_evaluated")).toHaveLength(2);
});
it("open-head gate refresh does not read an unrelated historical closed PR",async()=>{
  const s=await setup();
  mocks.get.mockImplementation(async({pull_number:number})=>({data:{number,changed_files:1,state:number===8?"closed":"open",merged:false,head:{sha:head},base:{sha:original.subject.revision,repo:{full_name:`${g.owner}/${g.repo}`}}}}));
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  const issue=s.source.reviewItems!.find(i=>i.id!==s.issue.id)!;
  const second=await performIssueAction({connectionId:s.connection.id,sessionId:sid,receiptId:s.source.releaseSha256,issueId:issue.id,actor:"agent:"+"b".repeat(32),at:new Date().toISOString(),action:"draft",draft:{risk:"Independent risk",action:"Correct its configuration",verification:"Collect the scoped scan"}}) as {proposal:{id:string}};
  await proposeFixPr(sid,s.connection.id,"agent:b",{poamItemId:second.proposal.id,prNumber:8});
  const provider=mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async input=>{if(input.pull_number===8)throw new Error("Historical provider read unavailable");return provider(input);});
  vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");
  const {refreshConnectionGates}=await import("../lib/github/poam-gate");
  await refreshConnectionGates(sid,s.connection.id);
  expect(mocks.checksCreate).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:"failure"}));
  await collect(s.connection.id,retest);
  await refreshConnectionGates(sid,s.connection.id);
  expect(mocks.checksCreate).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:"success"}));
  expect((await pullRequestLinks(sid,s.connection.id)).find(x=>x.prNumber===8)?.state).toBe("closed");
});
it.each([false,true])("named human break glass creates post-hoc POA&M and collector/audit evidence before gate success (runner %s)",async(runner)=>{
  const s=await setup();vi.stubEnv("AEGIS_GITHUB_POAM_GATE","true");vi.stubEnv("AEGIS_GITHUB_BREAK_GLASS_USERS","named-overrider");
  const account=await import("../lib/account/session");vi.spyOn(account,"accountFromRequest").mockResolvedValue({uid:"named-overrider",name:"Operator",email:"operator@example.invalid",provider:"google"});
  const {breakGlass,publishPoamGate}=await import("../lib/github/poam-gate");const req=new Request("https://binder.example");
  if (runner) {await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});vi.stubEnv("AEGIS_FIX_RUNNER","true");}
  const result=await breakGlass(req,sid,s.connection.id,s.owner,{prNumber:7,name:"Operator",reason:"Emergency availability repair"});
  expect(result.decision?.conclusion).toBe("success");expect(result.closureConfirmed).toBe(false);
  const record=(await readRemediation(sid))!.records.find(r=>r.key===prRecordKey(s.connection.id))!;
  const p=record.issueDrafts!.find(p=>(p as {id:string}).id===result.poamItemId) as import("../lib/aegis/plan-proposal").PlanProposal;
  expect(p.acceptance).toBe("proposed");expect(p.closureConfirmed).toBe(false);expect(p.readyToClose).toBe(false);
  expect((await queryTimeline(s.connection.id,{control:"CM-3"})).some(x=>x.body.reason_code==="break_glass_override"&&x.body.summary.reason==="Emergency availability repair")).toBe(true);
  expect((await collectedProposal(sid,p,s.connection.id)).readyToClose).toBe(false);
  const retry=await breakGlass(req,sid,s.connection.id,s.owner,{prNumber:7,name:"Operator",reason:"Emergency availability repair"});expect(retry.poamItemId).toBe(result.poamItemId);
  // A complete later collector run still cannot earn closure before merge.
  const clean=structuredClone(retest);clean.run.id="777777";clean.run.observedAt="2026-10-27T04:01:00Z";
  const {sealCollectedArtifact}=await import("../lib/collector/seal");
  for(const a of clean.artifacts){
    const meta=JSON.parse(Buffer.from(a.contentBase64,"base64").toString("utf8"));meta.capturedAt=clean.run.observedAt;
    meta.facts=meta.facts.filter((f:{outcome?:string})=>f.outcome!=="fail").map((f:{key:string;field:string;value:unknown;content:string})=>f.key==="scan-findings"||f.key==="scan-blocking"?{...f,value:0,content:`${f.field} = 0`}:f);
    const bytes=JSON.stringify(sealCollectedArtifact(meta));a.contentBase64=Buffer.from(bytes).toString("base64");a.sha256=sha256(bytes);
  }
  for(const check of clean.checks){check.verdict="pass";check.validUntil="2026-10-28T04:01:00Z";}
  vi.setSystemTime(new Date("2026-10-27T04:02:00Z"));await collect(s.connection.id,clean);
  expect((await collectedProposal(sid,p,s.connection.id)).readyToClose).toBe(false);
  state="merged";await applyPrWebhook("pull_request",payload());
  const measured=await collectedProposal(sid,p,s.connection.id);expect(measured.readyToClose).toBe(true);expect(measured.closureConfirmed).toBe(false);expect(measured.acceptance).toBe("proposed");
  head="f".repeat(40);state="open";expect((await publishPoamGate(g,7))?.conclusion).toBe("failure");
});
it("agents and unnamed people cannot break glass",async()=>{
  const s=await setup();const {breakGlass}=await import("../lib/github/poam-gate");
  await expect(breakGlass(new Request("https://binder.example",{headers:{authorization:"Bearer unit-agent"}}),sid,s.connection.id,s.owner,{prNumber:7,name:"Bot",reason:"Skip"})).rejects.toMatchObject({code:"needs_human"});
  await expect(breakGlass(new Request("https://binder.example"),sid,s.connection.id,s.owner,{prNumber:7,name:"Person",reason:"Skip"})).rejects.toMatchObject({code:"needs_human"});
  expect(mocks.checksCreate).not.toHaveBeenCalled();
});

it("a retest request cannot reuse pre-link satisfaction or a different merged commit",async()=>{
  const s=await setup();await collect(s.connection.id,retest);
  const {satisfyCollectedRetests,retestRequests}=await import("../lib/agent/retest");
  const request={id:"requested-retest",at:new Date().toISOString(),tokenId:"public-id",issueId:s.issue.id,sourceReceipt:s.source.releaseSha256,sourceWorkflow:"aegis-release-evidence.yml",state:"pending"};
  await appendLog(storageKey(["retest-requests",s.connection.id])+"/",request,x=>x.id===request.id);
  await satisfyCollectedRetests(sid,s.connection.id);expect((await retestRequests(s.connection.id,sid))[0].satisfaction?.outcome).toBe("fixed");
  // Attaching a PR invalidates the earlier unbound satisfaction.
  head="e".repeat(40);merged=head;
  await proposeFixPr(sid,s.connection.id,"agent:a",{poamItemId:s.p.id,prNumber:7});
  expect((await retestRequests(s.connection.id,sid))[0].satisfaction).toBeNull();
  state="merged";await applyPrWebhook("pull_request",payload());
  expect((await retestRequests(s.connection.id,sid))[0].satisfaction).toBeNull();
  const corrected=structuredClone(retest);corrected.subject.revision=merged;corrected.run.id="888888";
  const {sealCollectedArtifact}=await import("../lib/collector/seal");
  for(const a of corrected.artifacts){const meta=JSON.parse(Buffer.from(a.contentBase64,"base64").toString("utf8"));meta.source.commit=merged;const bytes=JSON.stringify(sealCollectedArtifact(meta));a.contentBase64=Buffer.from(bytes).toString("base64");a.sha256=sha256(bytes);}
  await collect(s.connection.id,corrected);await satisfyCollectedRetests(sid,s.connection.id);
  expect((await retestRequests(s.connection.id,sid))[0].satisfaction?.outcome).toBe("fixed");
  ci="failure";await applyPrWebhook("check_run",payload());expect((await retestRequests(s.connection.id,sid))[0].satisfaction).toBeNull();
});

it("historical unlinked collection retains its measured result without earning fresh closure proof",async()=>{
  const s=await setup();await collect(s.connection.id,retest);
  const {satisfyCollectedRetests,retestRequests}=await import("../lib/agent/retest");
  const request={id:"historical-retest",at:new Date().toISOString(),tokenId:"public-id",issueId:s.issue.id,sourceReceipt:s.source.releaseSha256,sourceWorkflow:"aegis-release-evidence.yml",state:"pending"};
  await appendLog(storageKey(["retest-requests",s.connection.id])+"/",request,x=>x.id===request.id);
  vi.setSystemTime(new Date("2026-10-30T04:00:00Z"));
  await satisfyCollectedRetests(sid,s.connection.id);
  expect((await retestRequests(s.connection.id,sid))[0].satisfaction?.outcome).toBe("fixed");
  expect((await collectedScannerProof(sid,s.source.pipelineId,s.issue.id,s.connection.id)).ready).toBe(false);
});
