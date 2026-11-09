import earlierMapping from "./fixtures/earlier-mapping.json" with {type:"json"};
import {test, expect, type Page} from "@playwright/test";
import {readFile, writeFile} from "node:fs/promises";
import {navigateWorkspace} from "./helpers/navigation";

async function podinfo(page: Page) {
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");
}
async function boutique(page: Page) {
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("captured-reference");
  await expect(page.getByRole("heading", {name: "System connections", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true}).click();
  await expect(page.getByTestId("binder-summary")).toBeVisible();
}
async function proposal(page: Page, artifact: string) {
  const panel = page.getByTestId("mapping-proposals"), row = panel.locator(`[data-proposal-artifact="${artifact}"]`);
  for (let i = 0; i < 20 && !(await row.isVisible()); i++) await panel.getByRole("button", {name: "Next proposals"}).click();
  await expect(row).toBeVisible();
  return row;
}
async function plan(page: Page) {
  await navigateWorkspace(page, "map");
  await page.locator('[data-control-id="CM-6"]').click();
  await page.getByTestId("pipeline-control-panel").getByRole("button", {name: "Open plan of action", exact: true}).click();
  return page.getByTestId("plan-proposal");
}

test("accepted publisher mapping survives SSP load, each workspace switch and reload", async ({page}) => {
  await podinfo(page);
  const panel = page.getByTestId("mapping-proposals");
  const pending = 94;
  await expect(panel).toContainText(`${pending} pending`);
  const row = await proposal(page, "publisher-manifest.json");
  await panel.getByLabel("Mapping reviewer").fill("Alex Reviewer");
  await row.getByLabel("Control to accept for publisher-manifest.json").selectOption("CM-8");
  await row.getByRole("button", {name: "Accept mapping for publisher-manifest.json"}).click();
  await expect(row).toHaveAttribute("data-decision", "accepted");
  const audit = await row.locator(".mapping-decision").innerText();
  async function retained() {
    await navigateWorkspace(page, "release");
    await expect(panel).toContainText(`${pending - 1} pending`);
    const saved = await proposal(page, "publisher-manifest.json");
    await expect(saved.locator(".mapping-decision")).toHaveText(audit);
    await navigateWorkspace(page, "map");
    await expect(page.getByTestId("map-rollup-summary")).toContainText("16 linked");
    await expect(page.locator('[data-control-id="CM-8"]')).toBeVisible();
  }
  await retained();
  await navigateWorkspace(page, "export");
  await page.getByRole("button", {name: "Load sample SSP for this workspace"}).click();
  await retained(); // isolates the exact step that previously invalidated the profile
  await navigateWorkspace(page, "connections");
  await page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true}).click();
  await expect(page.getByTestId("binder-summary")).toBeVisible();
  await page.getByLabel("Evidence system").selectOption("example");
  await retained();
  await page.reload();
  await retained();
});

