import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

const SESSION_LOST = "This browser's package was not found on the server. Reload the page, or upload the package again.";

async function useSample(page: Page) {
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByRole("button", { name: "Stage sample SSP" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sample staged: sample-oscal-ssp-rev5.json" })).toBeVisible();
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await expect(page.getByTestId("completeness-status").first()).toContainText("FAIL");
}

for (const entry of ["/workspace?editor=classic", "/workspace", "/planning"]) test(`${entry}: immediate Upload waits for the held sample response instead of dropping the upload`, async ({ page }, info) => {
  let releaseSample!: () => void;
  let sampleRequested!: () => void;
  const held = new Promise<void>(resolve => { releaseSample = resolve; });
  const requested = new Promise<void>(resolve => { sampleRequested = resolve; });
  await page.route("**/samples/sample-oscal-ssp-rev5.json", async route => {
    sampleRequested();
    await held;
    await route.continue();
  });
  await page.goto(entry);
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  const upload = page.getByRole("button", { name: "Upload OSCAL", exact: true });
  await expect(upload).toBeDisabled();
  if (entry !== "/workspace?editor=classic") await page.locator("summary").filter({ hasText: "More starting points" }).click();
  await page.getByRole("button", { name: /^Stage sample SSP/ }).click();
  const ingested = page.waitForResponse(response => response.url().endsWith("/oscal/ingest") && response.request().method() === "POST");
  const immediateUpload = upload.click();
  await requested;
  try {
    await expect(upload).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Preparing sample" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Sample staged:" })).toHaveCount(0);
    await expect(page.getByText("FILE_REQUIRED", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("sample-preparing.png") });
  } finally {
    releaseSample();
  }
  await immediateUpload;
  const response = await ingested;
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.packageState.loaded).toBe(true);
  expect(body.packageState.workspaceName).toBe("Upload sample CSP");
  expect(body.packageState.controls).toHaveLength(12);
  await expect(page.getByTestId("package-map")).toBeVisible();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await expect(page.getByText("FILE_REQUIRED", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("sample-uploaded.png") });
});

async function openAu2(page: Page) {
  await page.getByRole("button", { name: "Package map" }).click();
  await page.getByRole("button", { name: /AU-2 Event Logging/ }).click();
  await expect(page.getByRole("heading", { name: "Event Logging" })).toBeVisible();
}

function parseXml(xml: string): void {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const doc = parser.parse(xml) as { "system-security-plan"?: unknown };
  expect(doc["system-security-plan"]).toBeTruthy();
}

test("sample partial save stays FAIL, a full fix opens the gate, and export downloads both", async ({ page }) => {
  await useSample(page);
  await openAu2(page);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("save-hint")).toHaveText("Needs responsibleRole, evidence");
  await expect(page.getByTestId("save-hint")).toHaveClass("hint");

  await page.getByRole("combobox", { name: "responsibleRole" }).selectOption({ label: "System Owner" });
  await expect(save).toBeEnabled();
  await expect(page.getByTestId("save-hint")).toHaveText("Needs evidence");
  await expect(page.getByTestId("save-hint")).toHaveClass("hint");
  await save.click();
  await expect(page.getByTestId("save-hint")).toHaveText("Saved. Still needs: evidence");
  await expect(page.getByTestId("save-hint")).toHaveClass("hint");
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await expect(page.getByTestId("completeness-status").first()).toContainText("FAIL");
  const map = page.getByTestId("package-map");
  await expect(map.getByRole("button", { name: "✕ role" })).toHaveCount(0);
  await expect(map.getByRole("button", { name: "✕ evidence" })).toHaveCount(1);
  await expect(map.getByRole("button", { name: /AU-2 Event Logging/ })).toContainText("✕ evidence");
  await expect(map.locator(".pmap-lane-label", { has: page.locator("strong", { hasText: /^AU$/ }) })).toContainText("1 of 2 open");

  await page.reload();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await openAu2(page);
  await expect(page.getByRole("combobox", { name: "responsibleRole" })).toHaveValue("System Owner");
  await expect(page.getByTestId("save-hint")).toHaveText("Needs evidence");
  await expect(page.getByTestId("save-hint")).toHaveClass("hint");

  await page.getByRole("button", { name: "Export flow" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Completeness FAIL" })).toContainText("WIP");
  const partialDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const partial = await partialDownload;
  expect(partial.suggestedFilename()).toBe("exp-0001-package-oscal.xml");
  const partialPath = await partial.path();
  expect(partialPath).toBeTruthy();
  const partialXml = readFileSync(partialPath!, "utf8");
  parseXml(partialXml);
  const partialAu2 = partialXml.split("<implemented-requirement").find((part) => part.startsWith(' control-id="au-2"')) ?? "";
  expect(partialAu2).toContain('responsible-role role-id="system-owner"');
  expect(partialAu2).not.toContain('rel="evidence"');
  await expect(page.locator(".artifact-name").first()).toContainText("exp-0001-package-oscal.xml");
  await expect(page.locator(".artifact-name").first()).toContainText("Downloaded");
  await expect(page.locator(".feature-card", { hasText: "Export OSCAL" })).toContainText("WIP");
  await expect(page.locator(".banner.fail")).toHaveCount(0);

  await openAu2(page);
  await page.getByLabel("Title").fill("Quarterly event review");
  await page.getByLabel("Link or path").fill("https://evidence.example/au-2-review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("12 of 12 complete · gate open").first()).toBeVisible();
  await expect(page.getByTestId("completeness-status").first()).toContainText("PASS");
  await expect(page.getByTestId("package-map").locator(".pmap-lane-label", { has: page.locator("strong", { hasText: /^AU$/ }) })).toContainText("2 ok");
  await expect(page.getByTestId("package-map").getByRole("button", { name: /AU-2 Event Logging/ })).toContainText("complete");
  await expect(page.getByText("Saved · control complete")).toBeVisible();

  await page.getByRole("button", { name: "Export flow" }).click();
  const fullDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const full = await fullDownload;
  expect(full.suggestedFilename()).toBe("exp-0002-package-oscal.xml");
  const fullPath = await full.path();
  const fullXml = readFileSync(fullPath!, "utf8");
  parseXml(fullXml);
  const fullAu2 = fullXml.split("<implemented-requirement").find((part) => part.startsWith(' control-id="au-2"')) ?? "";
  expect(fullAu2).toContain('responsible-role role-id="system-owner"');
  expect(fullAu2).toContain('rel="evidence"');
  expect(fullXml).toContain('title="Quarterly event review"');
  expect(fullXml).toContain('href="https://evidence.example/au-2-review"');
  await expect(page.locator(".artifact-name").first()).toContainText("Downloaded");
});

test("invalid evidence keeps Save blocked", async ({ page }) => {
  await useSample(page);
  await openAu2(page);
  await page.getByRole("combobox", { name: "responsibleRole" }).selectOption({ label: "System Owner" });
  await page.getByLabel("Link or path").fill("http://insecure.example/au-2");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByText("Save blocked")).toBeVisible();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
});

test("a forced export 500 shows the error banner", async ({ page }) => {
  await useSample(page);
  await page.getByRole("button", { name: "Export flow" }).click();
  await page.route("**/api/oscal/export", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "Export failed.", details: null } }),
  }));
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const banner = page.locator(".banner.fail");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Export failed.");
  await expect(banner).toContainText("HTTP 500");
});

