import {it,expect} from 'vitest';
import {packageMapFocus} from '../lib/aegis/package-map-focus';
import {providerExtent,providerBoxes} from '../lib/aegis/provider-coverage';
import {map} from './pmap-r2-fixture';
it('centers the most connected family, then the requested family and control',()=>{
 const layout=packageMapFocus(map,1440,500);expect(layout.focus.family).toBe('CM');expect(layout.spokes.every(s=>s.d)).toBe(true);
 for(const lane of layout.lanes){const focused=packageMapFocus(map,1440,500,{focusFamily:lane.id});expect(focused.focus.family).toBe(lane.id);expect(focused.lanes.find(l=>l.id===lane.id)?.focus).toBe('center');}
 for(const c of map.controls){const selected=packageMapFocus(map,1280,420,{focusControl:c.id});expect(selected.focus.hub).toBe(c.id);expect(selected.controls.find(n=>n.id===c.id)?.hub).toBe(true);expect(selected.spokes.every(s=>s.d),c.id).toBe(true);}
});
it('places evidence in open space below the top family and outside every family',()=>{
 const layout=packageMapFocus(map,1280,420,{pipeFiles:map.controls.map(c=>({name:`EXAMPLE-${c.id}`,controlIds:[c.id]}))});
 for(const e of layout.evidence){expect(e.y).toBeGreaterThanOrEqual(layout.focus.familyTop);for(const b of layout.lanes)expect(e.x<b.x+b.w&&e.x+e.w>b.x&&e.y<b.y+b.h&&e.y+e.h>b.y).toBe(false);}
});
it('uses supplied provider coverage only; example provider values remain fixtures',()=>{
 expect(providerBoxes(map)).toEqual([]);expect(providerExtent(map.controls[0])).toBe(null);
 const example={...map,controls:map.controls.map((c,i)=>({...c,providerCoverage:i<2?[{provider:{id:'EXAMPLE-provider',title:'EXAMPLE provider',example:true},coverage:i===0?'all' as const:'part' as const}]:undefined}))};
 expect(providerExtent(example.controls[0])).toBe('all');expect(providerExtent(example.controls[1])).toBe('part');expect(providerBoxes(example)[0].controlIds).toHaveLength(2);
 const layout=packageMapFocus(example,1440,500,{providers:providerBoxes(example)});expect(layout.evidence.filter(e=>e.provider)).toHaveLength(1);
});
it('keeps neutral inventory tiles separate without moving controls or inventing coverage',()=>{
 const before=packageMapFocus(map,1440,500);
 const after=packageMapFocus(map,1440,500,{pipeFiles:[{name:'commercial-summary.json',controlIds:[],inventory:true},{name:'govcloud-summary.json',controlIds:[],inventory:true}]});
 expect(after.controls).toEqual(before.controls);expect(after.lanes).toEqual(before.lanes);expect(after.mm).toBe(before.mm);
 const summaries=after.evidence.filter(e=>e.pipe);expect(summaries).toHaveLength(2);
 for(const tile of summaries){expect(tile.controlIds).toEqual([]);expect(tile.host).toBe('');expect(tile.y).toBeGreaterThanOrEqual(Math.max(...before.lanes.map(l=>l.y+l.h)));}
});
