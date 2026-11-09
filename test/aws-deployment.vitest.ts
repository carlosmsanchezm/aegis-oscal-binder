import { describe, it, expect, vi } from "vitest";
import { awsDeploymentEvent } from "../lib/collector/aws/deployment";
import { AWS_IAC_CRITERIA } from "../lib/collector/aws/deployment-criteria";
import { ingestProwler } from "../lib/collector/aws/ingest";
import { connectedReleases } from "../lib/aegis/connected-evidence";
import { scannerRetestDiff } from "../lib/collector/retest-diff";
import { awsIaCHeadProof } from "../lib/collector/aws/head-proof";
import { collectedScannerProof, collectedPrHeadProof } from "../lib/aegis/collected-closure";
import { sealCollectedArtifact } from "../lib/collector/seal";
import { parseScanner } from "../lib/collector/scanners";
import { parseEvidenceEvent, type EvidenceEvent } from "../lib/builder/evidence";
import { digest } from "../lib/collector/collect";
import type { CollectedArtifact } from "../lib/collector/types";
import type { SystemObservationEvidence } from "../lib/aegis/pipeline-evidence";
import {accountScanSummary} from "../lib/collector/aws/summary";
import {mapEvidenceFiles} from "../lib/aegis/map-evidence-files";

const trusted=vi.hoisted(()=>({releases:[] as SystemObservationEvidence[]}));
vi.mock("../lib/collector/trusted-release",()=>({trustedReleases:async()=>trusted.releases}));
vi.mock("../lib/github/pull-requests",()=>({pullRequestLinks:async()=>[]}));
const repo="https://github.com/unit-tests/private-demo";
const base="a".repeat(40),head="b".repeat(40);
const paths={s3_bucket_object_versioning:["infra/aegis-demo/modules/gaps/bucket.tf"],
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22:["infra/aegis-demo/modules/gaps/network.tf"]};
const then=new Date(Date.now()-120_000).toISOString(),later=new Date(Date.now()-60_000).toISOString();

/** Mock data for unit tests only. These values are never retained as take receipts. */
function scan(partition:"aws"|"aws-us-gov",status:string,time:string,trigger:"local-profile"|"fixture"="local-profile"){
  const account=partition==="aws"?"123456789012":"111122223333",region=partition==="aws"?"us-east-1":"us-gov-west-1";
  const findings=Object.keys(AWS_IAC_CRITERIA).map(id=>({
    metadata:{event_code:id,product:{name:"Prowler",version:"5.45.0"},version:"1.5.0"},status_code:status,status_detail:"Unit test check.",
    cloud:{provider:"aws",partition,region,account:{uid:account}},resources:[{uid:`arn:${partition}:iam::${account}:root`,region}],
  }));
  return ingestProwler({target:{partition,allowedAccountIds:[account],regions:[region]},findings,
    caller:{Account:account,Arn:`arn:${partition}:iam::${account}:root`,UserId:"unit-test"},capturedAt:time,now:new Date(time),trigger,gitCommit:base});
}
function projection(event:EvidenceEvent):SystemObservationEvidence{
  const id=digest(JSON.stringify(event));
  return connectedReleases({id:"00000000-0000-0000-0000-000000000000",name:"Unit test",createdAt:then,revokedAt:null,
    history:[{id,receivedAt:event.run.observedAt,run:event.run,subject:event.subject,checks:event.checks,limitations:event.limitations,
      artifacts:event.artifacts.map(a=>({name:a.name,sha256:a.sha256})),
      collectedArtifacts:event.artifacts.map(a=>JSON.parse(Buffer.from(a.contentBase64,"base64").toString()) as CollectedArtifact)}]},"https://demo.example")[0];
}
function cloud(status="FAIL",commit=base,time=then){return projection(awsDeploymentEvent([scan("aws",status,time),scan("aws-us-gov",status,time)],{repository:repo,appliedCommit:commit,fixPaths:paths}));}
function native(commit:string,time:string,failed:boolean){
  const result=parseScanner("checkov",{results:{failed_checks:failed?Object.entries(AWS_IAC_CRITERIA).map(([criterion,rule])=>({check_id:rule,repo_file_path:paths[criterion as keyof typeof paths][0],file_line_range:[1,5]})):[],
    passed_checks:[{check_id:"CKV_AWS_21"}],parsing_errors:[]},summary:{failed:failed?2:0}},"checkov.json");
  const artifact=sealCollectedArtifact({schema:"aegis.collected-artifact.v1",name:`source-${digest(commit).slice(0,24)}.json`,type:"checkov",source:{kind:"scan-result",repo,commit,path:"ci/checkov.json",sha256:digest(commit)},capturedAt:time,sha256:"0".repeat(64),facts:result.facts,limitations:["Unit test data only."]});
  const bytes=JSON.stringify(artifact);
  return projection(parseEvidenceEvent({schema:"aegis.evidence-event.v1",run:{id:failed?"101":"102",producer:"GitHub Actions",observedAt:time},subject:{kind:"code",id:repo,revision:commit},
    checks:[{id:"checkov",version:"unit-test-v1",description:"Test Checkov",requirement:{framework:"Scanner policy",reference:"checkov",objective:"Same pinned criteria"},verdict:failed?"fail":"pass",artifacts:[artifact.name],validUntil:new Date(Date.parse(time)+86400_000).toISOString()}],
    artifacts:[{name:artifact.name,mediaType:"application/json",sha256:digest(bytes),contentBase64:Buffer.from(bytes).toString("base64")}],limitations:["Unit test data only."]}));
}

