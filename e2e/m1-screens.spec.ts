import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { M1_STATES } from "./helpers/m1-states";
import { seedRetained, seedStore } from "./helpers/m1-seed";

const HONESTY = "Coverage only \u00b7 a person approves. Validation is not an assessment or an ATO.";
const STALE_SAMPLE = "94db668";

for (const planning of [false, true]) {
  test(`frame 23: no refusal is an empty successful request in ${planning ? "planning" : "classic"}`, async ({ page }) => {
    const seeded = await seedStore(page.request, { planning, exports: 1, complete: true });
    const evidence = seeded.objects.find(item => item.kind === "evidence")!;
    const failures: string[] = [];
    const errors: string[] = [];
    page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
    page.on("requestfailed", request => failures.push(`${request.failure()?.errorText} ${request.url()}`));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`/audit-trail?objectKey=${evidence.objectKey}${planning ? "&workspace=sa1-demo" : ""}`);
    await expect(page.getByTestId("m1-frame23")).toHaveAttribute("data-state", "evidence-empty");
    await expect(page.getByTestId("m1-audit-row")).toHaveCount(1);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });
}

function headSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

for (const [name, state] of Object.entries(M1_STATES)) {
  test(`${name}: honesty sentence and OSCAL binder alpha footer`, async ({ browser, baseURL }) => {
    const capture = await state.reach(browser, baseURL as string);
    try {
      const { page } = capture;
      if (capture.kind === "card") await expect(capture.target.getByTestId("m1-honesty")).toHaveText(HONESTY);
      await expect(page.getByTestId("m1-honesty").first()).toHaveText(HONESTY);
      for (const row of await page.getByTestId("m1-file-row").all()) {
        const width = await row.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(width.scroll, "A stored file row must keep its result pill inside the card").toBeLessThanOrEqual(width.client);
        for (const name of await row.locator(".m1-name").all()) {
          const size = await name.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
          expect(size.scroll, "The locked evidence title must stay fully visible").toBeLessThanOrEqual(size.client);
        }
      }
      const footer = page.getByTestId("m1-footer");
      await expect(footer).toContainText("OSCAL binder alpha");
      await expect(footer).toContainText("version");
      await expect(footer).toContainText("X \u00b7 placeholder");
      await expect(footer).toContainText("Not FedRAMP authorized \u00b7 not an ATO");
      await expect(footer).toContainText("Alpha data handling");
      const build = (await page.getByTestId("m1-build").textContent())?.trim() ?? "";
      expect(build).toMatch(/^build ([0-9a-f]{7}|unknown)$/);
      if (build.includes(STALE_SAMPLE)) expect(headSha()).toBe(STALE_SAMPLE);
      expect(await page.locator("body").innerText()).not.toContain(STALE_SAMPLE === headSha() ? "\u0000" : STALE_SAMPLE);
    } finally {
      await capture.context.close();
    }
  });
}

