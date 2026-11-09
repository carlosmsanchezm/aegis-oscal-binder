import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { inventory, seedRetained, seedStore, tamperOneByte, type Seeded } from "./m1-seed";

type Obj = Seeded["objects"][number];

export type M1Capture = { page: Page; context: BrowserContext; target: Locator; kind: "main" | "card" };

/** One locked frame state: how to reach it through the real routes, and what to capture. */
export type M1State = { frame: "19" | "22" | "23" | "24" | "25"; reach: (browser: Browser, baseURL: string) => Promise<M1Capture> };

const HOLD = () => new Promise<never>(() => undefined);
const unavailable = { status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: "The private store did not answer." } }) };

async function fresh(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  return { context, page: await context.newPage() };
}

function evidenceOf(seeded: Seeded): Obj {
  return seeded.objects.find((item) => item.kind === "evidence") as Obj;
}

function latestOscal(seeded: Seeded): Obj {
  return seeded.objects.filter((item) => item.kind === "export" && item.role === "oscal" && item.current).sort((a, b) => String(b.exportId).localeCompare(String(a.exportId)))[0] as Obj;
}

async function screen(page: Page, frame: string, state: string): Promise<void> {
  await expect(page.getByTestId(`m1-frame${frame}`)).toHaveAttribute("data-state", state);
  await page.evaluate(() => document.fonts.ready);
}

function main(page: Page, context: BrowserContext): M1Capture {
  return { page, context, target: page.locator("body"), kind: "main" };
}

function card(page: Page, context: BrowserContext, scope = ""): M1Capture {
  return { page, context, target: page.locator(`${scope} [data-testid="m1-state-card"]`.trim()).first(), kind: "card" };
}

async function openRegenerate(page: Page, object: Obj) {
  await page.goto(`/stored-evidence?objectKey=${object.objectKey}`);
  await screen(page, "22", object.kind === "evidence" ? "evidence-mismatch" : "export-mismatch");
  await page.getByTestId("m1-link-regenerate").click();
}

async function frame19(browser: Browser, baseURL: string, options: { hold?: boolean; fail?: boolean } = {}) {
  const { context, page } = await fresh(browser, baseURL);
  await seedStore(context.request, { planning: true, evidence: false, exports: 0, complete: true });
  const retained = await seedRetained(context.request);
  if (options.hold) await page.route(`**/api/builder/evidence/${retained.evidenceId}?*`, HOLD);
  if (options.fail) await page.route(`**/api/builder/evidence/${retained.evidenceId}?*`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Builder storage or retained evidence is unavailable. Retry after checking the configured store." }) }));
  await page.goto(retained.url);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, retained };
}

