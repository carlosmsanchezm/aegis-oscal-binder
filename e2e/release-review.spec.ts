import { chooseStartingPoint, navigateWorkspace } from "./helpers/navigation";
import { test, expect } from "@playwright/test";
import { CCM_EXAMPLE, summaryForSession } from "../lib/aegis/pipeline-evidence";

// The planning workspace starts empty. These cases explicitly select its recorded example.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(summary => {
    if (!sessionStorage.getItem("aegis.planning.release.v1")) sessionStorage.setItem("aegis.planning.release.v1", JSON.stringify(summary));
  }, summaryForSession(CCM_EXAMPLE));
  await page.route("**/api/pipeline/events", route => route.fulfill({ json: { ok: true, configured: false, webhookPath: "/api/pipeline/events", receivedAt: null, evidence: null, releases: [] } }));
  await page.goto("/planning/pipeline");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  const ingested = page.waitForResponse(response => response.url().endsWith("/api/demo/sa1/oscal/ingest") && response.request().method() === "POST");
  await chooseStartingPoint(page, "Load planning example");
  expect((await ingested).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Load planning example", exact: true })).toBeHidden();
  await expect(page.getByTestId("package-map")).toBeVisible();
  // These SSP-role cases deliberately exercise the scoped package view.
  await page.getByRole("checkbox",{name:"Show untouched controls"}).uncheck();
});

test("map modes retain the selected control and distinguish its links from the whole family", async ({ page }) => {
  // Inspect the authored SSP, including controls without release evidence.
  await page.locator(".round21-snapshot > summary").click();
  await page.getByRole("option",{name:/None current map/}).click();
  const gate = await page.getByTestId("completeness-status").textContent();
  const map = page.getByTestId("package-map");
  await map.locator('[data-control-id="SC-7"]').click();
  await expect(map.getByTestId("map-mode-context")).toHaveText("Control SC-7 · individual connections");
  if (await map.getByRole("button", { name: "Roles", exact: true }).getAttribute("aria-pressed") !== "true") await map.getByRole("button", { name: "Roles", exact: true }).click();
  await page.mouse.move(1, 1);
  const sc8Role = map.locator('[data-rel="role"][data-to="SC-8"]').first();
  const individualOpacity = Number(await sc8Role.getAttribute("opacity"));
  await page.getByRole("button", { name: "By family", exact: true }).click();
  await expect(map.getByTestId("map-mode-context")).toHaveText(/Family SC · all \d+ package controls/);
  await expect(map.locator('[data-control-id="SC-7"]')).toHaveAttribute("aria-pressed", "true");
  const familyOpacity = Number(await sc8Role.getAttribute("opacity"));
  expect(familyOpacity).toBeGreaterThan(individualOpacity);
  await page.getByRole("button", { name: "Selected control", exact: true }).click();
  await expect(map.getByTestId("map-mode-context")).toHaveText("Control SC-7 · individual connections");
  await expect(sc8Role).toHaveAttribute("opacity", String(individualOpacity));
  await expect(map.locator('[data-family-box="SC"]')).not.toHaveAttribute("data-selected", "true");
  await page.locator(".round21-snapshot > summary").click();
  await page.getByRole("option",{name:/#2894050908/}).click();
  await expect(page.getByTestId("pipeline-control-panel").getByRole("link", { name: "configuration.json ↗", exact: true })).toHaveAttribute("data-source-href", /16815627409.*configuration.json$/);
  await expect(page.getByTestId("completeness-status")).toHaveText(gate!);
});

test("release sources remain readable and trace into control-level evidence without changing the SSP gate", async ({ page }) => {
  const gate = await page.getByTestId("completeness-status").textContent();
  await navigateWorkspace(page, "release");
  await page.locator(".release-chain-fold > summary").click();
  const chain = page.locator(".release-chain");
  await expect(chain.locator(":scope > div")).toHaveCount(6);
  // The current overview uses readable wrapped rows; every source must stay inside its card.
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1541, height: 927 }, { width: 1800, height: 1100 }]) {
    await page.setViewportSize(viewport);
    const fits = await chain.locator(":scope > div").evaluateAll(cards => cards.every(card => {
      const box = card.getBoundingClientRect();
      return Array.from(card.children).every(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= box.left - 1 && bounds.right <= box.right + 1 && bounds.bottom <= box.bottom + 1;
      });
    }));
    expect(fits).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.baseline-footprint-grid [data-family="AT"]')).toHaveAttribute("data-linked", "0");
  await expect(page.locator('.baseline-footprint-grid [data-family="PE"]')).toHaveAttribute("data-linked", "0");
  await expect(page.locator(".baseline-footprint-grid > button")).toHaveCount(18);
  await page.getByRole("button", { name: /linked · Baseline coverage/ }).click();
  const overlaps=await page.locator(".pmap-layer [data-control-id]").evaluateAll(cards=>{
    const boxes=cards.map(card=>({id:card.getAttribute("data-control-id"),box:card.getBoundingClientRect()}));
    return boxes.flatMap((a,i)=>boxes.slice(i+1).filter(b=>a.box.left<b.box.right&&a.box.right>b.box.left&&a.box.top<b.box.bottom&&a.box.bottom>b.box.top).map(b=>[a.id,b.id]));
  });expect(overlaps).toEqual([]);
  await page.locator('[data-control-id="SC-7"]').click();
  const panel = page.getByTestId("pipeline-control-panel");
  await expect(panel.getByRole("link", { name: "configuration.json ↗", exact: true })).toHaveAttribute("data-source-href", /16815627409.*configuration.json$/);
  await panel.getByRole("button", { name: "Open SC-7 in Level 2 →" }).click();
  await expect(page.getByTestId("level2-item-coverage")).toContainText("Recorded control-level evidence");
  await expect(page.locator(".round21-focus-evidence")).toContainText("Not mapped to");
  await page.locator(".round21-focus-evidence").getByRole("button", { name: /configuration.json/ }).click();
  await expect(panel.getByRole("link", { name: "configuration.json ↗", exact: true })).toBeFocused();
  await expect(panel).toContainText("Not assigned to this statement");
  await expect(page.getByTestId("completeness-status")).toHaveText(gate!);
});

