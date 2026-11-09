import type {buildLayout} from "./map-placement";

/** Compact overview faces keep large proposal sets readable. Focused selection
 * continues to use the existing layout and relationship routing. */
export function coverageOverviewLayout(geometry:ReturnType<typeof buildLayout>,status:ReadonlySet<string>,fillHeight=0,faceWidth=60) {
  const gap=36,side=16,top=geometry.roles.length ? Math.max(...geometry.roles.map(r=>r.y+r.h))+18 : 16;
  const columns=Math.max(1,Math.min(6,Math.floor(geometry.width/170)));
  const placed=geometry.lanes.map((l,i)=>({...l,band:Math.floor(i/columns)}));
  const bands=[...new Set(placed.map(l=>l.band))];
  const sized=placed.map(l=>{
    const row=placed.filter(other=>other.band===l.band);
    const desired=(lane:typeof l)=>Math.max(138,Math.min(4,Math.ceil(geometry.controls.filter(c=>c.family===lane.id).length/2))*(faceWidth+6)+6);
    const extra=(geometry.width-side*2-(row.length-1)*16-row.reduce((sum,lane)=>sum+desired(lane),0))/row.length;
    const slot=row.findIndex(lane=>lane.id===l.id);
    return {...l,x:side+row.slice(0,slot).reduce((sum,lane)=>sum+desired(lane)+extra+16,0),w:desired(l)+extra};
  });
  const dimensions=new Map(sized.map(l=>{
    const members=geometry.controls.filter(c=>c.family===l.id),columns=Math.max(1,Math.min(members.length || 1,Math.floor((l.w-6)/(faceWidth+6))));
    const heights=Array.from({length:Math.ceil(members.length/columns)},(_,row)=>Math.max(...members.slice(row*columns,(row+1)*columns).map(c=>status.has(c.id)?52:28)));
    return [l.id,{members,columns,heights,headerH:Math.max(76,l.headerH),w:Math.min(faceWidth,(l.w-12-(columns-1)*6)/columns)}] as const;
  }));
  const heights=bands.map(band=>Math.max(104,...sized.filter(l=>l.band===band).map(l=>{
    const d=dimensions.get(l.id)!;return d.headerH+24+d.heights.reduce((sum,h)=>sum+h,0)+Math.max(0,d.heights.length-1)*6;
  })));
  // Existing family routes begin 18 px outside a lane and need a 14 px margin.
  const natural=top+heights.reduce((sum,h)=>sum+h,0)+Math.max(0,bands.length-1)*gap+32;
  const extra=Math.max(0,fillHeight-natural)/Math.max(1,bands.length);
  const lanes=sized.map(l=>{
    const slot=bands.indexOf(l.band),d=dimensions.get(l.id)!;
    return {...l,y:top+heights.slice(0,slot).reduce((sum,h)=>sum+h+extra+gap,0),h:heights[slot]+extra,headerH:d.headerH};
  });
  const controls=geometry.controls.map(c=>{
    const lane=lanes.find(l=>l.id===c.family)!,d=dimensions.get(c.family)!,slot=d.members.findIndex(m=>m.id===c.id),row=Math.floor(slot/d.columns);
    const room=d.columns*d.w+(d.columns-1)*6;
    return {...c,x:lane.x+(lane.w-room)/2+(slot%d.columns)*(d.w+6),y:lane.y+d.headerH+12+d.heights.slice(0,row).reduce((sum,h)=>sum+h+6,0),w:d.w,h:status.has(c.id)?52:28};
  });
  return {...geometry,lanes,controls,height:Math.max(natural,fillHeight)};
}