export const M1_STATES: Record<string, M1State> = {
  "f19-main": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL);
    await expect(page.getByTestId("m1-measured")).toBeVisible();
    return main(page, context);
  } },
  "f19-state1-current": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL);
    await page.getByRole("button", { name: /Open fresh retest/ }).click();
    return card(page, context, ".m1-popover");
  } },
  "f19-state2-expired": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL);
    await page.getByRole("button", { name: "Expired", exact: true }).click();
    return card(page, context, ".m1-popover");
  } },
  "f19-state3-verified": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL);
    await page.getByRole("button", { name: "Producer identity unverified" }).click();
    return card(page, context, ".m1-popover");
  } },
  "f19-state4-empty": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL);
    await page.locator(".m1-f19-right").getByRole("button", { name: /authorization-review\.json/ }).click();
    await expect(page.getByTestId("m1-file-list")).toBeVisible();
    return card(page, context, ".m1-f19-empty");
  } },
  "f19-state5-loading": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL, { hold: true });
    await expect(page.locator('[data-state="loading"]')).toBeVisible();
    return card(page, context);
  } },
  "f19-state6-error": { frame: "19", reach: async (browser, baseURL) => {
    const { context, page } = await frame19(browser, baseURL, { fail: true });
    await expect(page.locator('[data-state="error"]')).toBeVisible();
    return card(page, context);
  } },

  "f22-main": { frame: "22", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    tamperOneByte(evidenceOf(seeded));
    await page.goto(`/stored-evidence?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "22", "evidence-mismatch");
    return main(page, context);
  } },
  "f22-state1-export-mismatch": { frame: "22", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    tamperOneByte(latestOscal(seeded));
    await page.goto(`/stored-evidence?objectKey=${latestOscal(seeded).objectKey}`);
    await screen(page, "22", "export-mismatch");
    return card(page, context);
  } },
  "f22-state2-all-match": { frame: "22", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    await seedStore(context.request, { exports: 1, complete: true });
    await page.goto("/stored-evidence");
    await screen(page, "22", "all-match");
    return card(page, context);
  } },
  "f22-state3-loading": { frame: "22", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    await page.route("**/api/digest/verify", HOLD);
    await page.goto(`/stored-evidence?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "22", "loading");
    return card(page, context);
  } },
  "f22-state4-error": { frame: "22", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    await page.route("**/api/digest/verify", (route) => route.fulfill(unavailable));
    await page.goto(`/stored-evidence?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "22", "error");
    return card(page, context);
  } },

  "f23-main": { frame: "23", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    const evidence = evidenceOf(seeded);
    tamperOneByte(evidence);
    const listed = await inventory(context.request);
    const stored = listed.objects.find((item) => item.objectKey === evidence.objectKey) as Obj & { controlId: string; evidenceId: string };
    expect((await context.request.get(`/api/controls/${stored.controlId}/evidence/${stored.evidenceId}/bytes`)).status()).toBe(409);
    await page.goto(`/audit-trail?objectKey=${evidence.objectKey}`);
    await screen(page, "23", "evidence");
    return main(page, context);
  } },
  "f23-state1-export": { frame: "23", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    const oscal = latestOscal(seeded);
    tamperOneByte(oscal);
    // Record two real refusal events, a pass and an attempted download.
    expect((await context.request.post("/api/digest/verify")).ok()).toBeTruthy();
    expect((await context.request.get("/api/artifacts/oscal")).status()).toBe(409);
    expect((await context.request.post("/api/digest/regenerate", { data: { exportId: oscal.exportId, newExport: true } })).ok()).toBeTruthy();
    const kept = (await inventory(context.request)).objects.find((item) => item.objectKey === oscal.objectKey) as Obj;
    await page.goto(`/audit-trail?objectKey=${kept.objectKey}`);
    await screen(page, "23", "export");
    return card(page, context);
  } },
  "f23-state2-evidence-empty": { frame: "23", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    await page.goto(`/audit-trail?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "23", "evidence-empty");
    return card(page, context);
  } },
  "f23-state3-loading": { frame: "23", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    await page.route("**/api/digest/refusals", HOLD);
    await page.goto(`/audit-trail?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "23", "loading");
    await expect(page.getByTestId("m1-state-card")).toBeVisible();
    return card(page, context);
  } },
  "f23-state4-error": { frame: "23", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    await page.route("**/api/digest/refusals", (route) => route.fulfill(unavailable));
    await page.goto(`/audit-trail?objectKey=${evidenceOf(seeded).objectKey}`);
    await screen(page, "23", "error");
    return card(page, context);
  } },

  "f24-main": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    tamperOneByte(latestOscal(seeded));
    await openRegenerate(page, latestOscal(seeded));
    await screen(page, "24", "confirm");
    return main(page, context);
  } },
  "f24-state1-building": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    tamperOneByte(latestOscal(seeded));
    await page.route("**/api/digest/regenerate", HOLD);
    await openRegenerate(page, latestOscal(seeded));
    await screen(page, "24", "confirm");
    await page.getByTestId("m1-regenerate").click();
    await screen(page, "24", "building");
    return card(page, context);
  } },
  "f24-state2-done": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    tamperOneByte(latestOscal(seeded));
    await openRegenerate(page, latestOscal(seeded));
    await screen(page, "24", "confirm");
    await page.getByTestId("m1-regenerate").click();
    await screen(page, "24", "done");
    return card(page, context);
  } },
  "f24-state3-error": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    tamperOneByte(latestOscal(seeded));
    await page.route("**/api/digest/regenerate", (route) => route.fulfill(unavailable));
    await openRegenerate(page, latestOscal(seeded));
    await screen(page, "24", "confirm");
    await page.getByTestId("m1-regenerate").click();
    await screen(page, "24", "error");
    return card(page, context);
  } },
  "f24-state4-disabled": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 1, complete: true });
    tamperOneByte(evidenceOf(seeded));
    await openRegenerate(page, evidenceOf(seeded));
    await screen(page, "24", "disabled");
    return card(page, context);
  } },
  "f24-state5-not-needed": { frame: "24", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, complete: true });
    await page.goto("/stored-evidence");
    await screen(page, "22", "all-match");
    await page.getByTestId("m1-file-row").filter({ hasText: "exp-0002" }).getByTestId("m1-link-regenerate").click();
    await screen(page, "24", "confirm");
    await page.getByTestId("m1-regenerate").click();
    await screen(page, "24", "not-needed");
    return card(page, context);
  } },

  "f25-main": { frame: "25", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    const seeded = await seedStore(context.request, { exports: 2, renders: true, complete: true });
    tamperOneByte(evidenceOf(seeded));
    await page.goto("/verify-stored-files");
    await screen(page, "25", "results");
    return main(page, context);
  } },
  "f25-state1-all-match": { frame: "25", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    await seedStore(context.request, { exports: 2, renders: true, complete: true });
    await page.goto("/verify-stored-files");
    await screen(page, "25", "all-match");
    return main(page, context);
  } },
  "f25-state2-loading": { frame: "25", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    await seedStore(context.request, { exports: 2, renders: true, complete: true });
    let calls = 0;
    await page.route("**/api/digest/verify", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      calls += 1;
      return calls <= 3 ? route.continue() : HOLD();
    });
    await page.goto("/verify-stored-files");
    await screen(page, "25", "loading");
    await expect(page.getByTestId("m1-state-card")).toContainText("3 of 5");
    return card(page, context);
  } },
  "f25-state3-empty": { frame: "25", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    await seedStore(context.request, { evidence: false, exports: 0, complete: true });
    await page.goto("/verify-stored-files");
    await screen(page, "25", "empty");
    return card(page, context);
  } },
  "f25-state4-error": { frame: "25", reach: async (browser, baseURL) => {
    const { context, page } = await fresh(browser, baseURL);
    await seedStore(context.request, { exports: 1, complete: true });
    await page.route("**/api/digest/files", (route) => route.fulfill(unavailable));
    await page.goto("/verify-stored-files");
    await screen(page, "25", "error");
    return card(page, context);
  } },
};
