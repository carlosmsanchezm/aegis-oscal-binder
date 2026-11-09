import type {FixAssignment} from "../agent/fix-runner";
import type {ReleaseEvidence} from "./release-evidence";
import type {SystemObservationEvidence} from "./pipeline-evidence";
import {AWS_DEPLOYMENT_PRODUCER} from "../collector/aws/deployment-criteria";
export type FixProgress = {startedAt:string; finishedAt:string|null; total:number; verified:number};
/** Current release proof controls the clock; stale/remaining/new unverified releases restart it. */
export function fixProgress(assignments:Omit<FixAssignment,"sessionId">[], releases:ReleaseEvidence[], trusted:readonly SystemObservationEvidence[]=[]):FixProgress|null {
  const batch = assignments.at(-1)?.batchId;
  const jobs = assignments.filter(j=>j.batchId===batch && j.state!=="abandoned");
  const startedAt = jobs.flatMap(j=>j.dispatchedAt?[j.dispatchedAt]:[]).sort()[0];
  if (!jobs.length || !startedAt) return null;
  const latest = releases.at(-1);
  const completed:string[]=[];
  const verified = latest?.rangeStatus === "verified" ? jobs.filter(j=>j.prNumber && latest.items.some(i=>{
    if(i.poamItemId!==j.poamItemId||i.prNumber!==j.prNumber||i.retestResult!=="pass")return false;
    if(i.retestReceiptId===latest.releaseSha256){completed.push(latest.collectedAt);return true;}
    // The server revalidates the linked item before supplying this projection.
    // Cloud proof has its own trusted receipt, after the merged native scan.
    const cloud=trusted.find(r=>r.releaseSha256===i.retestReceiptId && r.commitSha===latest.commitSha &&
      r.observation.producer===AWS_DEPLOYMENT_PRODUCER && r.observation.checks.length>0 &&
      r.observation.checks.every(c=>c.verdict==="pass"&&Date.parse(c.validUntil)>Date.now()) &&
      Date.parse(r.createdAt)>=Date.parse(latest.collectedAt)&&Date.parse(r.createdAt)<=Date.now()+300_000);
    if(!cloud)return false;
    completed.push(cloud.createdAt);return true;
  })).length : 0;
  return {startedAt,finishedAt:verified===jobs.length?completed.sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)!:null,total:jobs.length,verified};
}
