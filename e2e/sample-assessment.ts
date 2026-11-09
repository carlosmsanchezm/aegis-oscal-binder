import type { Page } from "@playwright/test";

export async function loadSampleAssessment(page: Page) {
  await page.getByTestId("assessment-drawer").getByText("Record context", { exact: true }).click();
  await page.getByRole("button", { name: "Load sample assessment", exact: true }).click();
  await page.getByTestId("assessment-drawer").getByText("Record context", { exact: true }).click();
}
