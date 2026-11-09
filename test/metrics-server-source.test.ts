import assert from "node:assert/strict";
import test from "node:test";
import slice from "./fixtures/metrics-server-slice.json" with {type:"json"};
import {collectSource} from "../lib/collector/collect";
import {factCandidates} from "../lib/collector/mappings";
import {moderateControls} from "../lib/aegis/moderate-baseline";
const allowed=new Set(moderateControls().map(c=>c.id));
test("an unseen pinned Kubernetes application retains exact workload and RBAC facts and catalog proposals",()=>{
 assert.equal(slice.source.commit,"9c32bfc6312e093c91e33d80f7fd2149054d056d");
 for(const file of slice.files){
  const actual=collectSource({...slice.source,path:file.path,content:file.content});
  assert.deepEqual(actual,file.expectedArtifact);
  assert.deepEqual(factCandidates(actual!,allowed,"fedramp-rev5").map(candidate=>candidate.controlId),file.expectedCandidates);
 }
 const workload=slice.files.find(file=>file.path.endsWith("deployment.yaml"))!.expectedArtifact;
 assert.ok(workload.facts.some(fact=>fact.key==="non-root" && fact.value===true && fact.line===54));
 assert.ok(workload.facts.some(fact=>fact.key==="read-only" && fact.line===53));
 assert.ok(workload.facts.every(fact=>!('outcome' in fact)),"Source configuration does not invent failed measurements");
});
