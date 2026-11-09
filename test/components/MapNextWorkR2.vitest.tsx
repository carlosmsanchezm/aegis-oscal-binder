import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {NextWorkBand} from "../../components/binder/NextWorkBand";
it("retains ranked accessible destinations and queue escape focus with compact content and a legend",()=>{
 vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});
 const items=Array.from({length:5},(_,i)=>({id:String(i),controlId:`CM-${i+2}`,kind:"open-finding",riskReason:"Retained finding",relevanceReason:"Source evidence",costReason:"Human review"}));
 const open=vi.fn();render(<NextWorkBand items={items} hasHistory proposalCounts={new Map()} hasPlan={()=>true} onOpen={open}/>);
 expect(screen.getByLabelText("Next work legend").textContent).toContain("Suggested files → control on map");expect(screen.getByRole("button",{name:/1 CM-2 Finding opens plan of action/})).toBeTruthy();
 const queue=screen.getByRole("button",{name:"Full queue ▾"});fireEvent.click(queue);expect(queue.getAttribute("aria-expanded")).toBe("true");fireEvent.keyDown(document,{key:"Escape"});expect(queue.getAttribute("aria-expanded")).toBe("false");expect(document.activeElement).toBe(queue);
});
