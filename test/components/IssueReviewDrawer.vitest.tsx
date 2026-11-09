import React from "react";
import {it,expect} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {IssueReviewDrawer} from "../../components/binder/IssueReviewDrawer";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
import {observation} from "../r3-fixture";
it("requires a reason before recording either supported triage outcome",()=>{render(<IssueReviewDrawer record={CCM_EXAMPLE} issue={observation} action="triage" onClose={()=>{}} onDraft={()=>{}}/>);const button=screen.getByRole("button",{name:"Record triage"}) as HTMLButtonElement;expect(button.disabled).toBe(true);fireEvent.change(screen.getByLabelText("Triage reason"),{target:{value:"Reviewed scope"}});expect(button.disabled).toBe(false);expect(screen.getAllByRole("option").map(option=>(option as HTMLOptionElement).value)).toEqual(["fix-now","plan-it"]);expect(screen.queryByRole("option",{name:/accept risk/i})).toBeNull();});
