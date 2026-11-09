import { test, expect } from "@playwright/test";
import { navigateWorkspace } from "./helpers/navigation";
test("Round 31 navigation keeps secondary features reachable and explains actual export prerequisites", async ({ page }) => {
  await page.goto("/planning");
  const nav=page.getByTestId("workspace-navigation");
  await expect(nav.locator(":scope > button")).toHaveCount(5);
  await expect(page.getByLabel("Workspace view")).toHaveCount(0);
  await nav.getByRole("button",{name:"More"}).click();
  await expect(nav.getByRole("link",{name:/Package workspace/})).toContainText("Open the active planning workspace");
  await page.keyboard.press("Escape");
  await expect(nav.getByRole("button",{name:"More"})).toHaveAttribute("aria-expanded","false");
  await navigateWorkspace(page,"future");await expect(page.locator(".stub-grid .stub")).toHaveCount(6);
  await navigateWorkspace(page,"export");
  await expect(page.getByTestId("export-empty")).toContainText("incomplete loaded package can still be exported as WIP");
  await expect(page.getByTestId("export-empty")).toContainText("Independent of rendering");
  await page.reload();await expect(nav).toHaveAttribute("data-current-view","export");
  await page.getByRole("button",{name:"Upload SSP on Package map"}).click();await expect(nav).toHaveAttribute("data-current-view","map");
});
