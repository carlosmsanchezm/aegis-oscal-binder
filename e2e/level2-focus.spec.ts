import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const SHOTS = "test-results/level2-screenshots";

async function expectNoAddressedCount(focus: Locator) {
  await expect(focus.getByTestId("level2-item-coverage")).not.toContainText("of 12");
  await expect(focus.getByTestId("level2-item-coverage")).not.toContainText("/");
  await expect(focus).not.toContainText("items addressed");
}

async function loadGold(page: Page) {
  const reset = await page.request.post("/api/workspace/reset");
  expect(reset.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByRole("button", { name: "Load demo sample package" }).click();
  await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
  await page.getByRole("button", { name: /AC-2 Account Management, incomplete/ }).click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
}

test("Level 2 AC-2 focus shows catalog statement facts and leaves the gate alone", async ({ page }) => {
  await loadGold(page);
  await mkdir(SHOTS, { recursive: true });

  await test.step("Expand opens 11a on the same canvas", async () => {
    await page.getByRole("button", { name: /AC-2 Account Management, incomplete/ }).dblclick();
    const focus = page.getByTestId("level2-focus");
    await expect(focus).toBeVisible();
    await expect(page.getByTestId("level2-breadcrumb")).toContainText("Package map");
    await expect(page.getByTestId("level2-breadcrumb")).toContainText("AC");
    await expect(page.getByTestId("level2-breadcrumb")).toContainText("AC-2");
    await expect(focus.getByText("Level 2 · focus")).toBeVisible();
    await expect(page.getByTestId("package-map").locator('path[data-rel="related"]')).toHaveCount(0);
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await expect(page.getByTestId("completeness-status")).toContainText("FAIL");
    await expect(page.getByTestId("completeness-status")).toContainText("3 of 12 incomplete");
  });

  await test.step("AC-2 rows, links, constraints, and enhancements come from the truth table", async () => {
    const focus = page.getByTestId("level2-focus");
    for (const letter of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
      await expect(focus.getByTestId(`statement-${letter}`)).toBeVisible();
      await expect(focus.getByTestId(`statement-${letter}`)).toHaveAttribute("data-addressed", "false");
    }
    await expect(focus.getByTestId("statement-j")).toHaveAttribute("aria-pressed", "false");
    await expect(focus.getByTestId("statement-j")).toContainText("Review accounts for compliance with account management requirements");
    await expect(focus.getByTestId("statement-j")).toContainText("quarterly for privileged access, annually for non-privileged access");
    await expect(focus.getByTestId("statement-h")).toContainText("twenty-four (24) hours");
    await expect(focus.getByTestId("statement-h")).toContainText("eight (8) hours");
    await expect(focus.getByTestId("statement-h")).toContainText("3 sub-items");
    await expect(focus.getByTestId("statement-c")).toContainText("odp.01");
    await expect(focus.getByTestId("statement-a")).toContainText("obj 2");
    await expect(focus.getByTestId("statement-d")).toContainText("obj 4");
    await expect(focus.getByTestId("statement-f")).toContainText("obj 5");
    await expect(focus.getByTestId("statement-j")).toContainText("obj 1");
    await expect(focus.getByTestId("level2-item-coverage")).toHaveText("✕ fields incomplete");
    await expect(focus.getByTestId("level2-control")).toContainText("Role · no role");
    await expect(focus.getByTestId("level2-control")).toContainText("✕ fields incomplete");
    await expect(focus.getByTestId("level2-evidence")).toContainText("No item-level evidence links");
    await expectNoAddressedCount(focus);

    await expect(focus.getByTestId("focus-mutual")).toContainText("AC-3");
    await expect(focus.getByTestId("focus-mutual")).toContainText("AC-6");
    await expect(focus.getByTestId("focus-mutual")).toContainText("AU-2");
    await expect(focus.getByTestId("focus-mutual")).toContainText("IA-2");
    await expect(focus.getByTestId("focus-outbound")).toContainText("IA-5");
    await expect(focus.getByTestId("focus-outbound")).toContainText("SC-7");
    await expect(focus.getByTestId("focus-reverse")).toContainText("AU-6");
    await expect(focus.getByTestId("focus-outside")).toContainText("22");
    await expect(focus.getByRole("button", { name: "AC-5" })).toHaveCount(0);
    await expect(focus.getByRole("button", { name: "AC-17" })).toHaveCount(0);

    const enhancements = focus.getByTestId("focus-enhancements");
    await expect(enhancements.locator("li")).toHaveCount(9);
    await expect(enhancements).toContainText("Automated System Account Management");
    await expect(enhancements).toContainText("Restrictions on Use of Shared and Group Accounts");
    await expect(enhancements).toContainText("Account Monitoring for Atypical Usage");
    await expect(enhancements).toContainText("Disable Accounts for High-risk Individuals");
    await expect(enhancements.locator('[data-enhancement-id="ac-2.6"]')).toHaveCount(0);
    await expect(enhancements.locator('[data-enhancement-id="ac-2.1"]')).toHaveCount(1);

    await expect(focus).not.toContainText("EV-IDP-01");
    await expect(focus).not.toContainText("EV-HR-01");
    await expect(focus).not.toContainText("EV-AC2-01");
    await expect(focus).not.toContainText("6/12");
    await expect(focus.getByTestId("level2-evidence")).toContainText("No evidence linked.");
    await expect(focus.getByTestId("level2-evidence")).toContainText("No item-level evidence links");
    await expect(focus.getByTestId("level2-legend")).toContainText("FedRAMP constraint");
    await expect(focus.getByTestId("level2-legend")).toContainText("not in subset");
  });

  await test.step("item j panel is read only and does not score the gate", async () => {
    await page.getByTestId("statement-j").click();
    const panel = page.getByTestId("statement-focus");
    await expect(panel).toContainText("AC-2 · j.");
    await expect(panel.getByTestId("statement-prose")).toHaveAttribute(
      "data-prose",
      "Review accounts for compliance with account management requirements {{ insert: param, ac-02_odp.10 }};",
    );
    await expect(panel.getByTestId("statement-parameters")).toContainText("ac-02_odp.10");
    await expect(panel.getByTestId("statement-parameters")).toContainText("quarterly for privileged access, annually for non-privileged access");
    await expect(panel.getByTestId("statement-parameters")).toContainText("not recorded");
    await expect(panel.getByTestId("statement-implementation")).toContainText("No by-statement entry");
    await expect(panel.getByTestId("statement-evidence")).toContainText("not an item mapping");
    await expect(panel.getByTestId("statement-objectives")).toContainText("AC-02j");
    await expect(panel.getByTestId("statement-objectives")).toContainText("accounts are reviewed for compliance with account management requirements");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();

    await page.getByTestId("statement-a").click();
    await expect(panel).toContainText("AC-2 · a.");
    await expect(panel.getByTestId("statement-prose")).toContainText("Define and document the types of accounts allowed");
    await expect(panel.getByTestId("statement-objectives")).toContainText("account types allowed");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/level2-ac2-focus.png`, fullPage: true });
  });

  await test.step("Esc and Show on map return to the Level 1 selection", async () => {
    await page.keyboard.press("Escape");
    const map = page.getByTestId("package-map");
    await expect(page.getByTestId("level2-focus")).toHaveCount(0);
    await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
    await expect(map.getByRole("button", { name: /AC-2 Account Management, incomplete/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();

    await map.getByRole("button", { name: /AC-2 Account Management, incomplete/ }).dblclick();
    await expect(page.getByTestId("level2-focus")).toBeVisible();
    await expect(page.getByTestId("statement-j")).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Show on map" }).click();
    await expect(page.getByTestId("level2-focus")).toHaveCount(0);
    await expect(map.locator('path[data-rel="related"][data-glyph="mutual"]')).toHaveCount(4);
    await page.screenshot({ path: `${SHOTS}/level1-after-focus.png`, fullPage: true });
  });

  await test.step("AU-2 focus uses its own statement items and AC-3 evidence stays unmapped", async () => {
    await page.getByRole("button", { name: /AU-2 Event Logging/ }).dblclick();
    const focus = page.getByTestId("level2-focus");
    await expect(page.getByTestId("level2-breadcrumb")).toContainText("AU-2");
    await expect(focus.getByTestId("statement-a")).toContainText("Identify the types of events that the system is capable of logging");
    await expect(focus.getByTestId("level2-item-coverage")).toHaveText("✕ fields incomplete");
    await expect(focus.getByTestId("level2-evidence")).toContainText("No item-level evidence links");
    await expectNoAddressedCount(focus);
    await expect(focus).not.toContainText("Review accounts for compliance");
    await expect(focus.getByTestId("level2-control")).toContainText("CSP SOC Analyst");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /AC-3 Access Enforcement/ }).dblclick();
    const ac3 = page.getByTestId("level2-focus");
    await expect(ac3.getByTestId("statement-ac-3_smt")).toContainText("Enforce approved authorizations for logical access");
    await expect(ac3.getByTestId("level2-item-coverage")).toHaveText("✓ fields complete");
    await expect(ac3.getByTestId("level2-evidence")).toContainText("not its individual statements");
    await expectNoAddressedCount(ac3);
    await expect(ac3.locator(".l2-control-evidence")).toContainText("EV-AC3-01");
    await expect(ac3.locator(".l2-control-evidence")).toContainText("Access policy export");
    await expect(ac3.locator('path[data-rel="item-evidence"]')).toHaveCount(0);
    await expect(ac3).not.toContainText("supports a");
    await page.keyboard.press("Escape");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
  });

  await test.step("WIP export still downloads while the package is FAIL", async () => {
    await page.getByRole("button", { name: "Export flow" }).click();
    await expect(page.getByText("WIP export can still be downloaded.")).toBeVisible();
    await expect(page.getByText("completeness FAIL · WIP")).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export OSCAL" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("package-oscal");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/wip-export-after-level2.png`, fullPage: true });
  });
});
