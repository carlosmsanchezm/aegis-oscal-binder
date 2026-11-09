import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceByControl } from "../lib/collector/control-evidence";
import { familyViewport } from "../lib/collector/family-viewport";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
test("control index keeps declared evidence separate from suggested files", () => {
  const index = evidenceByControl([CCM_EXAMPLE], ["CM-6", "AC-2"]);
  const cm = index.controls.find((c) => c.id === "CM-6")!;
  assert(cm.evidence.some((file) => file.name === "configuration.json"));
  for (const control of index.controls)
    for (const file of control.suggested)
      assert(!control.evidence.includes(file));
  assert.equal(
    new Set(index.files.map((file) => file.key)).size,
    index.files.length,
  );
});
test("family viewport pins headers within their frame and marks continued edges", () => {
  const lane = { x: 10, y: 20, w: 400, h: 1000, headerH: 40 };
  const view = familyViewport(lane, {
    left: 50,
    top: 500,
    width: 300,
    height: 200,
  });
  assert.equal(view.headerTop, 500);
  assert(view.cutTop && view.cutBottom && view.cutLeft && view.cutRight);
  const end = familyViewport(lane, {
    left: 0,
    top: 1000,
    width: 500,
    height: 200,
  });
  assert.equal(end.headerTop, 956);
  assert.equal(end.cutBottom, false);
});

test("accepted and dismissed suggestions retain their source-bound decisions",async()=>{
 const {mappingDecision}=await import('../lib/aegis/artifact-mapping');
 const ids=['CM-6','AC-2'];
 const pending=evidenceByControl([CCM_EXAMPLE],ids).controls.find(c=>c.id==='CM-6')!.suggested.find(file=>file.proposal)!;
 assert(pending?.proposal);
 const decision=mappingDecision(pending.source,pending.proposal,'accepted','2026-10-26T10:00:00Z',['CM-6'],'Synthetic reviewer');
 const accepted=evidenceByControl([CCM_EXAMPLE],ids,'fedramp-rev5',[decision]).controls.find(c=>c.id==='CM-6')!;
 const file=accepted.evidence.find(file=>file.key===pending.key)!;
 assert.equal(file.decision?.reviewer,'Synthetic reviewer');assert.equal(file.decision?.decidedAt,decision.decidedAt);
 assert(!accepted.suggested.some(file=>file.key===pending.key));
 const dismissed=evidenceByControl([CCM_EXAMPLE],ids,'fedramp-rev5',[{...decision,status:'rejected'}]);
 assert(!dismissed.controls.some(control=>control.suggested.some(file=>file.key===pending.key)));
});
