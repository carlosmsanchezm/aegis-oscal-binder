import {it,expect} from "vitest";
import {packageMapR2} from "../lib/aegis/package-map-r2";
import {map} from "./pmap-r2-fixture";
it.each([1440,1920])("fills every family row at %i without reserving an inspector column",width=>{
 const layout=packageMapR2(map,width,700);
 for(const band of new Set(layout.lanes.map(lane=>lane.band))){
  const lanes=layout.lanes.filter(lane=>lane.band===band);
  expect(Math.min(...lanes.map(lane=>lane.x))).toBeCloseTo(16);
  expect(Math.max(...lanes.map(lane=>lane.x+lane.w))).toBeCloseTo(width-16);
 }
 expect(layout.height).toBeGreaterThanOrEqual(700);
 expect(layout.controls.map(c=>c.id).sort()).toEqual(map.controls.map(c=>c.id).sort());
 for(const c of layout.controls){const lane=layout.lanes.find(l=>l.id===c.family)!;expect(c.x).toBeGreaterThan(lane.x);expect(c.x+c.w).toBeLessThanOrEqual(lane.x+lane.w);}
});
