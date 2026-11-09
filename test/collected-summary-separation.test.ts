import assert from "node:assert/strict";
import test from "node:test";
import {CCM_EXAMPLE} from "./support/collected-example";
import {binderSummary,proposedControlCounts,retainedProposedControlCounts,completeRetainedSources} from "../lib/aegis/binder-summary";
import {moderateControls} from "../lib/aegis/moderate-baseline";
const ids=moderateControls().map(control=>control.id);
test("collected facts retain separate producer links and pending suggestions across the exact refreshed inventory",()=>{
 const rows=binderSummary(CCM_EXAMPLE,ids);
 assert.equal(rows.length,274);
 assert.deepEqual([...new Set(rows.flatMap(row=>row.families))].sort(),["AC","AU","CA","CM","IA","PL","RA","SA","SC","SI","SR"]);
 for(const row of rows){
  assert.equal(new Set(row.proposed).size,row.proposed.length);
  assert.ok(row.proposed.every(id=>!row.linked.includes(id) && !row.approved.includes(id)));
 }
 const publisher=rows.find(row=>row.name==="publisher-manifest.json")!;
 assert.deepEqual(publisher.linked,[]);assert.deepEqual(publisher.approved,[]);
 assert.deepEqual(publisher.proposed,["AC-6","AU-12","CA-7","CM-2","CM-3","CM-6","CM-7","CM-8","SC-7","SI-2","SI-7"]);
 assert.equal(proposedControlCounts([CCM_EXAMPLE],ids).get("CM-8"),56);
});

test("retained receipts use complete facts only from the same release and source",()=>{
 const receipt={...CCM_EXAMPLE,collectedArtifacts:[]};
 const foreign={...CCM_EXAMPLE,pipelineUrl:"https://example.invalid/other"};
 assert.equal(completeRetainedSources([receipt],[foreign])[0],receipt);
 const restored=completeRetainedSources([receipt],[receipt,CCM_EXAMPLE,foreign]);
 assert.equal(restored[0],CCM_EXAMPLE);
 const counts=retainedProposedControlCounts(restored,ids);
 assert.equal(counts.size,27);
 assert.equal(counts.get("CM-8"),56);
 assert.deepEqual(retainedProposedControlCounts([...restored,...restored],ids),counts);
});
