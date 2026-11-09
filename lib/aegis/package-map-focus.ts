import {buildLayout} from './map-placement';
import {manropeWidth} from './map-layout';
import {FocusRouter,type Rect} from './focus-router';
import type {PackageState} from './types';
import type {R2Options} from './package-map-r2';
export type ProviderBox={id:string;title:string;subtitle:string;controlIds:string[];example?:boolean};
export type FocusOptions=Omit<R2Options,'mode'|'custom'|'fixed'>&{focusFamily?:string|null;focusControl?:string|null;providers?:ProviderBox[];fixed?:{mm:number}};
export type FocusSpoke={id:string;from:string;to:string;d:string;glyph:'mutual'|'outbound'|'reverse';count:number;label?:{x:number;y:number}};
const PAD=16,GAP=44,CARD_GAP=16,TILE_GAP=10,ROW_GAP=30,HEADER=52;
/** Content-sized families orbit the strongest/selected family or selected control.
 * All sizes and packing priorities follow the supplied revision 3b board. */
export function packageMapFocus(pkg:PackageState,width:number,height:number,options:FocusOptions={}){
 const W=Math.max(650,width),H=Math.max(420,height||900),original=buildLayout(pkg,W,false,undefined,true,false);
 const onMap=new Set(original.controls.map(c=>c.id)),familyOf=new Map(original.controls.map(c=>[c.id,c.family]));
 const families=original.lanes.filter(f=>f.memberIds.length),hub=options.focusControl&&onMap.has(options.focusControl)?options.focusControl:null;
 const key=(a:string,b:string)=>a<b?`${a}|${b}`:`${b}|${a}`;
 const pairs=new Map<string,{a:string;b:string;ab:boolean;ba:boolean}>();
 for(const edge of pkg.map.edges){if(!onMap.has(edge.fromId)||!onMap.has(edge.toId)||edge.fromId===edge.toId)continue;const k=key(edge.fromId,edge.toId),pair=pairs.get(k)??{a:edge.fromId<edge.toId?edge.fromId:edge.toId,b:edge.fromId<edge.toId?edge.toId:edge.fromId,ab:false,ba:false};if(edge.fromId===pair.a)pair.ab=true;else pair.ba=true;if(edge.mutual)pair.ab=pair.ba=true;pairs.set(k,pair);}
 const weights=new Map<string,number>(),directions=new Map<string,{out:number;in:number}>();
 for(const pair of pairs.values()){const a=familyOf.get(pair.a)!,b=familyOf.get(pair.b)!;if(a===b)continue;weights.set(key(a,b),(weights.get(key(a,b))??0)+1);const ab=directions.get(`${a}>${b}`)??{out:0,in:0},ba=directions.get(`${b}>${a}`)??{out:0,in:0};if(pair.ab){ab.out++;ba.in++;}if(pair.ba){ba.out++;ab.in++;}directions.set(`${a}>${b}`,ab);directions.set(`${b}>${a}`,ba);}
 const degree=(id:string)=>families.reduce((sum,f)=>sum+(weights.get(key(id,f.id))??0),0),neighbors=new Map<string,{out:boolean;in:boolean}>();
 if(hub)for(const pair of pairs.values()){if(pair.a!==hub&&pair.b!==hub)continue;neighbors.set(pair.a===hub?pair.b:pair.a,{out:pair.a===hub?pair.ab:pair.ba,in:pair.a===hub?pair.ba:pair.ab});}
 const centerFamily=hub?familyOf.get(hub)!:options.focusFamily&&families.some(f=>f.id===options.focusFamily)?options.focusFamily:[...families].sort((a,b)=>degree(b.id)-degree(a.id)||families.indexOf(a)-families.indexOf(b))[0]?.id;
 const affinity=(id:string)=>hub?[...neighbors.keys()].filter(c=>familyOf.get(c)===id).length+(id===centerFamily?.5:0):id===centerFamily?1e9:weights.get(key(centerFamily??'',id))??0;
 const order=[...families].sort((a,b)=>affinity(b.id)-affinity(a.id)||families.indexOf(a)-families.indexOf(b));
 const focus=(id:string):'center'|'near'|'far'=>!hub&&id===centerFamily?'center':affinity(id)>0?'near':'far';
 const tile=(id:string)=>Boolean(options.touchedIds&&!options.touchedIds.has(id));
 const size=(lane:typeof families[number],mm:number)=>{
  const k=focus(lane.id)==='center'?1.12:focus(lane.id)==='far'?Math.max(.82,Math.min(1,54/mm)):1,cw=mm*k,tw=mm*.62*k;
  const members=original.controls.filter(c=>c.family===lane.id&&c.id!==hub).map(c=>c.id),active=members.filter(c=>!tile(c)),quiet=members.filter(tile);
  let cols=active.length?Math.max(1,Math.ceil(Math.sqrt(active.length*1.6))):0,tcols=quiet.length?Math.max(1,Math.ceil(Math.sqrt(quiet.length*2.4))):0;
  const titleW=manropeWidth(lane.title||'',13,600)+28,w=Math.min(W-PAD*2,Math.max(120,cols?cols*(cw+CARD_GAP)-CARD_GAP+24:0,tcols?tcols*(tw+TILE_GAP)-TILE_GAP+24:0,Math.min(titleW,300)));
  cols=active.length?Math.max(1,Math.floor((w-24+CARD_GAP)/(cw+CARD_GAP)+1e-6)):0;tcols=quiet.length?Math.max(1,Math.floor((w-24+TILE_GAP)/(tw+TILE_GAP)+1e-6)):0;
  const headerH=HEADER+(titleW>w?17:0),rows=cols?Math.ceil(active.length/cols):0,trows=tcols?Math.ceil(quiet.length/tcols):0;
  const h=headerH+24+(rows?rows*cw+(rows-1)*ROW_GAP:0)+(trows?(rows?16:0)+trows*36-10:0)+12+(rows||trows?0:24);
  return {lane,k,w,h,headerH,cols,tcols,cw,tw,active,quiet};
 };
 type Sized=ReturnType<typeof size>;type Placed=Rect&{block?:Sized;hub?:boolean};
 const segmentHits=(x:number,y:number,tx:number,ty:number,r:Rect)=>{
  let lo=0,hi=1;const dx=tx-x,dy=ty-y,p=[-dx,dx,-dy,dy],q=[x-r.x,r.x+r.w-x,y-r.y,r.y+r.h-y];
  for(let i=0;i<4;i++){if(p[i]===0){if(q[i]<0)return false;continue;}const u=q[i]/p[i];if(p[i]<0){if(u>hi)return false;lo=Math.max(lo,u);}else{if(u<lo)return false;hi=Math.min(hi,u);}}return true;
 };
 const pack=(mm:number)=>{
  const blocks=order.map(l=>size(l,mm)),placed:Placed[]=[],rays:number[][]=[],cx=W/2,cy=H/2,aspect=Math.max(1,(W-32)/H)*1.25;
  let rest=blocks;if(hub){const w=mm*1.8;placed.push({x:cx-w/2,y:cy-w/2,w,h:w,hub:true});}else if(blocks[0]){placed.push({x:Math.max(PAD,cx-blocks[0].w/2),y:cy-blocks[0].h/2,w:blocks[0].w,h:blocks[0].h,block:blocks[0]});rest=blocks.slice(1);}
  for(const [index,block] of rest.entries()){
   let best:{x:number;y:number;score:number}|null=null,first:number|null=null;const near=affinity(block.lane.id)>0;
   for(let radius=24;radius<5000&&(first===null||radius<first+240);radius+=16)for(let angle=0;angle<36;angle++){
    const rad=((angle*10+index*37)%360)*Math.PI/180,x=cx+Math.cos(rad)*radius*aspect-block.w/2,y=cy+Math.sin(rad)*radius-block.h/2;
    if(x<PAD||x+block.w>W-PAD)continue;const gap=near?GAP:GAP*.75;
    if(placed.some(b=>x<b.x+b.w+gap&&x+block.w+gap>b.x&&y<b.y+b.h+gap&&y+block.h+gap>b.y))continue;
    if(near&&rays.some(r=>segmentHits(r[0],r[1],r[2],r[3],{x:x-12,y:y-12,w:block.w+24,h:block.h+24})))continue;
    first??=radius;let score=Math.hypot((x+block.w/2-cx)/aspect,(y+block.h/2-cy)*1.25);
    if(near)for(const b of placed.slice(1))if(segmentHits(cx,cy,x+block.w/2,y+block.h/2,{x:b.x+6,y:b.y+6,w:b.w-12,h:b.h-12}))score+=4000;
    if(!best||score<best.score)best={x,y,score};
   }
   const spot=best??{x:PAD,y:Math.max(0,...placed.map(b=>b.y+b.h))+GAP};placed.push({x:spot.x,y:spot.y,w:block.w,h:block.h,block});if(near)rays.push([cx,cy,spot.x+block.w/2,spot.y+block.h/2]);
  }
  const top=Math.min(...placed.map(b=>b.y),placed.length?Infinity:0),bottom=Math.max(0,...placed.map(b=>b.y+b.h));return {placed,top,height:bottom-top};
 };
 const allPipeItems=(options.pipeFiles??[]).map(f=>({id:`pipe:${f.name}`,uuid:`pipe:${f.name}`,displayId:'PIPELINE',title:f.name,subtitle:`${f.controlIds.length} mapped controls`,detail:'',controlIds:f.controlIds.filter(id=>onMap.has(id)),inventory:Boolean(f.inventory),families:new Set<string>(),x:0,y:0,w:0,h:48,row:0,band:0,host:'',placement:'family' as const,displaced:false,pipe:true,provider:false}));
 const pipeItems=allPipeItems.filter(f=>f.controlIds.length);
 const providerItems=(options.providers??[]).map(p=>({...p,uuid:p.id,displayId:'LEVERAGED',detail:p.example?'EXAMPLE DATA':'',controlIds:p.controlIds.filter(id=>onMap.has(id)),families:new Set<string>(),x:0,y:0,w:0,h:48,row:0,band:0,host:'',placement:'family' as const,displaced:false,pipe:false,provider:true})).filter(p=>p.controlIds.length);
 const items=[...(options.showEvidence===false?[]:original.evidence).map(e=>({...e,pipe:false,provider:false})),...pipeItems,...providerItems];
 const place=(packed:ReturnType<typeof pack>)=>{
  const dy=16-packed.top,lanes:Array<typeof families[number]&{k:number;focus:'center'|'near'|'far'}>=[],controls:Array<typeof original.controls[number]&{hub?:boolean}>=[];let hubRect:Rect|null=null;
  for(const p of packed.placed){if(p.hub){hubRect={x:p.x,y:p.y+dy,w:p.w,h:p.h};controls.push({...original.controls.find(c=>c.id===hub)!,...hubRect,hub:true});continue;}
   const b=p.block!,y=p.y+dy,controlY=y+b.headerH+24;
   for(const [i,id] of b.active.entries())controls.push({...original.controls.find(c=>c.id===id)!,x:p.x+12+i%b.cols*(b.cw+CARD_GAP),y:controlY+Math.floor(i/b.cols)*(b.cw+ROW_GAP),w:b.cw,h:b.cw});
   const rows=b.cols?Math.ceil(b.active.length/b.cols):0,ty=controlY+(rows?rows*b.cw+(rows-1)*ROW_GAP+16:0);
   for(const [i,id] of b.quiet.entries())controls.push({...original.controls.find(c=>c.id===id)!,x:p.x+12+i%b.tcols*(b.tw+TILE_GAP),y:ty+Math.floor(i/b.tcols)*36,w:b.tw,h:26});
   lanes.push({...b.lane,x:p.x,y,w:b.w,h:b.h,headerH:b.headerH,band:0,k:b.k,focus:focus(b.lane.id)});
  }
  const familyTop=Math.min(16,...lanes.map(l=>l.y),hubRect?.y??Infinity),occupied:Rect[]=[...lanes,...hubRect?[hubRect]:[]],evidence:typeof items=[];
  const byId=new Map(controls.map(c=>[c.id,c]));
  for(const item of [...items].sort((a,b)=>b.controlIds.length-a.controlIds.length||(a.displayId??a.id).localeCompare(b.displayId??b.id,undefined,{numeric:true}))){
   const targets=item.controlIds.map(id=>byId.get(id)).filter((c):c is NonNullable<typeof c>=>Boolean(c));if(!targets.length)continue;
   const cx=targets.reduce((s,c)=>s+c.x+c.w/2,0)/targets.length,cy=targets.reduce((s,c)=>s+c.y+c.h/2,0)/targets.length;let spot:{x:number;y:number}|null=null;
   for(let radius=0;radius<6000&&!spot;radius+=12)for(let angle=0;angle<(radius?32:1);angle++){
    const r=angle*11.25*Math.PI/180,x=cx+Math.cos(r)*radius-75,y=cy+Math.sin(r)*radius-24;
    if(x<PAD||x+150>W-PAD||y<familyTop)continue;if(occupied.some(b=>x<b.x+b.w+16&&x+166>b.x&&y<b.y+b.h+16&&y+64>b.y))continue;spot={x,y};break;
   }
   spot??={x:PAD,y:Math.max(16,...occupied.map(b=>b.y+b.h))+16};const host=[...lanes].sort((a,b)=>b.memberIds.filter(id=>item.controlIds.includes(id)).length-a.memberIds.filter(id=>item.controlIds.includes(id)).length)[0]?.id??'';
   const box={...item,...spot,w:150,h:48,host};evidence.push(box);occupied.push(box);
  }
  const bottom=Math.max(76,...occupied.map(b=>b.y+b.h));return {lanes,controls,hubRect,familyTop,evidence,byId,bottom,height:bottom-familyTop};
 };
 let mm=options.fixed?.mm??60;if(!options.fixed){let low=60,high=170;for(let i=0;i<8;i++){const mid=(low+high)/2;if(pack(mid).height<=H-28){low=mid;mm=mid;}else high=mid;}}
 let placed=place(pack(mm));for(let i=0;!options.fixed&&i<3&&placed.height>H-28&&mm>60;i++){mm=Math.max(60,mm*.88);placed=place(pack(mm));}
 // Neutral inventory uses existing overflow placement after fitting. It cannot
 // resize/reposition control families or acquire a fabricated coverage edge.
 for(const item of allPipeItems.filter(f=>f.inventory&&!f.controlIds.length)){
  const box={...item,x:PAD,y:placed.bottom+16,w:150,h:48};placed.evidence.push(box);placed.bottom=box.y+box.h;
 }
 const {lanes,controls,hubRect,familyTop,evidence,byId,bottom}=placed,canvasBottom=bottom+48,router=new FocusRouter(W,familyTop,canvasBottom-6,lanes,controls,evidence,hubRect),spokes:FocusSpoke[]=[];
 if(hub&&hubRect){for(const [id,dir] of [...neighbors].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}))){const c=byId.get(id);if(!c)continue;const route=router.route(hubRect,null,c,familyOf.get(id)??null,'spoke');spokes.push({id:`sp-${id}`,from:hub,to:id,d:route?.d??'',glyph:dir.out&&dir.in?'mutual':dir.out?'outbound':'reverse',count:1});}}
 else if(centerFamily){const center=lanes.find(l=>l.id===centerFamily);if(center)for(const lane of lanes){if(lane.id===centerFamily)continue;const count=weights.get(key(centerFamily,lane.id))??0;if(!count)continue;const dir=directions.get(`${centerFamily}>${lane.id}`)??{out:0,in:0},route=router.route(center,null,lane,null,'spoke');spokes.push({id:`sp-${lane.id}`,from:centerFamily,to:lane.id,d:route?.d??'',glyph:dir.out&&dir.in?'mutual':dir.out?'outbound':'reverse',count,label:route?.mid});}}
 return {...original,roles:[],pills:[],width:W,lanes,controls,evidence,bands:[{top:16,boxTop:16,boxBottom:bottom,controlY:16,evidenceY:16,bottom:canvasBottom-24}],mm,fixed:{mm,k:Object.fromEntries(lanes.map(l=>[l.id,l.k]))},height:Math.max(height,canvasBottom),controlY:16,evidenceY:16,boxTop:16,focus:{family:centerFamily??null,hub,hubRect,familyTop},spokes,router,
  evidenceRoutes:(id:string,only?:ReadonlySet<string>)=>router.tree(evidence.find(e=>e.uuid===id)??evidence.find(e=>e.id===id)??null,byId,only),
  relatedFrom:(id:string):FocusSpoke[]=>{const source=byId.get(id);if(!source)return [];const routes:FocusSpoke[]=[];for(const pair of pairs.values()){if(pair.a!==id&&pair.b!==id)continue;const other=pair.a===id?pair.b:pair.a,target=byId.get(other);if(!target)continue;const out=pair.a===id?pair.ab:pair.ba,inbound=pair.a===id?pair.ba:pair.ab,route=router.route(source,familyOf.get(id)??null,target,familyOf.get(other)??null,`hover:${id}`);routes.push({id:`hv-${id}-${other}`,from:id,to:other,d:route?.d??'',glyph:out&&inbound?'mutual':out?'outbound':'reverse',count:1});}return routes;}
 };
}
export type FocusLayout=ReturnType<typeof packageMapFocus>;