for (const system of ["podinfo", "boutique"] as const) test(`${system}: artifact count is visibly paced and finishes at the retained total`, async ({page}) => {
  await page.goto("/planning");
  await page.evaluate(() => {
    (window as any).arrivalFrames = [];
    new MutationObserver(() => {
      const node = document.querySelector('[data-testid="binder-summary"] [data-testid="artifact-arrival-count"]');
      const count = Number(node?.textContent?.match(/^(\d+)/)?.[1]);
      const frames = (window as any).arrivalFrames;
      if (node && (!frames.length || frames.at(-1).count !== count)) frames.push({count, at: performance.now()});
    }).observe(document.body, {subtree: true, childList: true, characterData: true});
  });
  if (system === "podinfo") await page.getByLabel("Evidence system").selectOption("example");
  else {
    await page.getByLabel("Evidence system").selectOption("captured-reference");
    await expect(page.getByRole("heading", {name: "System connections", exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true}).click();
  }
  const count = page.getByTestId("binder-summary").getByTestId("artifact-arrival-count");
  await expect(count).toBeInViewport();
  await expect.poll(async () => {
    const text = await count.innerText();
    const received = Number(text.match(/^(\d+)/)?.[1]);
    return received > 0 && !text.includes("complete");
  }).toBe(true);
  if (process.env.DEMO_STORY_EVIDENCE) await page.screenshot({path: `${process.env.DEMO_STORY_EVIDENCE}/round1-${system}-arrival.png`, fullPage: true});
  await expect(count).toContainText("complete");
  const frames = await page.evaluate(() => (window as any).arrivalFrames as {count: number; at: number}[]);
  if (process.env.DEMO_STORY_EVIDENCE) await writeFile(`${process.env.DEMO_STORY_EVIDENCE}/round1-${system}-arrival.json`, JSON.stringify(frames, null, 2));
  const total = system === "podinfo" ? 274 : 197;
  expect(frames.at(-1)?.count).toBe(total);
  const rising = frames.filter((frame, index) => index > 0 && frame.count > frames[index - 1].count);
  expect(rising.length).toBeGreaterThanOrEqual(Math.ceil(total / Math.ceil(total / 40)) - 1);
  expect(rising.every((frame,index)=>frame.count - (index ? rising[index-1].count : 0) <= Math.ceil(total / 40))).toBe(true);
  for (const frame of rising) {
    const index = frames.indexOf(frame);
    expect(frame.at - frames[index - 1].at, "each received row should remain readable before the next arrival").toBeGreaterThanOrEqual(120);
  }
});

test("reselecting a connected workspace opens System connections with its load action", async ({page}) => {
  await boutique(page);
  const selection = await page.getByLabel("Evidence system").inputValue();
  await page.getByLabel("Evidence system").selectOption("example");
  await page.getByLabel("Evidence system").selectOption(selection);
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "connections");
  await expect(page.getByRole("button", {name: "Load captured Online Boutique evidence", exact: true})).toBeVisible();
});

test("drawer body shows status and the owner matches exported plain and contact fields", async ({page}) => {
  await podinfo(page);
  const drawer = await plan(page);
  await expect(drawer.getByLabel("Who owns it")).toHaveValue("Unassigned");
  await expect(drawer.locator(".rem-drawer-body").getByTestId("plain-plan-status")).toHaveText("Closure proposed · Drafted · needs a person");
  await drawer.getByRole("button", {name: "Accept proposed draft", exact: true}).click();
  async function exported(owner: string) {
    const pending = page.waitForEvent("download");
    await drawer.getByRole("button", {name: "Download OSCAL plan of action"}).click();
    const file = await pending;
    const body = JSON.parse(await readFile((await file.path())!, "utf8"))["plan-of-action-and-milestones"];
    const props = body["poam-items"][0].props;
    expect(props.find((p: any) => p.name === "point-of-contact")?.value).toBe(owner);
    expect(JSON.parse(props.find((p: any) => p.name === "plain-plan-record").remarks).plain.whoOwnsIt).toBe(owner);
  }
  await exported("Unassigned");
  await drawer.getByLabel("Who owns it").fill("Alex Reviewer");
  await exported("Alex Reviewer");
});

