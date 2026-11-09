import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {EvidenceGraph} from "../../components/binder/EvidenceGraph";
import {graphFixture} from "../r3-fixture";
it("switches through file mode and opens controls with accessible selection",()=>{const select=vi.fn();render(<EvidenceGraph controls={graphFixture()} titles={{"AC-2":"Account Management"}} plans={[]} selected={null} onSelect={select}/>);fireEvent.click(screen.getByRole("button",{name:"Start from a file"}));expect(screen.getByLabelText("File")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Evidence for AC-2"}));expect(select).toHaveBeenCalledWith("AC-2");expect(screen.getByRole("button",{name:"Start from a control"}).getAttribute("aria-pressed")).toBe("true");});
it("expands overflow without losing the selected control",()=>{render(<EvidenceGraph controls={graphFixture()} titles={{}} plans={[]} selected="CM-6" onSelect={()=>{}}/>);fireEvent.click(screen.getByRole("button",{name:"+ 4 more files"}));expect(screen.getByRole("button",{name:"file-11.json src/service/"})).toBeTruthy();});
