import {it,expect} from "vitest";
import {evidenceLinesVisible} from "../lib/aegis/map-line-visibility";
it("hides lines at rest and discloses only incident evidence on hover, selection or family focus",()=>{
 const controls=["CM-6","AC-6"];expect(evidenceLinesVisible("configuration.json",controls,{})).toBe(false);
 for(const focus of [{hoveredEvidence:"configuration.json"},{selectedEvidence:"configuration.json"},{hoveredControl:"CM-6"},{selectedControl:"AC-6"},{familyControls:new Set(["CM-6"])}])expect(evidenceLinesVisible("configuration.json",controls,focus)).toBe(true);
 expect(evidenceLinesVisible("configuration.json",controls,{selectedControl:"AU-2"})).toBe(false);
});
