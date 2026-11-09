import {it,expect} from "vitest";
import {footprintRows} from "../lib/aegis/footprint-rows";
import {coverageFamilies} from "../lib/aegis/baseline-coverage";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
it("preserves the full moderate baseline and enhancement counts",()=>{const rows=footprintRows(coverageFamilies(CCM_EXAMPLE,[CCM_EXAMPLE],false),new Set(["AC-2","CM-7"]));expect(rows).toHaveLength(21);expect(rows[0].total).toBe(323);expect(rows[1].total).toBe(181);expect(rows[2].total).toBe(142);expect(rows[0].evidence).toBe(15);expect(rows[0].suggested).toBe(2);});
it("does not count the same control as both evidence and suggested in the footprint",()=>{const rows=footprintRows(coverageFamilies(CCM_EXAMPLE,[CCM_EXAMPLE],false),new Set(["CM-6"]));expect(rows[0].suggested).toBe(0);});
