import { toggleDeveloperDetails } from "./helpers/navigation";
import { navigateWorkspace } from "./helpers/navigation";
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
  for (const name of [/override export/i, /ai generate/i, /soft pass/i]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  }
}

async function openControl(page: Page, id: string, title: string) {
  await page.getByRole("button", { name: "Package map" }).click();
  await page.getByRole("button", { name: new RegExp(`${id} ${title}`) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

test("operator demo loop", async ({ page, request }) => {
  const reset = await request.post("/api/workspace/reset");
  expect(reset.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");

  await test.step("empty workspace", async () => {
    await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load demo sample package" })).toBeVisible();
    await expect(page.getByText("None loaded")).toBeVisible();
    await expect(page.getByTestId("gate-lamp")).toContainText("no package loaded");
    await expect(page.getByText("Gold fixture CSP boundary")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("3 of 12 incomplete");
    await expectChrome(page);
  });

  await test.step("Load gold shows FAIL 3 of 12 and the AC-2 side panel", async () => {
    await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
    await page.getByRole("button", { name: "Load demo sample package" }).click();
    await expect(page.getByText("Gold fixture CSP boundary").first()).toBeVisible();
    await expect(page.getByText("bnd-gold-0001")).toBeVisible();
    await expect(page.getByText(/fedramp-rev5-subset@2026\.09/).first()).toBeVisible();
    await expect(page.getByText("read only").first()).toBeVisible();
    await expect(page.getByText("FAIL").first()).toBeVisible();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    const map = page.getByTestId("package-map");
    await map.getByRole("button", { name: /AC-2 Account Management, incomplete/ }).click();
    await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
    await expect(page.getByRole("button", { name: /AC-2 Account Management, incomplete/ })).toHaveAttribute("aria-pressed", "true");
    await expect(map.getByRole("button", { name: /AU-2 Event Logging/ })).toBeVisible();
    await expect(map.getByRole("button", { name: /CM-6 Configuration Settings/ })).toBeVisible();
    await expect(page.getByText("No evidence linked.")).toBeVisible();
    await expect(page.getByText("aegis-oscal validate --fixture gold")).toHaveCount(0);
    await expect(page.getByTestId("build-version")).toContainText(/local|[0-9a-f]{7}/);
    await toggleDeveloperDetails(page);
    await expect(page.getByText("aegis-oscal validate --fixture gold")).toBeVisible();
    await toggleDeveloperDetails(page);
    await expect(page.getByText("aegis-oscal validate --fixture gold")).toHaveCount(0);
    await expect(map.locator(".next-ship")).toHaveCount(0);
    await expect(map.getByText("missing required fields")).toBeVisible();
    await expect(page.getByText("next · not shipped")).toHaveCount(0);
    await expect(map.getByText("Controls · 12 in scope")).toBeVisible();
    await expect(map.getByText("Export pipeline")).toHaveCount(0);
    await expect(map.getByText("not authorization")).toBeVisible();
    await expect(page.getByTestId("completeness-status")).toContainText("FAIL");
    await expect(map.locator(".gate-node")).toHaveCount(0);
    await expect(map.locator('path[data-rel="pipeline"]')).toHaveCount(0);
    await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
    await expect(map.locator('path[data-rel="related"][data-glyph="mutual"]')).toHaveCount(4);
    await expect(map.locator('path[data-rel="related"][data-glyph="outbound"]')).toHaveCount(2);
    await expect(map.locator('path[data-rel="related"][data-glyph="reverse"]')).toHaveCount(1);
    await expect(map.locator('path[data-rel="related"][data-to="AC-3"]')).toHaveCount(1);
    await expect(map.locator('path[data-rel="related"][data-from="AU-6"][data-to="AC-2"]')).toHaveCount(1);
    await expect(map.locator('path[data-rel="related"][data-line="solid"]')).toHaveCount(4);
    await expect(map.locator('path[data-rel="related"][data-line="dashed"]')).toHaveCount(3);
    await expect(map.locator(".l1-card.l1-dim")).toHaveCount(4);
    await expect(map.locator(".pmap-role,path[data-rel=role]")).toHaveCount(0);
    await expect(map.getByLabel("Owner",{exact:true}).locator("option").filter({hasText:/CSP IAM Administrator/})).toHaveCount(1);
    await expect(map.getByText("AC-5")).toHaveCount(0);
    await expect(map.getByText("AC-17")).toHaveCount(0);
    await expect(page.getByTestId("related-mutual")).toContainText("AC-3");
    await expect(page.getByTestId("related-mutual")).toContainText("AC-6");
    await expect(page.getByTestId("related-mutual")).toContainText("AU-2");
    await expect(page.getByTestId("related-mutual")).toContainText("IA-2");
    await expect(page.getByTestId("related-outbound")).toContainText("IA-5");
    await expect(page.getByTestId("related-outbound")).toContainText("SC-7");
    await expect(page.getByTestId("related-reverse")).toContainText("AU-6");
    await expect(page.getByTestId("related-outside")).toContainText("22");
    await page.getByRole("button", { name: "+22 outside subset" }).click();
    await expect(page.getByTestId("related-outside-list")).toContainText("AC-5");
    await page.getByRole("button", { name: "By family" }).click();
    await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
    await expect(map.locator(".pmap-count")).toHaveCount(0);
    await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
    await expect(map.locator(".l1-card.l1-dim")).toHaveCount(0);
    await expect(map.getByText("both list each other")).toBeVisible();
    await expect(map.getByText("one-way related")).toBeVisible();
    await expect(map.getByText("reverse")).toHaveCount(0);
    await page.getByRole("button", { name: "Selected control" }).click();
    await map.getByRole("button",{name:"Missing",exact:true}).click();
    await expect(map.getByRole("button", { name: "Missing", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(map.locator(".pmap-lane-label", { has: page.locator("strong", { hasText: /^AC$/ }) })).toContainText("2 of 17");
    await expect(map.locator(".pmap-lane-label", { has: page.locator("strong", { hasText: /^AU$/ }) })).toContainText("1 of 11");
    await expect(map.locator(".pmap-lane-label", { has: page.locator("strong", { hasText: /^CM$/ }) })).toContainText("2 of 12");
    await expect(map.getByRole("button", { name: "✕ impl" })).toHaveCount(2);
    await expect(map.getByRole("button", { name: "✕ role" })).toHaveCount(1);
    await expect(map.getByRole("button", { name: "✕ evidence" })).toHaveCount(2);
    await expect(map.getByText("Incomplete", { exact: true })).toBeVisible();
    await expect(map.getByText("locked by gate")).toHaveCount(0);
    await expect(page.getByText("empty").first()).toBeVisible();
    const ac2Role = page.getByRole("combobox", { name: /responsibleRole/ });
    const ac2Link = page.getByLabel("Link or path");
    const ac2Title = page.getByLabel("Title");
    await expect(ac2Role).toHaveAttribute("data-empty", "true");
    await expect(ac2Link).toHaveAttribute("data-empty", "true");
    await expect(ac2Title).toHaveAttribute("data-empty", "true");
    await expect(ac2Role).toHaveCSS("border-top-color", "rgb(232, 38, 79)");
    await expect(ac2Role).toHaveCSS("background-color", "rgb(255, 232, 238)");
    await expect(ac2Link).toHaveCSS("border-top-color", "rgb(232, 38, 79)");
    await expect(ac2Link).toHaveCSS("background-color", "rgb(255, 232, 238)");
    await expect(page.locator('input[type="file"]')).not.toHaveAttribute("data-empty", "true");
    await expect(page.getByText("gate FAIL", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Baseline · FedRAMP Rev5 Moderate/ }).click();
    await expect(page.getByTestId("baseline-constraints")).toContainText("twenty-four (24) hours");
    await expect(page.getByTestId("baseline-constraints").locator("code", { hasText: "odp.10" })).toHaveAttribute("title", "ac-02_odp.10");
    await expect(page.getByTestId("baseline-enhancements")).toContainText("AC-2(1)");
    await expect(page.getByTestId("baseline-enhancements")).toContainText("Automated System Account Management");
    await expect(page.getByText("not in this subset")).toBeVisible();
    await expect(page.getByText("Reference only. The completeness gate checks fields and evidence.")).toBeVisible();
    await page.getByRole("button", { name: /AC-3 Access Enforcement/ }).click();
    const panel = page.locator(".panel");
    await expect(panel.getByText("EV-AC3-01")).toBeVisible();
    await expect(panel.getByText("Access policy export")).toBeVisible();
    await expect(page.getByText("feeds OSCAL back-matter, Word, Excel")).toBeVisible();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await page.getByRole("button", { name: /AC-2 Account Management/ }).click();
    await expect(page.getByText("No evidence linked.")).toBeVisible();
    await expectChrome(page);
  });

  await test.step("AC-2 rejects a bad URL and a missing file", async () => {
    await page.getByLabel("Title").fill("Broken link probe");
    await page.getByLabel("Link or path").fill("htps//drive.example/iam-review");
    await page.getByRole("button", { name: "Add evidence" }).click();
    await expect(page.getByText("Invalid URL · use https:// or an evidence/ path")).toBeVisible();
    await expect(page.getByText("Evidence was not added")).toBeVisible();
    await expect(page.getByText("No evidence linked.")).toBeVisible();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();

    await page.getByLabel("Title").fill("Missing file probe");
    await page.getByLabel("Link or path").fill("evidence/ac-2/does-not-exist.pdf");
    await page.getByRole("button", { name: "Add evidence" }).click();
    await expect(page.getByText("Missing file · nothing at this path")).toBeVisible();
    await expect(page.getByText("No evidence linked.")).toBeVisible();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await expect(page.getByText("Save blocked")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expectChrome(page);
  });

  await test.step("WIP export downloads while completeness stays FAIL", async () => {
    await page.getByRole("button", { name: "Export flow" }).click();
    await expect(page.getByRole("heading", { name: "Completeness FAIL" })).toBeVisible();
    await expect(page.getByText("Load an OSCAL package or the demo sample package first")).toHaveCount(0);
    await expect(page.getByText("next · not shipped")).toHaveCount(0);
    const pathBack = page.getByRole("navigation", { name: "Path back to incompletes" });
    const warning = page.getByRole("status").filter({ hasText: "Completeness FAIL" });
    await expect(pathBack.getByRole("button", { name: "Open AU-2" })).toBeVisible();
    await expect(warning).toContainText("missing required fields");
    await expect(warning).toContainText("not an authorization result");
    await expect(warning).not.toContainText("FedRAMP authorization failed");
    const pathBox = await pathBack.boundingBox();
    const warnBox = await warning.boundingBox();
    expect(pathBox && warnBox && pathBox.y < warnBox.y).toBeTruthy();
    await expect(page.getByText("exp-0001-package-oscal.xml").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Render Word" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Render Excel" })).toBeDisabled();
    const exportButton = page.getByRole("button", { name: "Export OSCAL" });
    await expect(exportButton).toBeEnabled();
    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("exp-0001-package-oscal.xml");
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await expect(page.getByText("Written").first()).toBeVisible();
    await expect(page.getByText("None").first()).toBeVisible();
    await expect(page.getByText("Disabled · needs validator GREEN")).toBeVisible();
    await expect(page.getByText("blocked · gate FAIL · no artifacts written")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /override/i })).toHaveCount(0);
    await pathBack.getByRole("button", { name: "Open AU-2" }).click();
    await expect(page.getByRole("heading", { name: "Event Logging" })).toBeVisible();
    await expectChrome(page);
  });

  await test.step("valid saves clear AC-2, AU-2, and CM-6 and the gate PASSes", async () => {
    await openControl(page, "AC-2", "Account Management");
    await toggleDeveloperDetails(page);
    await page.getByRole("button", { name: "Fill AC-2 example" }).click();
    await expect(page.getByText("Ready to save")).toBeVisible();
    await expect(page.getByText("staged, saves with the control")).toBeVisible();
    await expect(page.getByText("Required fields and 1 valid evidence present")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
    await save(page);
    await expect(page.locator(".panel").getByText("EV-AC2-01", { exact: true })).toBeVisible();
    await expect(page.locator(".panel").getByText("Quarterly account review")).toBeVisible();
    await expect(page.getByText("2 of 12 incomplete").first()).toBeVisible();

    await page.getByLabel("Title").fill("Quarterly account review");
    await page.getByLabel("Link or path").fill("evidence/ac-2/iam-review-2026-08.pdf");
    await save(page);
    await expect(page.getByText("Duplicate title · already used by EV-AC2-01")).toBeVisible();
    await expect(page.getByText("2 of 12 incomplete").first()).toBeVisible();

    await openControl(page, "AU-2", "Event Logging");
    const au2Link = page.getByLabel("Link or path");
    const au2Title = page.getByLabel("Title");
    await expect(page.locator("label.field-empty").filter({ hasText: "Link or path" })).toBeVisible();
    await expect(page.locator("label.field-empty").filter({ hasText: "Title" })).toBeVisible();
    await expect(page.locator("label.field-empty .status.empty .mark-bad")).toHaveCount(2);
    await expect(au2Link).toHaveAttribute("data-empty", "true");
    await expect(au2Title).toHaveAttribute("data-empty", "true");
    await expect(au2Link).toHaveCSS("border-top-color", "rgb(232, 38, 79)");
    await expect(page.getByRole("combobox", { name: /responsibleRole/ })).not.toHaveAttribute("data-empty", "true");
    await expect(page.locator('input[type="file"]')).not.toHaveCSS("border-top-color", "rgb(232, 38, 79)");
    await page.getByRole("button", { name: "Fill AU-2 evidence" }).click();
    await expect(au2Link).not.toHaveAttribute("data-empty", "true");
    await expect(au2Title).not.toHaveAttribute("data-empty", "true");
    await save(page);
    await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();

    await openControl(page, "CM-6", "Configuration Settings");
    await page.getByRole("button", { name: "Fill CM-6 implementation" }).click();
    await save(page);
    await expect(page.getByText("PASS").first()).toBeVisible();
    await expect(page.getByText("12 of 12 complete · gate open").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("0 of 12 incomplete");
    await expect(page.locator("body")).not.toContainText("3 of 12 incomplete");
    const passed = page.getByTestId("package-map");
    await expect(passed.locator(".l1-miss")).toHaveCount(0);
    await expect(passed.locator('path[data-rel="pipeline"]')).toHaveCount(0);
    await expect(passed.locator('path[data-rel="related"]')).toHaveCount(6);
    await expect(passed.locator(".mark-ok")).toHaveCount(12);
    await expect(page.getByText("Saved · control complete")).toBeVisible();
    await expect(page.getByText("feeds OSCAL back-matter, Word, Excel").first()).toBeVisible();
    await expectChrome(page);
  });

  await test.step("export GREEN path renders Word and Excel from the same IR", async () => {
    await page.getByRole("button", { name: "Export flow" }).click();
    const passDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export OSCAL" }).click();
    expect((await passDownload).suggestedFilename()).toBe("exp-0002-package-oscal.xml");
    const exportCard = page.locator(".feature-card", { hasText: "Export OSCAL" });
    await expect(exportCard).toContainText("Written");
    await expect(exportCard).toContainText("exp-0002-package-oscal.xml");
    const baselineCard = page.locator(".feature-card", { hasText: "Baseline" });
    await expect(baselineCard).toContainText("None");

    const lockedBaseline = page.getByRole("button", { name: "Update baseline" });
    await expect(lockedBaseline).toBeDisabled();
    await expect(lockedBaseline).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Locked until validator GREEN").first()).toBeVisible();
    await expect(page.getByText("bl-0001")).toHaveCount(0);

    const validateCard = page.locator(".feature-card", { hasText: "Validate" });
    await page.getByRole("button", { name: "Validator RED sample" }).click();
    await expect(validateCard).toContainText("RED");
    await expect(page.getByText("Required element last-modified is missing")).toBeVisible();
    await expect(page.getByText("role-id iam-admin has no matching role")).toBeVisible();
    await expect(page.getByText("back-matter resource uuid is not a valid UUID")).toBeVisible();
    await expect(page.getByText("Invalid OSCAL is never marked green")).toBeVisible();
    await expect(page.getByText("package-oscal.xml").first()).toBeVisible();
    await expect(page.getByText("bl-0001")).toHaveCount(0);

    await page.getByRole("button", { name: "Validate current" }).click();
    await expect(validateCard).toContainText("GREEN");
    await expect(validateCard).toContainText("0 errors");
    await page.getByRole("button", { name: "Package map" }).click();
    await expect(page.getByTestId("map-fail-banner")).toContainText("not an authorization result");
    await expect(page.locator('[data-testid="package-map"] path[data-rel="pipeline"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Export flow" }).click();

    await page.getByRole("button", { name: "Render Word" }).click();
    const renderCard = page.locator(".feature-card", { hasText: "Render Word" });
    await expect(renderCard).toContainText("Word rendered");
    await page.getByRole("button", { name: "Render Excel" }).click();
    await expect(renderCard).toContainText("Excel rendered");
    await expect(page.getByText("Parity check passed")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Parity mismatch/ })).toHaveCount(0);
    await expect(page.getByText("Enabled because the validator is GREEN")).toBeVisible();
    await expect(page.getByText("Not automatic").first()).toBeVisible();
    await expectChrome(page);
  });

  await test.step("Update baseline is explicit and Changes names the AC-2 delta", async () => {
    await page.getByRole("button", { name: "Update baseline" }).click();
    await expect(page.getByText("bl-0001").first()).toBeVisible();

    await openControl(page, "AC-2", "Account Management");
    await page.getByRole("button", { name: "Point EV-AC2-01 at September file" }).click();
    await expect(page.getByText("evidence/ac-2/iam-review-2026-09.pdf")).toBeVisible();

    await page.getByRole("button", { name: "Changes" }).click();
    await expect(page.getByText("Evidence · Modified")).toBeVisible();
    await expect(page.getByText("EV-AC2-01").first()).toBeVisible();
    await expect(page.getByText("Quarterly account review")).toBeVisible();
    await expect(page.getByText("AC-2").first()).toBeVisible();
    await expect(page.getByText("iam-review-2026-09.pdf")).toBeVisible();
    await expect(page.getByText("bl-0001").first()).toBeVisible();
    await expect(page.getByText("1 changed · 11 unchanged")).toBeVisible();
    await expect(page.getByText("Re export does not move the baseline.")).toBeVisible();
    await expect(page.getByText("Not automatic").first()).toBeVisible();
    await expectChrome(page);

    await page.getByRole("button", { name: "Export flow" }).click();
    const againDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export OSCAL" }).click();
    expect((await againDownload).suggestedFilename()).toBe("exp-0003-package-oscal.xml");
    await expect(page.getByText("exp-0003-package-oscal.xml")).toBeVisible();
    await expect(page.getByText("bl-0001").first()).toBeVisible();
    await expect(page.getByText("bl-0002")).toHaveCount(0);
    await expectChrome(page);
  });

  await test.step("Future stubs are visible and are not a live Turn 5 flow", async () => {
    await navigateWorkspace(page, "future");
    await expect(page.getByText("POA&M map")).toBeVisible();
    await expect(page.getByText("eMASS").first()).toBeVisible();
    await expect(page.getByText("Jira").first()).toBeVisible();
    await expect(page.getByText("STUB").first()).toBeVisible();
    await expect(page.getByText("0 live connections")).toBeVisible();
    await expect(page.getByText(/not built/i).first()).toBeVisible();
    await expect(page.getByText("not wired").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i })).toHaveCount(0);
    await expect(page.getByText(/application error|unhandled runtime/i)).toHaveCount(0);
    await expectChrome(page);
  });
});
