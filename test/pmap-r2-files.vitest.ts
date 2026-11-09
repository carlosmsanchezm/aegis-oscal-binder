import {it,expect} from "vitest";
import {mapEvidenceFiles} from "../lib/aegis/map-evidence-files";
import {records,map} from "./pmap-r2-fixture";
it("includes only collected or suggested files incident to visible map controls at the selected snapshot",()=>{
 const files=mapEvidenceFiles(records[0],records,map.controls.map(c=>c.id));expect(files.length).toBeGreaterThan(0);
 for(const file of files){expect(file.controlIds.length).toBeGreaterThan(0);expect(file.controlIds.every(id=>map.controls.some(c=>c.id===id))).toBe(true);expect(file.source.artifactJobId).toBe("40446239616");}
 expect(mapEvidenceFiles(records[0],records,[])).toEqual([]);
});
