import {test, expect, type Page} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {navigateWorkspace} from "./helpers/navigation";
async function load(page: Page, system: "podinfo" | "boutique") {
  await page.goto("/planning");
  if (system === "podinfo") await page.getByLabel("Evidence system").selectOption("example");
  else {
    await page.getByLabel("Evidence system").selectOption("captured-reference");
    await page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true}).click();
  }
  await expect(page.getByTestId("binder-summary").getByTestId("artifact-arrival-count")).toContainText("complete");
}

test("closed plan badge agrees with the map tile immediately and after reload", async ({page}) => {
  await load(page, "podinfo");
  await navigateWorkspace(page, "map");
  const tile = page.locator('[data-control-id="CM-6"]');
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("pipeline-control-panel");
  await expect(panel.locator("header")).toContainText("Needs review");
  await page.getByTestId("pipeline-control-panel").getByRole("button", {name: "Open plan of action", exact: true}).click();
  const drawer = page.getByTestId("plan-proposal");
  await drawer.getByRole("button", {name: "Accept proposed draft", exact: true}).click();
  await drawer.getByLabel("Closure name").fill("Throwaway round 2 reviewer");
  await drawer.getByLabel("Closure reason").fill("Reviewed the retained passing measurements.");
  await drawer.getByRole("button", {name: "Confirm closure", exact: true}).click();
  await expect(tile).toContainText("Closed · 1 open");
  await expect(panel.locator("header")).toContainText("Closed · 1 open");
  await expect(panel.locator("header")).not.toContainText("Needs review");
  await drawer.getByRole("button", {name: "Close proposed plan"}).click();
  if (process.env.DEMO_STORY_EVIDENCE) await page.screenshot({path: `${process.env.DEMO_STORY_EVIDENCE}/round2-closed-panel.png`});
  await page.reload();
  await expect(tile).toContainText("Closed · 1 open");
  await expect(panel.locator("header")).toContainText("Closed · 1 open");
  await expect(panel.locator("header")).not.toContainText("Needs review");
});

for (const system of ["podinfo", "boutique"] as const) test(`${system}: returning to evidence and reloading never replay arrivals; an actual load does`, async ({page}) => {
  await load(page, system);
  const total = system === "podinfo" ? 274 : 197;
  await page.evaluate(() => {
    (window as any).returnCounts = [];
    new MutationObserver(() => {
      const node = document.querySelector('[data-testid="binder-summary"] [data-testid="artifact-arrival-count"]');
      if (node) (window as any).returnCounts.push(Number(node.textContent?.match(/^(\d+)/)?.[1]));
    }).observe(document.body, {subtree: true, childList: true, characterData: true});
  });
  await navigateWorkspace(page, "map");
  await navigateWorkspace(page, "release");
  const count = page.getByTestId("binder-summary").getByTestId("artifact-arrival-count");
  await expect(count).toBeVisible();
  const seen = await page.evaluate(() => (window as any).returnCounts as number[]);
  expect(seen.length).toBeGreaterThan(0);
  expect(new Set(seen)).toEqual(new Set([total]));
  await page.addInitScript(() => {
    (window as any).reloadCounts = [];
    new MutationObserver(() => {
      const node = document.querySelector('[data-testid="binder-summary"] [data-testid="artifact-arrival-count"]');
      if (node) (window as any).reloadCounts.push(Number(node.textContent?.match(/^(\d+)/)?.[1]));
    }).observe(document, {subtree: true, childList: true, characterData: true});
  });
  await page.reload();
  await expect(count).toHaveText(`${total} artifacts loaded · complete`);
  const reloadSeen = await page.evaluate(() => (window as any).reloadCounts as number[]);
  expect(new Set(reloadSeen)).toEqual(new Set([total]));
  // New load actions are allowed to replay, including loading the same bytes again.
  if (system === "podinfo") {
    await page.getByLabel("Evidence system").selectOption("");
    await page.getByLabel("Evidence system").selectOption("example");
  } else {
    await navigateWorkspace(page, "connections");
    await page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true}).click();
  }
  await expect.poll(async () => /loading recorded artifacts/.test(await count.innerText())).toBe(true);
  await expect(count).toHaveText(`${total} artifacts loaded · complete`);
  if (process.env.DEMO_STORY_EVIDENCE) await writeFile(`${process.env.DEMO_STORY_EVIDENCE}/round2-${system}-return-counts.json`, JSON.stringify(seen));
});

