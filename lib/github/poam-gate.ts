import {createHash, randomUUID} from "node:crypto";
import {withPrInstallation} from "./auth";
import {activeInstallationRepo} from "./store";
import {isOwnGithubApp, isOwnPoamGateCheck, connectedPrRepo, prLocators, pullRequestLinks, readPrSnapshot, prRecordKey, indexPrLink, recordPrFacts} from "./pull-requests";
import {ciGreenFor, type PullRequestLink} from "./pr-types";
import {collectedPrHeadProof} from "../aegis/collected-closure";
import {readConnection, ownsConnection, retainEvent} from "../server/builder-store";
import {updateRemediationRecord} from "../aegis/remediation-store";
import {queryTimeline, appendTimeline} from "../timeline/store";
import {connectionRecords} from "../agent/service";
import {issueDraft} from "../aegis/issue-actions";
import {sealCollectedArtifact} from "../collector/seal";
import {collectorEvents} from "../collector/events";
import {accountFromRequest} from "../account/session";
import {containsSecret} from "../aegis/gates/redact";
import {AgentAccessError} from "../agent/agent-token";
export const POAM_GATE = "aegis/poam-gate";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const gateEnabled = () => process.env.AEGIS_GITHUB_POAM_GATE === "true";
const overriders = () => (process.env.AEGIS_GITHUB_BREAK_GLASS_USERS ?? "").split(",").map(x=>x.trim()).filter(Boolean);
export function touchesControlledPaths(files: string[]) {
  const paths = (process.env.AEGIS_GITHUB_CONTROLLED_PATHS ?? "**").split(",").map(x=>x.trim());
  if (!paths.length || paths.some(x=>!x || x.startsWith("/") || x.includes("..") || (x !== "**" && /[*?\\]/.test(x)))) throw new Error("Configure literal controlled path prefixes, or ** for all paths.");
  return files.some(file=>paths.some(prefix=>prefix === "**" || file === prefix.replace(/\/$/,"") || file.startsWith(prefix.endsWith("/")?prefix:prefix+"/")));
}
export function gateDecision(input: {controlled: boolean; linked: boolean; ciGreen: boolean; retestReady: boolean; override: boolean}) {
  if (input.override) return {conclusion:"success" as const,reason:"Named human emergency override recorded; post-hoc POA&M requires retest and human sign-off."};
  if (!input.controlled) return {conclusion:"success" as const,reason:"No controlled paths changed."};
  if (!input.linked) return {conclusion:"failure" as const,reason:"Controlled paths require a linked open POA&M item."};
  if (!input.ciGreen) return {conclusion:"failure" as const,reason:"Current PR head needs successful CI checks."};
  if (!input.retestReady) return {conclusion:"failure" as const,reason:"A fresh server-collected retest on the current PR head is required."};
  return {conclusion:"success" as const,reason:"Linked POA&M, current-head CI and server-collected retest verified. Human closure remains required."};
}
type Repo = {installationId:number;owner:string;repo:string};
export async function publishPoamGate(g: Repo, number: number) {
  if (!gateEnabled()) throw new Error("POA&M merge gate is disabled.");
  if (!await activeInstallationRepo(g.installationId,g.owner,g.repo)) throw new Error("Repository is not connected.");
  const snapshot=await readPrSnapshot(g,number);
  if (snapshot.state!=="open") return;
  await writeGate(g,snapshot.headSha);
  // Complete server-read file inventory; renamed source paths count too.
  const files=await withPrInstallation(g.installationId,g.repo,"pr-read",async({octokit})=>{
    const pr=(await octokit.rest.pulls.get({owner:g.owner,repo:g.repo,pull_number:number})).data;
    const list=await octokit.paginate(octokit.rest.pulls.listFiles,{owner:g.owner,repo:g.repo,pull_number:number,per_page:100});
    if(pr.head.sha!==snapshot.headSha||list.length!==pr.changed_files||list.length>3000)throw new Error("PR head or complete file inventory is unavailable.");
    return list.flatMap(f=>f.previous_filename?[f.filename,f.previous_filename]:[f.filename]);
  });
  const controlled=touchesControlledPaths(files);
  let linked=false,ciGreen=false,retestReady=false,override=false;
  const matching: {link:PullRequestLink;sessionId:string}[]=[];
  const histories=new Map<string,Awaited<ReturnType<typeof queryTimeline>>>();
  for(const locator of await prLocators(g.installationId,g.owner,g.repo)) {
    const c=await readConnection(locator.connectionId);
    if(!c||c.revokedAt||JSON.stringify(c.github)!==JSON.stringify(g))continue;
    const link=(await pullRequestLinks(locator.sessionId,c.id)).findLast(l=>l.poamItemId===locator.poamItemId);
    if(!link||link.prNumber!==number||link.state!=="open"||link.headSha!==snapshot.headSha)continue;
    const {connectionProposals}=await import("../agent/approvals");
    const p=(await connectionProposals(c.id,locator.sessionId,undefined,link.poamItemId)).find(x=>x.proposal.id===link.poamItemId)?.proposal;
    if(!p||p.closureConfirmed||p.draft_revision!==link.draftRevision)continue;
    matching.push({link,sessionId:locator.sessionId});
    let history=histories.get(c.id);if(!history){history=await queryTimeline(c.id);histories.set(c.id,history);}
    const row=history.findLast(x=>x.body.reason_code==="break_glass_override"&&x.body.commit===snapshot.headSha&&x.body.items?.includes(link.poamItemId));
    if(row&&overriders().includes(String(row.body.summary.actorUid)))override=true;
  }
  // Preserve the existing named-human emergency authority; agents cannot invoke it.
  if (!override) for (const {link, sessionId} of matching) await (await import("../agent/fix-runner")).checkRunnerPrFiles(sessionId, link.connectionId, link, files);
  if(matching.length) {
    linked=true;ciGreen=ciGreenFor({...matching[0].link,ciStatus:snapshot.ciStatus},snapshot.headSha);
    // Every linked item must pass: adding a weaker item cannot bypass another finding.
    const results=await Promise.all(matching.map(({link,sessionId})=>collectedPrHeadProof(sessionId,link.sourceReleaseId,link.findingId,link.connectionId,snapshot.headSha)));
    retestReady=results.every(p=>p.ready);
  }
  const decision=gateDecision({controlled,linked,ciGreen,retestReady,override});
  await writeGate(g,snapshot.headSha,decision);
  for(const {link} of matching){
    const previous=histories.get(link.connectionId)?.findLast(x=>x.body.reason_code==="poam_gate_evaluated"&&x.body.items?.includes(link.poamItemId));
    if(previous?.body.commit===snapshot.headSha&&previous.body.summary.conclusion===decision.conclusion&&previous.body.summary.reason===decision.reason)continue;
    await recordPrFacts({...link,...snapshot,updatedAt:new Date().toISOString()},"poam_gate",decision.conclusion);
    await appendTimeline(link.connectionId,{id:hash(JSON.stringify([POAM_GATE,link.poamItemId,snapshot.headSha,decision,new Date().toISOString()])),kind:"monitoring-capture",source:{url:link.prUrl},commit:snapshot.headSha,observedAt:new Date().toISOString(),artifactSha256:[],controls:["CM-3"],findings:[link.findingId],items:[link.poamItemId],collected:true,reason_code:"poam_gate_evaluated",summary:{conclusion:decision.conclusion,reason:decision.reason}});
  }
  return decision;
}
export async function refreshConnectionGates(sessionId:string,connectionId:string) {
  if(!gateEnabled())return;
  const links=await pullRequestLinks(sessionId,connectionId);
  const numbers=new Set(links.filter(l=>l.state==="open").map(l=>l.prNumber));
  if(!numbers.size)return;
  const g=await connectedPrRepo(connectionId);
  // A collected workflow triggers one authoritative reconciliation of all links,
  // before each exact-head gate is independently evaluated and written.
  await (await import("./pull-requests")).applyPrWebhook("workflow_run",{installation:{id:g.installationId},repository:{owner:{login:g.owner},name:g.repo}},{prNumbers:[...numbers]});
  for(const number of numbers) {
    await publishPoamGate(g,number);
  }
}
export async function poamGateWebhook(event:string,body:unknown) {
  if(!gateEnabled()||!["pull_request","check_run","check_suite","workflow_run"].includes(event))return;
  const b=body as {installation?:{id?:number};repository?:{owner?:{login?:string};name?:string};pull_request?:{number?:number};check_run?:{name?:string;head_sha?:string;app?:{id?:number}};check_suite?:{head_sha?:string;app?:{id?:number}};workflow_run?:{head_sha?:string}};
  if(isOwnPoamGateCheck(b.check_run)||(event==="check_suite"&&isOwnGithubApp(b.check_suite)))return;
  const installationId=b.installation?.id,owner=b.repository?.owner?.login,repo=b.repository?.name;
  if(!installationId||!owner||!repo||!await activeInstallationRepo(installationId,owner,repo))return;
  const g={installationId,owner,repo};
  if(b.pull_request?.number){await publishPoamGate(g,b.pull_request.number);return;}
  const sha=b.check_run?.head_sha??b.check_suite?.head_sha??b.workflow_run?.head_sha;
  if(!sha||!/^[a-f0-9]{40}$/.test(sha))return;
  const prs=await withPrInstallation(installationId,repo,"pr-read",async({octokit})=>octokit.paginate(octokit.rest.pulls.list,{owner,repo,state:"open",per_page:100},response=>{if(response.data.length>=100)throw new Error("Open PR inventory exceeds bounded gate refresh.");return response.data;}));
  for(const pr of prs.filter(p=>p.head.sha===sha))await publishPoamGate(g,pr.number);
}
/** Human-only route calls this after the existing browser-owner boundary. No agent-supplied identity is accepted. */
export async function breakGlass(req:Request,sessionId:string,connectionId:string,ownerSecret:string,input:{prNumber?:unknown;name?:unknown;reason?:unknown}) {
  if(req.headers.has("authorization"))throw new AgentAccessError("Agents cannot break glass.",403,"needs_human");
  const account=await accountFromRequest(req),c=await readConnection(connectionId);
  if(!account||!overriders().includes(account.uid)||!c||!ownsConnection(c,ownerSecret)||c.revokedAt)throw new AgentAccessError("A named authenticated overrider owning this connection is required.",403,"needs_human");
  if(typeof input.name!=="string"||!input.name.trim()||input.name.length>200||typeof input.reason!=="string"||!input.reason.trim()||input.reason.length>4000||containsSecret(input.name)||containsSecret(input.reason)||!Number.isSafeInteger(input.prNumber)||Number(input.prNumber)<=0)
    throw new AgentAccessError("A PR number, name and credential-free reason are required.",400,"invalid_request");
  if(!gateEnabled())throw new Error("POA&M merge gate is disabled.");
  const g=await connectedPrRepo(connectionId),snapshot=await readPrSnapshot(g,Number(input.prNumber));
  if(snapshot.state!=="open")throw new AgentAccessError("Break glass requires an open PR.",409,"invalid_request");
  const key=hash(`${connectionId}:${snapshot.prNumber}:${snapshot.headSha}`);
  const intent=await appendTimeline(connectionId,{id:"break-glass-intent:"+key,kind:"person-action",source:{url:snapshot.prUrl},commit:snapshot.headSha,observedAt:(await queryTimeline(connectionId)).find(x=>x.body.id==="break-glass-intent:"+key)?.body.observedAt??new Date().toISOString(),artifactSha256:[],controls:["CM-3"],findings:[],collected:false,reason_code:"break_glass_requested",summary:{actorUid:account.uid,name:input.name.trim(),reason:input.reason.trim()}});
  if(intent.body.summary.actorUid!==account.uid||intent.body.summary.name!==input.name.trim()||intent.body.summary.reason!==input.reason.trim())throw new AgentAccessError("This PR head already has a different emergency request.",409,"invalid_request");
  const at=intent.body.observedAt;
  // Post-hoc issue is real collected governance metadata, not a synthetic scanner success.
  const field="emergency-change",value="human-override-needs-retest";
  const artifact=sealCollectedArtifact({schema:"aegis.collected-artifact.v1",name:`source-${key.slice(0,24)}.json`,type:"change-control",source:{repo:`https://github.com/${g.owner}/${g.repo}`,commit:snapshot.headSha,path:`pulls/${snapshot.prNumber}/emergency/${key}`,sha256:key},capturedAt:at,sha256:"0".repeat(64),facts:[{key:"change-control",field,value,content:`${field} = ${value}`,line:1,outcome:"fail"}],limitations:["Human emergency change requires post-hoc retest and ISSO sign-off. This is not authorization or risk acceptance."]});
  let bundleId="";
  for(const event of collectorEvents([artifact]))bundleId=(await retainEvent(connectionId,event.rawEvent,undefined,"browser-owner",true)).id;
  const source=(await connectionRecords({connectionId,ownerHash:c.ownerHash})).find(r=>r.releaseSha256===bundleId)!;
  const issue=source.reviewItems![0];
  const proposal={...issueDraft(source,issue,{risk:"Emergency change bypassed the normal merge evidence gate.",action:"Review the emergency change against CM-3 and collect a complete passing release scan of the merged commit.",verification:"Verify complete fresh server-collected release checks and merged-commit CI; obtain ISSO plan and closure decisions."}),draft_revision:key,source_label:{kind:"person" as const,name:input.name.trim(),identity_verification:"typed_unverified" as const}};
  const link:PullRequestLink={schema:"binder.pull-request-link.v1",...g,...snapshot,connectionId,poamItemId:proposal.id,findingId:issue.id,sourceReleaseId:source.pipelineId,draftRevision:key,createdBy:`person:${account.uid}`,createdAt:at,updatedAt:at,emergency:true};
  await indexPrLink(link,sessionId);
  await updateRemediationRecord(sessionId,prRecordKey(connectionId),async record=>{
    const base=record??{key:prRecordKey(connectionId),assessment:null,assessments:{},plans:[],proposals:[]};
    if(base.pullRequests?.some(l=>l.poamItemId===link.poamItemId))return base;
    await recordPrFacts(link,"break_glass");
    return {...base,issueDrafts:[...(base.issueDrafts??[]),proposal],pullRequests:[...(base.pullRequests??[]),link]};
  },undefined,true);
  const overrideScope="single-pr-head";
  await appendTimeline(connectionId,{id:"break-glass-override:"+key,kind:"person-action",source:{url:snapshot.prUrl},commit:snapshot.headSha,observedAt:at,artifactSha256:[artifact.sha256],controls:["CM-3"],findings:[issue.id],items:[proposal.id],collected:false,reason_code:"break_glass_override",summary:{actorUid:account.uid,name:input.name.trim(),reason:input.reason.trim(),overrideScope,identity_verification:"typed_unverified"}});
  const decision=await publishPoamGate(g,snapshot.prNumber);
  return {poamItemId:proposal.id,overrideScope,decision,closureConfirmed:false};
}

