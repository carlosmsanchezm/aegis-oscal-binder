import { expect, test } from "@playwright/test";

const MODERATE_SAMPLE = "/samples/sample-oscal-ssp-rev5-moderate.json";
const WEEK1_SAMPLE = "public/samples/sample-oscal-ssp-rev5.json";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
});

test("blank controls count incomplete for the Moderate sample and the 12-control sample stays 1 of 12", async ({ page }) => {
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles(WEEK1_SAMPLE);
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await expect(page.getByText("322 of 323 incomplete")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /AC-1 Policy and Procedures/ })).toHaveCount(0);
  await expect(page.locator(".chrome-pin-value")).toHaveText("fedramp-rev5-subset@2026.09");

  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();

  const served = await page.request.get(MODERATE_SAMPLE);
  expect(served.ok()).toBeTruthy();
  const document = await served.json();
  expect(document["system-security-plan"]["import-profile"].href).toBe("fixtures/rev5/fedramp-rev5-moderate-profile.json");
  await page.getByLabel("OSCAL package").setInputFiles({
    name: "sample-oscal-ssp-rev5-moderate.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await page.getByRole("button", { name: "Upload OSCAL" }).click();

  await expect(page.getByText("322 of 323 incomplete").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("1 of 12 incomplete")).toHaveCount(0);
  await expect(page.getByText("Synthetic Moderate sample").first()).toBeVisible();
  await expect(page.getByText("bnd-moderate-sample")).toBeVisible();
  await expect(page.locator(".chrome-pin-value")).toHaveText("fedramp-3.0.0rc1-oscal-1.1.2");
  await expect(page.getByTestId("package-map").getByText("Controls · 323 in scope")).toBeVisible();
  await expect(page.getByTestId("completeness-status").first()).toContainText("FAIL");

  const blank = page.getByRole("button", { name: /AC-1 Policy and Procedures, incomplete/ });
  await expect(blank).toBeVisible();
  await expect(page.getByRole("button", { name: /AC-3 Access Enforcement, incomplete/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /AC-2 Account Management, complete/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ })).toBeVisible();

  await blank.click();
  await expect(page.getByRole("heading", { name: "Policy and Procedures" })).toBeVisible();
  await expect(page.getByTestId("save-hint")).toHaveText("Needs implementation, responsibleRole and 1 valid evidence");
  await expect(page.locator("aside.panel").getByRole("textbox", { name: /implementation/ })).toHaveValue("");
  await expect(page.getByText("322 of 323 incomplete").first()).toBeVisible();
});
