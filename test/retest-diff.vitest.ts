import {releaseIssues} from "../lib/aegis/release-issues";
import {deriveReviewItems} from "../lib/collector/derive-review-items";
import {it,expect,vi} from "vitest";
import {scannerRetestDiff} from "../lib/collector/retest-diff";
import {CCM_EXAMPLE,type SystemObservationEvidence} from "../lib/aegis/pipeline-evidence";
import type {CollectedArtifact} from "../lib/collector/types";
const fact={key:"configuration-scan",value:"fail",field:"finding.KSV-0020/frontend.yaml",line:1,content:"finding.KSV-0020/frontend.yaml = fail",outcome:"fail" as const};
function record(commit:string,time:string,failed:boolean,count=failed?1:0):SystemObservationEvidence{
 const artifact:CollectedArtifact={schema:"aegis.collected-artifact.v1",name:`source-${"a".repeat(24)}.json`,type:"configuration",source:{kind:"scan-result",repo:"https://github.com/synthetic/repo",commit,path:"configuration.json",sha256:"b".repeat(64)},sha256:"b".repeat(64),capturedAt:time,facts:[{key:"scan-findings",value:count,field:"findings.count",line:1,content:`findings.count = ${count}`},...(failed?[fact]:[])],limitations:[]};
 const check={id:"configuration",version:"1.0.0",description:"Synthetic check",requirement:{framework:"Scanner policy",reference:"configuration",objective:"Same criteria"},verdict:failed?"fail" as const:"pass" as const,artifacts:[artifact.name],validUntil:"2026-10-28T00:00:00Z"};
 return {...CCM_EXAMPLE,schema:"aegis.evidence-event.v1",source:"Retained system observation",image:null,approval:null,runtime:null,commitSha:commit,createdAt:time,collectedArtifacts:[artifact],observation:{connectionId:"00000000-0000-0000-0000-000000000000",systemName:"Synthetic fixture",subject:{kind:"code",id:"https://github.com/synthetic/repo",revision:commit},producer:"Synthetic fixture",checks:[check],artifactDigests:[],reportedOutcome:check.verdict}};
}
it("proves a finding absent only in a complete fresh comparable retest",()=>{const before=record("a".repeat(40),"2026-10-26T12:00:00Z",true),after=record("b".repeat(40),"2026-10-26T13:00:00Z",false);const now=Date.parse("2026-10-26T14:00:00Z");expect(scannerRetestDiff(before,after,now).fixed).toHaveLength(1);expect(scannerRetestDiff(before,{...after,collectedArtifacts:after.collectedArtifacts!.map(a=>({...a,facts:[{key:"scan-findings",value:99,field:"findings.count",line:1,content:"findings.count = 99"}]}))},now).unverified).toHaveLength(1);expect(scannerRetestDiff(before,after,Date.parse("2026-10-29T00:00:00Z")).fixed).toEqual([]);});
it("refuses a same-commit or foreign-subject comparison",()=>{const before=record("a".repeat(40),"2026-10-26T12:00:00Z",true);expect(scannerRetestDiff(before,{...before,createdAt:"2026-10-26T13:00:00Z"}).comparable).toBe(false);});

it("does not keep a fixed label after a newer regression invalidates an earlier passing retest",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
 try{const before=record("a".repeat(40),"2026-10-26T12:00:00Z",true),pass=record("b".repeat(40),"2026-10-26T13:00:00Z",false),regression=record("c".repeat(40),"2026-10-26T14:00:00Z",true);before.reviewItems=deriveReviewItems(before.collectedArtifacts!);expect(releaseIssues(before,[],[pass]).count("fixed")).toBe(1);expect(releaseIssues(before,[],[pass,regression]).count("fixed")).toBe(0);}finally{vi.useRealTimers();}
});
