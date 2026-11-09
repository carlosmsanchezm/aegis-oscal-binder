import {navigateWorkspace} from "./helpers/navigation";
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { receivedRetest } from "../test/support/received-retest";

async function expectReadableStatements(page: Page, requireMultiline = true) {
  const prose = page.locator(".round21-focus-statements .l2-prose");
  await expect(prose.first()).toBeVisible();
  const bounds = await prose.evaluateAll((nodes) => nodes.map((node) => {
    const text = node as HTMLElement;
    const box = text.getBoundingClientRect();
    const card = text.closest(".l2-row")!.getBoundingClientRect();
    return {
      clipped: text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1,
      insideCard: box.bottom <= card.bottom && box.top >= card.top,
      lines: box.height / parseFloat(getComputedStyle(text).lineHeight),
      fontSize: parseFloat(getComputedStyle(text).fontSize),
      lineHeight: parseFloat(getComputedStyle(text).lineHeight),
    };
  }));
  expect(bounds.every((b) => !b.clipped && b.insideCard)).toBe(true);
  expect(bounds.every(b=>b.fontSize>=12 && b.lineHeight>=17)).toBe(true);
  // These real catalog clauses can fit in two lines in the approved wider
  // statement column. Readability requires wrapping, size and no clipping.
  if (requireMultiline) expect(bounds.some((b) => b.lines > 1)).toBe(true);
}

test("Harbor upload keeps full Level 2 statements readable without changing package or release coverage", async ({ page }) => {
  const evidence = receivedRetest();
  await page.route("**/api/pipeline/events", route => route.fulfill({ json: {
    ok: true, configured: false, webhookPath: "/api/pipeline/events",
    receivedAt: evidence.createdAt, evidence, releases: [{ evidence, receivedAt: evidence.createdAt }],
  } }));
  await page.goto("/planning");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles(path.join(process.cwd(), "fixtures/upload/upload-test-ssp-rev5.json"));
  await page.getByRole("button", { name: "Upload OSCAL", exact: true }).click();
  await expect(page.locator("[data-control-id]")).toHaveCount(12);
  await expect(page.locator("[data-family-box]")).toHaveCount(5);
  await expect(page.getByTestId("completeness-status")).toContainText("6 of 12 incomplete");
  await expect(page.locator(".pmap-legend")).toContainText("Responsible role");
  await expect(page.locator(".pmap-legend")).not.toContainText("responsibleRole");
  await page.getByLabel("Evidence system").selectOption("pipeline");await navigateWorkspace(page,"map");
  await page.locator('summary[aria-label="Release snapshot #2908682168"]').click();
  await page.getByRole("option", { name: /None current map/ }).click();
  await page.getByRole('checkbox',{name:'Show untouched controls'}).check();
  await page.locator('[data-control-id="AC-1"]').dblclick();
  await expectReadableStatements(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expectReadableStatements(page, false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("level2-back").click();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.locator('summary[aria-label="Release snapshot None"]').click();
  await page.getByRole("option", { name: /#2908682168/ }).click();
  await expect(page.getByTestId("map-rollup-summary")).toContainText("15 linked");
  await expect(page.locator('[data-release-linked="true"]')).toHaveCount(15);
  await expect(page.getByTestId("completeness-status")).toContainText("6 of 12 incomplete");
  await page.getByRole("checkbox", { name: "Show untouched controls" }).check();
  await expect(page.locator("[data-family-box]")).toHaveCount(18);
  await page.locator('[data-control-id="CM-6"]').dblclick();
  await expectReadableStatements(page);
  const panel = page.getByTestId("pipeline-control-panel");
  await expect(panel).toContainText("#2908682168");
  await expect(panel).toContainText("configuration.json");
  await expect(panel.locator(".pipeline-control-checks li")).toHaveCount(3);
  await expect(panel).toContainText("Not assigned to this statement");
  await expect(page.getByTestId("completeness-status")).toContainText("6 of 12 incomplete");
});
