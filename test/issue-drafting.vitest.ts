import {it,expect} from "vitest";
import {issueDraft,validateDraftText} from "../lib/aegis/issue-actions";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {observation} from "./r3-fixture";
it("model text cannot auto accept or close a proposed plan",()=>{const plan=issueDraft(CCM_EXAMPLE,observation,validateDraftText({risk:"Possible exposure",action:"Harden the workload",verification:"Fresh scanner result",acceptance:"accepted",closureConfirmed:true}));expect(plan.acceptance).toBe("proposed");expect(plan.closureConfirmed).toBe(false);expect(plan.readyToClose).toBe(false);expect(plan.finding).toBe(observation.description);});
it("rejects empty or malformed model output",()=>{expect(()=>validateDraftText({risk:"",action:"x",verification:"x"})).toThrow();expect(()=>validateDraftText(null)).toThrow();});

it("AI request uses structured draft text, disables storage and keeps server acceptance separate",async()=>{
 const {generateIssueDraft}=await import("../lib/server/issue-actions");
 const previousKey=process.env.OPENAI_API_KEY,previousModel=process.env.AEGIS_PLAN_AI_MODEL;
 try{
  process.env.OPENAI_API_KEY="synthetic-test-only";process.env.AEGIS_PLAN_AI_MODEL="synthetic-model";
  let payload:Record<string,unknown>={};
  const runFetch:typeof fetch=async (_url,options)=>{payload=JSON.parse(String(options?.body));return Response.json({output:[{content:[{type:"output_text",text:JSON.stringify({risk:"Observed synthetic finding",action:"Proposed review",verification:"Fresh scanner result"})}]}]});};
  expect((await generateIssueDraft({issue:"Synthetic fixture only"},runFetch)).action).toBe("Proposed review");
  expect(payload.store).toBe(false);expect(payload.model).toBe("synthetic-model");expect(payload.text).toMatchObject({format:{strict:true,schema:{required:["risk","action","verification"]}}});
 }finally{if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;if(previousModel===undefined)delete process.env.AEGIS_PLAN_AI_MODEL;else process.env.AEGIS_PLAN_AI_MODEL=previousModel;}
});

it("saves a real recorded issue draft as proposed, binds triage to its receipt and rejects another owner",async()=>{
 const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),path=await import("node:path");
 const {Session,runWithSession}=await import("../lib/aegis/store");
 const {createConnection,retainEvent}=await import("../lib/server/builder-store");
 const {handleIssueAction}=await import("../lib/server/issue-actions");
 const {readRemediation}=await import("../lib/aegis/remediation-store");
 const {createHash}=await import("node:crypto");
 const {deriveReviewItems}=await import("../lib/collector/derive-review-items");
 const {summarizeBuilderBundle}=await import("../lib/server/builder-observation");
 const event=(await import("../fixtures/boutique-live/40446239616/event.json")).default;
 const folder=mkdtempSync(path.join(tmpdir(),"r3-issue-draft-")),previous={data:process.env.AEGIS_DATA_DIR,key:process.env.OPENAI_API_KEY,model:process.env.AEGIS_PLAN_AI_MODEL},originalFetch=globalThis.fetch;
 try{
  process.env.AEGIS_DATA_DIR=folder;process.env.OPENAI_API_KEY="synthetic-test-only";process.env.AEGIS_PLAN_AI_MODEL="synthetic-model";
  globalThis.fetch=async()=>Response.json({output:[{content:[{type:"output_text",text:JSON.stringify({risk:"Recorded finding needs review",action:"Proposed configuration review",verification:"Fresh scanner result"})}]}]});
  const created=await createConnection("Online Boutique"),bundle=await retainEvent(created.connection.id,JSON.stringify(event),undefined,"browser-owner");
  const issue=deriveReviewItems(summarizeBuilderBundle(bundle).collectedArtifacts!).find(i=>i.scope.controls.includes("CM-6"))!;
  const request=(action:string,owner=created.owner,outcome="plan-it")=>new Request("http://localhost/api/remediation/issues",{method:"POST",headers:{cookie:`aegis_sid=${session.id}; aegis_builder_owner=${owner}`,"content-type":"application/json"},body:JSON.stringify({action,connectionId:created.connection.id,receiptId:bundle.id,issueId:issue.id,outcome,reason:"CI verifies source binding only"})});
  const session=Session.create("ef".repeat(16));session.commit(session.state);await session.flush();
  await runWithSession(session,async()=>{
   const draft=await handleIssueAction(request("draft"));expect(draft.status).toBe(200);const body=await draft.json();expect(body.proposal.acceptance).toBe("proposed");expect(body.proposal.closureConfirmed).toBe(false);expect(body.proposal.result.sourceCommit).toBe(event.subject.revision);
   const triage=await handleIssueAction(request("triage"));expect(triage.status).toBe(200);
   const {POST}=await import("../app/api/remediation/issues/route");
   for(const outcome of ["accept-risk","accept risk"]){const response=await POST(request("triage",created.owner,outcome));expect(response.status).toBe(400);expect((await response.json()).code).toBe("invalid_request");}
   const stored=(await readRemediation(session.id))!.records[0];expect(stored.issueDrafts).toHaveLength(1);expect(JSON.stringify(stored.issueTriage)).not.toContain(session.id);expect(stored.issueTriage?.[0]).toMatchObject({receiptId:bundle.id,issueId:issue.id,actor:`browser:${createHash("sha256").update(`triage-actor:${session.id}`).digest("hex").slice(0,24)}`,outcome:"plan-it"});
   const modelFetch=globalThis.fetch;
   globalThis.fetch=async()=>Response.json({output:[{content:[{type:"output_text",text:JSON.stringify({risk:"Bearer synthetic-test-value",action:"Proposed correction",verification:"Fresh result"})}]}]});
   const unsafeDraft=await POST(request("draft"));expect(unsafeDraft.status).toBe(503);expect((await unsafeDraft.json()).error).toContain("Remove credentials");
   globalThis.fetch=modelFetch;
   expect((await handleIssueAction(request("draft","0".repeat(64)))).status).toBe(403);
   expect(await readRemediation("ab".repeat(16))).toBeNull();
  });
 }finally{
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries({AEGIS_DATA_DIR:previous.data,OPENAI_API_KEY:previous.key,AEGIS_PLAN_AI_MODEL:previous.model})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(folder,{recursive:true,force:true});
 }
});
