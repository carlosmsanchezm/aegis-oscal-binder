import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageFamilyInspector } from "../components/binder/BaselineCoverage";
import { coverageFamilies } from "../lib/aegis/baseline-coverage";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";

test("family inspector nests dotted catalog enhancements under their parent and traces each artifact", () => {
  const history = [CCM_EXAMPLE];
  const family = coverageFamilies(CCM_EXAMPLE, history, true).find(f => f.id === "CM")!;
  const markup = renderToStaticMarkup(createElement(CoverageFamilyInspector,{family,history,accumulated:true,onClose:()=>{},onOpenControl:()=>{},onReview:()=>{}}));
  assert.match(markup, /3 required enhancements/);
  assert.match(markup, /data-control="CM-2.2"[^>]*data-result="blank"/);
  assert.match(markup, /Trace configuration.json for CM-6 on map/);
  assert.match(markup, /Needs review/);
  assert.match(markup, /Blank ≠ noncompliant/);
});
