import {it,expect} from "vitest";
import {arrangeFamilies,moveFamily,familyGaps,alignFamilyRows,crossingGapWeights} from "../lib/aegis/family-arrange";
import {map} from "./pmap-r2-fixture";
it("keeps all families exactly once in deterministic relationship and alphabetical arrangements",()=>{
 const alpha=map.map.families.map(f=>f.id).sort();expect(arrangeFamilies(map,"alphabetical")).toEqual(alpha);
 const related=arrangeFamilies(map,"relationship");expect([...related].sort()).toEqual(alpha);expect(arrangeFamilies(map,"relationship")).toEqual(related);
 const moved=moveFamily(related,related.at(-1)!,related[0]);expect(moved[0]).toBe(related.at(-1));expect(arrangeFamilies(map,"custom",moved)).toEqual(moved);
});
it("weights crossing gaps with a maximum sixteen percent row ratio and even manual gaps",()=>{
 for(const width of [0,320,1440,1920]){const gaps=familyGaps(width,[0,3,100],true);expect(gaps.reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(width*.16+.00001);if(width)expect(gaps[2]).toBeGreaterThan(gaps[0]);}
 const even=familyGaps(1440,[0,3,100],false);expect(even.every(g=>g===even[0])).toBe(true);
});

it("aligns wrapped families vertically and assigns room to cross row routes",()=>{const weights=new Map([["AC|SI",8],["CM|RA",6]]);expect(alignFamilyRows([["AC","CM"],["RA","SI"]],weights)).toEqual([["AC","CM"],["SI","RA"]]);expect(crossingGapWeights(["AC","CM"],[["RA","SI"]],weights)[0]).toBe(14);});
