import React from "react";
import {it,expect} from "vitest";
import {render,screen} from "@testing-library/react";
import {PlanProposalDrawer} from "../../components/binder/PlanProposal";
import {issueDraft} from "../../lib/aegis/issue-actions";
import {CCM_EXAMPLE} from "../../lib/aegis/pipeline-evidence";
import {observation} from "../r3-fixture";
it("POA&M drawer shows only the linked PR number/url and CI chip from its server projection",()=>{
 const proposal=issueDraft(CCM_EXAMPLE,observation,{risk:"Proposed correction",action:"Correct setting",verification:"Collect a retest"});
 const view=render(<PlanProposalDrawer proposal={proposal} onClose={()=>{}}/>);
 expect(screen.queryByRole("link",{name:"PR #7"})).toBeNull();
 view.rerender(<PlanProposalDrawer proposal={{...proposal,pullRequest:{schema:"binder.pull-request-link.v1",connectionId:"unit",installationId:42,poamItemId:proposal.id,findingId:observation.id,sourceReleaseId:proposal.sourceReleaseId,owner:"example",repo:"service",prNumber:7,prUrl:"https://github.com/example/service/pull/7",headSha:"a".repeat(40),baseSha:"b".repeat(40),state:"open",ciStatus:{sha:"a".repeat(40),state:"pending",checks:0,checkedAt:"2026-10-29T12:00:00Z"},createdBy:"agent:public-id",createdAt:"2026-10-29T12:00:00Z",updatedAt:"2026-10-29T12:00:00Z"}}} onClose={()=>{}}/>);
 expect(screen.getByRole("link",{name:"PR #7"}).getAttribute("href")).toBe("https://github.com/example/service/pull/7");
 expect(screen.getByLabelText("CI pending").textContent).toBe("CI pending");
 expect(screen.getByText("A person confirms closure")).toBeTruthy();
});
