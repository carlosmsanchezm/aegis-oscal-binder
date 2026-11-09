import {buildLayout} from "./map-placement";
import {placeOneRow,packRow,controlBlockHeight} from "./map-layout";
import type {PackageState} from "./types";

const FACE_HEIGHT=controlBlockHeight(0,88);
const CONTROL_WIDTH=70;
const CONTROL_GAP=6;
const FAMILY_GAP=8;
const PAD=16;

/** Count sized families flow across the frame; large families wrap their controls. */
export function packageMapGeometry(pkg:PackageState,viewWidth:number,panelOpen:boolean,viewHeight:number) {
  const width=Math.max(650,viewWidth),room=width-PAD*2;
  // Planning uses node metadata but does not draw the classic family buses.
  const original=buildLayout(pkg,width,panelOpen,undefined,true,false);
  const groups:typeof original.lanes[]=[];
  for(const lane of original.lanes){
    if(!lane.memberIds.length)continue;
    const w=Math.min(room,Math.max(92,lane.memberIds.length*(CONTROL_WIDTH+CONTROL_GAP)-CONTROL_GAP+24));
    const row=groups.at(-1);
    if(row&&row.reduce((sum,item)=>sum+item.w,0)+row.length*FAMILY_GAP+w<=room)row.push({...lane,w});
    else groups.push([{...lane,w}]);
  }
  const lanes:typeof original.lanes=[],controls:typeof original.controls=[],evidence:typeof original.evidence=[],bands:typeof original.bands=[];
  const roleColumns=Math.max(1,Math.floor((room+8)/Math.max(1,...original.roles.map(role=>role.w+8))));
  const roleRows=Math.ceil(original.roles.length/roleColumns);
  let y=roleRows*48+10;
  const pendingEvidence=original.evidence.map(item=>{
    const counts=groups.map(group=>item.controlIds.filter(id=>group.some(lane=>lane.memberIds.includes(id))).length);
    const band=Math.max(0,counts.indexOf(Math.max(...counts)));
    return {...item,band};
  });
  for(const [band,group] of groups.entries()){
    const total=group.reduce((sum,lane)=>sum+lane.w,0)+Math.max(0,group.length-1)*FAMILY_GAP;
    let x=band===0?PAD:(width-total)/2;
    const headerH=52,controlY=y+12+headerH+12;
    const rowCount=Math.max(1,...group.map(lane=>Math.ceil(lane.memberIds.length/Math.max(1,Math.floor((lane.w-24+CONTROL_GAP)/(CONTROL_WIDTH+CONTROL_GAP))))));
    const boxBottom=controlY+FACE_HEIGHT+(rowCount-1)*(FACE_HEIGHT+48)+12;
    for(const lane of group){
      const members=original.controls.filter(control=>control.family===lane.id);
      const columns=Math.max(1,Math.floor((lane.w-24+CONTROL_GAP)/(CONTROL_WIDTH+CONTROL_GAP)));
      for(const [index,control] of members.entries())controls.push({...control,x:x+12+(index%columns)*(CONTROL_WIDTH+CONTROL_GAP),y:controlY+Math.floor(index/columns)*(FACE_HEIGHT+48),w:CONTROL_WIDTH,h:FACE_HEIGHT});
      lanes.push({...lane,x,y,headerH,band,h:boxBottom-y});x+=lane.w+FAMILY_GAP;
    }
    const bandLanes=lanes.filter(lane=>lane.band===band);
    const entries=pendingEvidence.filter(item=>item.band===band);
    const evidenceGap=band===0?102:Math.max(16,...controls.filter(control=>bandLanes.some(lane=>lane.id===control.family)).map(control=>control.missing.filter(field=>field!=="responsibleRole").length*20));
    const evidenceStart=evidence.length;
    let evidenceBottom=boxBottom+40;
    for(const lane of bandLanes){
      const owned=entries.filter(item=>{
        const count=(candidate:typeof lane)=>item.controlIds.filter(id=>candidate.memberIds.includes(id)).length;
        return [...bandLanes].sort((a,b)=>count(b)-count(a)||a.x-b.x)[0]?.id===lane.id;
      }).sort((a,b)=>(a.displayId??a.id).localeCompare(b.displayId??b.id,undefined,{numeric:true}));
      const evidenceWidth=Math.min(140,Math.max(110,lane.w));
      const evidenceColumns=Math.max(1,Math.floor((lane.w+32)/(evidenceWidth+8)));
      for(let row=0;row<Math.ceil(owned.length/evidenceColumns);row++){
        const items=owned.slice(row*evidenceColumns,(row+1)*evidenceColumns);
        const slots=placeOneRow(items.map((item,index)=>({id:item.uuid,w:evidenceWidth,ideal:lane.x+lane.w/2+(index-(items.length-1)/2)*(evidenceWidth+8)})),{left:PAD,right:width-PAD},boxBottom+evidenceGap+row*56,8);
        evidence.push(...slots.map(slot=>({...items.find(item=>item.uuid===slot.id)!,x:slot.x,y:slot.y,w:slot.w,h:48,row,host:lane.id})));
        evidenceBottom=Math.max(evidenceBottom,boxBottom+evidenceGap+row*56+48);
      }
    }
    const bandEvidence=evidence.splice(evidenceStart);
    let nextRow=0;
    for(const sourceRow of [...new Set(bandEvidence.map(item=>item.row))].sort((a,b)=>a-b)){
      const chunks:typeof bandEvidence[]=[];
      for(const item of bandEvidence.filter(item=>item.row===sourceRow).sort((a,b)=>a.x-b.x||a.uuid.localeCompare(b.uuid))){
        const chunk=chunks.at(-1);
        if(chunk && chunk.reduce((sum,entry)=>sum+entry.w,0)+chunk.length*8+item.w<=room)chunk.push(item);
        else chunks.push([item]);
      }
      for(const chunk of chunks){
        const lefts=packRow(chunk.map(item=>({w:item.w,target:item.x})),{left:PAD,right:width-PAD},8);
        const evidenceY=boxBottom+evidenceGap+nextRow*56;
        evidence.push(...chunk.map((item,index)=>({...item,x:lefts[index],y:evidenceY,row:nextRow})));
        evidenceBottom=Math.max(evidenceBottom,evidenceY+48);nextRow++;
      }
    }
    bands.push({top:y,boxTop:y,boxBottom,controlY,evidenceY:boxBottom+evidenceGap,bottom:evidenceBottom});
    y=evidenceBottom+28;
  }
  const byId=new Map(controls.map(control=>[control.id,control]));
  const roles=Array.from({length:roleRows},(_,row)=>{
    const peers=original.roles.slice(row*roleColumns,(row+1)*roleColumns).map(role=>({...role,ideal:role.controlIds.reduce((sum,id)=>sum+(byId.get(id)?.x??width/2)+(byId.get(id)?.w??0)/2,0)/Math.max(1,role.controlIds.length)})).sort((a,b)=>a.ideal-b.ideal||a.id.localeCompare(b.id));
    const lefts=packRow(peers.map(role=>({w:role.w,target:role.ideal-role.w/2})),{left:PAD,right:width-PAD},8);
    return peers.map((role,index)=>({...role,x:lefts[index],y:row*48,sourceId:role.id}));
  }).flat();
  const missingSlots=new Map<string,number>();
  const pills=original.pills.map(pill=>{
    const control=byId.get(pill.controlId)!;
    const lane=lanes.find(lane=>lane.memberIds.includes(pill.controlId))!;
    const slot=missingSlots.get(control.id)??0;
    if(pill.kind!=="role")missingSlots.set(control.id,slot+1);
    return {...pill,x:Math.max(PAD,Math.min(width-PAD-pill.w,control.x+control.w/2-pill.w/2)),y:pill.kind==="role"?lane.y-22:control.y+control.h+12+slot*20};
  });
  return {...original,width,lanes,controls,roles,evidence,pills,bands,height:Math.max(viewHeight,(bands.at(-1)?.bottom??0)+24),controlY:bands[0]?.controlY??0,evidenceY:bands[0]?.evidenceY??0,boxTop:bands[0]?.boxTop??0};
}
