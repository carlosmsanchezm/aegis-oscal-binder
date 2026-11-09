import { expect, test, type Page } from "@playwright/test";

const D6 =
  "CSP side tooling demo. Subset only. Harness not LLM. Aegis is not FedRAMP authorized / not IL ATO / not a cleared facility / not 8(a).";

async function expectChrome(page: Page) {
  const footer = page.locator("footer");
  await expect(footer).toContainText("D6");
  await expect(footer).toContainText(D6);
  const claim = page.getByTestId("completeness-claim");
  await expect(claim).toBeVisible();
  await expect(claim).toContainText("missing required fields");
  await expect(claim).not.toContainText("not shipped");
}

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
});

test("upload an OSCAL package and select FedRAMP Rev5 or 20x", async ({ page }) => {
  await page.goto("/workspace?editor=classic");

  await test.step("empty workspace keeps CTAs off until a catalog is chosen", async () => {
    await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: /FedRAMP 20x/ })).not.toBeChecked();
    await expect(page.getByText("fedramp-rev5-subset@2026.09").first()).toBeVisible();
    await expect(page.getByText("fedramp-20x-subset@2026.09").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Load demo sample package" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Upload CSV" })).toBeDisabled();
    await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
    await expect(page.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Load demo sample package" })).toBeEnabled();
    await expect(page.getByRole("link", { name: "FedRAMP Rev5 subset sample" })).toHaveAttribute("href", "/samples/sample-oscal-ssp-rev5.json");
    await expect(page.getByText(/12-control FedRAMP Rev5 subset/).first()).toBeVisible();
    await expect(page.getByText(/\(12 controls\)/)).toHaveCount(0);
    await expect(page.getByText(/AC-2 and AU-2 only/)).toHaveCount(0);
    await expect(page.getByText(/component-definition file is rejected/)).toBeVisible();
    await expect(page.getByText("bnd-gold-0001").first()).toBeVisible();
    await expect(page.getByText("read only")).toHaveCount(0);
    await expectChrome(page);
  });

  await test.step("a bad upload is rejected and the workspace stays empty", async () => {
    await page.getByLabel("OSCAL package").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this is not an OSCAL package"),
    });
    await page.getByRole("button", { name: "Upload OSCAL" }).click();
    await expect(page.locator(".banner.fail")).toContainText("INGEST_REJECTED");
    await expect(page.locator(".banner.fail")).toContainText(/not OSCAL/i);
    await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
    await expect(page.getByText("bnd-upload-rev5")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear error" }).click();
    await expect(page.locator(".banner.fail")).toHaveCount(0);
    await expectChrome(page);
  });

  await test.step("Rev5 JSON upload opens the package map", async () => {
    const sample = await page.request.get("/samples/sample-oscal-ssp-rev5.json");
    expect(sample.ok()).toBeTruthy();
    const document = await sample.json();
    expect(document["system-security-plan"]).toBeTruthy();
    await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
    await page.getByRole("button", { name: "Upload OSCAL" }).click();
    await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
    await expect(page.getByText("bnd-upload-rev5")).toBeVisible();
    await expect(page.getByText(/fedramp-rev5-subset@2026\.09/).first()).toBeVisible();
    await expect(page.locator(".l1-scope-count")).toBeHidden();
    await expect(page.getByTestId("package-map").getByText("Controls · 12 in scope")).toBeVisible();
    await expect(page.getByRole("button", { name: /AC-2 Account Management/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /AC-3 Access Enforcement/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /AU-2 Event Logging/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /CM-6 Configuration Settings/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /IA-5 Authenticator Management/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /SC-7 Boundary Protection/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /SI-2 Flaw Remediation/ })).toBeVisible();
    await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /AC-2 Account Management, complete/ })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ }).click();
    await expect(page.getByRole("heading", { name: "Event Logging" })).toBeVisible();
    await expectChrome(page);
  });

  await test.step("a file can be attached as evidence on a control", async () => {
    await page.getByRole("button", { name: /AU-2 Event Logging/ }).click();
    await expect(page.getByRole("heading", { name: "Event Logging" })).toBeVisible();
    await page.getByLabel("Attach file").setInputFiles({
      name: "audit-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("audit sample"),
    });
    await expect(page.locator(".panel").getByText(/workspace-evidence\/AU-2\//)).toBeVisible();
    await expect(page.locator(".panel").getByText("audit-note.txt", { exact: true })).toBeVisible();
    await expectChrome(page);
  });

  await test.step("FedRAMP 20x is a separate stub catalog", async () => {
    await page.request.post("/api/workspace/reset");
    await page.goto("/workspace?editor=classic");
    await page.getByRole("radio", { name: /FedRAMP 20x/ }).check();
    await expect(page.getByText(/not vendored/).first()).toBeVisible();
    await expect(page.getByText("stub").first()).toBeVisible();
    await page.getByLabel("OSCAL package").setInputFiles("fixtures/upload/ssp-rev5.json");
    await page.getByRole("button", { name: "Upload OSCAL" }).click();
    await expect(page.locator(".banner.fail")).toContainText("CATALOG_MISMATCH");
    await expect(page.locator(".banner.fail")).toContainText(/FedRAMP Rev5/);
    await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
    await page.getByRole("button", { name: "Clear error" }).click();
    await page.getByLabel("OSCAL package").setInputFiles("fixtures/upload/ssp-20x.json");
    await page.getByRole("button", { name: "Upload OSCAL" }).click();
    await expect(page.getByText("Upload sample 20x").first()).toBeVisible();
    await expect(page.getByText("bnd-upload-20x")).toBeVisible();
    await expect(page.getByText(/fedramp-20x-subset@2026\.09/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /KSI-IAM Identity and access \(stub\)/ })).toBeVisible();
    await expect(page.getByText(/not vendored/).first()).toBeVisible();
    await expect(page.getByText("fedramp-rev5-subset@2026.09")).toHaveCount(0);
    await expectChrome(page);
  });

  await test.step("CSV ingest and Load gold still bootstrap a map", async () => {
    await page.request.post("/api/workspace/reset");
    await page.goto("/workspace?editor=classic");
    await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
    await page.getByLabel("CSV control table").setInputFiles("fixtures/upload/controls.csv");
    await page.getByRole("button", { name: "Upload CSV" }).click();
    await expect(page.getByText("bnd-csv")).toBeVisible();
    await expect(page.getByRole("button", { name: /AC-2 Account Management/ })).toBeVisible();
    await expect(page.getByText(/fedramp-rev5-subset@2026\.09/).first()).toBeVisible();

    await page.request.post("/api/workspace/reset");
    await page.goto("/workspace?editor=classic");
    await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
    await page.getByRole("button", { name: "Load demo sample package" }).click();
    await expect(page.getByText("Gold fixture CSP boundary").first()).toBeVisible();
    await expect(page.getByText("bnd-gold-0001")).toBeVisible();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await page.getByRole("button", { name: /AC-2 Account Management, incomplete/ }).click();
    await expect(page.getByRole("button", { name: /AC-2 Account Management, incomplete/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("read only").first()).toBeVisible();
    await expectChrome(page);
  });
});

test("Use sample stages the Rev5 file and upload opens the first incomplete control", async ({ page }) => {
  await page.goto("/workspace?editor=classic");
  await expect(page.getByRole("button", { name: "Stage sample SSP" })).toBeVisible();
  await page.getByRole("button", { name: "Stage sample SSP" }).click();
  await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "sample-oscal-ssp-rev5.json" })).toBeVisible();
  const staged = await page.getByLabel("OSCAL package").evaluate((node: HTMLInputElement) => node.files?.[0]?.name ?? "");
  expect(staged).toBe("sample-oscal-ssp-rev5.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ }).click();
  await expect(page.getByRole("heading", { name: "Event Logging" })).toBeVisible();
  await expect(page.getByRole("button", { name: /AU-2 Event Logging, incomplete/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await expectChrome(page);
});
