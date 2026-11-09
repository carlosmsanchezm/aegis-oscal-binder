import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

async function reset(page: Page) {
  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
}

async function assertEvidenceRow(page: Page) {
  const boxes = await page.locator("[data-evidence-id]").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    const overflow = [...node.querySelectorAll(".eid, strong, em")]
      .filter((part) => part.scrollWidth > part.clientWidth || part.scrollHeight > part.clientHeight)
      .map((part) => (part.textContent ?? "").trim());
    return { id: node.getAttribute("data-evidence-id"), x: box.left, y: box.top, w: box.width, h: box.height, overflow };
  }));
  expect(boxes.length).toBeGreaterThan(1);
  for (const box of boxes) {
    const row = (box.y - Math.min(...boxes.map((item) => item.y))) / 56;
    expect(Math.abs(row - Math.round(row)), `${box.id} sits on an evidence row`).toBeLessThanOrEqual(0.01);
    expect(box.h, `${box.id} height`).toBeLessThanOrEqual(48);
    expect(box.overflow, `${box.id} text overflow`).toEqual([]);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
      expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

/** Every family box keeps 12px between its border and its header and controls, 8px between boxes. */
async function assertTightFamilyBoxes(page: Page) {
  const boxes = await page.locator("[data-family-box]").evaluateAll((rects) => rects.map((rect) => {
    const id = rect.getAttribute("data-family-box") ?? "";
    const box = rect.getBoundingClientRect();
    const outer = { left: box.left - 0.5, top: box.top - 0.5, right: box.right + 0.5, bottom: box.bottom + 0.5 };
    const header = document.querySelector(`[data-family-header="${id}"]`)!.getBoundingClientRect();
    const clipped = [...document.querySelectorAll(`[data-family-header="${id}"] > *`)].filter((line) => line.scrollWidth > line.clientWidth).length;
    const controls = [...document.querySelectorAll(".pmap-control")].map((node) => node.getBoundingClientRect())
      .filter((control) => control.left >= outer.left && control.right <= outer.right && control.top >= outer.top && control.bottom <= outer.bottom);
    return {
      id,
      left: Math.min(header.left, ...controls.map((control) => control.left)) - outer.left,
      right: outer.right - Math.max(header.right, ...controls.map((control) => control.right)),
      top: header.top - outer.top,
      gap: Math.min(...controls.map((control) => control.top)) - header.bottom,
      bottom: outer.bottom - Math.max(...controls.map((control) => control.bottom)),
      controls: controls.length,
      clipped,
      x: outer.left,
      end: outer.right,
      height: outer.bottom - outer.top,
    };
  }));
  expect(boxes.length).toBeGreaterThan(1);
  boxes.forEach((box, index) => {
    expect(box.controls, `${box.id} controls`).toBeGreaterThan(0);
    for (const side of ["left", "right", "top", "gap", "bottom"] as const) expect(Math.abs(box[side] - 12), `${box.id} ${side} ${box[side]}`).toBeLessThanOrEqual(1);
    expect(box.clipped, `${box.id} header clipped`).toBe(0);
    expect(Math.abs(box.height - boxes[0].height), `${box.id} height`).toBeLessThanOrEqual(0.5);
    if (index > 0) expect(Math.abs(box.x - boxes[index - 1].end - 8), `${box.id} gap`).toBeLessThanOrEqual(1);
  });
}

async function assertSaveAboveDisclaimer(page: Page) {
  const save = page.locator("aside.panel .savebar button", { hasText: "Save" });
  await expect(save).toBeVisible();
  const placement = await save.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const bar = document.querySelector(".chrome-footer")?.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 2);
    return {
      top: box.top,
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      barTop: bar?.top ?? null,
      onTop: hit === button || button.contains(hit),
    };
  });
  expect(placement.barTop).not.toBeNull();
  expect(placement.top).toBeGreaterThanOrEqual(0);
  expect(placement.left).toBeGreaterThanOrEqual(0);
  expect(placement.right).toBeLessThanOrEqual(placement.viewW);
  expect(placement.bottom).toBeLessThanOrEqual(placement.viewH);
  expect(placement.bottom).toBeLessThanOrEqual(placement.barTop!);
  expect(placement.onTop).toBe(true);
}

