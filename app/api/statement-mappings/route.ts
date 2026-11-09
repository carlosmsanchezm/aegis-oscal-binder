import {createHash} from "node:crypto";
import {withSession,jsonOk} from "@/lib/server/http";
import {getSession,AegisError,findRepoRoot} from "@/lib/aegis";
import {loadRecords,connectedHistory} from "@/lib/server/remediation-draft";
import {readReleaseHistory} from "@/lib/server/pipeline-inbound";
import {remediationSessionCookie} from "@/lib/server/remediation-session";
import {writeRemediationRecord} from "@/lib/aegis/remediation-store";
import {STATEMENT_MAPPING_KEY,normalizeStatementMapping} from "@/lib/aegis/statement-mapping";
import {RECORDED_EVIDENCE} from "@/lib/aegis/recorded-evidence";
import {mergeStoredReleases,evidenceForRelease} from "@/lib/aegis/control-rollup";
import {artifactFilename} from "@/lib/aegis/pipeline-evidence";
import {packageMapFor} from "@/lib/aegis/map-graph";
import {storageUnconfigured} from "@/lib/durable";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const scope=()=>createHash("sha256").update(getSession().id).digest("hex");
async function reviews(req:Request){return (await loadRecords(req.headers.get("cookie"))).find(r=>r.key===STATEMENT_MAPPING_KEY)?.statementMappings?.flatMap(v=>{const m=normalizeStatementMapping(v);return m?[m]:[];})??[];}
export function GET(req:Request){return withSession(req,async()=>jsonOk({reviews:await reviews(req),sessionScope:scope()}));}
export function POST(req:Request){return withSession(req,async()=>{
 if(req.headers.get("x-aegis-expected-session")!==scope())throw new AegisError("SESSION_CHANGED","Reload before reviewing this mapping.",409);
 const text=await req.text();
 if(text.length>16_384)throw new AegisError("PAYLOAD_TOO_LARGE","This statement review is too large.",413);
 let body:Record<string,unknown>;
 try {const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();body=value;}catch{throw new AegisError("BAD_REQUEST","A statement review must be a JSON object.",400);}
 const input=normalizeStatementMapping({...body,id:"0".repeat(64),reviewedAt:new Date().toISOString()});
 if(!input || (body.action!=="review"&&body.action!=="reopen"))throw new AegisError("BAD_REQUEST","A statement, captured artifact, reviewer and rationale are required.",400);
 let received:Awaited<ReturnType<typeof readReleaseHistory>>=[];
 try {received=await readReleaseHistory();}catch(error){if(!storageUnconfigured(error))throw error;}
 const releases=[...mergeStoredReleases([...RECORDED_EVIDENCE,...received.map(r=>r.evidence)]),...await connectedHistory(req.headers.get("cookie"),new URL(req.url).origin)];
 const source=releases.find(r=>r.pipelineId===input.sourceReleaseId&&r.releaseSha256===input.sourceSha256);
 const result=source?evidenceForRelease(source,releases).get(input.controlId):null;
 const expected=result?.evidence.map(artifactFilename).map(name=>`${source!.pipelineId}:${source!.artifactJobId}:${source!.releaseSha256}:${name}`)??[];
 const items=packageMapFor(findRepoRoot(),"fedramp-rev5",[{id:input.controlId,family:input.controlId.split("-")[0]}]).statements[input.controlId]?.items??[];
 if(!source||!expected.includes(input.evidenceId)||!items.some(i=>i.id===input.statementId))throw new AegisError("MAPPING_STALE","This statement or captured artifact is no longer available. Reload its evidence before reviewing.",409);
 const id=createHash("sha256").update(JSON.stringify([input.controlId,input.statementId,input.evidenceId,input.sourceReleaseId,input.sourceSha256])).digest("hex");
 const previous=await reviews(req),next=previous.filter(m=>m.id!==id);
 if(body.action==="review")next.push({...input,id});
 if(next.length>200)throw new AegisError("MAPPING_LIMIT","This session has reached its statement review limit.",413);
 const record={key:STATEMENT_MAPPING_KEY,assessment:null,assessments:{},plans:[],statementMappings:next};
 try {await writeRemediationRecord(getSession().id,record);return jsonOk({reviews:next});}
 catch(error){if(!storageUnconfigured(error))throw error;const response=jsonOk({reviews:next});response.headers.append("set-cookie",remediationSessionCookie(record,getSession().id,req));return response;}
 });}
