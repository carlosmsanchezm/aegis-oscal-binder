import React from "react";
import {it,expect} from "vitest";
import {render,screen} from "@testing-library/react";
import {MapControlFace} from "../../components/binder/MapControlFace";
const props={id:"CM-6",a:"Configuration",b:"Settings",proposalPill:false,coverage:[],selectedDot:null,linked:false,reviewText:null,reviewTitle:"",reviewState:"open" as const,statusClass:"pmap-status-line",statusText:"1 proposed",statusTitle:"Suggested file",proposalFont:7};
it("renders a full control face with its proposed state and a compact id only untouched tile",()=>{const {rerender}=render(<MapControlFace {...props}/>);expect(screen.getByText("Configuration")).toBeTruthy();expect(screen.getByText("1 proposed")).toBeTruthy();rerender(<MapControlFace {...props} untouched/>);expect(screen.getByText("CM-6")).toBeTruthy();expect(screen.queryByText("Configuration")).toBeNull();expect(screen.queryByText("1 proposed")).toBeNull();});
