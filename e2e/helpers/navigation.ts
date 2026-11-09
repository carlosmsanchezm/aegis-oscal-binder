import { expect, type Page } from "@playwright/test";
export async function navigateWorkspace(page: Page, view: string) {
  // A captured system imports more than one receipt before its summary opens.
  if (["map", "release"].includes(view) && await page.locator('[data-testid="reference-connection"][data-load-state="loading"]').count()) {
    await expect(page.getByTestId("binder-summary")).toBeVisible();
  }
  if (await page.getByTestId("source-inventory-loading").count()) await expect(page.getByTestId("source-inventory-loading")).toHaveCount(0);
  const nav = page.getByTestId("workspace-navigation");
  if (view === "future") await nav.getByRole("button", { name: "More" }).click();
  await nav.locator(`[data-view="${view}"]`).click();
  await expect(nav).toHaveAttribute("data-current-view", view);
}

export async function chooseStartingPoint(page: Page, name: string) {
  if (await page.getByTestId("source-inventory-loading").count()) await expect(page.getByTestId("source-inventory-loading")).toHaveCount(0);
  const button=page.getByRole("button", {name,exact:true});
  if (!(await button.isVisible())) {
    const moreStarts = page.locator("summary").filter({hasText:"More starting points"});
    if (await moreStarts.count()) await moreStarts.first().click();
    else await page.getByTestId("workspace-navigation").getByRole("button", { name: "More", exact: true }).click();
  }
  await button.click();
}

export async function toggleDeveloperDetails(page: Page) {
  const nav = page.getByTestId("workspace-navigation");
  await nav.getByRole("button", { name: "More", exact: true }).click();
  await nav.getByRole("button", { name: /^Developer details/ }).click();
}
