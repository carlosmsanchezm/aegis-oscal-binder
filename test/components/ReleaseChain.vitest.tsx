import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen} from "@testing-library/react";
import {PipelineEvidenceView} from "../../components/binder/PipelineEvidenceView";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
it("keeps the release chain open and renders gates as the approved card",()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({ok:true,record:null,sessionScope:"test"}))));render(<PipelineEvidenceView record={CCM_EXAMPLE}/>);expect(screen.getByRole("heading",{name:"Release chain"})).toBeTruthy();expect(screen.getByRole("heading",{name:"Release gates"})).toBeTruthy();expect(screen.getByRole("heading",{name:"Release chain"}).closest("details")).toBeNull();});
