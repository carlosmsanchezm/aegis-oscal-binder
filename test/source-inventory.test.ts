import assert from "node:assert/strict";
import test from "node:test";
import {CCM_EXAMPLE, pipelineArtifactNames, parseCcmSummary, summaryForSession} from "../lib/aegis/pipeline-evidence";
import {loadSourceInventory,withSourceInventories} from "../lib/collector/load-inventory";
import {GET} from "../app/api/collector/references/[id]/route";
const pin="3e0ff8ae123b710bc91de1315cba0f996a8896c2";
const request=new Request("http://localhost/api/collector/references/"+pin);
test("recorded source inventory is served separately, with safe facts and original provenance",async()=>{
 assert.equal(pipelineArtifactNames(CCM_EXAMPLE).length,28);
 assert.equal(CCM_EXAMPLE.collectedArtifacts,undefined);
 const response=await GET(request,{params:Promise.resolve({id:pin})});
 const capture=await response.json(), artifacts=capture.artifacts;assert.equal(artifacts.length,246);
 assert.equal(capture.source.commit,pin);
 assert.ok(artifacts.some((a:any)=>a.source.commit===pin));
 assert.ok(artifacts.every((a:any)=>!('content' in a) && !('content' in a.source)));
 assert.equal((await GET(request,{params:Promise.resolve({id:"a".repeat(40)})})).status,404);
 let calls=0;
 const fetcher=(async(href:any,init:any)=>{calls++;assert.equal(href,CCM_EXAMPLE.sourceInventoryHref);assert.equal(init.cache,"no-store");return Response.json(capture);}) as typeof fetch;
 const loaded=await loadSourceInventory(CCM_EXAMPLE,fetcher);
 assert.equal(pipelineArtifactNames(loaded).length,274);
 assert.equal(pipelineArtifactNames(parseCcmSummary(summaryForSession(loaded))).length,274);
 await loadSourceInventory(CCM_EXAMPLE,fetcher);assert.equal(calls,2,"explicitly loading the same source must still make a fresh load request");
 await loadSourceInventory({...CCM_EXAMPLE,sourceInventoryHref:undefined},fetcher);assert.equal(calls,2);
});
test("source inventory loading rejects failures, malformed captures, changed pins and unsafe locations",async()=>{
 const capture=await (await GET(request,{params:Promise.resolve({id:pin})})).json(), artifacts=capture.artifacts;
 for(const value of [{},{source:capture.source,artifacts:[artifacts[0],artifacts[0]]},{...capture,source:{...capture.source,commit:"b".repeat(40)}}])
  await assert.rejects(loadSourceInventory(CCM_EXAMPLE,(async()=>Response.json(value)) as typeof fetch),/Invalid source inventory/);
 await assert.rejects(loadSourceInventory(CCM_EXAMPLE,(async()=>new Response(null,{status:503})) as typeof fetch),/unavailable/);
 await assert.rejects(loadSourceInventory({...CCM_EXAMPLE,sourceInventoryHref:"https://example.invalid/source"},(async()=>{throw new Error("must not fetch");}) as typeof fetch),/Invalid source inventory reference/);
});

test("retained source facts follow receipt selection without changing measured checks or the receipt seal",async()=>{
 const loaded=await loadSourceInventory(CCM_EXAMPLE,(async()=>GET(request,{params:Promise.resolve({id:pin})})) as typeof fetch);
 const {receivedRetest}=await import("./support/received-retest");
 const retest=receivedRetest(), next=withSourceInventories(retest,[loaded,loaded]);
 assert.equal(pipelineArtifactNames(next).length,275);
 assert.deepEqual(next.checks,retest.checks);assert.deepEqual(next.verification,retest.verification);
 assert.equal(next.commitSha,retest.commitSha);assert.equal(next.releaseSha256,retest.releaseSha256);
 assert.equal(next.collectedArtifacts!.length,246);
 assert.equal(pipelineArtifactNames(parseCcmSummary(summaryForSession(next))).length,275);
});
