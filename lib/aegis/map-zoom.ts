export type MapZoom={scale:number;x:number;y:number};
export const mapZoomLimits={min:.25,max:3};
export function zoomAt(view:MapZoom,scale:number,pointer:{x:number;y:number}):MapZoom{
 // A Fit below the usual minimum stays reachable: zooming never jumps up past the current scale.
 const next=Math.min(mapZoomLimits.max,Math.max(Math.min(mapZoomLimits.min,view.scale),Number.isFinite(scale)?scale:1));
 const ratio=next/view.scale;
 return {scale:next,x:pointer.x-(pointer.x-view.x)*ratio,y:pointer.y-(pointer.y-view.y)*ratio};
}
export function fitMap(content:{width:number;height:number},viewport:{width:number;height:number}):MapZoom{
 const scale=Math.max(mapZoomLimits.min,Math.min(1,viewport.width/Math.max(1,content.width),viewport.height/Math.max(1,content.height)));
 return {scale,x:0,y:0};
}
/** A box in map units: cards, frames, and the drawn lines with their arrowheads. */
export type MapBox={x:number;y:number;w:number;h:number};
export function unionBox(boxes:readonly MapBox[],pad=0):MapBox|null{
 if(!boxes.length)return null;
 const x=Math.min(...boxes.map(b=>b.x))-pad,y=Math.min(...boxes.map(b=>b.y))-pad;
 return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))+pad-x,h:Math.max(...boxes.map(b=>b.y+b.h))+pad-y};
}
/** Fit: the whole box on screen, top left, never above 100%. `base` is the map's own scale (side panel room). */
export function fitBox(box:MapBox,base:number,viewport:{width:number;height:number},margin=8):MapZoom{
 // Fit may go below the zoom buttons' minimum: the whole map, lines included, must be on screen (item c).
 const scale=Math.max(.05,Math.min(1,(viewport.width-margin*2)/Math.max(1,box.w*base),(viewport.height-margin*2)/Math.max(1,box.h*base)));
 const k=base*scale;
 return {scale,x:margin-box.x*k,y:margin-box.y*k};
}
/** Auto fit after a selection: null when the box is already fully visible; otherwise the smallest move
 * (zooming out only when the box cannot fit at the current zoom) that brings every line and arrowhead into view.
 * `scroll` is the stage scroll offset in screen pixels. */
export function revealBox(box:MapBox,view:MapZoom,base:number,viewport:{width:number;height:number},scroll:{left:number;top:number}={left:0,top:0},margin=8):MapZoom|null{
 let next=view,k=base*view.scale;
 if(box.w*k>viewport.width-margin*2||box.h*k>viewport.height-margin*2){
  const fitted=fitBox(box,base,viewport,margin);
  next={...view,scale:Math.min(view.scale,fitted.scale)};k=base*next.scale;
 }
 const left=box.x*k+next.x-scroll.left,top=box.y*k+next.y-scroll.top,right=left+box.w*k,bottom=top+box.h*k;
 const dx=left<margin?margin-left:right>viewport.width-margin?Math.max(margin-left,viewport.width-margin-right):0;
 const dy=top<margin?margin-top:bottom>viewport.height-margin?Math.max(margin-top,viewport.height-margin-bottom):0;
 if(next===view&&!dx&&!dy)return null;
 return {scale:next.scale,x:next.x+dx,y:next.y+dy};
}
