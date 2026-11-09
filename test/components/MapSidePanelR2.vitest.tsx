import React from "react";
import {it,expect} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {PipelineControlPanel} from "../../components/binder/RollupMap";
import {pkg,records} from "../pmap-r2-fixture";
it("keeps Option A header, evidence card and working Level 2 and suggested file actions",()=>{
 let expanded=false,released=false;render(<PipelineControlPanel pkg={pkg} control={pkg.controls.find(c=>c.id==="CM-6")!} result={null} level2={false} history={records} proposalCount={1} onClose={()=>{}} onExpand={()=>{expanded=true;}} onRelease={()=>{released=true;}}/>);
 expect(screen.getByTestId("pipeline-control-panel").className).toContain("r2-side-panel");fireEvent.click(screen.getByRole("button",{name:"Open in Level 2 →"}));expect(expanded).toBe(true);fireEvent.click(screen.getByRole("button",{name:"Review suggested files →"}));expect(released).toBe(true);expect(screen.getByRole("button",{name:/^Evidence/}).getAttribute("aria-expanded")).toBe("true");
});
