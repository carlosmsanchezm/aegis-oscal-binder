import { chooseStartingPoint, navigateWorkspace } from "./helpers/navigation";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";

test("original finding → accept edited draft → confirm → reload → accurate OSCAL download with no durable store", async ({ page, context, browser }, testInfo) => {
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  await navigateWorkspace(page, "release");
  await page.getByRole("button", { name: "Open proposed plan CM-6 · Application UID/GID hardening" }).click();
  const drawer = page.getByTestId("plan-proposal");
  await expect(drawer).toContainText("Original failed observation #2894050908");
  await expect(drawer).toContainText("Retest #2908682168");
  await expect(drawer.locator("ol li")).toHaveCount(3);
  await expect(drawer.locator("ol li small").filter({ hasText: "PASS" })).toHaveCount(3);
  await expect(drawer.getByRole("button", { name: "Confirm closure", exact: true })).toBeDisabled();
  await expect(drawer.getByRole("button", { name: "Download OSCAL plan of action" })).toBeDisabled();
  await page.getByLabel("Risk statement", { exact: true }).fill("Reviewed hardening risk for PR 39.");
  await page.getByLabel("Official plan id", { exact: true }).fill("POAM-39");
  await drawer.getByRole("button", { name: "Accept proposed draft" }).click();
  await expect(drawer).toContainText("Accepted · ready to close · needs a person");
  await drawer.getByLabel("Closure name").fill("Test reviewer");
  await drawer.getByLabel("Closure reason").fill("All passing measurements reviewed.");
  await drawer.getByRole("button", { name: "Confirm closure", exact: true }).click();
  await expect(drawer).toContainText("Closure confirmed by a person · official plan id POAM-39");
  await expect(drawer).not.toContainText("Closure stays unconfirmed");
  await page.reload();
  const loaded = page.waitForResponse(response => response.url().endsWith("/api/demo/sa1/oscal/ingest") && response.request().method() === "POST");
  await chooseStartingPoint(page, "Load planning example");
  expect((await loaded).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Load planning example", exact: true })).toBeHidden();
  await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
  await navigateWorkspace(page, "release");
  await page.getByRole("button", { name: "Open proposed plan CM-6 · Application UID/GID hardening" }).click();
  await expect(drawer).toContainText("Closure confirmed by a person · official plan id POAM-39");
  await expect(page.getByLabel("Risk statement", { exact: true })).toHaveValue("Reviewed hardening risk for PR 39.");
  const downloadPromise = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "Download OSCAL plan of action" }).click();
  const download = await downloadPromise;
  const file = JSON.parse(await readFile((await download.path())!, "utf8"))["plan-of-action-and-milestones"];
  expect(file.risks[0].status).toBe("closed");
  expect(file.risks[0].props).toContainEqual(expect.objectContaining({ name: "person-closure-confirmed", value: "true" }));
  expect(file["poam-items"][0].props).toContainEqual(expect.objectContaining({ name: "poam-id", value: "POAM-39" }));
  expect(file["poam-items"][0].remarks).toContain("passes every required check");
  expect(JSON.stringify(file)).not.toMatch(/not a passing proof|has not recorded closure/);
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  const cookies = await context.cookies();
  const recordCookies = cookies.filter(c => c.name.startsWith("aegis_remediation_v2_"));
  expect(recordCookies.length).toBeGreaterThan(0);
  expect(recordCookies.every(c => c.httpOnly && !c.value.includes("POAM-39"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pr39-confirmed.png"), fullPage: true });
  const isolated = await browser.newContext();
  const other = await isolated.newPage();
  await other.goto("/planning");
  await other.getByLabel("Evidence system").selectOption("example");
  await navigateWorkspace(other, "release");
  await other.getByRole("button", { name: "Open proposed plan CM-6 · Application UID/GID hardening" }).click();
  await expect(other.getByRole("button", { name: "Accept proposed draft" })).toBeEnabled();
  await isolated.close();
});

test("overlapping fallback writes retain separate records and copied cookies do not cross sessions", async ({ context }) => {
  await context.request.get("/api/remediation?key=bootstrap");
  const decision = { schema: "binder.plan-proposal.v1", id: `proposal:CM-6:${CCM_EXAMPLE.pipelineId}:${CCM_EXAMPLE.reviewItems![0].id}`, controlId: "CM-6", finding: CCM_EXAMPLE.reviewItems![0].description, sourceReleaseId: CCM_EXAMPLE.pipelineId, riskStatement: "Test risk", action: "Test action", milestone: { description: "Test milestone", target: "" }, acceptance: "accepted", closureConfirmed: false, officialId: "" };
  await Promise.all(["one", "two"].map(async key => {
    const response = await context.request.put("/api/remediation", { data: { key, assessment: null, assessments: {}, plans: [], proposals: [decision] } });
    expect(response.status()).toBe(200);
  }));
  for (const key of ["one", "two"]) {
    const response = await context.request.get(`/api/remediation?key=${key}`);
    expect((await response.json()).record.key).toBe(key);
  }
  const cookies = await context.cookies();
  const copied = cookies.filter(c => c.name.startsWith("aegis_remediation_v2_"));
  const response = await context.request.get("/api/remediation?key=one", { headers: { cookie: `aegis_sid=${"ff".repeat(16)}; ${copied.map(c => `${c.name}=${c.value}`).join("; ")}` } });
  expect((await response.json()).record).toBeNull();
});
