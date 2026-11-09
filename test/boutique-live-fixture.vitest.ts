// Recordings of real Actions runs. Never production defaults.
import {it,expect} from "vitest";
import {createHash} from "node:crypto";
import original from "../fixtures/boutique-live/40446239616/event.json";
import retest from "../fixtures/boutique-live/40446815397/event.json";
import {parseEvidenceEvent} from "../lib/builder/evidence";
import {summarizeBuilderBundle} from "../lib/server/builder-observation";
import {connectedReleases} from "../lib/aegis/connected-evidence";
import {scannerRetestDiff} from "../lib/collector/retest-diff";
import {scannerFindingId} from "../lib/collector/derive-review-items";
import {releaseIssues} from "../lib/aegis/release-issues";
import {proposePlans} from "../lib/aegis/plan-proposal";
import {issueDraft} from "../lib/aegis/issue-actions";
function recording(value:unknown){const event=parseEvidenceEvent(value),rawEvent=JSON.stringify(event);return summarizeBuilderBundle({schema:"aegis.evidence-bundle.v1",connectionId:"00000000-0000-0000-0000-000000000000",id:createHash("sha256").update(rawEvent).digest("hex"),rawEvent,event,receivedAt:event.run.observedAt,integrity:"verified",authentication:"browser-owner"});}
const clock=Date.parse(retest.run.observedAt)+60_000;
const [before,after]=connectedReleases({id:"00000000-0000-0000-0000-000000000000",name:"Online Boutique",createdAt:original.run.observedAt,revokedAt:null,history:[recording(original),recording(retest)]},"https://binder.example",clock);
it("retains actual run identity, nine scanner inputs, runtime counts and all configuration findings",()=>{
 expect(before.commitSha).toBe("f97c3dd235afb076d6fde9c5bda37e0e272d34da");expect(after.commitSha).toBe("0de50e1a46822c1553272402fa95bc2f8af7037f");
 expect(before.checks).toHaveLength(9);expect(before.checks.find(c=>c.id==="configuration")?.findings).toBe(79);expect(after.checks.find(c=>c.id==="configuration")?.findings).toBe(77);
 expect(after.collectedArtifacts?.find(a=>a.source.path==="runtime.json")?.facts.find(f=>f.field==="pods.ready")?.value).toBe(12);
 expect(after.collectedArtifacts?.find(a=>a.source.path==="summary.json")?.facts.find(f=>f.field==="images.count")?.value).toBe(11);
 expect(before.approval).toBeNull();expect(after.checks.find(c=>c.id==="publisher-signature")?.status).toBe("unknown");
});
it("proves exactly two frontend UID and GID findings fixed without accepting a mapping or closing a plan",()=>{
 const expected=["KSV-0020","KSV-0021"].map(rule=>scannerFindingId("configuration.json",`finding.${rule}/frontend.yaml`)).sort();
 expect(scannerRetestDiff(before,after,clock).fixed.sort()).toEqual(expected);
 expect(before.reviewItems?.filter(i=>expected.includes(i.id)).every(i=>i.mappingStatus==="proposed")).toBe(true);
 expect(proposePlans([before,after])).toEqual([]);
 const finding=before.reviewItems!.find(i=>i.id===expected[0])!;const draft=issueDraft(before,finding,{risk:"Recorded scanner finding",action:"Proposed frontend configuration review",verification:"Rerun the same scanner"});expect(draft.acceptance).toBe("proposed");expect(draft.readyToClose).toBe(false);expect(draft.closureConfirmed).toBe(false);
});

it("uses all retained batches at the selected snapshot without including future runs",async()=>{
 const {evidenceInventoryRecords}=await import("../lib/collector/control-evidence");
 expect(evidenceInventoryRecords(before,[before,after]).map(r=>r.commitSha)).toEqual([before.commitSha]);
 expect(evidenceInventoryRecords(after,[before,after]).map(r=>r.commitSha)).toEqual([before.commitSha,after.commitSha]);
});
