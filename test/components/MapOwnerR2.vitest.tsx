import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {MapOwnerPicker,ownerMatches,missingFieldsInSsp} from "../../components/binder/MapOwnerPicker";
import {pkg} from "../pmap-r2-fixture";
it("offers only loaded SSP owners and derives nonowner fading without changing membership",()=>{const authored={...pkg,loaded:true,roles:[{id:"engineer",title:"Engineer"}],controls:[{...pkg.controls[0],responsibleRoleId:"engineer",responsibleRoleIds:["engineer"]}]};const change=vi.fn();const {rerender}=render(<MapOwnerPicker pkg={authored} value="" onChange={change}/>);fireEvent.change(screen.getByLabelText("Owner"),{target:{value:"engineer"}});expect(change).toHaveBeenCalledWith("engineer");expect(ownerMatches(authored,authored.controls[0].id,"engineer")).toBe(true);expect(ownerMatches(authored,"AU-2","engineer")).toBe(false);rerender(<MapOwnerPicker pkg={{...authored,loaded:false}} value="" onChange={change}/>);expect(screen.queryByLabelText("Owner")).toBeNull();});

it("distinguishes absent SSP entries from missing fields and unloaded packages",()=>{const loaded={...pkg,loaded:true,controls:[{...pkg.controls[0],missing:[]}]};expect(missingFieldsInSsp(loaded,"XX-1")).toEqual(["SSP entry"]);expect(missingFieldsInSsp(loaded,loaded.controls[0].id)).toEqual([]);expect(missingFieldsInSsp({...loaded,loaded:false},"XX-1")).toEqual([]);});
