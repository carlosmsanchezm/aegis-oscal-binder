import {it,expect} from "vitest";
import {nextWorkModel,controlOwner} from "../lib/aegis/map-next-work";
import {pkg} from "./pmap-r2-fixture";
const base={riskReason:"Retained finding",relevanceReason:"Collected configuration",costReason:"Review required"};
it("drops blank work without suggestions while retaining ranking and destinations",()=>{
 const items=[{...base,id:"a",controlId:"CM-6",kind:"open-finding"},{...base,id:"b",controlId:"AC-6",kind:"blank"},{...base,id:"c",controlId:"AU-2",kind:"blank"}];
 const next=nextWorkModel(items,new Map([["AC-6",2]]));expect(next.map(i=>i.id)).toEqual(["a","b"]);expect(next.map(i=>i.destination)).toEqual(["plan of action","control on map"]);expect(next[0].owner).toBeUndefined();
});
it("uses only SSP responsible roles for owner labels",()=>{const authored={...pkg,loaded:true,controls:[{...pkg.controls[0],roleLabels:["Engineer"],responsibleRole:"Engineer"}]};expect(controlOwner(authored,authored.controls[0].id)).toBe("Engineer");expect(controlOwner({...authored,loaded:false},authored.controls[0].id)).toBeUndefined();});
