import {it,expect} from "vitest";
import {packageMapR2,FAMILY_TITLE_PX} from "../lib/aegis/package-map-r2";
import {clearStem} from "../lib/aegis/selected-tree";
import {manropeWidth} from "../lib/aegis/map-layout";
import {map} from "./pmap-r2-fixture";
// Package map live fixes round 2. Real Boutique recordings are test inputs only.
const onMap=map.controls.map(c=>c.id);
const files=[{name:"a/configuration.json",controlIds:onMap.slice(0,3)},{name:"b/configuration.json",controlIds:onMap.slice(0,3)},{name:"image.json",controlIds:onMap.slice(2,5)},{name:"elsewhere.json",controlIds:["ZZ-99"]}];
it("a and d: evidence files are evidence boxes of the layout, under their main family, with room for lines between them",()=>{
 const layout=packageMapR2(map,1440,800,{pipeFiles:files});
 const pipes=layout.evidence.filter(e=>(e as {pipe?:boolean}).pipe);
 // A file whose controls are not on the map gets no box (the export does the same).
 expect(pipes.map(e=>e.title).sort()).toEqual(["a/configuration.json","b/configuration.json","image.json"]);
 for(const box of pipes){
  const band=layout.bands[box.band];
  expect(box.y).toBeGreaterThanOrEqual(band.boxBottom);expect(box.y+box.h).toBeLessThanOrEqual(band.bottom);
  for(const other of pipes)if(other!==box){
   const gapX=Math.max(other.x-(box.x+box.w),box.x-(other.x+other.w)),gapY=Math.max(other.y-(box.y+box.h),box.y-(other.y+other.h));
   expect(Math.max(gapX,gapY)).toBeGreaterThanOrEqual(16);
  }
 }
});
it("e: every family header uses one title size; a row with a long title gets a taller header, never smaller type",()=>{
 const layout=packageMapR2(map,1280,800);
 for(const band of new Set(layout.lanes.map(l=>l.band))){
  const row=layout.lanes.filter(l=>l.band===band);
  expect(new Set(row.map(l=>l.headerH)).size).toBe(1);
  const wraps=row.some(l=>manropeWidth(l.title,FAMILY_TITLE_PX,600)>l.w-24);
  expect(row[0].headerH).toBe(wraps?52+Math.ceil(FAMILY_TITLE_PX*1.3):52);
 }
});
it("g: the last resort stem keeps clear of evidence boxes",()=>{
 const selected={id:"S",family:"A",x:100,y:300,w:40,h:40},target={id:"T",family:"B",x:100,y:20,w:40,h:40};
 const wall={x:60,y:150,w:120,h:48};
 const route=clearStem({selected,targets:[target],lanes:[],controls:[selected,target],obstacles:[wall],width:400,height:400,clearStems:true},target)!;
 expect(route).not.toBeNull();
 const crosses=route.slice(1).some((p,i)=>{const a=route[i];return Math.max(a.x,p.x)>wall.x&&Math.min(a.x,p.x)<wall.x+wall.w&&Math.max(a.y,p.y)>wall.y&&Math.min(a.y,p.y)<wall.y+wall.h;});
 expect(crosses).toBe(false);
 expect(route[0]).toEqual({x:120,y:300});expect(route.at(-1)).toEqual({x:120,y:60});
});
