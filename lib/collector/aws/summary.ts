import type { CollectedArtifact } from "../types";

export function plantedAwsArtifact(artifact?:CollectedArtifact){return artifact?.source.kind==="aws-account"&&artifact.facts.some(f=>f.field==="deployment.demo_branch"&&f.value==="codex/phase7-cloud-baseline");}

/** A view over shared collected facts, never a second evidence model or verdict. */
export function accountScanSummary(artifact?: CollectedArtifact) {
  if (artifact?.source.kind !== "aws-account") return null;
  const receipt=artifact.facts.find(f=>f.field==="inventory.full_scan_receipt")?.value,connection=artifact.facts.find(f=>f.field==="inventory.connection_id")?.value,record=artifact.facts.find(f=>f.field==="inventory.scan_record_sha256")?.value;
  if(typeof receipt!=="string"||!/^[a-f0-9]{64}$/.test(receipt)||typeof connection!=="string"||!/^[a-f0-9-]{36}$/.test(connection)||typeof record!=="string"||!/^[a-f0-9]{64}$/.test(record))return null;
  const href=`/api/builder/evidence/${receipt}?connection=${connection}&artifact=scan-${record.slice(0,24)}.json`;
  const counts=Object.fromEntries(["pass","fail","error","manual","not_applicable"].map(key=>[key,artifact.facts.find(f=>f.field===`inventory.${key}`)?.value]));
  if(Object.values(counts).some(v=>typeof v!=="number"||!Number.isSafeInteger(v)||v<0))return null;
  return {key:`${artifact.source.partition}:${artifact.source.account}`,title:artifact.source.partition==="aws-us-gov"?"GovCloud account scan":"Commercial account scan",href,counts:counts as Record<"pass"|"fail"|"error"|"manual"|"not_applicable",number>};
}

export function awsArtifactTitle(artifact?:CollectedArtifact) {
  const summary=accountScanSummary(artifact);
  if(summary)return summary.title;
  if(plantedAwsArtifact(artifact) && artifact?.source.kind==="aws-account") {
    return `${artifact.source.partition==="aws-us-gov"?"GovCloud":"Commercial"} planted checks`;
  }
  return artifact?.source.path;
}
