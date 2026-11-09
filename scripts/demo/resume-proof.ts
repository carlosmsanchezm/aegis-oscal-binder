/** Resume the operator stages only after the server retained five real worker PRs. */
export function assertResumableTake(jobs:any[],prs:any[],audit:any[],ids:string[],receipt:string){
 const active=jobs.filter(j=>ids.includes(j.poamItemId)&&!["expired","abandoned"].includes(j.state));
 const links=prs.filter(p=>ids.includes(p.poamItemId)),rows=audit.map(row=>row.body??row);
 if(ids.length!==5||new Set(ids).size!==5||active.length!==5||links.length!==5||new Set(active.map(j=>j.tokenId)).size!==5||new Set(links.map(p=>p.prNumber)).size!==5)throw new Error("Resume requires five distinct retained worker assignments and PRs.");
 for(const job of active){
  const link=links.find(p=>p.poamItemId===job.poamItemId);
  if(!["pr-open","merged"].includes(job.state)||!job.tokenId||!link||link.prNumber!==job.prNumber||link.createdBy!=="agent:"+job.tokenId||job.sourceReleaseId!==receipt.slice(0,32)||link.sourceReleaseId!==job.sourceReleaseId||link.draftRevision!==job.draftRevision)throw new Error("Resume worker/PR identity is not verified.");
  const intent=rows.find(r=>r.tokenId===job.tokenId&&r.tool==="propose_fix_pr"&&r.result==="requested"&&r.inputs?.operation==="open"&&r.inputs?.runnerAssignmentId===job.id&&r.inputs?.poamItemId===job.poamItemId);
  const claim=intent&&rows.some(r=>r.tokenId===job.tokenId&&r.tool==="claim_fix"&&r.result==="recorded"&&Date.parse(r.at)>=Date.parse(job.queuedAt)&&Date.parse(r.at)<=Date.parse(intent.at));
  const retest=intent&&rows.some(r=>r.tokenId===job.tokenId&&r.tool==="request_retest"&&r.result==="recorded"&&r.inputs?.issueId===job.findingId&&r.inputs?.receiptId===receipt&&Date.parse(r.at)>=Date.parse(intent.at));
  if(!claim||!retest)throw new Error("Resume requires retained owning-worker claim, PR-open intent and retest audit.");
 }
 return active;
}
