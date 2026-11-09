import {selectAuthorizationRetest} from "./helpers/collector-reference";
import { navigateWorkspace } from "./helpers/navigation";
import { test, expect } from "@playwright/test";

test("native AC-6 statement label stays on one line and clear of its prose; the whole check card opens its viewer", async ({ page, context }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect a system or load captured evidence" }).click();
  await page.getByRole("button", { name: "Load captured Online Boutique evidence" }).click();
  await navigateWorkspace(page,"release");
  await expect(page.getByTestId("release-dashboard")).toBeVisible();
  await page.getByRole("button", { name: "Package map", exact: true }).click();
  await page.locator('[data-control-id="AC-6"]').first().dblclick();
  const row = page.locator('[data-item-id="ac-6_smt"]');
  await row.click();
  for (const width of [1440, 1280, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row).toBeVisible();
    const bounds = await row.evaluate(el => {
      const label = el.querySelector(".l2-label")!, prose = el.querySelector(".l2-prose")!;
      const labelRect = label.getBoundingClientRect(), proseRect = prose.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(label);
      return { label: label.textContent, height: labelRect.height, right: labelRect.right, proseLeft: proseRect.left, textWidth: range.getBoundingClientRect().width, width: labelRect.width };
    });
    expect(bounds.label).toBe("ac-6_smt");
    expect(bounds.height).toBeLessThan(24);
    expect(bounds.textWidth).toBeLessThanOrEqual(bounds.width + 1);
    expect(bounds.right).toBeLessThan(bounds.proseLeft);
  }
  await page.screenshot({ path: info.outputPath("native-statement-label.png"), fullPage: true });
  await page.getByRole("button", { name: "Release evidence", exact: true }).click();
  await selectAuthorizationRetest(page);
  const link = page.getByRole("link", { name: "frontend-secret-read ↗", exact: true });
  const href = await link.getAttribute("href");
  const card = page.locator("article.observation-check").filter({ has: link });
  // Click the card's padding, away from both the title and its explicit arrow link.
  const popup = page.waitForEvent("popup");
  await card.click({ position: { x: 5, y: 5 } });
  const viewer = await popup;
  await expect(viewer).toHaveURL(new URL(href!, page.url()).toString());
  await expect(viewer.getByTestId("retained-check")).toContainText("frontend-secret-read");
  await viewer.close();
  await link.focus();
  const keyboardPopup = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const keyboardViewer = await keyboardPopup;
  await expect(keyboardViewer.getByTestId("retained-check")).toContainText("Captured PASS");
  await keyboardViewer.close();
  const artifactLink = card.getByRole("link", { name: "Result ↗", exact: true });
  await expect(artifactLink).toHaveAttribute("title", "authorization-review.json");
  const artifactPopup = page.waitForEvent("popup");
  await artifactLink.click();
  const artifact = await artifactPopup;
  await expect(artifact.getByTestId("retained-artifact")).toContainText('"allowed": false');
  await expect(artifact).toHaveURL(/artifact=authorization-review.json/);
  await artifact.close();
  expect(context.pages()).toHaveLength(1);
  // A new control bookmark takes focus; reload keeps it while Map remains the last tab.
  await page.goto("/planning?control=AC-6&pipeline=1");
  await expect(page.getByTestId("level2-breadcrumb")).toContainText("AC-6");
  await page.reload();
  await expect(page.getByTestId("level2-breadcrumb")).toContainText("AC-6");
  await navigateWorkspace(page, "release");
  await page.reload();
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "release");
  await expect(page.getByTestId("release-dashboard")).toBeVisible();
});

test("reload restores every planning tab, preserves query entry intent and separates the package editor", async ({ page, browser }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
  for (const view of ["connections", "release", "export", "changes", "future", "map"]) {
    await navigateWorkspace(page, view);
    await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", view);
    await page.reload();
    await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", view);
    if (view === "future") await expect(page.locator(".stub-grid .stub")).toHaveCount(6);
    if (view === "changes") await expect(page.getByRole("heading", { name: "No baseline yet" })).toBeVisible();
  }
  await navigateWorkspace(page, "release");
  await page.goto("/planning?view=connections");
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "connections");
  await navigateWorkspace(page, "release");
  await page.reload();
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "release");
  await page.goto("/workspace?editor=classic");
  await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
  await page.goto("/planning");
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "release");
  const other = await browser.newContext({ baseURL: info.project.use.baseURL });
  const fresh = await other.newPage();
  await fresh.goto("/planning");
  await expect(fresh.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
  await other.close();
  await page.evaluate(() => sessionStorage.setItem("binder.workspace-view.v1:planning", "unknown-view"));
  await page.reload();
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
});

test("site root loads and reloads with successful startup reads and no HTTP or browser errors", async ({ page }) => {
  const failures: string[] = [], errors: string[] = [];
  page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  for (let i = 0; i < 2; i++) {
    const reads = ["/api/builder", "/api/pipeline/events", "/api/demo/sa1/package", "/api/demo/sa1/pipeline/mappings"].map(path => page.waitForResponse(response => new URL(response.url()).pathname === path));
    if (i === 0) await page.goto("/"); else await page.reload();
    for (const response of await Promise.all(reads)) expect(response.status()).toBe(200);
    await expect(page.getByTestId("workspace-navigation").locator('[data-view="map"]')).toBeEnabled();
  }
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});
