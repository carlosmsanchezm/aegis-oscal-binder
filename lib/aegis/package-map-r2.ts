import {arrangeFamilies,familyWeights,type ArrangeMode} from "./family-arrange";
import {buildLayout} from "./map-placement";
import {placeOneRow,packRow,manropeWidth} from "./map-layout";
import type {PackageState} from "./types";
export type R2Fixed={mm:number;k:Record<string,number>};
export type R2Options={mode?:ArrangeMode;custom?:string[];touchedIds?:ReadonlySet<string>;showEvidence?:boolean;
 /** Chosen pipeline evidence files. As in the r2 export they are evidence boxes of the layout, placed in the row
  * under their main family and routed by the same attachment trees, so each file leaves by one bundled line. */
 pipeFiles?:ReadonlyArray<{name:string;controlIds:readonly string[];inventory?:boolean}>;
 /** Card size and row scales of the full map, so hiding suggested cards does not resize the rest. */
 fixed?:R2Fixed};

const CONTROL_GAP=6,FAMILY_GAP=10,PAD=16,HEADER_H=52,MAX_ROW_SCALE=2.6;
/** One type size for every family header on the map: code, count and full title. */
export const FAMILY_CODE_PX=18,FAMILY_TITLE_PX=13,FAMILY_COUNT_PX=13;
const TITLE_LINE=Math.ceil(FAMILY_TITLE_PX*1.3);
/** Room between evidence boxes (the export uses 8). Item g: lines route around evidence boxes,
 * so the gaps must leave a clear track once the router pads each box. */
const EV_GAP=16,EV_PITCH=48+EV_GAP;

/**
 * Product geometry for the frozen r2 family frames (layout `mj`).
 * Families are sized to their content: a base card size is chosen so the rows fit the visible
 * height, each row then scales its families (cards and text) up to fill the width, capped at
 * 2.6x. Boxes never stretch vertically to fill spare height.
 */
