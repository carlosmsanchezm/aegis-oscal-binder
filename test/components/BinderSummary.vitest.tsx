import React from "react";
import {it,expect} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {BinderSummary} from "../../components/binder/BinderSummary";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
import {ids} from "../r3-fixture";
it("replaces the legacy table while keeping control details",()=>{render(<BinderSummary record={CCM_EXAMPLE} controlIds={ids}/>);expect(screen.queryByText("Open evidence map →")).toBeNull();fireEvent.click(screen.getAllByRole("button",{name:"Evidence for CM-6"})[0]);expect(screen.getByLabelText("CM-6 evidence details")).toBeTruthy();expect(screen.getByRole("button",{name:"Close control evidence"})).toBeTruthy();});
