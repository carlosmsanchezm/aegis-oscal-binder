import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { proposalTabStorageKey } from "../components/binder/PlanProposal";
import { PipelineEvidenceView } from "../components/binder/PipelineEvidenceView";
import { PODINFO_RETEST_RECEIPT } from "../lib/aegis/control-rollup";

test("default received Podinfo overview offers its bound plan alongside Findings and an Effort tab with no package", () => {
  const html = renderToStaticMarkup(React.createElement(PipelineEvidenceView, { record: PODINFO_RETEST_RECEIPT, packageControls: [] }));
  assert.match(html, /Pipeline policy findings/);
  assert.match(html, /Effort 5/);
  assert.match(html, /data-testid="proposed-plans"/);
  assert.match(html, /Open proposed plan CM-6/);
  assert.match(html, /Open plan of action · draft/);
  assert.match(html, /Proposed · not accepted/);
  assert.doesNotMatch(html, /Load planning example|Stage sample SSP/);
});

test("proposal save keeps planning session headers on both read and write", async () => {
  const { saveRemediationRecord } = await import("../lib/client/remediation-save");
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init!);
    return Response.json(init?.method === "PUT" ? { ok: true } : { record: null });
  };
  try {
    await saveRemediationRecord({ key: "test-planning", assessment: null, assessments: {}, plans: [], proposals: [] }, undefined, { "x-aegis-workspace": "sa1-demo" });
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0].headers).get("x-aegis-workspace"), "sa1-demo");
    assert.equal(new Headers(requests[1].headers).get("x-aegis-workspace"), "sa1-demo");
  } finally { globalThis.fetch = original; }
});


test("opening the standard workspace cannot restore a planning proposal from this tab", () => {
  const recordKey = "binder.plan-proposals.v1:https://gitlab.com/example/project";
  const accepted = JSON.stringify([{ acceptance: "accepted", officialId: "" }]);
  const tab = new Map([[recordKey, accepted], [proposalTabStorageKey(recordKey, true), accepted]]);
  assert.equal(tab.get(proposalTabStorageKey(recordKey, true)), accepted);
  assert.equal(tab.get(proposalTabStorageKey(recordKey, false)), undefined);
  tab.set(proposalTabStorageKey(recordKey, false), "[]");
  assert.equal(tab.get(proposalTabStorageKey(recordKey, true)), accepted);
});
