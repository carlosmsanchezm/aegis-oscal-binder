import {referenceHistory as mergeStoredReleases} from "./support/reference-history";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {PODINFO_RETEST_RECEIPT, releasesAtSnapshot, rollupControlResults} from '../lib/aegis/control-rollup';
test('older snapshot cannot borrow a later finding, measured retest or artifact job',()=>{
  const history=mergeStoredReleases();
  const original=releasesAtSnapshot(history,CCM_EXAMPLE);
  assert.deepEqual(original.map(r=>r.pipelineId),[CCM_EXAMPLE.pipelineId]);
  const cm6=rollupControlResults(original).find(r=>r.id==='CM-6')!.result!;
  assert.equal(cm6.releaseId,'2894050908');
  assert.match(cm6.finding,/KSV-0020/);
  assert.equal(cm6.checks.length,0);
  assert.equal(cm6.correctiveReleaseId,'');
  const latest=rollupControlResults(releasesAtSnapshot(history,PODINFO_RETEST_RECEIPT)).find(r=>r.id==='CM-6')!.result!;
  assert.equal(latest.releaseId,'2908682168');
  assert.match(latest.finding,/KSV-0125/);
});
test('snapshot projection keeps earlier coverage and excludes other project observations',()=>{
  const unrelated={...PODINFO_RETEST_RECEIPT,pipelineUrl:'https://gitlab.example/another/-/pipelines/1'};
  const rows=releasesAtSnapshot([...mergeStoredReleases(),unrelated],PODINFO_RETEST_RECEIPT);
  assert.equal(rows.length,2);
  assert.equal(rollupControlResults(rows).find(r=>r.id==='AC-6')!.result!.releaseId,'2894050908');
});
