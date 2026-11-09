import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {ReleaseIssues} from "../../components/binder/ReleaseIssues";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
it("renders real retained counts and invokes triage",()=>{const action=vi.fn();render(<ReleaseIssues record={CCM_EXAMPLE} plans={[]} onOpen={()=>{}} onAction={action}/>);fireEvent.click(screen.getByRole("button",{name:"Triage"}));expect(action).toHaveBeenCalled();expect(screen.getByText("Not reviewed 30")).toBeTruthy();});