test("frame 19: Esc closes a popover first, then returns to Release evidence", async ({ page }) => {
  await seedStore(page.request, { planning: true, evidence: false, exports: 0, complete: true });
  const retained = await seedRetained(page.request);
  await page.goto(retained.url);
  await expect(page.getByRole("heading", { name: "Retained evidence", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Producer identity unverified" }).click();
  const dialog = page.getByRole("dialog", { name: "Producer verified, planned sample" });
  await expect(dialog).toContainText("planned sample");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/evidence/${retained.evidenceId}`));
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/planning\?view=release/);
});

test("frame 19: folded fields expand and the full JSON stays in the copy and the download", async ({ page }) => {
  await seedStore(page.request, { planning: true, evidence: false, exports: 0, complete: true });
  const retained = await seedRetained(page.request);
  await page.goto(retained.url);
  const artifact = page.getByTestId("retained-artifact");
  await expect(artifact).toContainText("\u25b8 { 4 fields }");
  await expect(artifact).toContainText('"allowed": false');
  await artifact.getByRole("button", { name: "Expand 4 collapsed entries" }).click();
  await expect(artifact).not.toContainText("\u25b8");
  await expect(artifact).toContainText('"f:namespace"');
  const raw = await page.request.get((await page.getByRole("link", { name: "Download original artifact" }).getAttribute("href"))!);
  expect(JSON.parse(await raw.text()).status.allowed).toBe(false);
  await expect(page.getByTestId("m1-measured")).toHaveText("status.allowed: false is the measured result. It is evidence for the AC-6 objective, not approval.");
});

test("frame 13: undrawn entry points open the audit trail and the verify pass in the same session", async ({ page }) => {
  await seedStore(page.request, { exports: 1, complete: true });
  await page.goto("/workspace?editor=classic&view=export");
  const entry = page.getByTestId("stored-file-entry-points");
  await expect(entry.getByRole("link", { name: "Open audit trail" })).toHaveClass(/btn ghost/);
  await entry.getByRole("link", { name: "Open audit trail" }).click();
  await expect(page.getByTestId("m1-frame23")).toHaveAttribute("data-state", "export");
  await page.goBack();
  await entry.getByRole("link", { name: "Verify stored files" }).click();
  await expect(page.getByTestId("m1-frame25")).toHaveAttribute("data-state", "all-match");
});

for (const planning of [false, true]) {
  test(`frame 24: stored export links preserve the object and workspace in ${planning ? "planning" : "classic"}`, async ({ page }) => {
    const seeded = await seedStore(page.request, { planning, exports: 1, renders: true, complete: true });
    await page.goto(planning ? "/planning?view=export" : "/workspace?editor=classic&view=export");
    await page.getByTestId("stored-file-entry-points").getByRole("link", { name: "Stored exports", exact: true }).click();
    await expect(page.getByTestId("m1-frame22")).toHaveAttribute("data-state", "all-match");
    const storedUrl = page.url();
    for (const role of ["oscal", "word", "excel"]) {
      const object = seeded.objects.find(item => item.role === role)!;
      const row = page.getByTestId("m1-file-row").filter({ hasText: role === "oscal" ? "package-oscal.xml" : role === "word" ? "ssp-readable.docx" : "control-table.xlsx" });
      const link = row.getByTestId("m1-link-regenerate");
      await expect(link).toHaveAttribute("href", new RegExp(`objectKey=${object.objectKey}.*exportId=${object.exportId}.*render=${role}${planning ? ".*workspace=sa1-demo" : ""}`));
      await link.click();
      await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "confirm");
      await expect(page.getByTestId("m1-export-row")).toHaveAttribute("data-object", object.objectKey);
      const answer = page.waitForResponse(response => /\/api\/(demo\/sa1\/)?digest\/regenerate$/.test(response.url()) && response.request().method() === "POST");
      await page.getByTestId("m1-regenerate").click();
      expect((await (await answer).json()).error.code).toBe("REGENERATE_UNNEEDED");
      await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "not-needed");
      await page.goto(storedUrl);
      await expect(page.getByTestId("m1-frame22")).toHaveAttribute("data-state", "all-match");
    }
    await page.goto(`/regenerate-export?exportId=exp-0001&render=oscal${planning ? "&workspace=sa1-demo" : ""}`);
    await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "confirm");
    await page.goto(`/regenerate-export${planning ? "?workspace=sa1-demo" : ""}`);
    await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "confirm");
    await page.goto(`/regenerate-export?exportId=exp-does-not-exist${planning ? "&workspace=sa1-demo" : ""}`);
    await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "missing");
  });
}

for (const planning of [false, true]) {
  test(`frame 25: a matching pass keeps its full real inventory in ${planning ? "planning" : "classic"}`, async ({ page }) => {
    const seeded = await seedStore(page.request, { planning, exports: 2, renders: true, complete: true });
    const query = planning ? "?workspace=sa1-demo" : "";
    const api = planning ? "/api/demo/sa1/digest/verify" : "/api/digest/verify";
    await page.goto(`/verify-stored-files${query}`);
    await expect(page.getByTestId("m1-frame25")).toHaveAttribute("data-state", "all-match");
    await expect(page.getByTestId("m1-frame25-main")).toBeVisible();
    await expect(page.getByText("What this checks", { exact: true })).toBeVisible();
    const check = await (await page.request.get(api)).json();
    expect(check.files.length).toBeGreaterThan(0);
    await expect(page.getByTestId("m1-verify-row")).toHaveCount(check.files.length);
    await expect(page.getByTestId("m1-count-checked")).toHaveText(String(check.matched));
    await expect(page.getByTestId("m1-count-match")).toHaveText(String(check.matched));
    await expect(page.getByTestId("m1-count-mismatch")).toHaveText("0");
    await expect(page.getByTestId("m1-count-unreadable")).toHaveText("0");
    for (const file of check.files) {
      const row = page.locator(`[data-testid="m1-verify-row"][data-object="${file.objectKey}"]`);
      await expect(row).toHaveAttribute("data-status", file.result);
      expect(file.recomputedDigest).toBe(file.recordedDigest);
      await expect(row.locator(`[title="${file.recordedDigest}"]`)).toHaveCount(1);
      await expect(row.locator(`[title="Recomputed on read: ${file.recomputedDigest}"]`)).toHaveCount(1);
    }
    const finished = page.waitForResponse(response => response.url().endsWith(api) && response.request().method() === "POST" && !response.request().postDataJSON()?.objectKey);
    await page.getByTestId("m1-run").click();
    expect((await (await finished).json()).matched).toBe(check.matched);
    await expect(page.getByTestId("m1-frame25")).toHaveAttribute("data-state", "all-match");
    const evidence = seeded.objects.find(item => item.kind === "evidence")!;
    await page.locator(`[data-testid="m1-verify-row"][data-object="${evidence.objectKey}"]`).getByTestId("m1-link-regenerate").click();
    await expect(page.getByTestId("m1-frame24")).toHaveAttribute("data-state", "disabled");
    await expect(page.getByTestId("m1-regenerate")).toBeDisabled();
  });
}