describe("operator AWS deployment projection",()=>{
  it("retains neutral per-account full-scan summaries without adding control mappings or changing planted findings",()=>{
    const scans=[scan("aws","FAIL",then),scan("aws-us-gov","FAIL",then)];
    const links=Object.fromEntries(scans.map((s,i)=>[s.record.integrity.sha256,`/api/builder/evidence/${String(i+1).repeat(64)}?connection=00000000-0000-0000-0000-000000000000&artifact=scan-${s.record.integrity.sha256.slice(0,24)}.json`]));
    const view=projection(awsDeploymentEvent(scans,{repository:repo,appliedCommit:base,fixPaths:paths,plantedBranch:"codex/phase7-cloud-baseline"},links));
    expect(view.reviewItems).toHaveLength(2);
    const summaries=view.collectedArtifacts!.filter(a=>accountScanSummary(a));
    expect(summaries).toHaveLength(2);
    for(const artifact of summaries){
      const summary=accountScanSummary(artifact)!;
      expect(summary.counts.error).toBeGreaterThan(0);
      expect(artifact.facts.every(f=>!f.outcome)).toBe(true);
      expect(view.observation.checks.every(c=>!c.artifacts.includes(artifact.name))).toBe(true);
      const row=mapEvidenceFiles(view,[view],["CM-6"]).find(f=>f.name===artifact.name)!;
      expect(row.inventory).toBe(true);expect(row.controlIds).toEqual([]);
      const unsafe=structuredClone(artifact);unsafe.facts.find(f=>f.field==="inventory.full_scan_receipt")!.value="https://other.example/scan";
      expect(accountScanSummary(unsafe)).toBe(null);
    }
    const newer=structuredClone(view);newer.createdAt=later;newer.releaseSha256="f".repeat(64);
    for(const artifact of newer.collectedArtifacts!){artifact.capturedAt=later;artifact.name=artifact.name.replace("source-","source-new-");}
    newer.artifacts=newer.collectedArtifacts!.map(a=>a.name);
    const selected=mapEvidenceFiles(newer,[view,newer],["CM-6"]).filter(f=>f.inventory);
    expect(selected).toHaveLength(2);expect(selected.every(f=>f.capturedAt===later)).toBe(true);
    expect(mapEvidenceFiles(view,[view,newer],["CM-6"]).filter(f=>f.inventory).every(f=>f.capturedAt===then)).toBe(true);
  });
  it("groups two IaC corrections across both accounts while preserving AWS source identity and full record hashes",()=>{
    const scans=[scan("aws","FAIL",then),scan("aws-us-gov","FAIL",then)],original=JSON.stringify(scans);
    const event=awsDeploymentEvent(scans,{repository:repo,appliedCommit:base,fixPaths:paths}),view=projection(event);
    expect(view.reviewItems).toHaveLength(2);
    for(const issue of view.reviewItems!)expect(issue.scope.artifacts).toHaveLength(2);
    for(const issue of view.reviewItems!)expect(issue.scope.controls).toContain("CM-6");
    expect(view.collectedArtifacts!.every(a=>a.source.kind==="aws-account"&&!("repo" in a.source)&&!("commit" in a.source))).toBe(true);
    expect(view.collectedArtifacts!.every(a=>a.facts.some(f=>f.field==="deployment.scan_record_sha256"))).toBe(true);
    expect(event.limitations.join(" ")).toContain("Operator-local");
    expect(scans.every(s=>s.record.checks.some(c=>c.result==="error"))).toBe(true);
    expect(JSON.stringify(scans)).toBe(original);
  });
  it("rejects fixture triggers, envelope tamper, mixed source identity and duplicate account/region input",()=>{
    const good=scan("aws","FAIL",then),binding={repository:repo,appliedCommit:base,fixPaths:paths};
    expect(()=>awsDeploymentEvent([scan("aws","FAIL",then,"fixture")],binding)).toThrow(/fixture/);
    const tampered=structuredClone(good);tampered.record.checks[0].result="pass";
    expect(()=>awsDeploymentEvent([tampered],binding)).toThrow(/hash/);
    const mixed=structuredClone(good);mixed.artifacts[0].source={...mixed.artifacts[0].source,account:"111111111111"} as typeof mixed.artifacts[0]["source"];
    expect(()=>awsDeploymentEvent([mixed],binding)).toThrow(/mismatch/);
    expect(()=>awsDeploymentEvent([good,good],binding)).toThrow(/Duplicate/);
  });
  it("requires explicit live PASS in every originally bound account and region",()=>{
    const before=cloud(),after=cloud("PASS",head,later);
    expect(scannerRetestDiff(before,after).fixed).toHaveLength(2);
    const partial=structuredClone(after);partial.collectedArtifacts!.pop();
    expect(scannerRetestDiff(before,partial).fixed).toEqual([]);
    expect(scannerRetestDiff(before,partial).unverified).toHaveLength(2);
    const errored=cloud("MANUAL",head,later);
    expect(scannerRetestDiff(before,errored).fixed).toEqual([]);
    expect(scannerRetestDiff(before,errored).unverified).toHaveLength(2);
    const foreign=structuredClone(after);foreign.collectedArtifacts![1].source={...foreign.collectedArtifacts![1].source,region:"us-gov-east-1"} as CollectedArtifact["source"];
    expect(scannerRetestDiff(before,foreign).fixed).toEqual([]);
    expect(scannerRetestDiff(before,after,Date.now()+2*86400_000).fixed).toEqual([]);
    expect(scannerRetestDiff(before,{...after,commitSha:base}).comparable).toBe(false);
  });
  it("does not allow one passing account to hide a failure in the other",()=>{
    const before=cloud(),mixed=projection(awsDeploymentEvent([scan("aws","PASS",later),scan("aws-us-gov","FAIL",later)],{repository:repo,appliedCommit:head,fixPaths:paths}));
    expect(scannerRetestDiff(before,mixed).remaining).toHaveLength(2);
    expect(scannerRetestDiff(before,mixed).fixed).toEqual([]);
  });
  it("uses exact native Checkov head criteria for merge readiness while refusing cloud closure without live retest",async()=>{
    const before=cloud(),baseline=native(base,then,true),corrected=native(head,later,false),issue=before.reviewItems![0];
    trusted.releases=[baseline,before,corrected];
    expect(awsIaCHeadProof(before,issue.id,trusted.releases,head)).toBe(corrected);
    const review=await collectedPrHeadProof("unit",before.pipelineId,issue.id,"unit",head);
    expect(review.ready).toBe(true);
    expect(review.retests).toEqual([]);
    expect((await collectedScannerProof("unit",before.pipelineId,issue.id,undefined,head)).ready).toBe(false);
    expect((await collectedScannerProof("unit",before.pipelineId,issue.id)).ready).toBe(false);
    const live=cloud("PASS",head,new Date(Date.parse(later)+1000).toISOString());trusted.releases.push(live);
    const closure=await collectedScannerProof("unit",before.pipelineId,issue.id,undefined,head,corrected.releaseSha256);
    expect(closure.ready).toBe(true);
    expect("retest" in closure ? closure.retest?.releaseSha256 : undefined).toBe(live.releaseSha256);
    expect(closure.retests[0].evidence).toBe(live.pipelineUrl);
    expect(awsIaCHeadProof(before,issue.id,[baseline,before,native(head,later,true)],head)).toBeNull();
  });
  it("does not accept an uploaded event as an internal collector receipt",async()=>{
    const before=cloud();trusted.releases=[];
    expect((await collectedScannerProof("unit",before.pipelineId,before.reviewItems![0].id)).ready).toBe(false);
  });
});
