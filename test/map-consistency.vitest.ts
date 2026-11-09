import {describe,it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {RollupMap} from "../components/binder/RollupMap";
import {resultsMapPackage} from "../lib/aegis/results-map";
import {mergeStoredReleases,PODINFO_RETEST_RECEIPT} from "../lib/aegis/control-rollup";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {findRepoRoot} from "../lib/aegis/paths";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {receivedRetest} from "./support/received-retest";
const shell=moderateRollupShell(findRepoRoot());
const record=receivedRetest();
const boutique={...CCM_EXAMPLE,pipelineUrl:"https://gitlab.com/reference/online-boutique/-/pipelines/42",pipelineId:"42"};
const scenarios=[{name:"No evidence",history:[]},{name:"Podinfo",history:[CCM_EXAMPLE,PODINFO_RETEST_RECEIPT]},{name:"Received pipeline evidence",history:[CCM_EXAMPLE,record]},{name:"Online Boutique",history:[boutique]}];
const subset={...shell,loaded:true,controls:shell.controls.filter(c=>["AC-2","CM-6","AU-2"].includes(c.id)),map:{...shell.map,families:shell.map.families.filter(f=>["AC","CM","AU"].includes(f.id))}};
describe.each(scenarios)("$name",({history})=>{
 for(const loaded of [false,true])for(const snapshot of ["newest","older","None"]){
  it(`keeps family trees and usable layers with SSP ${loaded} and snapshot ${snapshot}`,()=>{
   const current=snapshot==="older" ? history[0] ?? record : history.at(-1) ?? record;
   const pkg=applyReleaseRollup(shell,history,loaded?subset:null);
   const html=renderToStaticMarkup(createElement(RollupMap,{pkg,basePkg:loaded?subset:undefined,history,record:current,highlighted:snapshot!=="None"&&history.length>0,packageControlIds:[],onRecordChange(){},onRelease(){}}));
   expect(html).toContain('data-layout-engine="round21"');
   expect(html).not.toMatch(/pmap-related-chip|pmap-coverage-overview/);
   if(history.length){expect(html).toContain("Evidence files");expect(html.match(/<button([^>]*)><i[^>]*>[^<]*<\/i>SSP evidence<\/button>/)?.[1]).not.toContain("disabled");expect(html).not.toContain('class="map-no-ssp"');}
   if(loaded)expect(html).toContain("pmap-coverage-ticks");
  });
 }
 it("keeps the same controls and families when the overlay is switched",()=>{
  const pkg=applyReleaseRollup(shell,history);
  const a=resultsMapPackage(pkg,subset,true,false),b=resultsMapPackage(pkg,subset,false,false);
  expect(a.controls.map(c=>c.id)).toEqual(b.controls.map(c=>c.id));
  expect(a.map.families).toEqual(b.map.families);
 });
});
it("stored history never injects a fixture into another workspace",()=>{
 expect(mergeStoredReleases([],CCM_EXAMPLE.pipelineUrl)).toEqual([]);
 expect(mergeStoredReleases([boutique],boutique.pipelineUrl)).toHaveLength(1);
 expect(mergeStoredReleases([CCM_EXAMPLE],CCM_EXAMPLE.pipelineUrl)).not.toContainEqual(PODINFO_RETEST_RECEIPT);
});

import {generatedMapFixture,type FixtureSize} from "./support/map-fixtures";
import {packageMapGeometry} from "../lib/aegis/package-map-geometry";
for(const size of ["tiny","medium","huge","random"] as FixtureSize[])it(`${size} seeded import has stable family trees and nonoverlapping cards`,()=>{
 const fixture=generatedMapFixture(5721,size);
 const pkg=resultsMapPackage(applyReleaseRollup(shell,fixture.records),null,true,false);
 const map={...pkg,map:{...pkg.map,edges:fixture.edges}};
 expect(generatedMapFixture(5721,size).records).toEqual(fixture.records);
 if(size==="huge"){expect(fixture.ids.size).toBe(323);expect(fixture.artifacts.length).toBeGreaterThan(2000);expect(map.map.families).toHaveLength(18);}
 for(const width of [1280,1440,1920])for(const panel of [false,true]){
  const geometry=packageMapGeometry(map,width,panel,900);
  if(size==="huge"){expect(geometry.width).toBe(width);expect(Math.min(...geometry.lanes.map(lane=>lane.x))).toBeLessThanOrEqual(64);expect(width-Math.max(...geometry.lanes.map(lane=>lane.x+lane.w))).toBeLessThanOrEqual(64);}
  for(const [i,a] of geometry.controls.entries())for(const b of geometry.controls.slice(i+1))expect(Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y)).toBe(false);
 }
});

import {compactFaceLines} from "../lib/aegis/compact-face";
it("compact faces preserve the full title separately and fit every catalog control",()=>{
 for(const control of shell.controls)for(const width of [46,60,88]){
  const lines=compactFaceLines(control.id,control.title,width);
  expect(lines).toHaveLength(2);expect(lines.every(line=>!line.includes("\n"))).toBe(true);
 }
 expect(compactFaceLines("CM-6","Configuration Settings",60)).toEqual(["Config","Settings"]);
});
it("planning cards are square for linked and proposed controls and None has no completeness footer",()=>{
 for(const highlighted of [false,true]){
  const pkg=applyReleaseRollup(shell,[CCM_EXAMPLE,PODINFO_RETEST_RECEIPT],subset);
  const html=renderToStaticMarkup(createElement(RollupMap,{pkg,basePkg:subset,history:[CCM_EXAMPLE,PODINFO_RETEST_RECEIPT],record:PODINFO_RETEST_RECEIPT,highlighted,packageControlIds:[],onRecordChange(){},onRelease(){}}));
  expect(html).toContain('data-map-style="planning"');expect(html).not.toContain('mark-ok');
  const faces=html.match(/<button[^>]*data-control-id="[^"]+"[^>]*>/g) ?? [];
  expect(faces.length).toBeGreaterThan(0);
  expect(faces.every(face=>{const w=/width:([\d.]+)px/.exec(face),h=/height:([\d.]+)px/.exec(face);return w&&h&&Math.abs(Number(w[1])-Number(h[1]))<.01;})).toBe(true); // BUI-024 replaces the old 36 and 77 pixel faces.
 }
});