/** Emergency-change findings have governance provenance, not an invented scanner baseline. */
export async function collectedEmergencyProof(sessionId:string,link:PullRequestLink,expectedCommit?:string,expectedReceipt?:string) {
  const fail=(message:string)=>({ready:false as const,problems:[message],retests:[] as import("../aegis/plan-proposal").AttachedRetest[],source:undefined,retest:undefined,issue:undefined});
  const c=await readConnection(link.connectionId);
  if(!c||c.revokedAt||!await activeInstallationRepo(link.installationId,link.owner,link.repo))return fail("Emergency-change connection is unavailable.");
  if(!expectedCommit&&(link.state!=="merged"||!link.mergedCommitSha||!ciGreenFor(link,link.mergedCommitSha)))return fail("Emergency change needs merged-commit CI before closure review.");
  const source=(await connectionRecords({connectionId:c.id,ownerHash:c.ownerHash})).find(r=>r.pipelineId===link.sourceReleaseId);
  const issue=source?.reviewItems?.find(i=>i.id===link.findingId);
  const override=(await queryTimeline(c.id)).find(x=>x.body.reason_code==="break_glass_override"&&x.body.items?.includes(link.poamItemId));
  if(!source||!issue||!override)return fail("Emergency change needs its retained governance record and named override receipt.");
  const releases=await (await import("../collector/trusted-release")).trustedReleases(sessionId,c.id);
  const after=[...releases].reverse().find(r=>(!expectedReceipt||r.releaseSha256===expectedReceipt)&&r.commitSha===(expectedCommit??link.mergedCommitSha)&&r.observation.subject.id===source.observation.subject.id&&r.observation.producer==="GitHub Actions"&&Date.parse(r.createdAt)>Date.parse(override.body.observedAt)&&Date.parse(r.createdAt)<=Date.now()+300_000&&r.observation.checks.length>0&&r.observation.checks.every(check=>check.verdict==="pass"&&Date.parse(check.validUntil)>Date.now())&&r.collectedArtifacts?.some(a=>a.facts.some(f=>f.key==="scan-findings"))&&r.collectedArtifacts.filter(a=>a.facts.some(f=>f.key==="scan-findings")).every(a=>a.facts.find(f=>f.key==="scan-findings")?.value===0&&!a.facts.some(f=>f.outcome==="fail")));
  if(!after)return fail("Emergency change requires a complete fresh passing server-collected release scan after override, on the bound commit.");
  const retests:import("../aegis/plan-proposal").AttachedRetest[]=issue.scope.verification.map(description=>({description,evidence:after.observation.subject.id+"/actions/runs/"+after.artifactJobId,result:"Complete passing server-collected release scan after emergency override.",date:after.createdAt.slice(0,10),capturedAt:after.createdAt,reviewer:"Server evidence collector",source_label:{kind:"server-collected"},verdict:"pass",evidenceState:"pass",releaseId:after.pipelineId}));
  return {ready:true,problems:[] as string[],retests,source,retest:after,issue};
}