for (const viewport of [{width:1280,height:800}, {width:1366,height:768}, {width:1440,height:900}]) for (const system of ["podinfo", "boutique"] as const)
  test(`${system} ${viewport.width}x${viewport.height}: historical summary and current map keep proposals separate from links`, async ({page}, info) => {
    await page.setViewportSize(viewport);
    await load(page, system);
    const families = Number(await page.getByTestId("binder-summary").getByTestId("summary-family-coverage").getAttribute("data-touched-families"));
    expect(families).toBe(11);
    const mapFamilies=families;
    await navigateWorkspace(page, "map");
    await expect(page.getByRole("checkbox", {name:"Show untouched controls"})).not.toBeChecked();
    await expect(page.locator("[data-family-box]")).toHaveCount(mapFamilies);
    const proposalOnly = await page.locator("[data-family-box]").evaluateAll(nodes => nodes.filter(node => node.getAttribute("data-linked") === "0" && Number(node.getAttribute("data-proposed")) > 0).map(node => node.getAttribute("data-family-box")));
    expect(proposalOnly.length).toBeGreaterThan(0);
    const untouched = await page.locator("[data-family-box]").evaluateAll(nodes => nodes.filter(node => Number(node.getAttribute("data-linked")) === 0 && Number(node.getAttribute("data-proposed")) === 0).length);
    expect(untouched).toBe(0);
    const proposedTile = page.locator('[data-proposal-control]').first();
    await expect(proposedTile.locator(".pmap-status-line")).toHaveAttribute("title",/proposed artifact mappings, not accepted/);
    await expect(proposedTile).toHaveAttribute("aria-label", /not accepted/);
    await expect(proposedTile).not.toContainText("● linked");
    await expect(page.getByTestId("map-rollup-summary")).toContainText(`${system === "podinfo" ? 15 : 1} linked`);
    await page.screenshot({path: process.env.DEMO_STORY_EVIDENCE ? `${process.env.DEMO_STORY_EVIDENCE}/round2-${system}-${viewport.width}-proposed-map.png` : info.outputPath("proposed-map.png")});
    await proposedTile.click();
    await expect(page.getByTestId("pipeline-control-panel").locator("header")).toContainText("Proposed mapping · not accepted");
    await page.getByRole("button", {name:"Close panel", exact:true}).click();
    await page.getByRole("checkbox", {name:"Show untouched controls"}).check();
    expect(await page.locator("[data-family-box]").count()).toBeGreaterThan(mapFamilies);
    await page.getByRole("checkbox", {name:"Show untouched controls"}).uncheck();
    await expect(page.locator("[data-family-box]")).toHaveCount(mapFamilies);
  });

test("accepting an artifact moves its suggestions to linked coverage while retaining the current map family set", async ({page}) => {
  await load(page, "podinfo");
  const panel = page.getByTestId("mapping-proposals"), row = panel.locator('[data-proposal-artifact="publisher-manifest.json"]');
  for (let i=0;i<20 && !(await row.isVisible());i++) await panel.getByRole("button", {name:"Next proposals"}).click();
  await panel.getByLabel("Mapping reviewer").fill("Throwaway round 2 mapping reviewer");
  await row.getByLabel("Control to accept for publisher-manifest.json").selectOption("CM-8");
  await row.getByRole("button", {name:"Accept mapping for publisher-manifest.json"}).click();
  await expect(row).toHaveAttribute("data-decision", "accepted");
  const mapFamilies=Number(await page.getByTestId("summary-family-coverage").getAttribute("data-touched-families"));
  await navigateWorkspace(page, "map");
  await expect(page.getByTestId("map-rollup-summary")).toContainText("16 linked");
  await expect(page.locator("[data-family-box]")).toHaveCount(mapFamilies);
  await expect(page.locator('[data-control-id="CM-8"]')).toContainText("● linked");
});
