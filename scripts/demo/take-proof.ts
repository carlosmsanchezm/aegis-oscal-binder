/** A gate success from a human override is never a passing scanner retest. */
export function headGateProgress(prs:any[],trace:any[],ids:string[]){
 const complete=prs.length===5&&new Set(prs.map(p=>p.prNumber)).size===5&&ids.every(id=>prs.some(p=>p.poamItemId===id));
 const latest=(pr:any)=>trace.findLast(e=>e.body?.reason_code==="poam_gate_evaluated"&&e.body.commit===pr.headSha&&e.body.items?.includes(pr.poamItemId))?.body.summary;
 const decisions=prs.map(latest);
 const rejected=decisions.some(d=>d&&d.conclusion!=="success"&&!['Current PR head needs successful CI checks.','A fresh server-collected retest on the current PR head is required.'].includes(d.reason));
 return {evaluated:complete&&decisions.every(Boolean),rejected,green:complete&&decisions.every(d=>d?.conclusion==="success"&&d.reason==="Linked POA&M, current-head CI and server-collected retest verified. Human closure remains required.")};
}
export function releaseTakeReady(jobs:any[],bundle:any,ids:string[]){
 return jobs.length===5&&jobs.every(j=>j.readyForClosureReview)&&bundle?.rangeStatus==="verified"&&ids.every(id=>bundle.items.some((i:any)=>i.poamItemId===id&&i.retestResult==="pass"&&/^[a-f0-9]{64}$/.test(i.retestReceiptId)));
}
type TakeRun={databaseId:number;headSha:string;headBranch:string;status:string;conclusion:string};
/** Scheduling hints only: gate and release readiness still require server proof. */
export function retainedNativeRuns(history:any[],repository:string,now=Date.now()):string[]{
 return [...new Set(history.filter(h=>Array.isArray(h.artifacts)&&h.artifacts.length&&h.artifacts.every((artifact:any)=>artifact.source_label?.kind==="server-collected")&&
  /^[a-f0-9]{64}$/.test(h.id??"")&&h.subject?.id===`https://github.com/${repository}`&&
  h.run?.producer==="GitHub Actions"&&/^[1-9][0-9]*$/.test(h.run?.id??"")&&
  Number.isFinite(Date.parse(h.run?.observedAt))&&Date.parse(h.run.observedAt)<=now+300_000&&
  Array.isArray(h.checks)&&h.checks.length&&h.checks.every((check:any)=>Date.parse(check.validUntil)>now)&&
  ["semgrep","checkov"].every(engine=>h.checks.some((check:any)=>check.description===`${engine} scanner result`))
 ).map(h=>String(h.run.id)))];
}
/** One real successful run per current PR/merge head, plus the protected release branch. */
export function currentTakeRuns(runs:TakeRun[],prs:{headSha:string;mergedCommitSha?:string}[],ref:string,collected:ReadonlySet<string>){
 const heads=new Set(prs.flatMap(pr=>[pr.headSha,...(pr.mergedCommitSha?[pr.mergedCommitSha]:[])]));
 const seen=new Set(runs.filter(run=>collected.has(String(run.databaseId))).map(run=>run.headSha));
 return runs.filter(run=>{
  if(run.status!=="completed"||run.conclusion!=="success"||collected.has(String(run.databaseId))||seen.has(run.headSha)||(!heads.has(run.headSha)&&run.headBranch!==ref))return false;
  seen.add(run.headSha);return true;
 }).reverse();
}
