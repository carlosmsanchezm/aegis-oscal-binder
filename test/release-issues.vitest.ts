import {it,expect} from "vitest";
import {releaseIssues} from "../lib/aegis/release-issues";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
it("retains scan counts and scoped issues from the recorded release",()=>{const m=releaseIssues(CCM_EXAMPLE,[]);expect(m.total).toBe(33);expect(m.groups.some(g=>g.control==="CM-6")).toBe(true);expect(m.count("unrev")).toBe(30);});
it("has no issue card for an empty release",()=>{expect(releaseIssues({...CCM_EXAMPLE,reviewItems:[],checks:[],findingCount:0},[]).empty).toBe(true);});
it("counts every finding in an aggregate tile",()=>{const m=releaseIssues({...CCM_EXAMPLE,reviewItems:[],checks:[{id:"sast",status:"fail",findings:17,blockingCount:2,artifact:"sast.json"}],findingCount:17},[]);expect(m.groups[0].open).toBe(17);expect(m.count("unrev")).toBe(17);});
