import { toggleDeveloperDetails } from "./helpers/navigation";
import { expect, test } from "@playwright/test";

test("Rev5 stays selected across reload and sample upload", async ({ page }) => {
  await page.goto("/workspace?editor=classic");
  await page.request.post("/api/workspace/reset");
  await page.goto("/workspace?editor=classic");

  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).toBeChecked();
  await expect(page.getByText("CATALOG_REQUIRED")).toHaveCount(0);

  await page.getByRole("button", { name: "Pin", exact: true }).first().focus();
  await expect(page.getByRole("tooltip")).toContainText("baseline version");

  await page.getByRole("button", { name: "Stage sample SSP" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sample-oscal-ssp-rev5.json" })).toBeVisible();
  await expect(page.getByText("CATALOG_REQUIRED")).toHaveCount(0);

  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("CATALOG_REQUIRED")).toHaveCount(0);
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();

  await toggleDeveloperDetails(page);
  await expect(page.getByText("aegis-oscal validate --fixture gold")).toBeVisible();
  await page.reload();
  await expect(page.getByText("aegis-oscal validate --fixture gold")).toBeVisible();
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await toggleDeveloperDetails(page);
  await expect(page.getByText("aegis-oscal validate --fixture gold")).toHaveCount(0);

  await page.getByRole("button", { name: "New package" }).click();
  await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
  await expect(page.getByText("CATALOG_REQUIRED")).toHaveCount(0);
});
