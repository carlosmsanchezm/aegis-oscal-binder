import type {PackageState} from "./types";
export type NextWorkInput={id:string;controlId:string;kind:string;riskReason:string;relevanceReason:string;costReason:string};
export function controlOwner(pkg:PackageState|undefined,id:string){
 const c=pkg?.loaded?pkg.controls.find(c=>c.id===id):undefined;
 return c?.roleLabels?.join(", ")||c?.responsibleRole||undefined;
}
/** Next work shows one short owner per item: the control's first responsible role, by its short name. */
export function chipOwner(pkg:PackageState|undefined,id:string){
 const c=pkg?.loaded?pkg.controls.find(c=>c.id===id):undefined;if(!c)return undefined;
 const role=pkg!.roles.find(r=>r.id===(c.responsibleRoleIds?.[0]??c.responsibleRoleId));
 return role?.shortName||role?.title||c.roleLabels?.[0]||c.responsibleRole||undefined;
}
export function nextWorkModel<T extends NextWorkInput>(items:readonly T[],proposals:ReadonlyMap<string,number>=new Map(),pkg?:PackageState){
 return items.filter(item=>item.kind==="open-finding"||(item.kind==="blank"&&(proposals.get(item.controlId)??0)>0)).map(item=>({...item,owner:chipOwner(pkg,item.controlId),label:item.kind==="open-finding"?"Finding":"Suggested files",destination:item.kind==="open-finding"?"plan of action":"control on map"}));
}
