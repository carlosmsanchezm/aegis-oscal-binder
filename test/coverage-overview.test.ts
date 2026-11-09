import {CCM_EXAMPLE} from "./support/collected-example";
import assert from 'node:assert/strict';
import test from 'node:test';
import {coverageOverviewLayout} from '../lib/aegis/coverage-overview';
import {buildLayout} from '../lib/aegis/map-placement';
import {proposedControlCounts} from '../lib/aegis/binder-summary';
import {resultsMapPackage} from '../lib/aegis/results-map';
import {applyReleaseRollup} from '../lib/aegis/rollup-package';
import {moderateRollupShell} from '../lib/aegis/rollup-shell';
test('large proposed coverage retains every control in compact nonoverlapping family rows',()=>{
 const rolled=applyReleaseRollup(moderateRollupShell(process.cwd()),[CCM_EXAMPLE]);
 const pkg=resultsMapPackage(rolled,null,true,false,proposedControlCounts([CCM_EXAMPLE],rolled.controls.map(c=>c.id)));
 assert.equal(pkg.controls.length,27);assert.equal(pkg.map.families.length,11);
 const original=buildLayout(pkg,1280,false,new Set(pkg.controls.map(c=>c.id)),false);
 const status=new Set([original.controls[0].id]);const compact=coverageOverviewLayout(original,status,350);
 assert.deepEqual(compact.controls.map(c=>c.id),original.controls.map(c=>c.id));
 assert.deepEqual(compact.lanes.map(l=>l.id),original.lanes.map(l=>l.id));
 assert.ok(compact.height<500,'Overview must not shrink labels to fit a long single-column stack');
 for(const c of compact.controls){
  const l=compact.lanes.find(l=>l.id===c.family)!;
  assert.ok(c.x>=l.x+6 && c.x+c.w<=l.x+l.w-6+0.01);
  assert.ok(c.y>=l.y+l.headerH+12 && c.y+c.h<=l.y+l.h-12+0.01);
  assert.equal(c.h,status.has(c.id)?52:28);
  for(const other of compact.controls.filter(o=>o.id!==c.id))assert.ok(c.x+c.w<=other.x || other.x+other.w<=c.x || c.y+c.h<=other.y || other.y+other.h<=c.y);
 }
 assert.ok(compact.height-Math.max(...compact.lanes.map(l=>l.y+l.h))>=32);
 for(const band of [...new Set(compact.lanes.map(l=>l.band))].slice(1)){const previous=compact.lanes.filter(l=>l.band===band-1),next=compact.lanes.find(l=>l.band===band)!;assert.ok(next.y-Math.max(...previous.map(l=>l.y+l.h))>=36);}
 assert.equal(compact.roles,original.roles);assert.equal(compact.evidence,original.evidence);
});