test("release picker, artifact origins and policy versus review actions stay independently inspectable", async ({ page }) => {
  const gate = await page.getByTestId("completeness-status").textContent();
  await navigateWorkspace(page, "release");
  await expect(page.locator(".chrome-nav")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "System connections", exact: true })).toBeVisible();
  const picker = page.getByLabel("Release selection", { exact: true });
  await expect(picker).toHaveValue(JSON.stringify([CCM_EXAMPLE.pipelineUrl, CCM_EXAMPLE.commitSha, CCM_EXAMPLE.releaseSha256]));
  await page.getByRole("button", { name: "View pipeline policy findings" }).click();
  const policy = page.getByRole("complementary", { name: "Pipeline policy findings" });
  await expect(policy).toBeFocused();
  await expect(policy.locator(".release-policy-details > section")).toHaveCount(CCM_EXAMPLE.checks.length);
  for (const check of CCM_EXAMPLE.checks) {
    await expect(policy.getByRole("link", { name: `${check.artifact} ↗`, exact: true })).toHaveAttribute("data-source-href", new RegExp(`16815627409.*${check.artifact.replaceAll(".", "\\.")}$`));
  }
  await page.getByRole("button", { name: "View open security review items" }).click();
  const review = page.getByRole("complementary", { name: "Open review items" });
  await expect(review).toBeFocused();
  await expect(review.locator(".release-review-detail[open]")).toHaveCount(0);
  const networkGap = CCM_EXAMPLE.gaps.find(gap => /network.policy/i.test(gap))!;
  const networkReview = review.locator(".release-review-detail").filter({ hasText: networkGap });
  await expect(networkReview.locator("p")).toBeHidden();
  await networkReview.locator("summary").click();
  await expect(networkReview.locator("p")).toHaveText(networkGap);
  await expect(networkReview.locator("p")).toBeVisible();
  await expect(page.getByTestId("completeness-status")).toHaveText(gate!);
});

test("imported review observations retain their content and release identity after reload", async ({ page }) => {
  const gate = await page.getByTestId("completeness-status").textContent();
  await navigateWorkspace(page, "release");
  const customGap = "Imported observation: verify deploy-key rotation before release.";
  const imported = { ...CCM_EXAMPLE, findingCount: 34, reviewItems: [], gaps: [customGap] };
  await page.getByLabel("Import CCM summary JSON").setInputFiles({ name: "review-summary.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(summaryForSession(imported))) });
  await expect(page.getByTestId("release-dashboard")).toContainText("34 findings");
  await page.getByRole("button", { name: "View open security review items" }).click();
  const review = page.getByRole("complementary", { name: "Open review items" });
  await expect(review.locator(".release-review-detail summary")).toHaveText(customGap);
  await expect(review.locator(".release-review-detail p")).toBeHidden();
  await review.locator(".release-review-detail summary").click();
  await expect(review.locator(".release-review-detail p")).toHaveText(customGap);
  await expect(page.getByTestId("release-dashboard")).toContainText("34 findings");
  await page.reload();
  await expect(page.getByTestId("release-dashboard")).toContainText("34 findings");
  await page.getByRole("button", { name: "View open security review items" }).click();
  await expect(page.locator(".release-review-detail summary")).toHaveText(customGap);
  await expect(page.getByTestId("completeness-status")).toHaveText(gate!);
});