for (const viewport of [{width: 1280, height: 800}, {width: 1366, height: 768}, {width: 1440, height: 900}]) test(`roles clear every tile header with AC-6 selected at ${viewport.width}x${viewport.height}`, async ({page}, info) => {
  await page.setViewportSize(viewport);
  await boutique(page);
  await navigateWorkspace(page, "export");
  await page.getByRole("button", {name: "Load sample SSP for this workspace"}).click();
  await expect(page.getByRole("button", {name: "New package", exact: true})).toBeVisible();
  await navigateWorkspace(page, "map");
  await expect(page.getByRole("button", {name: "Roles", exact: true})).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("checkbox", {name: "Show untouched controls"}).check();
  await page.locator('[data-control-id="AC-6"]').click();
  await expect(page.locator('[data-control-id="AC-6"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pipeline-control-panel")).toBeVisible();
  for (const family of ["AT", "AU", "CA"]) await expect(page.locator(`[data-family-header="${family}"]`)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator(".pmap-role").first()).toBeVisible();
  const overlaps = await page.evaluate(() => {
    const headers = [...document.querySelectorAll("[data-family-header]")].map(node => ({id: node.getAttribute("data-family-header"), rect: node.getBoundingClientRect()}));
    return [...document.querySelectorAll(".pmap-role")].flatMap(node => {
      const rect = node.getBoundingClientRect();
      return headers.filter(header => rect.left < header.rect.right && rect.right > header.rect.left && rect.top < header.rect.bottom && rect.bottom > header.rect.top).map(header => ({role: node.getAttribute("title"), header: header.id}));
    });
  });
  expect(overlaps).toEqual([]);
  await page.screenshot({path: process.env.DEMO_STORY_EVIDENCE ? `${process.env.DEMO_STORY_EVIDENCE}/round1-roles-${viewport.width}.png` : info.outputPath("roles-clear-headers.png")});
});

test("confirmed plan closure updates its map tile immediately and after reload", async ({page}) => {
  await podinfo(page);
  const drawer = await plan(page);
  await drawer.getByRole("button", {name: "Accept proposed draft", exact: true}).click();
  await drawer.getByLabel("Closure name").fill("Alex Reviewer");
  await drawer.getByLabel("Closure reason").fill("Reviewed all passing measurements.");
  await drawer.getByRole("button", {name: "Confirm closure", exact: true}).click();
  const tile = page.locator('[data-control-id="CM-6"]');
  await expect(tile).toContainText("Closed");
  await expect(tile.locator('.pmap-review-state[data-plan-state="open"]')).toHaveCount(0);
  await expect(drawer.getByTestId("plain-plan-status")).toHaveText(/^Closed · Closure confirmed by a person/);
  await expect(tile).toContainText("1 open"); // a separate finding is not closed by this decision
  await drawer.getByRole("button", {name: "Close proposed plan"}).click();
  await page.reload();
  await expect(tile).toContainText("Closed");
  await expect(tile.locator('.pmap-review-state[data-plan-state="open"]')).toHaveCount(0);
});

test("an earlier SSP acceptance keeps its exact reviewer, time and controls in catalog review", async ({page}) => {
  await podinfo(page);
  await navigateWorkspace(page, "export");
  await page.getByRole("button", {name: "Load sample SSP for this workspace"}).click();
  await expect(page.getByRole("button", {name: "New package", exact: true})).toBeVisible();
  const pkg = (await (await page.request.get("/api/demo/sa1/package")).json()).packageState;
  expect(pkg.loaded).toBe(true);
  const earlier = earlierMapping;
  expect(pkg.controls.map((control: any) => control.id).sort()).toEqual(earlier.profile.controlIds);
  const response = await page.request.post("/api/demo/sa1/pipeline/mappings", {data: {proposalKey: earlier.key, profile: earlier.profile, status: "accepted", controls: ["CM-6"], reviewer: "Earlier reviewer"}});
  expect(response.status()).toBe(200);
  const saved = (await response.json()).decision;
  await page.reload();
  await navigateWorkspace(page, "export");
  await page.getByRole("button", {name: "New package", exact: true}).click();
  await navigateWorkspace(page, "release");
  const row = await proposal(page, "configuration.raw.json");
  await expect(row).toHaveAttribute("data-decision", "accepted");
  await expect(row).toContainText(`Earlier reviewer · CM-6 · ${saved.decidedAt}`);
  const records = (await (await page.request.get("/api/demo/sa1/pipeline/mappings", {headers: {"x-aegis-mapping-scope": "catalog"}})).json()).decisions;
  expect(records).toContainEqual(saved);
  expect(records.find((record: any) => record.proposalKey === earlier.key).controls).toEqual(["CM-6"]);
});