test("a deleted session cookie shows the package-not-found banner on export and save", async ({ page }) => {
  await useSample(page);
  await openAu2(page);
  await page.getByRole("combobox", { name: "responsibleRole" }).selectOption({ label: "System Owner" });
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Export flow" }).click();
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const exportBanner = page.locator(".banner.fail");
  await expect(exportBanner).toBeVisible();
  await expect(exportBanner).toContainText(SESSION_LOST);
  await expect(exportBanner).toContainText("HTTP 400");
  await expect(page.locator(".artifact-name").first()).not.toContainText("Downloaded");

  await page.context().clearCookies();
  await page.getByRole("button", { name: "Package map" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saveBanner = page.locator("aside.panel .banner.fail");
  await expect(saveBanner).toBeVisible();
  await expect(saveBanner).toContainText(SESSION_LOST);
  await expect(saveBanner).toContainText("HTTP 400");
});

test("a lost server session shows the package-not-found error", async ({ page }) => {
  await useSample(page);
  await openAu2(page);
  await page.getByRole("combobox", { name: "responsibleRole" }).selectOption({ label: "System Owner" });
  await page.context().addCookies([{
    name: "aegis_sid",
    value: randomBytes(16).toString("hex"),
    url: "http://127.0.0.1:3000",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".banner.fail")).toContainText(SESSION_LOST);

  await page.context().addCookies([{
    name: "aegis_sid",
    value: randomBytes(16).toString("hex"),
    url: "http://127.0.0.1:3000",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.getByRole("button", { name: "Export flow" }).click();
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  await expect(page.locator(".banner.fail")).toContainText(SESSION_LOST);
  await expect(page.locator(".banner.fail")).toContainText("HTTP 409");
});

test("gold AC-2 and package A save through the same panel", async ({ page }) => {
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByRole("button", { name: "Load demo sample package" }).click();
  await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
  await page.getByRole("button", { name: /AC-2 Account Management/ }).click();
  await page.getByRole("combobox", { name: "responsibleRole" }).selectOption({ label: "CSP IAM Administrator" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("save-hint")).toHaveText("Saved. Still needs: implementation, evidence");
  await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
  await expect(page.getByTestId("completeness-status").first()).toContainText("FAIL");

  await page.getByRole("button", { name: "New package" }).click();
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles("fixtures/audit/package-a.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("Audit package A").first()).toBeVisible();
  await expect(page.getByText("5 of 8 incomplete").first()).toBeVisible();
  await page.getByRole("button", { name: /CP-2 Contingency Plan/ }).click();
  const implementation = page.locator("aside.panel textarea");
  const current = await implementation.inputValue();
  await implementation.fill(`${current} Partial note.`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("save-hint")).toHaveText("Saved. Still needs: evidence");
  await expect(page.getByText("5 of 8 incomplete").first()).toBeVisible();
  await page.getByRole("button", { name: "Export flow" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const download = await downloadPromise;
  const xml = readFileSync((await download.path())!, "utf8");
  parseXml(xml);
  expect(xml).toContain("Partial note.");
  await expect(page.locator(".artifact-name").first()).toContainText("Downloaded");
});
