import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageCounts, coverageFamilies, coverageMatches, coverageSource } from "../lib/aegis/baseline-coverage";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { receivedRetest } from "./support/received-retest";

test("coverage has every pinned family, base control and enhancement even with no evidence", () => {
  const empty={...CCM_EXAMPLE,families:[],reviewItems:[],gaps:[]};
  const families=coverageFamilies(empty,[empty],false);
  assert.equal(families.length,18);
  assert.deepEqual(coverageCounts(families.flatMap(f=>f.controls)),{all:323,linked:0,blank:323,review:0});
  assert.equal(families.flatMap(f=>f.controls).filter(r=>r.enhancement).length,142);
});
test("selected release and accumulated coverage never conflate name-only mappings or retest scope", () => {
  const retest=receivedRetest();
  const history=mergeStoredReleases([retest]);
  const selected=coverageFamilies(retest,history,false).flatMap(f=>f.controls);
  const accumulated=coverageFamilies(retest,history,true).flatMap(f=>f.controls);
  assert.equal(coverageCounts(selected).linked,1);
  assert.equal(selected.find(r=>r.id==="CM-6")?.result?.checks.length,3);
  assert.equal(selected.find(r=>r.id==="SC-7")?.result,null);
  assert.equal(accumulated.find(r=>r.id==="SC-7")?.result?.releaseId,CCM_EXAMPLE.pipelineId);
  assert.equal(coverageSource(accumulated.find(r=>r.id==="CM-6")!,history)?.artifactJobId,retest.artifactJobId);
  const named={...retest,verification:undefined,families:[{family:"SC",controls:["SC-7"],coverage:"name only",evidence:[]}]};
  assert.equal(coverageCounts(coverageFamilies(named,[named],false).flatMap(f=>f.controls)).linked,0);
});
test("coverage filters emphasize results without changing baseline totals", () => {
  const rows=coverageFamilies(CCM_EXAMPLE,mergeStoredReleases(),true).flatMap(f=>f.controls);
  const counts=coverageCounts(rows);
  for(const filter of ["all","linked","blank","review"] as const) assert.equal(rows.filter(r=>coverageMatches(r,filter)).length,counts[filter]);
  assert.equal(counts.all,323);
});
