import {createHash} from "node:crypto";
import {sealCollectedArtifact} from "../../lib/collector/seal";
import {collectorEvents} from "../../lib/collector/events";
import {parseEvidenceEvent} from "../../lib/builder/evidence";
import {DEMO_GAPS} from "./gaps";
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
/** Recorded fixtures exercise the shared collector pipeline in isolated tests only. */
export function demoEvent(repository:string, commit:string, at:string, run:string, remaining:readonly string[]=DEMO_GAPS.map(g=>g.id), count=5) {
  const artifacts = Array.from({length:count}, (_,i) => {
    const gap = DEMO_GAPS[i % DEMO_GAPS.length], id = i < 5 ? gap.id : gap.id + "-" + i;
    const field = "finding." + id + "/" + gap.path;
    const failed = remaining.includes(id);
    return sealCollectedArtifact({schema:"aegis.collected-artifact.v1", name:"source-"+hash(id).slice(0,24)+".json", type:"Synthetic demo scanner fixture",
      source:{kind:"scan-result",repo:repository,commit,path:"demo-scans/"+id+".json",sha256:hash(JSON.stringify({id,failed,commit}))}, capturedAt:at,sha256:"0".repeat(64),
      facts:[{key:"scan-findings",field:"findings.count",value:failed?1:0,line:1,content:`findings.count = ${failed?1:0}`},
        {key:gap.key,field:"scanner.completed",value:true,line:1,content:"scanner.completed = true"},
        ...(failed ? [{key:gap.key,field,value:"fail",line:1,content:field+" = fail",outcome:"fail",fixPaths:[i < 5 ? gap.path : `synthetic/item-${i}.py`], resourceIds:[i < 5 ? gap.resource : `demo:resource-${i}`]}] : [])],
      limitations:["SYNTHETIC DEMO FIXTURE. No live cloud observation or customer evidence.", "Scanner mappings require applicability review; no authorization or human closure."]});
  });
  const event = JSON.parse(collectorEvents(artifacts)[0].rawEvent);
  // Reuse the shared event contract; fixtures report a complete scan for each planted gap.
  event.run = {id:run,url:repository+"/actions/runs/"+run,producer:"GitHub Actions",observedAt:at};
  event.checks = artifacts.map((a,i) => ({id:"demo-"+i,version:"1",description:"SYNTHETIC complete scanner fixture", requirement:{framework:"NIST SP 800-53 Rev 5",reference:DEMO_GAPS[i%5].control,objective:"Rerun the same synthetic scanner criteria"},verdict:a.facts.some(f=>f.outcome==="fail")?"fail":"pass",artifacts:[a.name],validUntil:new Date(Date.parse(at)+3600000).toISOString()}));
  return parseEvidenceEvent(event);
}
