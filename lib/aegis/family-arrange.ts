import type {PackageState} from "./types";
export type ArrangeMode="relationship"|"alphabetical"|"custom";
export function familyWeights(pkg:PackageState){
 const byControl=new Map(pkg.controls.map(c=>[c.id,c.family]));
 const weights=new Map<string,number>();
 const add=(a:string,b:string)=>{if(a===b)return;const key=[a,b].sort().join("|");weights.set(key,(weights.get(key)??0)+1);};
 for(const edge of pkg.map.edges){const a=byControl.get(edge.fromId),b=byControl.get(edge.toId);if(a&&b)add(a,b);}
 const evidence=new Map<string,Set<string>>();
 for(const c of pkg.controls)for(const e of c.evidence){const set=evidence.get(e.uuid)??new Set<string>();set.add(c.family);evidence.set(e.uuid,set);}
 for(const set of evidence.values()){const ids=[...set];for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)add(ids[i],ids[j]);}
 return weights;
}
export function arrangeFamilies(pkg:PackageState,mode:ArrangeMode,custom:readonly string[]=[]){
 const ids=pkg.map.families.map(f=>f.id).sort();
 if(mode==="alphabetical")return ids;
 if(mode==="custom")return [...new Set([...custom.filter(id=>ids.includes(id)),...ids])];
 const weights=familyWeights(pkg),weight=(a:string,b:string)=>weights.get([a,b].sort().join("|"))??0;
 const total=(id:string)=>ids.reduce((sum,b)=>sum+weight(id,b),0);
 const remaining=[...ids].sort((a,b)=>total(b)-total(a)||a.localeCompare(b));
 const order:string[]=[];
 while(remaining.length){if(order.length)remaining.sort((a,b)=>weight(order.at(-1)!,b)-weight(order.at(-1)!,a)||total(b)-total(a)||a.localeCompare(b));order.push(remaining.shift()!);}
 return order;
}
export function moveFamily(order:readonly string[],from:string,to:string){const next=order.filter(id=>id!==from);const index=next.indexOf(to);if(!order.includes(from)||index<0)return [...order];next.splice(index,0,from);return next;}
/** Gaps never consume more than sixteen percent of the row. A ratio, independent of pixels. */
export function familyGaps(width:number,crossings:readonly number[],weighted:boolean){
 if(!crossings.length)return [];
 const budget=Math.min(Math.max(0,width)*.16,crossings.length*8+crossings.reduce((a,b)=>a+Math.max(0,b),0)*3);
 const weights=crossings.map(value=>weighted?1+Math.max(0,value):1),sum=weights.reduce((a,b)=>a+b,0);
 return weights.map(value=>budget*value/sum);
}
/** Barycentric alignment keeps linked families above or below their peers after wrapping. */
export function alignFamilyRows(rows:readonly (readonly string[])[],weights:ReadonlyMap<string,number>){
 const result:string[][]=[];
 for(const row of rows){
  const above=result.at(-1);if(!above){result.push([...row]);continue;}
  const center=(id:string)=>{let total=0,position=0;above.forEach((other,index)=>{const weight=weights.get([id,other].sort().join("|"))??0;total+=weight;position+=weight*(index+.5)/above.length;});return total?position/total:(row.indexOf(id)+.5)/row.length;};
  result.push([...row].sort((a,b)=>center(a)-center(b)||row.indexOf(a)-row.indexOf(b)));
 }
 return result;
}
export function crossingGapWeights(row:readonly string[],neighbors:readonly (readonly string[])[],weights:ReadonlyMap<string,number>){
 return row.slice(0,-1).map((_,gap)=>{
  const cut=(gap+1)/row.length;let count=0;
  for(const [i,a] of row.entries()){
   for(const [j,b] of row.entries())if(i<j&&(i+.5)/row.length<cut&&(j+.5)/row.length>cut)count+=weights.get([a,b].sort().join("|"))??0;
   for(const peers of neighbors)for(const [j,b] of peers.entries())if(((i+.5)/row.length-cut)*((j+.5)/peers.length-cut)<0)count+=weights.get([a,b].sort().join("|"))??0;
  }
  return count;
 });
}
