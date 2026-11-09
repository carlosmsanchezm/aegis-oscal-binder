import {referenceAuthorizationPlan,selectAuthorizationRetest} from "./helpers/collector-reference";
import { navigateWorkspace } from "./helpers/navigation";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

test("Boutique Level 2 survives Release evidence return, with readable owned artifacts, runs and checks", async ({ page, context, browser }, info) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/planning");
  await page.getByRole("button", { name: "Connect a system or load captured evidence" }).click();
  await page.getByRole("button", { name: "Load captured Online Boutique evidence" }).click();
  await navigateWorkspace(page,"release");
  await expect(page.getByTestId("release-dashboard")).toBeVisible();
  await page.getByRole("button", { name: referenceAuthorizationPlan }).click();
  await expect(page.getByLabel("Corrective action", { exact: true })).toHaveValue(/namespace\.$/);
  await expect(page.getByLabel("Corrective action", { exact: true })).not.toHaveValue(/\.\.$/);
  await page.getByRole("button", { name: "Close proposed plan" }).click();
  await page.getByRole("button", { name: "Package map", exact: true }).click();
  await page.locator('[data-control-id="AC-6"]').first().dblclick();
  const focus = page.getByTestId("level2-focus");
  await expect(focus).toBeVisible();
  await expect(focus).toContainText("Supports AC-6 as a whole. Not mapped to statement ac-6_smt.");
  const statement = page.locator('[data-item-id="ac-6_smt"]');
  await statement.click();
  await expect(statement).toHaveAttribute("aria-pressed", "true");
  for (const method of ["button", "escape", "navigation", "selector"]) {
    await page.getByRole("button", { name: "Release evidence", exact: true }).click();
    await expect(page.getByTestId("release-dashboard")).toBeVisible();
    await expect(page.getByTestId("release-map-return")).toContainText("AC-6 · Level 2");
    if (method === "button") await page.getByTestId("release-map-return").click();
    else if (method === "escape") await page.keyboard.press("Escape");
    else if (method === "navigation") await page.getByRole("button", { name: "Package map", exact: true }).click();
    else await navigateWorkspace(page, "map");
    await expect(focus).toBeVisible();
    await expect(page.getByTestId("level2-breadcrumb")).toContainText("AC-6");
    await expect(statement).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Release evidence", exact: true }).click();
  await selectAuthorizationRetest(page);
  await page.getByText("Sources ▾", { exact: true }).click();
  for (const name of ["authorization-review.json ↗", "Pipeline run ↗", "frontend-secret-read ↗"]) {
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name, exact: true }).click();
    const viewer = await popup;
    await expect(viewer.getByRole("heading", { name: "Retained evidence", exact: true })).toBeVisible();
    await expect(viewer.getByTestId("retained-check")).toContainText("Captured PASS");
    await expect(viewer.getByTestId("retained-check")).toContainText("AC-6");
    if (name.startsWith("authorization")) {
      await expect(viewer.getByTestId("retained-artifact")).toContainText('"allowed": false');
      const raw = await viewer.request.get((await viewer.getByRole("link", { name: "Download original artifact" }).getAttribute("href"))!);
      expect(raw.headers()["content-disposition"]).toContain("attachment");
      expect(JSON.parse(await raw.text()).status.allowed).toBe(false);
      await viewer.screenshot({ path: info.outputPath("readable-authorization-evidence.png"), fullPage: true });
    }
    await viewer.close();
  }
  // Producer HTML is escaped, including script markup. Raw bytes still download unchanged.
  const summary = await (await page.request.get("/api/builder")).json();
  const connection = summary.connections[0];
  const reference = await (await page.request.get("/api/builder/reference")).json();
  const event = JSON.parse(reference.events[0].rawEvent);
  const html = '<script>window.producerExecuted=true</script><h1>Producer markup</h1>';
  event.run.id = "escaped-artifact-test";
  event.artifacts.push({ name: "producer.html", mediaType: "text/html", contentBase64: Buffer.from(html).toString("base64"), sha256: createHash("sha256").update(html).digest("hex") });
  const receipt = await page.request.post(`/api/builder/connections/${connection.id}/imports`, { data: event });
  expect(receipt.status()).toBe(201);
  const imported = await receipt.json();
  const viewerUrl = `/evidence/${imported.evidenceId}?connection=${connection.id}&artifact=producer.html`;
  const safe = await context.newPage();
  await safe.goto(viewerUrl);
  await expect(safe.getByTestId("retained-artifact")).toContainText(html);
  expect(await safe.evaluate(() => (window as unknown as { producerExecuted?: boolean }).producerExecuted)).toBeUndefined();
  const other = await browser.newContext({ baseURL: info.project.use.baseURL });
  const outsider = await other.newPage();
  await outsider.goto(viewerUrl);
  await expect(outsider.getByTestId("observation-viewer").getByRole("alert")).toHaveAttribute("aria-label", /Evidence not found/);
  await expect(outsider.getByTestId("retained-artifact")).toHaveCount(0);
  await other.close(); await safe.close();
  expect(errors).toEqual([]);
});
