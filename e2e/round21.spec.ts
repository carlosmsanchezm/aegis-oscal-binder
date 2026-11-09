import {navigateWorkspace} from "./helpers/navigation";
import { test, expect } from "@playwright/test";
import { receivedRetest } from "../test/support/received-retest";

test("round 21a–d preserves the package and connects release highlighting, selected control, and focus", async ({
  page,
}) => {
  const evidence = receivedRetest();
  await page.route("**/api/pipeline/events", (route) =>
    route.fulfill({
      json: {
        ok: true,
        configured: false,
        webhookPath: "/api/pipeline/events",
        receivedAt: evidence.createdAt,
        evidence,
        releases: [{ evidence, receivedAt: evidence.createdAt }],
      },
    }),
  );
  await page.goto("/planning");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByTestId("workspace-navigation").getByRole("button",{name:"More",exact:true}).click();
  await page.getByTestId("workspace-navigation").getByRole("button",{name:/Developer details/}).click();
  await expect(
    page.getByRole("button", { name: "Load demo sample package", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Load demo sample package", exact: true })
    .click();
  await expect(page.locator("[data-control-id]")).toHaveCount(12);
  await expect(page.locator("[data-family-box]")).toHaveCount(6);
  await expect(
    page.locator('[data-control-id="CM-6"] .pmap-coverage-ticks i'),
  ).toHaveCount(4);
  await expect(page.getByTestId("completeness-status")).toContainText(
    "3 of 12 incomplete",
  );
  await expect(page.locator("[data-role-id]")).toHaveCount(6);
  await expect(page.locator("[data-evidence-id]")).toHaveCount(10);
  await expect(page.locator('path[data-rel="related"]')).toHaveCount(0);
  await page.locator('[data-control-id="CM-6"]').hover();
  await expect(page.locator('path[data-rel="related"]').first()).toBeVisible();
  await page.locator(".brand").hover();
  await expect(page.locator('path[data-rel="related"]')).toHaveCount(0);
  await page.getByLabel("Evidence system").selectOption("pipeline");await navigateWorkspace(page,"map");
  await page.locator('summary[aria-label="Release snapshot #2908682168"]').click();
  await page.getByRole("option", { name: /None current map/ }).click();
  const snapshot = page.locator('summary[aria-label="Release snapshot None"]');
  await snapshot.click();
  await expect(
    page.getByRole("option", { name: /None current map/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: /Podinfo.*#2908682168/ }).click();
  await expect(page.getByTestId("map-rollup-summary")).toContainText(
    "15 linked",
  );
  await expect(page.locator('[data-release-linked="true"]')).toHaveCount(15);
  await expect(
    page.locator('[data-control-id="CM-6"] .pmap-coverage-ticks i'),
  ).toHaveCount(4);
  await expect(page.locator("[data-evidence-id]")).toHaveCount(8);
  await expect(page.locator('[data-control-id="AC-6"]')).toHaveAttribute(
    "title",
    /2894050908/,
  );
  await expect(page.locator('[data-control-id="CM-6"]')).toHaveAttribute(
    "title",
    /2908682168/,
  );
  await expect(page.getByTestId("completeness-status")).toContainText(
    "3 of 12 incomplete",
  );
  await page.getByRole("button", { name: "SSP evidence", exact: true }).click();
  await expect(page.locator("[data-evidence-id]")).toHaveCount(0);
  await expect(page.locator('[data-release-linked="true"]')).toHaveCount(15);
  await page.getByRole("button", { name: "SSP evidence", exact: true }).click();
  await page.locator('[data-control-id="CM-6"]').click();
  const panel = page.getByTestId("pipeline-control-panel");
  await expect(panel).toContainText("#2908682168");
  await expect(panel.locator(".pipeline-control-artifact a[data-source-href]")).toHaveAttribute(
    "data-source-href",
    /16910084348.*configuration.json$/,
  );
  await expect(panel.locator(".pipeline-control-checks li")).toHaveCount(3);
  await expect(panel.locator("input,textarea,form")).toHaveCount(0);
  await expect(panel).toContainText("RA-5");
  await expect(
    page.locator('path[data-from="CM-6"][data-glyph="mutual"]').first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open CM-6 in Level 2 →" }).click();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  await expect(page.locator(".round21-item-evidence")).toHaveCount(4);
  await expect(page.getByTestId("level2-control")).toContainText(
    "CSP Configuration Manager",
  );
  await expect(page.getByTestId("focus-enhancements")).toContainText(
    "Automated Management",
  );
  await expect(panel).toContainText("Statement · selected");
  await expect(panel).toContainText("Evidence for this statement");
  await expect(panel).toContainText("Not assigned to this statement");
  await expect(panel.locator(".pipeline-control-checks li")).toHaveCount(3);
  await page.locator('[data-statement-evidence="cm-6_smt.a"]').locator(".round21-candidate-artifact").filter({hasText:"configuration.json"}).click();
  await expect(page.getByTestId("evidence-focus")).toBeVisible();
  await page.getByTestId("evidence-focus").getByRole("button", { name: /←/ }).click();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  await page.getByTestId("related-AU-2").click();
  await expect(page.getByTestId("level2-control")).toContainText("AU-2");
  await page.getByTestId("level2-back").click();
  await page.getByRole("checkbox", { name: "Show untouched controls" }).check();
  await expect(page.locator("[data-control-id]")).toHaveCount(323);
  await expect(page.locator("[data-family-box]")).toHaveCount(18);
  await expect(page.locator('[data-control-id="AT-1"]')).toHaveCount(1);
  await expect(page.locator('[data-control-id="CM-6"]')).toBeVisible();
  await expect(page.locator('[data-family-header="CM"]')).toContainText('2 linked');
  await expect(page.getByTestId("map-rollup-summary").first()).toContainText(
    "308 blank",
  );
  await page.getByRole("checkbox", { name: "Show untouched controls" }).uncheck();
  await expect(page.locator("[data-family-box]")).toHaveCount(11);
  await page
    .locator('summary[aria-label="Release snapshot #2908682168"]')
    .click();
  await page.getByRole("option", { name: /None current map/ }).click();
  await expect(page.locator("[data-release-linked]")).toHaveCount(0);
  await expect(page.locator("[data-evidence-id]")).toHaveCount(8);
  await page.getByRole("button", { name: "Export flow", exact: true }).click();
  await expect(page.getByTestId("completeness-status")).toContainText(
    "3 of 12 incomplete",
  );
  await page.getByRole("button", { name: "Package map", exact: true }).click();
  await expect(page.locator("[data-control-id]")).toHaveCount(27);
});