async function assertOnePanelScroller(page: Page) {
  const scrollers = await page.locator("aside.panel").evaluate((panel) => [panel, ...panel.querySelectorAll("*")]
    .filter((node) => {
      const overflowY = getComputedStyle(node).overflowY;
      return (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1;
    })
    .map((node) => node.className));
  expect(scrollers.length).toBeLessThanOrEqual(1);
  if (scrollers.length === 1) expect(scrollers[0]).toBe("panel-body");
}

async function assertBaselineSummaryVisible(page: Page) {
  const summary = page.locator("[data-testid='baseline-section'] .baseline-row .hint");
  await expect(summary).toContainText("constraints");
  const clipped = await summary.evaluate((el) => {
    const box = el.getBoundingClientRect();
    if (box.height < 1 || box.width < 1) return "empty";
    if (box.top < -0.5 || box.bottom > window.innerHeight + 0.5) return "offscreen";
    let node = el.parentElement;
    while (node) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden") {
        const frame = node.getBoundingClientRect();
        if (box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5) return `clipped:${node.className}`;
      }
      node = node.parentElement;
    }
    return "";
  });
  expect(clipped).toBe("");
}

async function assertLineageInsidePanel(page: Page) {
  const panel = page.locator("aside.panel");
  await expect(panel.locator(".lineage")).toContainText(/artifacts open|draft export/);
  const overflow = await panel.evaluate((node) => {
    const right = node.getBoundingClientRect().right;
    return [...node.querySelectorAll(".lineage .lin, .lineage .kicker, .lineage .lin-sep")]
      .map((chip) => ({
        text: (chip.textContent ?? "").trim(),
        delta: chip.getBoundingClientRect().right - right,
      }))
      .filter((chip) => chip.delta > 0.5);
  });
  expect(overflow).toEqual([]);
}

test("retest package keeps evidence kickers clear and lineage chips inside the panel", async ({ page }) => {
  await reset(page);
  await page.getByLabel("OSCAL package").setInputFiles("fixtures/audit/package-retest.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("8 of 8 complete").first()).toBeVisible();
  await assertEvidenceRow(page);
  await assertTightFamilyBoxes(page);

  const map = page.getByTestId("package-map");
  for (const name of [/CP-2 Contingency Plan, complete/, /AC-17 Remote Access, complete/, /SC-13 Cryptographic Protection, complete/]) {
    await map.getByRole("button", { name }).click();
    await expect(page.locator("aside.panel h2")).toBeVisible();
    await assertLineageInsidePanel(page);
  }
  await assertEvidenceRow(page);

  await map.getByRole("button", { name: /CP-2 Contingency Plan, complete/ }).dblclick();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  await assertLineageInsidePanel(page);

  await page.getByRole("button", { name: "← Map Esc" }).click();
  await map.getByRole("button", { name: /AC-17 Remote Access, complete/ }).dblclick();
  const evidence = page.getByTestId("level2-evidence");
  await expect(evidence.locator(".l2-kicker")).toContainText(/not mapped to items/i);
  const covered = await evidence.evaluate((node) => {
    const kicker = node.querySelector(".l2-kicker");
    if (!kicker) return ["missing kicker"];
    const kickerBox = kicker.getBoundingClientRect();
    return [...node.querySelectorAll(".l2-ev-node, li")]
      .filter((card) => {
        const box = card.getBoundingClientRect();
        const overlapX = Math.min(kickerBox.right, box.right) - Math.max(kickerBox.left, box.left);
        const overlapY = Math.min(kickerBox.bottom, box.bottom) - Math.max(kickerBox.top, box.top);
        return overlapX > 1 && overlapY > 1;
      })
      .map((card) => (card.textContent ?? "").trim());
  });
  expect(covered).toEqual([]);
});

test("sample evidence stays on its rows and the AC-2 baseline summary is fully visible", async ({ page }) => {
  await reset(page);
  await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  await assertEvidenceRow(page);

  const map = page.getByTestId("package-map");
  await map.getByRole("button", { name: /AC-2 Account Management, complete/ }).click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await expect(map.locator(".pmap-control.selected")).toBeVisible();
  await assertEvidenceRow(page);
  await assertTightFamilyBoxes(page);
  await assertBaselineSummaryVisible(page);
  // A compact one-line lineage is also valid. Test fit, not a historical wrap count.
  await assertLineageInsidePanel(page);
  await assertSaveAboveDisclaimer(page);
  await assertOnePanelScroller(page);
});
