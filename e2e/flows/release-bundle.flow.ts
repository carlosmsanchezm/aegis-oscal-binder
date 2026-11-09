import {test, expect} from "@playwright/test";
import {readFileSync} from "node:fs";
import type {ReleaseEvidence} from "../../lib/aegis/release-evidence";
import type {SystemObservationEvidence} from "../../lib/aegis/pipeline-evidence";
import type {EvidenceConnection} from "../../lib/aegis/connected-evidence";
import type {PlanProposal} from "../../lib/aegis/plan-proposal";
const fixture = JSON.parse(readFileSync("e2e/fixtures/release-bundle.json", "utf8")) as {
  connection: EvidenceConnection; records: SystemObservationEvidence[]; proposals: PlanProposal[];
};
const connectionId = fixture.connection.id;
// Synthetic read-side projections exercise rendering/navigation, not provider trust.
// The backend suite separately exercises the collector, exact receipt, range and human gates.
for (const viewport of [{width:1440,height:900}, {width:1280,height:800}]) test("Release bundle strip and release-linked map at " + viewport.width, async ({page}, info) => {
  await page.setViewportSize(viewport);
  const {connection, records, proposals} = fixture;
  const repository = records[0].observation.subject.id, runId = records[1].artifactJobId;
  let remaining = false;
  const bundle = (): ReleaseEvidence => ({
    schema: "binder.release-evidence.v1", connectionId, repository,
    releaseId: records[1].pipelineId, releaseSha256: records[1].releaseSha256, commitSha: records[1].commitSha,
    previousCommitSha: records[0].commitSha, tagOrDeploy: runId, collectedAt: records[1].createdAt,
    releaseUrl: repository + "/actions/runs/" + runId, rangeStatus: "verified", remainingControls: [],
    items: proposals.map((p,i) => ({poamItemId: p.id, findingId: p.id.split(":").at(-1)!, sourceReleaseId: records[0].pipelineId,
      controlId: p.controlId, prNumber: 7+i, prUrl: repository + "/pull/" + (7+i), mergeSha: String(i+1).repeat(40),
      ciRunId: "700", ciRunUrl: repository + "/actions/runs/700",
      ciRuns: [{id: "700", url: repository + "/actions/runs/700"}],
      retestResult: remaining && i === 1 ? "remaining" : "pass", retestReceiptId: records[1].releaseSha256})),
  });
  await page.route("**/api/pipeline/events", route => route.fulfill({json: {ok:true, configured:false, evidence:null, releases:[]}}));
  await page.route("**/api/builder", route => route.request().method() === "GET" ?
    route.fulfill({json: {ok:true, connections:[{...connection, releaseEvidence:[bundle()]}]}}) : route.continue());
  await page.route("**/api/remediation?*", route => route.fulfill({json: {ok:true, sessionScope:"synthetic-bundle-browser",
    record:{key:"synthetic-projection",assessment:null,assessments:{},plans:[],proposals:[],issueDrafts:proposals.map((p,i) => ({...p,
      readyToClose: !(remaining && i === 1), correctiveReleaseId: records[1].pipelineId,
      retests: remaining && i === 1 ? [] : p.provingChecks.map(description => ({description,
        evidence: repository + "/actions/runs/" + runId, result:"Synthetic collected projection",
        date:"2026-10-30",capturedAt:new Date().toISOString(),reviewer:"Synthetic fixture",verdict:"pass",evidenceState:"pass",releaseId:records[1].pipelineId})),
    }))}}}));
  for (const state of ["pass","remaining"] as const) {
    remaining = state === "remaining";
    await page.goto("/planning?view=release");
    const strip = page.getByTestId("release-bundle-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("button")).toHaveCount(remaining ? 1 : 2);
    await expect(strip.locator("p")).toHaveCount(0);
    await strip.getByRole("button").first().click();
    await expect(page.getByTestId("plan-proposal")).toBeVisible();
    await expect(page.getByTestId("plan-proposal").getByText("A person confirms closure")).toBeVisible();
    await page.keyboard.press("Escape");
    await info.attach("bundle-strip-" + state + "-" + viewport.width, {body: await page.screenshot(), contentType:"image/png"});
    await page.getByRole("button", {name:"Package map",exact:true}).click();
    const tile = page.locator('[data-control-id="CM-6"]');
    if (remaining) {
      await expect(tile).not.toHaveAttribute("data-release-fixed", "true");
      await expect(tile).not.toHaveAttribute("href", /release=/);
    } else {
      await expect(tile).toHaveAttribute("data-release-id", records[1].pipelineId);
      await expect(tile).toHaveAttribute("href", /view=release.*release=/);
      await expect(tile).toHaveCSS("background-color", "rgb(227, 247, 238)");
      await tile.scrollIntoViewIfNeeded();
      await expect(tile).toBeInViewport();
      await info.attach("bundle-map-" + viewport.width, {body: await page.screenshot(), contentType:"image/png"});
      await tile.click();
      await expect(page.getByTestId("release-bundle-strip")).toBeVisible();
    }
  }
});
