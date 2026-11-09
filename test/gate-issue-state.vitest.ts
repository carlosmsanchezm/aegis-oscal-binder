import {it,expect} from "vitest";
import {issueDraft} from "../lib/aegis/issue-actions";
import {releaseIssues} from "../lib/aegis/release-issues";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {observation} from "./r3-fixture";
it("closure hides a tile while a measured retest remains a decision",()=>{const record={...CCM_EXAMPLE,reviewItems:[observation],checks:[],findingCount:1};const plan=issueDraft(record,observation,{risk:"r",action:"a",verification:"v"});expect(releaseIssues(record,[plan]).count("plan")).toBe(1);expect(releaseIssues(record,[{...plan,readyToClose:true}]).count("fixed")).toBe(1);expect(releaseIssues(record,[{...plan,closureConfirmed:true}]).empty).toBe(true);});
import {gateIssueState} from "../lib/aegis/gate-issue-state";
it("uses human gate workflow states for closure readiness",()=>{expect(gateIssueState("rescan-pending").readyToClose).toBe(false);expect(gateIssueState("ready-for-closure-review")).toEqual({readyToClose:true,closureConfirmed:false});expect(gateIssueState("closed-externally").closureConfirmed).toBe(true);});
