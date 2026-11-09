import React from "react";
import {it,expect,vi} from "vitest";
import {render,screen,fireEvent} from "@testing-library/react";
import {BaselineFootprint} from "../../components/binder/BaselineCoverage";
import {coverageFamilies} from "../../lib/aegis/baseline-coverage";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
it("preserves family inspector and full coverage navigation",()=>{const select=vi.fn(),expand=vi.fn();render(<BaselineFootprint families={coverageFamilies(CCM_EXAMPLE,[CCM_EXAMPLE],false)} selected="CM" onSelect={select} onExpand={expand}/>);const cm=screen.getByRole("button",{name:/^CM ·/});expect(cm.getAttribute("aria-pressed")).toBe("true");fireEvent.click(cm);expect(select).toHaveBeenCalledWith("CM");fireEvent.click(screen.getByRole("button",{name:"Baseline coverage →"}));expect(expand).toHaveBeenCalled();});
