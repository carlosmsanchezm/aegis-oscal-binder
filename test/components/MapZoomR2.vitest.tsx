import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {MapZoomControl} from "../../components/binder/MapZoomControl";
it("exposes keyboard reachable zoom, actual percentage, reset and Fit",()=>{const zoom=vi.fn(),reset=vi.fn(),fit=vi.fn();render(<MapZoomControl scale={1.2} onZoom={zoom} onReset={reset} onFit={fit}/>);fireEvent.click(screen.getByRole("button",{name:"Zoom in"}));expect(zoom).toHaveBeenCalledWith(1.2);fireEvent.click(screen.getByRole("button",{name:"120%"}));expect(reset).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole("button",{name:"Fit"}));expect(fit).toHaveBeenCalledOnce();});