export function packageMapR2(pkg:PackageState,width:number,height:number,options:R2Options={}){
 const n=Math.max(650,width),room=n-PAD*2,mode=options.mode??"relationship";
 const order=arrangeFamilies(pkg,mode,options.custom);
 const original=buildLayout(pkg,n,false,undefined,true,false);
 const onMap=new Set(original.controls.map(c=>c.id));
 const pipeItems=(options.pipeFiles??[]).map(f=>{const controlIds=f.controlIds.filter(id=>onMap.has(id));return {id:`pipe:${f.name}`,uuid:`pipe:${f.name}`,displayId:"PIPELINE",title:f.name,subtitle:`${controlIds.length} mapped control${controlIds.length===1?"":"s"}`,detail:"",controlIds,families:new Set<string>(),x:0,y:0,w:0,h:48,row:0,band:0,host:"",placement:"family" as const,displaced:false,pipe:true as boolean|undefined};}).filter(f=>f.controlIds.length);
 const evidenceItems=[...(options.showEvidence===false?[]:original.evidence).map(e=>({...e,pipe:undefined as boolean|undefined})),...pipeItems];
 const tiles=(id:string)=>Boolean(options.touchedIds&&!options.touchedIds.has(id));
 const tileCount=(lane:{memberIds:string[]})=>lane.memberIds.filter(tiles).length;
 const cardCount=(lane:{memberIds:string[]})=>lane.memberIds.length-tileCount(lane);
 const lanesInOrder=[...original.lanes].filter(l=>l.memberIds.length).sort((a,b)=>(order.indexOf(a.id)+1||999)-(order.indexOf(b.id)+1||999));
 // Base card size: the largest that lets the needed rows fit the visible height.
 const weightedCards=lanesInOrder.reduce((sum,l)=>sum+cardCount(l)+tileCount(l)*.4,0);
 const fx=options.fixed;
 let best:number|null=null;
 for(let rows=1;rows<=4;rows++){
  const m=(rows*.82*room-lanesInOrder.length*(24-CONTROL_GAP+FAMILY_GAP))/Math.max(1,weightedCards)-CONTROL_GAP;
  if(m<60)continue;
  if(10+rows*(m*1.2+130)+24<=(height||900))best=m;
 }
 const mm=fx?fx.mm:Math.max(60,Math.min(170,best??70));
 type Lane=(typeof original.lanes)[number]&{k:number};
 let rows:Lane[][]=[];
 for(const lane of lanesInOrder){
  const tileW=mm*.62,cards=cardCount(lane),tileN=tileCount(lane);
  const cardsW=cards?cards*(mm+CONTROL_GAP)-CONTROL_GAP+24:0;
  const tilesW=tileN?Math.ceil(Math.sqrt(tileN*2.2))*(tileW+4)-4+24:0;
  const w=Math.min(room,Math.max(92,cardsW,tilesW,(lane.title||"").length*4.6+30)*(fx?fx.k[lane.id]??1:1));
  const row=rows.at(-1);
  if(row&&row.reduce((sum,l)=>sum+l.w,0)+(row.length-(fx?1:0))*FAMILY_GAP+w<=room+(fx?1:0))row.push({...lane,w,k:1});else rows.push([{...lane,w,k:1}]);
 }
 // By relationship: reorder each wrapped row by the barycenter of its links to the other rows,
 // and give linked gaps extra room for the lines that pass between families.
 const weights=familyWeights(pkg);
 for(const item of evidenceItems){
  const fams=[...new Set(item.controlIds.map(id=>pkg.controls.find(c=>c.id===id)?.family).filter((f):f is string=>Boolean(f)))];
  for(const a of fams)for(const b of fams)if(a<b){const key=`${a}|${b}`;weights.set(key,(weights.get(key)??0)+2);}
 }
 const weight=(a:string,b:string)=>weights.get([a,b].sort().join("|"))??0;
 const optimize=mode==="relationship"&&rows.length>1;
 const crossing=new Map<string,number>();
 if(optimize){
  const centers=()=>{const map=new Map<string,number>();for(const row of rows){let x=0;const total=row.reduce((s,l)=>s+l.w,0)+(row.length-1)*FAMILY_GAP,k=room/Math.max(1,total);for(const l of row){map.set(l.id,(x+l.w/2)*k);x+=l.w+FAMILY_GAP;}}return map;};
  for(let sweep=0;sweep<4;sweep++){
   const at=centers();
   rows=rows.map((row,i)=>{const others=rows.filter((_,j)=>j!==i).flat();return [...row].map(lane=>{let total=0,sum=0;for(const other of others){const v=weight(lane.id,other.id);total+=v;sum+=v*(at.get(other.id)??0);}return {lane,b:total?sum/total:at.get(lane.id)??0};}).sort((a,b)=>a.b-b.b).map(item=>item.lane);});
  }
  for(const row of rows)for(const lane of row){let total=0;for(const other of rows)if(other!==row)for(const peer of other)total+=weight(lane.id,peer.id);crossing.set(lane.id,total);}
 }
 const lanes:Lane[]=[],controls:typeof original.controls=[],evidence:Array<(typeof original.evidence)[number]&{pipe?:boolean}>=[],bands:typeof original.bands=[];
 const placedEvidence=evidenceItems.map(item=>{const counts=rows.map(row=>item.controlIds.filter(id=>row.some(l=>l.memberIds.includes(id))).length);return {...item,band:Math.max(0,counts.indexOf(Math.max(...counts)))};});
 let y=10;
 for(const [band,source] of rows.entries()){
  const gapWeights=source.slice(0,-1).map((l,j)=>(crossing.get(l.id)??0)+(crossing.get(source[j+1].id)??0)+1);
  const gapTotal=gapWeights.reduce((a,b)=>a+b,0);
  const extra=optimize&&!fx&&source.length>1&&crossing.size?Math.min(room*.16,gapTotal*4):0;
  const k=Math.min(MAX_ROW_SCALE,(room-Math.max(0,source.length-1)*FAMILY_GAP-extra)/source.reduce((s,l)=>s+l.w,0));
  const row=source.map(l=>fx?{...l,k:fx.k[l.id]??1}:{...l,k,w:l.w*k});
  // Titles keep one size; a row whose titles need a second line gets a taller header instead of smaller type.
  const twoLines=row.some(l=>manropeWidth(l.title||"",FAMILY_TITLE_PX,600)>l.w-24);
  const headerH=HEADER_H+(twoLines?TITLE_LINE:0);
  const controlY=y+12+headerH+12;
  const contentH=(lane:Lane)=>{
   const cw=mm*lane.k,columns=Math.max(1,Math.floor((lane.w-24*lane.k+CONTROL_GAP*lane.k)/(cw+CONTROL_GAP*lane.k)+1e-6));
   const cardRows=Math.ceil(cardCount(lane)/columns),tileColumns=Math.max(1,Math.floor((lane.w-24*lane.k+4)/(mm*.62*lane.k+4)+1e-6)),tileRows=Math.ceil(tileCount(lane)/tileColumns);
   return (cardRows?cw+(cardRows-1)*(cw+48):0)+(tileRows?(cardRows?14:0)+tileRows*30-4:0);
  };
  const boxBottom=controlY+Math.max(30,...row.map(contentH))+12;
  let x=PAD;
  for(const [index,lane] of row.entries()){
   const cw=mm*lane.k,gap=CONTROL_GAP*lane.k,pad=12*lane.k;
   const members=original.controls.filter(c=>c.family===lane.id);
   const active=members.filter(c=>!tiles(c.id)),quiet=members.filter(c=>tiles(c.id));
   const columns=Math.max(1,Math.floor((lane.w-2*pad+gap)/(cw+gap)+1e-6));
   for(const [i,c] of active.entries())controls.push({...c,x:x+pad+(i%columns)*(cw+gap),y:controlY+Math.floor(i/columns)*(cw+48),w:cw,h:cw});
   const tileW=mm*.62*lane.k,tileColumns=Math.max(1,Math.floor((lane.w-2*pad+4)/(tileW+4)+1e-6));
   const tileY=controlY+(active.length?cw+(Math.ceil(active.length/columns)-1)*(cw+48)+14:0);
   for(const [i,c] of quiet.entries())controls.push({...c,x:x+pad+(i%tileColumns)*(tileW+4),y:tileY+Math.floor(i/tileColumns)*30,w:tileW,h:26});
   lanes.push({...lane,x,y,headerH,band,h:boxBottom-y});
   x+=lane.w+FAMILY_GAP+(extra&&gapTotal?extra*(gapWeights[index]??0)/gapTotal:0);
  }
  // SSP evidence and chosen evidence files share the row below their main family.
  const rowLanes=lanes.filter(l=>l.band===band),rowEvidence=placedEvidence.filter(e=>e.band===band),gapBelow=band===0?44:16,start=evidence.length;
  let bottom=boxBottom+40;
  for(const lane of rowLanes){
   const owned=rowEvidence.filter(item=>{const n=(l:Lane)=>item.controlIds.filter(id=>l.memberIds.includes(id)).length;return [...rowLanes].sort((a,b)=>n(b)-n(a)||a.x-b.x)[0]?.id===lane.id;}).sort((a,b)=>(a.displayId??a.id).localeCompare(b.displayId??b.id,undefined,{numeric:true}));
   const ew=Math.min(140,Math.max(110,lane.w)),cols=Math.max(1,Math.floor((lane.w+32)/(ew+EV_GAP)));
   for(let r=0;r<Math.ceil(owned.length/cols);r++){
    const chunk=owned.slice(r*cols,(r+1)*cols);
    const placed=placeOneRow(chunk.map((item,i)=>({id:item.uuid,w:ew,ideal:lane.x+lane.w/2+(i-(chunk.length-1)/2)*(ew+EV_GAP)})),{left:PAD,right:n-PAD},boxBottom+gapBelow+r*EV_PITCH,EV_GAP);
    evidence.push(...placed.map(p=>({...chunk.find(item=>item.uuid===p.id)!,x:p.x,y:p.y,w:p.w,h:48,row:r,host:lane.id})));
    bottom=Math.max(bottom,boxBottom+gapBelow+r*EV_PITCH+48);
   }
  }
  const placedRow=evidence.splice(start);let rowIndex=0;
  for(const r of [...new Set(placedRow.map(e=>e.row))].sort((a,b)=>a-b)){
   const groups:typeof placedRow[]=[];
   for(const item of placedRow.filter(e=>e.row===r).sort((a,b)=>a.x-b.x||a.uuid.localeCompare(b.uuid))){const g=groups.at(-1);if(g&&g.reduce((s,e)=>s+e.w,0)+g.length*EV_GAP+item.w<=room)g.push(item);else groups.push([item]);}
   for(const g of groups){const xs=packRow(g.map(e=>({w:e.w,target:e.x})),{left:PAD,right:n-PAD},EV_GAP),top=boxBottom+gapBelow+rowIndex*EV_PITCH;evidence.push(...g.map((e,i)=>({...e,x:xs[i],y:top,row:rowIndex})));bottom=Math.max(bottom,top+48);rowIndex++;}
  }
  bands.push({top:y,boxTop:y,boxBottom,controlY,evidenceY:boxBottom+gapBelow,bottom});
  y=bottom+28;
 }
 return {...original,roles:[],pills:[],width:n,lanes,controls,evidence,bands,mm,fixed:{mm,k:Object.fromEntries(lanes.map(l=>[l.id,l.k]))} as R2Fixed,height:Math.max(height,(bands.at(-1)?.bottom??0)+24),controlY:bands[0]?.controlY??0,evidenceY:bands[0]?.evidenceY??0,boxTop:bands[0]?.boxTop??0};
}
