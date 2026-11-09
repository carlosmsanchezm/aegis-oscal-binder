import {describe,it,expect} from "vitest";
import {evidenceGraph,visibleGraphRows,graphGeometry,evidenceFolder} from "../lib/aegis/evidence-graph";
import {graphFixture} from "./r3-fixture";
describe("approved evidence graph derivation",()=>{
 it("counts controls and inverts linked files without counting suggestions as evidence",()=>{const model=evidenceGraph(graphFixture());expect(model.evidenceCount).toBe(2);expect(model.suggestedCount).toBe(1);expect(model.files.find(f=>f.key==="fixture-2")?.links).toEqual([{controlId:"CM-6",kind:"S"}]);});
 it("preserves a valid selection and falls back only when it disappears",()=>{expect(evidenceGraph(graphFixture(),[],"CM-6").active?.id).toBe("CM-6");expect(evidenceGraph(graphFixture(),[],"absent").active?.id).toBe("AC-2");});
 it("shows seven plus overflow above eight, then expands all",()=>{expect(visibleGraphRows(Array.from({length:9},(_,i)=>i),false)).toEqual({shown:[0,1,2,3,4,5,6],more:2});expect(visibleGraphRows(Array(9),true).more).toBe(0);expect(visibleGraphRows(Array(8),false).more).toBe(0);});
 it("uses the approved node geometry",()=>{expect(graphGeometry(1)).toEqual({height:92,top:24,center:0});expect(graphGeometry(3).height).toBe(148);expect(graphGeometry(8).height).toBe(408);expect(graphGeometry(9).height).toBe(460);});
 it("truncates only the folder while keeping the basename separate",()=>{expect(evidenceFolder("Dockerfile")).toBe("");expect(evidenceFolder("a/".repeat(30)+"file")).toHaveLength(38);});
});
