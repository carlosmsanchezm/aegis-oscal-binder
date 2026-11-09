import { navigateWorkspace } from "./helpers/navigation";
import { test, expect } from "@playwright/test";
import { receivedRetest } from "../test/support/received-retest";

test("planning ranks evidence-adjacent work and stores a person's next-focus choice", async ({ page }, testInfo) => {
  const evidence = receivedRetest();
  await page.route("**/api/pipeline/events", route => route.fulfill({
    json: {
      ok: true,
      configured: false,
      webhookPath: "/api/pipeline/events",
      receivedAt: evidence.createdAt,
      evidence,
      releases: [{ evidence, receivedAt: evidence.createdAt }],
    },
  }));

  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  await navigateWorkspace(page, "release");

  await page.getByLabel("Release inspector").getByRole("button", {name:/^Effort/}).click();
  const panel = page.getByRole("complementary", { name: "Recommended next efforts" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-recommendation]")).toHaveCount(5);
  await expect(panel.locator('[data-recommendation="finding:CM-6"]')).toContainText("Open finding");
  await expect(panel.locator('[data-recommendation="blank:AC-2"]')).toContainText("inspection lead, not a mapping");
  await expect(panel).toContainText("does not establish satisfaction or authorization");

  await panel.locator('[data-recommendation="finding:CM-6"]').getByRole("button", { name: "Set as next focus" }).click();
  await expect(panel.locator('[data-recommendation="finding:CM-6"]')).toContainText("Next focus · person selected");
  await page.screenshot({ path: testInfo.outputPath("recommended-effort.png"), fullPage: true });

  await page.reload();
  await navigateWorkspace(page, "release");
  await expect(page.locator('[data-recommendation="finding:CM-6"]')).toContainText("Next focus · person selected");

  await page.locator('[data-recommendation="blank:AC-2"]').getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator('[data-recommendation="blank:AC-2"]')).toHaveCount(0);
  await expect(panel.locator("[data-recommendation]")).toHaveCount(5);
  await expect(panel.getByRole("button", { name: "Restore 1 dismissed recommendation" })).toBeVisible();
});
