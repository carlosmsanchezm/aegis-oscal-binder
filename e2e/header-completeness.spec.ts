import { expect, test, type Page } from "@playwright/test";
import { seedStore } from "./helpers/m1-seed";

const MODERATE_SAMPLE = "/samples/sample-oscal-ssp-rev5-moderate.json";
const WIDTHS = [1280, 1440, 1920] as const;

async function loadModerate(page: Page): Promise<void> {
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  const served = await page.request.get(MODERATE_SAMPLE);
  expect(served.ok()).toBeTruthy();
  await page.getByLabel("OSCAL package").setInputFiles({
    name: "sample-oscal-ssp-rev5-moderate.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(await served.json())),
  });
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByTestId("completeness-status").first()).toContainText("322 of 323 incomplete", { timeout: 60_000 });
}

async function expectWholeChip(page: Page, label: string, status: string, testId = "completeness-status"): Promise<void> {
  const chip = page.getByTestId(testId).first();
  await expect(chip).toContainText(label);
  await expect(chip).toContainText(status);
  const measured = await chip.evaluate((element) => {
    const parts = ([element, ...Array.from(element.querySelectorAll("*"))] as HTMLElement[]).filter(part => !part.closest('[role="tooltip"]'));
    const header = element.closest("header") as HTMLElement;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: Array<{ text: string; lines: number }> = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const box = (node.parentElement as HTMLElement).getBoundingClientRect();
      if (!text || box.width === 0 || node.parentElement?.closest('[role="tooltip"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const tops = new Set(Array.from(range.getClientRects()).filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      lines.push({ text, lines: tops.size });
    }
    return {
      lines,
      parts: parts.map((part) => ({ text: part.textContent ?? "", scroll: part.scrollWidth, client: part.clientWidth, ellipsis: getComputedStyle(part).textOverflow })),
      label: Array.from(element.children).map((child) => (child as HTMLElement).innerText.trim()).filter(Boolean),
      chipHeight: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 0,
      headerHeight: header.getBoundingClientRect().height,
      right: element.getBoundingClientRect().right,
      headerRight: header.getBoundingClientRect().right,
    };
  });
  for (const part of measured.parts) {
    expect(part.scroll, `"${part.text}" overflows its box`).toBeLessThanOrEqual(part.client);
    expect(part.ellipsis, `"${part.text}" uses an ellipsis`).not.toBe("ellipsis");
  }
  for (const run of measured.lines) {
    expect(run.lines, `"${run.text}" wraps onto ${run.lines} lines`).toBe(1);
  }
  expect(measured.label).toContain(label);
  expect(measured.right).toBeLessThanOrEqual(measured.headerRight);
}

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
});

test("the completeness chip shows the full Moderate count at 1280, 1440 and 1920 without changing header height", async ({ page }) => {
  await loadModerate(page);
  const heights: number[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expectWholeChip(page, "322 of 323 incomplete", "FAIL");
    heights.push(await page.locator("header.chrome-topbar").first().evaluate((element) => element.getBoundingClientRect().height));
  }
  expect(new Set(heights).size, `header heights ${heights.join(", ")}`).toBe(1);
});

test("a four digit count also stays whole at every width", async ({ page }) => {
  await loadModerate(page);
  await page.route("**/api/package", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.packageState.gate = { ...body.packageState.gate, incomplete: 1322, total: 1323, label: "1322 of 1323 incomplete" };
    await route.fulfill({ response, json: body });
  });
  const heights: number[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/workspace?editor=classic");
    await expectWholeChip(page, "1322 of 1323 incomplete", "FAIL");
    heights.push(await page.locator("header.chrome-topbar").first().evaluate((element) => element.getBoundingClientRect().height));
  }
  expect(new Set(heights).size, `header heights ${heights.join(", ")}`).toBe(1);
});

test("the complete Gold package keeps PASS and 0 of 12 incomplete whole at every width", async ({ page }) => {
  await seedStore(page.request, { evidence: false, exports: 0, complete: true });
  for (const scenario of [
    // Preserve M2's existing classic workspace wording and its map guard assertions.
    { url: "/workspace?editor=classic", label: "12 of 12 complete \u00b7 gate open", testId: "completeness-status", header: "header.chrome-topbar" },
    { url: "/stored-evidence", label: "0 of 12 incomplete", testId: "m1-completeness", header: "header.m1-head" },
  ]) {
    await page.goto(scenario.url);
    const heights: number[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expectWholeChip(page, scenario.label, "PASS", scenario.testId);
      heights.push(await page.locator(scenario.header).first().evaluate(element => element.getBoundingClientRect().height));
    }
    expect(new Set(heights).size).toBe(1);
  }
});
