import {it,expect} from "vitest";
import {zoomAt,fitMap,fitBox,revealBox,unionBox} from "../lib/aegis/map-zoom";
it("keeps the world point under the pointer fixed while zooming",()=>{
 const before={scale:1.2,x:-120,y:-60},pointer={x:400,y:250};const after=zoomAt(before,2,pointer);
 expect((pointer.x-after.x)/after.scale).toBeCloseTo((pointer.x-before.x)/before.scale);expect((pointer.y-after.y)/after.scale).toBeCloseTo((pointer.y-before.y)/before.scale);
 expect(zoomAt(before,20,pointer).scale).toBe(3);expect(zoomAt(before,0,pointer).scale).toBe(.25);
});
it("fits both axes and returns origin without reflowing content",()=>{expect(fitMap({width:1600,height:1000},{width:800,height:700})).toEqual({scale:.5,x:0,y:0});});
// Item c: Fit and auto fit include every line, arrowhead and box, not just the cards.
it("fits a content box that includes lines outside the cards",()=>{
 const box=unionBox([{x:20,y:10,w:400,h:200},{x:-30,y:150,w:10,h:300}],12)!;
 expect(box).toEqual({x:-42,y:-2,w:474,h:464});
 const view=fitBox(box,1,{width:800,height:400});
 expect(view.scale).toBeCloseTo(384/464);
 expect(box.x*view.scale+view.x).toBeCloseTo(8);expect(box.y*view.scale+view.y).toBeCloseTo(8);
 expect((box.y+box.h)*view.scale+view.y).toBeLessThanOrEqual(392.01);
});
it("auto fit leaves a visible selection alone, moves a clipped one and zooms out only when needed",()=>{
 const vp={width:800,height:500};
 expect(revealBox({x:100,y:100,w:200,h:100},{scale:1,x:0,y:0},1,vp)).toBeNull();
 const moved=revealBox({x:100,y:-60,w:200,h:100},{scale:1,x:0,y:0},1,vp)!;
 expect(moved).toEqual({scale:1,x:0,y:68});
 const shrunk=revealBox({x:0,y:0,w:1600,h:300},{scale:1,x:0,y:0},1,vp)!;
 expect(shrunk.scale).toBeCloseTo(784/1600);expect(shrunk.x).toBeCloseTo(8);
 // A scrolled stage counts: the box sits above the visible part.
 expect(revealBox({x:20,y:100,w:100,h:100},{scale:1,x:0,y:0},1,vp,{left:0,top:200})).toEqual({scale:1,x:0,y:108});
});
it("Fit may go below the zoom buttons' minimum; zooming out from there holds the Fit scale instead of jumping back up",()=>{
 const view=fitBox({x:0,y:0,w:4000,h:4000},1,{width:816,height:416});
 expect(view.scale).toBeCloseTo(.1);
 expect(zoomAt(view,view.scale/1.2,{x:0,y:0}).scale).toBeCloseTo(.1);
 expect(zoomAt(view,view.scale*1.2,{x:0,y:0}).scale).toBeCloseTo(.12);
});
