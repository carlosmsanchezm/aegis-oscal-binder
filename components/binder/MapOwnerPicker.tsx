"use client";
import React from "react";
import type {PackageState} from "@/lib/aegis/types";
export function MapOwnerPicker({pkg,value,onChange,example=false,panel=false}:{pkg:PackageState;value:string;onChange:(value:string)=>void;example?:boolean;panel?:boolean}){
 if(!panel&&(!pkg.loaded||!pkg.roles.length))return null;
 const available=pkg.roles.length>0;
 return <label className="pmap-owner" title="Filter the map by owner; this does not change assignments"><span>Owner</span>{example&&<b className="pm-example">EXAMPLE</b>}<select aria-label={panel?"Owner in side panel":"Owner"} value={available?value:""} disabled={!available} onChange={event=>{event.stopPropagation();onChange(event.target.value);}}><option value="">{available?"Everyone":"No owners supplied"}</option>{[...pkg.roles].sort((a,b)=>(a.shortName||a.title).localeCompare(b.shortName||b.title)).map(role=><option key={role.id} value={role.id}>{example?"EXAMPLE · ":""}{role.shortName||role.title}</option>)}</select></label>;
}
export function ownerMatches(pkg:PackageState,id:string,owner:string){const control=pkg.controls.find(c=>c.id===id);return !owner||Boolean(control?.responsibleRoleId===owner||control?.responsibleRoleIds.includes(owner));}

export function missingFieldsInSsp(pkg:PackageState,id:string):string[]{if(!pkg.loaded)return [];const control=pkg.controls.find(c=>c.id===id);return control?[...control.missing]:["SSP entry"];}
