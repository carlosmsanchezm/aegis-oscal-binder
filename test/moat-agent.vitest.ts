import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createMcpServer} from "../lib/agent/mcp-server";
import {createAgentToken,authenticateAgent,revokeAgentToken,listAgentTokens} from "../lib/agent/agent-token";
import {createConnection,retainEvent} from "../lib/server/builder-store";
import {writeObjectOnce,readObject} from "../lib/immutable-log";
import {storageKey} from "../lib/storage-key";
import {getAgentActivity,appendAgentActivity} from "../lib/agent/audit";
import {connectionRecords} from "../lib/agent/service";
import {writeRemediationRecord,readRemediation} from "../lib/aegis/remediation-store";
import {issueDraft} from "../lib/aegis/issue-actions";
import {releaseProject} from "../lib/aegis/control-rollup";
import {Session,runWithSession,adoptSession,dropCachedSession,endSession,SESSION_TTL_MS} from "../lib/aegis/store";
import {putRemediation} from "../lib/server/remediation-draft";
import {POST as signoutPost} from "../app/api/auth/signout/route";
import {POST as mcpPost} from "../app/api/mcp/route";
import {GET as timelineGet} from "../app/api/timeline/route";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
let folder:string;let previous:string|undefined;
beforeEach(()=>{previous=process.env.AEGIS_DATA_DIR;folder=mkdtempSync(path.join(tmpdir(),"moat-agent-"));process.env.AEGIS_DATA_DIR=folder;vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));});
afterEach(()=>{dropCachedSession(sessionId);vi.useRealTimers();if(previous===undefined)delete process.env.AEGIS_DATA_DIR;else process.env.AEGIS_DATA_DIR=previous;rmSync(folder,{recursive:true,force:true});});
const sessionId="ab".repeat(16);
async function setup(){const {session}=await adoptSession(`aegis_sid=${sessionId}`);session.commit(session.state);await session.flush();const created=await createConnection("Online Boutique");const issued=await createAgentToken(created.connection.id,created.owner,sessionId,["read","draft","triage","retest","close"]);return {...created,...issued};}
/** Test-only provenance fixture: production has no endpoint capable of issuing this receipt. */
async function recordedReceipt(connectionId:string,event:typeof original){const b=await retainEvent(connectionId,JSON.stringify(event));await writeObjectOnce(storageKey(["collector-receipts",sessionId,connectionId+"-"+b.id+".json"]),{connectionId,receiptId:b.id,sessionId,runId:event.run.id,commit:event.subject.revision,collectedAt:new Date().toISOString()});return b;}
async function connect(token:string){const server=createMcpServer(()=>token),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:"recorded-test",version:"1"});await client.connect(b);return {client,server};}
it("MCP advertises only supported triage outcomes and rejects risk acceptance at input validation",async()=>{
 const s=await setup(),{client,server}=await connect(s.token);
 try{
  const {tools}=await client.listTools();
  expect(tools).toHaveLength(13);
  expect(tools.some(tool=>tool.name === "propose_fix_pr")).toBe(true);
  expect(tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(["claim_fix","get_fix_assignments"]));
  expect(tools.some(tool=>/merge|approve|break_glass/.test(tool.name))).toBe(false);
  for(const tool of tools)expect(tool.inputSchema.properties?.outcome).toMatchObject({type:"string",enum:["fix-now","plan-it"]});
  for(const outcome of ["accept-risk","accept risk"]){
   const result=await client.callTool({name:"triage_finding",arguments:{outcome,reason:"Unsupported agent decision"}});
   expect(result.isError).toBe(true);
   expect((result.content as {text:string}[])[0].text).toContain("Input validation error: Invalid arguments for tool triage_finding");
  }
  expect(await getAgentActivity(s.connection.id)).toEqual([]);
 }finally{await client.close();await server.close();}
});
it("stores hashes only, binds scopes and owner, and revokes persistent credentials",async()=>{
 const s=await setup();const raw=readFileSync(path.join(folder,storageKey(["agent-tokens",s.record.id+".json"])),"utf8");expect(raw).not.toContain(s.token);expect(raw).toContain(s.record.hash);
 expect((await authenticateAgent(s.token,"read")).connectionId).toBe(s.connection.id);
 const read=await createAgentToken(s.connection.id,s.owner,sessionId,["read"]);await expect(authenticateAgent(read.token,"close")).rejects.toMatchObject({status:403});
 await expect(createAgentToken(s.connection.id,"00".repeat(32),sessionId,["read"])).rejects.toMatchObject({status:403});
 expect(JSON.stringify(await listAgentTokens(s.connection.id,s.owner))).not.toContain(s.record.hash);
 await revokeAgentToken(s.connection.id,s.owner,s.record.id);await expect(authenticateAgent(s.token)).rejects.toMatchObject({status:401});
});
it("allows an agent token linked to an active browser session",async()=>{
 const s=await setup();dropCachedSession(sessionId);
 expect((await authenticateAgent(s.token,"read")).id).toBe(s.record.id);
});
it("rejects an agent token after its browser session signs out",async()=>{
 const s=await setup();
 const response=await signoutPost(new Request("https://binder.example/api/auth/signout",{method:"POST",headers:{origin:"https://binder.example",cookie:`aegis_sid=${sessionId}`}}));
 expect(response.status).toBe(200);expect(response.headers.get("set-cookie")).toContain("aegis_sid=; ");
 dropCachedSession(sessionId);
 await expect(authenticateAgent(s.token)).rejects.toMatchObject({status:401,message:"Agent credential is invalid or revoked."});
 await endSession(sessionId); // Repeated sign-out preserves the same revocation.
 await expect(authenticateAgent(s.token)).rejects.toMatchObject({status:401,message:"Agent credential is invalid or revoked."});
});
it("rejects an agent token linked to an expired browser session",async()=>{
 const s=await setup();vi.advanceTimersByTime(SESSION_TTL_MS);
 await expect(authenticateAgent(s.token)).rejects.toMatchObject({status:401,message:"Agent credential is invalid or revoked."});
});
it("rejects a revoked agent token while its browser session remains active",async()=>{
 const s=await setup();await revokeAgentToken(s.connection.id,s.owner,s.record.id);
 await expect(authenticateAgent(s.token)).rejects.toMatchObject({status:401,message:"Agent credential is invalid or revoked."});
});
it("agent package reads do not extend the browser session lifetime",async()=>{
 const s=await setup(),longer=await createAgentToken(s.connection.id,s.owner,sessionId,["read"],{expires_at:new Date(Date.now()+SESSION_TTL_MS).toISOString()}),{client,server}=await connect(longer.token);
 try{
  vi.advanceTimersByTime(SESSION_TTL_MS-1);
  expect((await client.callTool({name:"get_package",arguments:{}})).isError).not.toBe(true);
  vi.advanceTimersByTime(1);
  await expect(authenticateAgent(longer.token)).rejects.toMatchObject({status:401,message:"Agent credential is invalid or revoked."});
 }finally{await client.close();await server.close();}
});
it.each([0,1])("rejects an entire MCP batch with an out-of-scope call at index %i",async(index)=>{
 const s=await setup(),read=await createAgentToken(s.connection.id,s.owner,sessionId,["read"]);
 const batch=[{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_package",arguments:{}}}];
 batch.splice(index,0,{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"attempt_close",arguments:{}}});
 const response=await mcpPost(new Request("https://binder.example/api/mcp",{method:"POST",headers:{authorization:`Bearer ${read.token}`,"content-type":"application/json"},body:JSON.stringify(batch)}));
 expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"Agent scope is required: close"});
 const audit=await getAgentActivity(s.connection.id);expect(audit).toHaveLength(1);expect(audit[0].body).toMatchObject({tool:"attempt_close",result:"refused",refusalReason:"Agent scope is required: close"});
});
it("MCP refuses forged and absent retests, then earns only closure review from recorded test receipts",async()=>{
 const s=await setup(),source=await recordedReceipt(s.connection.id,original);
 const records=await connectionRecords(s.record),record=records[0],issue=record.reviewItems!.find(i=>/frontend.*KSV-0020|KSV-0020.*frontend/.test(i.description))!;
 const proposal=issueDraft(record,issue,{risk:"Recorded test draft",action:"Proposed setting change",verification:"Rerun scanner"});
 const key=`binder.plan-proposals.v1:${releaseProject(record.pipelineUrl)}`;
 await writeRemediationRecord(sessionId,{key,assessment:null,assessments:{},plans:[],proposals:[],issueDrafts:[proposal]});
 const {client,server}=await connect(s.token);
 try{
  expect((await client.listTools()).tools).toHaveLength(13);
  const input={receiptId:source.id,issueId:issue.id};
  expect((await client.callTool({name:"list_findings",arguments:{receiptId:source.id}})).isError).not.toBe(true);
  const refused=await client.callTool({name:"attempt_close",arguments:input});expect(refused.isError).toBe(true);
  // Valid digests and a complete caller-uploaded event still cannot mint collector provenance.
  await retainEvent(s.connection.id,JSON.stringify(retest));expect((await client.callTool({name:"attempt_close",arguments:input})).isError).toBe(true);
  await expect(writeRemediationRecord(sessionId,{key,assessment:null,assessments:{},plans:[],proposals:[{...proposal,closureConfirmed:true,retests:[{verdict:"pass"}]}]})).rejects.toMatchObject({code:"EVIDENCE_REQUIRED"});
  const forged={key,assessment:null,assessments:{},plans:[],proposals:[{...proposal,closureConfirmed:true}]};
  await expect(runWithSession(Session.create(sessionId),()=>putRemediation(new Request("http://localhost/api/remediation",{method:"PUT",body:JSON.stringify(forged)})))).rejects.toMatchObject({code:"EVIDENCE_REQUIRED"});
  await recordedReceipt(s.connection.id,retest);
  const result=await client.callTool({name:"attempt_close",arguments:input});expect(result.isError).not.toBe(true);
  const text=(result.content as {text:string}[])[0].text;expect(JSON.parse(text)).toMatchObject({workflowState:"ready-for-closure-review",closureConfirmed:false,humanConfirmationRequired:true});
  const persisted=(await readRemediation(sessionId))!.records[0].issueDrafts![0];expect(persisted).toMatchObject({readyToClose:true,closureConfirmed:false,acceptance:"proposed"});
  const other=await createConnection("Same-owner isolated connection",s.owner);await retainEvent(other.connection.id,JSON.stringify(original));
  const otherToken=await createAgentToken(other.connection.id,s.owner,sessionId,["read","close"]),otherClient=await connect(otherToken.token);
  try{const status=await otherClient.client.callTool({name:"get_gate_status",arguments:{}});expect(JSON.parse((status.content as {text:string}[])[0].text).plans).toEqual([]);expect((await otherClient.client.callTool({name:"attempt_close",arguments:input})).isError).toBe(true);}finally{await otherClient.client.close();await otherClient.server.close();}
  const audit=await getAgentActivity(s.connection.id);expect(audit.filter(x=>x.body.result==="refused")).toHaveLength(2);expect(JSON.stringify(audit)).not.toContain(s.token);
 }finally{await client.close();await server.close();}
});
it("MCP scope denial is audited and HTTP refuses absent credentials and cross-origin mutations",async()=>{
 const s=await setup(),read=await createAgentToken(s.connection.id,s.owner,sessionId,["read"]);const {client,server}=await connect(read.token);
 try{expect((await client.callTool({name:"attempt_close",arguments:{}})).isError).toBe(true);}finally{await client.close();await server.close();}
 expect((await getAgentActivity(s.connection.id)).at(-1)?.body.refusalReason).toContain("scope");
 expect((await mcpPost(new Request("http://localhost/api/mcp",{method:"POST",body:"{}"}))).status).toBe(401);
 expect((await mcpPost(new Request("http://localhost/api/mcp",{method:"POST",headers:{authorization:`Bearer ${s.token}`,origin:"https://other.invalid"},body:"{}"}))).status).toBe(403);
 expect((await mcpPost(new Request("http://localhost/api/mcp",{method:"POST",headers:{authorization:`Bearer ${read.token}`,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"attempt_close",arguments:{}}})}))).status).toBe(403);
 expect((await timelineGet(new Request(`http://localhost/api/timeline?connection=${s.connection.id}`))).status).toBe(403);
});
it("audit chain redacts credentials and detects immutable overwrite and tampering",async()=>{
 const s=await setup();const row=await appendAgentActivity(s.connection.id,{tokenId:s.record.id,tool:"triage_finding",inputs:{reason:`Bearer example-credential ${s.token}`},result:"refused",refusalReason:null});
 expect(JSON.stringify(row)).not.toContain(s.token);expect(JSON.stringify(row)).not.toContain("example-credential");
 const dir=path.join(folder,storageKey(["agent-audit",s.connection.id]));const {readdirSync,writeFileSync}=await import("node:fs");const filename=readdirSync(dir)[0];const key=storageKey(["agent-audit",s.connection.id,filename]);
 await expect(writeObjectOnce(key,row)).rejects.toThrow();
 const edited=await readObject<Record<string,unknown>>(key);writeFileSync(path.join(folder,key),JSON.stringify({...edited,hash:"f".repeat(64)}));await expect(getAgentActivity(s.connection.id)).rejects.toThrow(/chain/);
});
it("official SDK Streamable HTTP client initializes and reads through the actual route",async()=>{
 const s=await setup();await recordedReceipt(s.connection.id,original);
 const {StreamableHTTPClientTransport}=await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
 const transport=new StreamableHTTPClientTransport(new URL("https://binder.example/api/mcp"),{requestInit:{headers:{Authorization:`Bearer ${s.token}`}},fetch:async (url,init)=>mcpPost(new Request(url,init))});
 const client=new Client({name:"http-route-test",version:"1"});
 try{await client.connect(transport);expect((await client.listTools()).tools).toHaveLength(13);const result=await client.callTool({name:"get_package",arguments:{}});expect(result.isError).not.toBe(true);expect(JSON.parse((result.content as {text:string}[])[0].text).connectionId).toBe(s.connection.id);expect(JSON.stringify(result)).not.toContain(sessionId);expect(JSON.stringify(result)).not.toContain(s.owner);
  const listed=await client.callTool({name:"list_findings",arguments:{}});const retainedUrl=JSON.parse((listed.content as {text:string}[])[0].text).retainedEvidenceUrl;expect(retainedUrl.startsWith("https://binder.example/")).toBe(true);
  const records=await connectionRecords(s.record),issue=records[0].reviewItems![0];
  const close=await client.callTool({name:"attempt_close",arguments:{receiptId:records[0].releaseSha256,issueId:issue.id,evidence:{verdict:"pass",sha256:"f".repeat(64)}}});
  expect(close.isError).toBe(true);expect((await getAgentActivity(s.connection.id)).at(-1)?.body.result).toBe("refused");}finally{await client.close();}
});


