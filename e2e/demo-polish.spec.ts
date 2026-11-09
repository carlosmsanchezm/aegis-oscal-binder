import {test, expect, type Page} from "@playwright/test";
import {navigateWorkspace} from "./helpers/navigation";

// Each check reads the rendered page: boxes, hit testing, visibility and text.
// Every one of them failed on the layout and drawer state they guard against.

async function podinfoMap(page: Page) {
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");
  await navigateWorkspace(page, "map");
}

async function selectCm6(page: Page) {
  const card = page.locator('[data-control-id="CM-6"]');
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  const panel = page.getByTestId("pipeline-control-panel");
  await expect(panel.locator('.side-card[data-side="next"]')).toBeVisible();
  return panel;
}

async function openPlan(page: Page) {
  await podinfoMap(page);
  const panel = await selectCm6(page);
  await panel.getByRole("button", {name: "Open CM-6 plan: Application UID/GID hardening", exact: true}).click();
  const drawer = page.getByTestId("plan-proposal");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function accept(drawer: ReturnType<Page["getByTestId"]>) {
  await drawer.getByRole("button", {name: "Accept proposed draft", exact: true}).click();
  await expect(drawer.getByRole("button", {name: "Accept proposed draft", exact: true})).toHaveCount(0);
  // Download is enabled only once the accepted decision is stored and nothing is saving.
  await expect(drawer.getByRole("button", {name: "Download OSCAL plan of action"})).toBeEnabled();
}

test.describe("CM-6 control panel at 1440x900", () => {
  test.use({viewport: {width: 1440, height: 900}});

  test("accordion Evidence rows remain visible without another card covering them", async ({page}) => {
    await podinfoMap(page);
    const panel = await selectCm6(page);
    const next = panel.locator('.side-card[data-side="next"] .side-card-toggle');
    const evidence = panel.locator('.side-card[data-side="evidence"] .side-card-toggle');
    await evidence.click();
    await expect(evidence).toHaveAttribute('aria-expanded', 'true');
    await expect(next).toHaveAttribute('aria-expanded', 'false');
    const rows = panel.locator('.side-card[data-side="evidence"] .pipeline-control-artifact');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (const block of ["end", "nearest", "start"] as const) {
      for (let index = 0; index < count; index++) {
        const row = rows.nth(index);
        // "end" and "nearest" are what keyboard focus and a scroll to a row below the fold do.
        await row.evaluate((node, value) => node.scrollIntoView({block: value}), block);
        const result = await row.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const owner = node.closest('[data-testid="pipeline-control-panel"]')!;
          const scroll = owner.querySelector(".panel-scroll")!.getBoundingClientRect();
          const x = rect.left + Math.min(12, rect.width / 2);
          const covered = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2].filter((y) => {
            const hit = document.elementFromPoint(x, y);
            return !hit || !node.contains(hit);
          }).length;
          return {top: rect.top, bottom: rect.bottom, height: rect.height, scrollTop: scroll.top, scrollBottom: scroll.bottom, covered};
        });
        expect(result.height).toBeGreaterThan(0);
        expect(result.covered, `Evidence row ${index + 1} (${block}) is hidden under another element`).toBe(0);
        // Subpixel scroll offsets round to CSS pixels.
        expect(result.top).toBeGreaterThanOrEqual(result.scrollTop - 0.5);
        expect(result.bottom).toBeLessThanOrEqual(result.scrollBottom + 0.5);
      }
    }
    const cards = await panel.locator('.side-card').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();return {top: box.top, bottom: box.bottom};
    }));
    expect(cards[0].bottom).toBeLessThanOrEqual(cards[1].top);
    await next.click();
    await expect(next).toHaveAttribute('aria-expanded', 'true');
    await expect(evidence).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('.control-action-rows > article')).toHaveCount(2);
  });
});

test.describe("Plan of action drawer", () => {
  test.use({viewport: {width: 1440, height: 900}});

  test("header and Status field show the same status before and after Accept", async ({page}) => {
    const drawer = await openPlan(page);
    const header = drawer.getByTestId("plan-header-status"), status = drawer.locator(".rem-drawer-body").getByTestId("plain-plan-status");
    await expect(status).toHaveText((await header.innerText()).trim());
    await accept(drawer);
    await expect(header).toContainText("Accepted · ready to close · needs a person");
    await expect(status).toContainText("Accepted · ready to close · needs a person");
    expect((await status.innerText()).trim()).toBe((await header.innerText()).trim());
    await expect(status).not.toHaveText("Closure proposed");
  });

  test("Save edits is shown only while editing an accepted plan", async ({page}) => {
    const drawer = await openPlan(page);
    const save = drawer.getByRole("button", {name: "Save edits", exact: true});
    await expect(save).toHaveCount(0);
    await accept(drawer);
    await expect(save).toHaveCount(0);
    await drawer.getByRole("button", {name: "Edit plan", exact: true}).click();
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();
    await drawer.getByRole("button", {name: "Done editing", exact: true}).click();
    await expect(drawer.getByRole("button", {name: "Edit plan", exact: true})).toBeVisible();
    await expect(save).toHaveCount(0);
  });

  test("Accept while editing leaves editing and hides Save edits", async ({page}) => {
    const drawer = await openPlan(page);
    const save = drawer.getByRole("button", {name: "Save edits", exact: true});
    await drawer.getByRole("button", {name: "Edit plan", exact: true}).click();
    await expect(drawer.getByRole("button", {name: "Done editing", exact: true})).toBeVisible();
    await accept(drawer);
    await expect(drawer.getByRole("button", {name: "Edit plan", exact: true})).toBeVisible();
    await expect(save).toHaveCount(0);
  });
});

for (const viewport of [{width: 1280, height: 800}, {width: 1440, height: 900}]) test(`Next work centers its compact chips without clipping at ${viewport.width}x${viewport.height}`, async ({page}) => {
  await page.setViewportSize(viewport);
  await podinfoMap(page);
  const work = page.getByTestId("map-next-work");
  await expect(work).toBeVisible();
  await expect(work.locator(".map-next-chip").first()).toBeVisible();
  const gap = await work.evaluate((node) => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const chips = [...node.querySelectorAll('.map-next-band > li:not([data-overflow="true"]) .map-next-chip')].map((chip) => chip.getBoundingClientRect());
    const chipsBottom = Math.max(...chips.map((chip) => chip.bottom));
    return {
      below: rect.bottom - chipsBottom,
      above: Math.min(...chips.map(chip => chip.top)) - rect.top,
      borderTop: parseFloat(style.borderTopWidth), borderBottom: parseFloat(style.borderBottomWidth),
      padding: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth),
      clipped: node.scrollHeight - node.clientHeight,
      chipsBottom, innerBottom: rect.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth),
    };
  });
  // Approved Option A centers content-sized chips in the band.
  expect(gap.below - gap.padding).toBeGreaterThanOrEqual(-0.5);
  expect(Math.abs((gap.below - gap.borderBottom) - (gap.above - gap.borderTop))).toBeLessThanOrEqual(1);
  // The smaller slot still shows the chips whole.
  expect(gap.chipsBottom).toBeLessThanOrEqual(gap.innerBottom + 0.5);
  expect(gap.clipped).toBeLessThanOrEqual(0);
  // The map follows directly after the slot's margin.
  const workBox = (await work.boundingBox())!, map = (await page.getByTestId("package-map").boundingBox())!;
  expect(map.y).toBeGreaterThanOrEqual(workBox.y + workBox.height);
});
