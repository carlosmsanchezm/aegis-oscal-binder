import { parseEvidenceEvent } from "../../builder/evidence";
import { readConnection, ownsConnection } from "../../server/builder-store";
import { connectedPrRepo } from "../../github/pull-requests";
import { digest } from "../collect";
import { retainInternalCollectorEvent } from "../trusted-release";
import { awsDeploymentEvent, type AwsDeploymentBinding } from "./deployment";
import { collectLiveAws } from "./run";
import type { AccountTarget } from "./account";
import { recordBytes } from "./scan-record";
import type { IngestedScan } from "./ingest";

/** Operator CLI only; never an upload endpoint. Both source data and trusted receipts
 * originate inside the live STS/Prowler collector, after owner/repository checks. */
export async function collectAndRetainAwsDeployment(input:{connectionId:string;sessionId:string;owner:string;
  binding:AwsDeploymentBinding;targets:{target:AccountTarget;profile:string;out:string;requiredRoleArn:string}[]}) {
  const connection=await readConnection(input.connectionId);
  if(!connection||connection.revokedAt||!ownsConnection(connection,input.owner)||!/^[a-f0-9]{32}$/.test(input.sessionId))
    throw new Error("An active owning workspace is required for operator collection.");
  const repo=await connectedPrRepo(input.connectionId);
  if(input.binding.repository!==`https://github.com/${repo.owner}/${repo.repo}`)throw new Error("Applied repository does not match the connection.");
  if(!input.targets.length||input.targets.length>10)throw new Error("A bounded set of partition-scoped profiles is required.");
  const scans:IngestedScan[]=[];
  for(const options of input.targets)scans.push(collectLiveAws(options));
  // Build and validate the projection before writing any authoritative receipt.
  awsDeploymentEvent(scans,input.binding);
  const context={origin:"operator-live-aws" as const,scanRecords:scans.map(s=>s.record.integrity.sha256).sort()};
  const captureReceipts:string[]=[];
  const fullScans:Record<string,string>={};
  for(const scan of scans){
    for(const event of scan.events){
      const original=parseEvidenceEvent(JSON.parse(event.rawEvent));
      const name=`event-${event.id.slice(0,24)}.json`;
      // The complete account inventory remains inspectable as its original shared
      // event bytes. It does not turn missing checks into package control failures
      // or passes; the explicitly selected live criteria are projected below.
      const inventory=parseEvidenceEvent({...original,run:{...original.run,id:original.run.id+"-inventory-"+event.id.slice(0,12)},
        checks:original.checks.map(c=>({...c,artifacts:[name]})),
        artifacts:[{name,mediaType:"application/json",contentBase64:Buffer.from(event.rawEvent).toString("base64"),sha256:digest(event.rawEvent)}],
        limitations:[...original.limitations,"Complete account event retained as inventory. Only explicitly selected deployment criteria enter the remediation projection."]});
      const bundle=await retainInternalCollectorEvent(input.connectionId,input.sessionId,inventory,context);
      captureReceipts.push(bundle.id);
    }
    // The registered integrity envelope is an attachment over the same artifacts,
    // not another evidence model. Its full check/error inventory stays available.
    const original=parseEvidenceEvent(JSON.parse(scan.events[0].rawEvent));
    const bytes=recordBytes(scan.record),name=`scan-${scan.record.integrity.sha256.slice(0,24)}.json`;
    const envelope=parseEvidenceEvent({...original,run:{...original.run,id:original.run.id+"-envelope-"+scan.record.integrity.sha256.slice(0,12)},
      checks:original.checks.map(c=>({...c,artifacts:[name]})),
      artifacts:[{name,mediaType:"application/json",contentBase64:Buffer.from(bytes).toString("base64"),sha256:digest(bytes)}],
      limitations:[...original.limitations,"Registered AWS scan integrity envelope. Full checks retained; no control effectiveness is inferred from its digest."]});
    const retained=await retainInternalCollectorEvent(input.connectionId,input.sessionId,envelope,context);
    captureReceipts.push(retained.id);
    fullScans[scan.record.integrity.sha256]=`/api/builder/evidence/${retained.id}?connection=${input.connectionId}&artifact=${name}`;
  }
  const deployment=awsDeploymentEvent(scans,input.binding,fullScans);
  const bundle=await retainInternalCollectorEvent(input.connectionId,input.sessionId,deployment,context);
  // The normal hosted GitHub collection refreshes release projections, retest
  // requests and gates. The local collector never needs GitHub App signing keys.
  return {bundle,captureReceipts,records:scans.map(s=>s.record),projectionPending:true};
}