async function writeGate(g:Repo,sha:string,decision?:{conclusion:"success"|"failure";reason:string}) {
  const base=process.env.AEGIS_PUBLIC_ORIGIN;
  let detailsUrl:string|undefined;
  if(base){const url=new URL(base);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("Use an HTTPS public origin.");detailsUrl=new URL("/planning",url).toString();}
  // Check is attached to the exact head evaluated above; no merge endpoint is used.
  await withPrInstallation(g.installationId,g.repo,"gate",async({octokit})=>{
    const all=await octokit.rest.checks.listForRef({owner:g.owner,repo:g.repo,ref:sha,check_name:POAM_GATE,filter:"latest"});
    const own=all.data.check_runs.find(c=>c.app?.id===Number(process.env.GITHUB_APP_ID));
    const params={owner:g.owner,repo:g.repo,name:POAM_GATE,status:decision ? "completed" as const : "in_progress" as const,...(decision ? {conclusion:decision.conclusion,completed_at:new Date().toISOString()} : {}),...(detailsUrl?{details_url:detailsUrl}:{}),output:{title:POAM_GATE,summary:decision?.reason ?? "Evaluating controlled paths, linked POA&M and collected proof."}};
    if(own)await octokit.rest.checks.update({...params,check_run_id:own.id});
    else await octokit.rest.checks.create({...params,head_sha:sha});
  });
}
