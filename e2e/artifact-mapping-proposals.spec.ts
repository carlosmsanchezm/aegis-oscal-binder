import { navigateWorkspace } from "./helpers/navigation";
import { parseStoredPipelineEvidence } from "../lib/aegis/pipeline-inbound";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { readFileSync } from "node:fs";
import { proposeArtifactMappings, mappingDecision } from "../lib/aegis/artifact-mapping";
import { expect, test } from "@playwright/test";

test("a person accepts an unmapped release artifact before binder links are applied", async ({ page }, testInfo) => {
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  await navigateWorkspace(page, "release");

  const panel = page.getByTestId("mapping-proposals");
  const proposal = panel.locator('[data-proposal-artifact="configuration.raw.json"]');
  await expect(proposal).toBeVisible();
  await expect(proposal).toHaveAttribute("data-decision", "pending");
  await expect(proposal).toContainText("CM-6");
  await expect(panel).toContainText("does not establish control satisfaction or authorization");

  await proposal.getByText("Why these controls?").click();
  await expect(proposal).toContainText("Existing mapping links configuration.json to CM-6");
  await panel.getByLabel("Mapping reviewer").fill("Test reviewer");
  await proposal.getByRole("button", { name: "Accept mapping for configuration.raw.json" }).click();
  await expect(proposal).toHaveAttribute("data-decision", "accepted");
  await expect(proposal).toContainText("applied to binder evidence links");

  await page.reload();
  await navigateWorkspace(page, "release");
  const persisted = page.locator('[data-proposal-artifact="configuration.raw.json"]');
  await expect(persisted).toHaveAttribute("data-decision", "accepted");
  await persisted.getByText("Why these controls?").click();
  await persisted.screenshot({
    path: process.env.WALKTHROUGH_SCREENSHOT ?? testInfo.outputPath("artifact-mapping-accepted.png"),
  });
});

test("an explicit decision survives reload in this tab when demo cookie encryption is unavailable", async ({ page }) => {
  await page.route("**/api/demo/sa1/pipeline/mappings", route => route.fulfill({
    status: 503,
    json: {
      ok: false,
      error: {
        code: "DEMO_CONFIGURATION",
        message: "Synthetic demo cookie encryption is not configured on this host.",
        details: { storageUnset: true },
      },
    },
  }));

  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  await navigateWorkspace(page, "release");
  const panel = page.getByTestId("mapping-proposals");
  await expect(panel).toContainText("Accept and Reject choices will be retained in this browser tab");

  const proposal = panel.locator('[data-proposal-artifact="configuration.raw.json"]');
  await panel.getByLabel("Mapping reviewer").fill("Test reviewer");
  await proposal.getByRole("button", { name: "Accept mapping for configuration.raw.json" }).click();
  await expect(proposal).toHaveAttribute("data-decision", "accepted");
  await expect(proposal).toContainText("applied to binder evidence links");
  await expect(panel).toContainText("This decision is retained in this browser tab");

  await page.reload();
  await navigateWorkspace(page, "release");
  await expect(page.locator('[data-proposal-artifact="configuration.raw.json"]')).toHaveAttribute("data-decision", "accepted");
});


test("configured storage failure leaves the proposal pending and shows the save error", async ({ page }) => {
 await page.route("**/api/demo/sa1/pipeline/mappings",route=>route.fulfill({status:503,json:{ok:false,error:{code:"STORE_UNAVAILABLE",message:"Configured storage failed.",details:null}}}));
 await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
 await navigateWorkspace(page, "release");
 const panel=page.getByTestId("mapping-proposals"); const proposal=page.locator('[data-proposal-artifact="configuration.raw.json"]');
 await panel.getByLabel("Mapping reviewer").fill("Test reviewer");
  await panel.getByLabel("Mapping reviewer").fill("Test reviewer"); await proposal.getByRole("button",{name:"Accept mapping for configuration.raw.json"}).click();
 await expect(proposal).toHaveAttribute("data-decision","pending");
 await expect(page.getByTestId("mapping-proposals").getByRole("alert")).toContainText("Configured storage failed.");
 await page.reload();await navigateWorkspace(page, "release");
 await expect(page.locator('[data-proposal-artifact="configuration.raw.json"]')).toHaveAttribute("data-decision","pending");
});

test("later proposals stay reachable after the first five are decided", async ({ page },testInfo) => {
 // Test-only receipt: eight unmapped artifacts, with its original inventory already linked.
 // It declares no additional source capture; the pagination assertions stay exactly 8 / 3.
 const baseline=JSON.parse(readFileSync(new URL("../catalogs/fedramp-rev5-moderate.json",import.meta.url),"utf8")) as {families:Array<{controls:Array<{id:string}>}>};
 const record=parseStoredPipelineEvidence({...CCM_EXAMPLE,sourceInventoryHref:undefined,source:"Inbound pipeline event",
  families:[...CCM_EXAMPLE.families,...baseline.families.map((f:any)=>({family:f.id,controls:f.controls.filter((c:any)=>!c.id.includes(".")).map((c:any)=>c.id),coverage:"Navigation fixture",evidence:CCM_EXAMPLE.artifacts!}))],
  artifacts:[...CCM_EXAMPLE.artifacts!,...Array.from({length:8},(_,i)=>`configuration-${i}.raw.json`)]});
 const proposals=proposeArtifactMappings(record,baseline.families.flatMap(family=>family.controls.map(control=>control.id)));
 expect(proposals).toHaveLength(8);
 const decisions=proposals.slice(0,5).map(p=>mappingDecision(record,p,"accepted","2026-10-05T12:00:00Z"));
 await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,evidence:record,releases:[],configured:false}}));
 await page.route("**/api/demo/sa1/pipeline/mappings",route=>route.fulfill({json:{ok:true,decisions}}));
 await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("pipeline");await navigateWorkspace(page, "release");
 const panel=page.getByTestId("mapping-proposals");
 await expect(panel).toContainText("3 pending");
 await expect(panel.getByRole("button",{name:/Accept mapping/})).toHaveCount(0);
 await panel.getByRole("button",{name:"Next proposals"}).click();
 await expect(panel.getByRole("button",{name:/Accept mapping/})).toHaveCount(3);
 await expect(panel).toContainText("Page 2 of 2");
 await panel.screenshot({path:testInfo.outputPath("later-proposals.png")});
 await panel.getByRole("button",{name:"Previous proposals"}).click();
 await expect(panel).toContainText("Page 1 of 2");
});


test("a network failure cannot turn an unsaved decision into an acceptance",async({page})=>{
 await page.route("**/api/demo/sa1/pipeline/mappings",route=>route.request().method()==="POST"?route.abort("failed"):route.continue());
 await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");await navigateWorkspace(page, "release");
 const panel=page.getByTestId("mapping-proposals"); const proposal=page.locator('[data-proposal-artifact="configuration.raw.json"]');
 await panel.getByLabel("Mapping reviewer").fill("Test reviewer");
  await panel.getByLabel("Mapping reviewer").fill("Test reviewer"); await proposal.getByRole("button",{name:"Accept mapping for configuration.raw.json"}).click();
 await expect(page.getByTestId("mapping-proposals").getByRole("alert")).toBeVisible();
 await expect(proposal).toHaveAttribute("data-decision","pending");
 await page.reload();await navigateWorkspace(page, "release");
 await expect(page.locator('[data-proposal-artifact="configuration.raw.json"]')).toHaveAttribute("data-decision","pending");
});
