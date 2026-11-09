import {it,expect} from "vitest";
import {assertResumableTake} from "../scripts/demo/resume-proof";
function fixture(){
 const receipt="a".repeat(64),ids=Array.from({length:5},(_,i)=>"item"+i),queuedAt="2026-11-02T20:00:00Z";
 const jobs=ids.map((poamItemId,i)=>({poamItemId,id:"job"+i,tokenId:"worker"+i,prNumber:i+2,state:"pr-open",sourceReleaseId:receipt.slice(0,32),draftRevision:"one",findingId:"finding"+i,queuedAt}));
 const prs=jobs.map(j=>({...j,createdBy:"agent:"+j.tokenId}));
 const audit=jobs.flatMap(j=>[
  {body:{tokenId:j.tokenId,tool:"claim_fix",result:"recorded",at:"2026-11-02T20:01:00Z"}},
  {body:{tokenId:j.tokenId,tool:"propose_fix_pr",result:"requested",at:"2026-11-02T20:02:00Z",inputs:{operation:"open",runnerAssignmentId:j.id,poamItemId:j.poamItemId}}},
  {body:{tokenId:j.tokenId,tool:"request_retest",result:"recorded",at:"2026-11-02T20:03:00Z",inputs:{issueId:j.findingId,receiptId:receipt}}},
 ]);
 return {receipt,ids,jobs,prs,audit};
}
it("resumes five retained real worker stages without treating expired credentials or new process output as proof",()=>{
 const s=fixture();expect(assertResumableTake(s.jobs,s.prs,s.audit,s.ids,s.receipt)).toHaveLength(5);
 s.jobs[0].state="merged";expect(assertResumableTake(s.jobs,s.prs,s.audit,s.ids,s.receipt)).toHaveLength(5);
});
it("refuses missing worker audit, substituted actors, mismatched PRs and incomplete registration",()=>{
 for(const mutate of [s=>s.audit.pop(),s=>s.prs[0].createdBy="person",s=>s.prs[0].prNumber=99,s=>s.jobs[0].state="proposing",s=>s.jobs[0].tokenId=s.jobs[1].tokenId,s=>s.audit[0].body.at="2026-11-02T19:00:00Z",s=>s.audit[2].body.inputs!.receiptId="wrong"] as ((s:ReturnType<typeof fixture>)=>void)[]){
  const s=fixture();mutate(s);expect(()=>assertResumableTake(s.jobs,s.prs,s.audit,s.ids,s.receipt)).toThrow(/Resume/);
 }
});