it("MCP retains a measured historical diff but expired evidence cannot earn closure review",async()=>{
 vi.setSystemTime(new Date("2026-10-28T05:00:00Z"));
 const s=await setup(),source=await recordedReceipt(s.connection.id,original);
 await recordedReceipt(s.connection.id,retest);
 const record=(await connectionRecords(s.record)).find(r=>r.releaseSha256===source.id)!;
 const issue=record.reviewItems!.find(i=>/frontend.*KSV-0020|KSV-0020.*frontend/.test(i.description))!;
 const {client,server}=await connect(s.token);
 try{
  const result=await client.callTool({name:"get_evidence",arguments:{receiptId:source.id,issueId:issue.id,control:"CM-6"}});
  expect(result.isError).not.toBe(true);
  const retests=JSON.parse((result.content as {text:string}[])[0].text).retests;
  const measured=retests.find((r:{runId:string})=>r.runId===retest.run.id);
  expect(measured.measuredAt).toBe(retest.run.observedAt);
  expect(measured.measured.fixed).toContain(issue.id);
  expect(measured.fixed).toEqual([]);
  expect(measured.unverified).toContain(issue.id);
  const refused=await client.callTool({name:"attempt_close",arguments:{receiptId:source.id,issueId:issue.id}});
  expect(refused.isError).toBe(true);
  expect(JSON.parse((refused.content as {text:string}[])[0].text)).toMatchObject({refused:true,closureConfirmed:false});
 }finally{await client.close();await server.close();}
});
