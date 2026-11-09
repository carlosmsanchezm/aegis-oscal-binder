import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const SHOTS = "/tmp/night-shots";

test.use({ viewport: { width: 1440, height: 900 } });

async function upload(page: Page, file: string, ready: string) {
  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles(file);
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText(ready).first()).toBeVisible();
  await page.mouse.move(2, 2);
}

function intersects(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

test("favicon.ico is served", async ({ page }) => {
  const response = await page.request.get("/favicon.ico");
  expect(response.status()).toBe(200);
  expect((await response.body()).byteLength).toBeGreaterThan(100);
});

test("wrapped upload package renders two bands and a zero-link family tooltip", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  await upload(page, "public/upload/upload-test-wrapped-ssp-rev5.json", "9 of 24 incomplete");
  await expect(page.locator("[data-family-box]")).toHaveCount(12);
  const bands = await page.locator("[data-family-box]").evaluateAll((nodes) => {
    const tops = new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
    return tops.size;
  });
  expect(bands).toBeGreaterThan(1);

  const ma = (await page.locator("[data-family-box='MA']").boundingBox())!;
  await page.mouse.move(ma.x + ma.width / 2, ma.y + 6);
  await expect(page.locator(".pmap-tip")).toHaveText("No related controls");
  await page.mouse.click(ma.x + ma.width / 2, ma.y + 6);
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-family-box='MA']")).toHaveAttribute("data-selected", "true");
  await expect(page.locator(".pmap-tip")).toHaveText("No related controls");

  await page.getByRole("button", { name: /AC-1 Policy and Procedures/ }).hover();
  await expect(page.locator(".pmap-tip")).toHaveText("No related controls");
  await page.screenshot({ path: `${SHOTS}/wrapped-map-1440.png` });
});

test("toolbar sentence stays clear of the toggles at 1440 and 1280 with the panel open", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  const gaps: Record<string, number> = {};
  for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
    await page.setViewportSize({ width, height });
    await upload(page, "public/upload/upload-test-ssp-rev5.json", "6 of 12 incomplete");
    await page.getByRole("button", { name: /AC-1 Policy and Procedures/ }).click();
    await expect(page.locator("aside.panel")).toBeVisible();
    const boxes = await page.evaluate(() => {
      const rect = (node: Element) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      return {
        claim: rect(document.querySelector("[data-testid='completeness-claim']")!),
        toggles: rect(document.querySelector(".pmap-toggles")!),
      };
    });
    expect(intersects(boxes.claim, boxes.toggles), `${width} claim overlaps toggles ${JSON.stringify(boxes)}`).toBe(false);
    gaps[`${width}`] = Math.round((boxes.toggles.left - boxes.claim.right) * 10) / 10;
    await page.screenshot({ path: `${SHOTS}/toolbar-${width}.png` });
  }
  await writeFile(`${SHOTS}/toolbar-gaps.json`, JSON.stringify(gaps, null, 2));
});

test("Level 2 Show on map stays clear of the evidence heading at 1100", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 800 });
  await upload(page, "public/upload/upload-test-ssp-rev5.json", "6 of 12 incomplete");
  await page.getByRole("button", { name: /AC-1 Policy and Procedures/ }).dblclick();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  const boxes = await page.evaluate(() => {
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      show: rect(document.querySelector(".l2-show")!),
      kicker: rect(document.querySelector("[data-testid='level2-evidence'] .l2-kicker")!),
      nodes: [...document.querySelectorAll(".l2-ev-node")].map(rect),
    };
  });
  expect(boxes.show.width).toBeGreaterThan(20);
  expect(intersects(boxes.show, boxes.kicker), JSON.stringify(boxes)).toBe(false);
  for (const node of boxes.nodes) expect(intersects(boxes.show, node), JSON.stringify({ show: boxes.show, node })).toBe(false);
  await page.screenshot({ path: `${SHOTS}/level2-1100.png` });
  await writeFile(`${SHOTS}/level2-1100.json`, JSON.stringify(boxes, null, 2));
});

test("Package B AC family hover draws one arc per other family", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  await upload(page, "fixtures/audit/package-b.json", "16 of 40 incomplete");
  const ac = (await page.locator("[data-family-box='AC']").boundingBox())!;
  await page.mouse.move(ac.x + ac.width / 2, ac.y + 6);
  await expect(page.locator("[data-family-box='AC']")).toHaveAttribute("data-hover", "true");
  const arcs = await page.locator("svg.pmap-wires path[data-rel='related']").count();
  expect(arcs).toBeGreaterThan(0);
  expect(arcs).toBeLessThan(24);
  await expect(page.locator(".pmap-count")).toHaveCount(0);
  await expect(page.locator("path[data-rel='family-bundle']")).toHaveCount(0);
  await expect(page.locator(".pmap-tip")).toContainText("related to");
  await page.screenshot({ path: `${SHOTS}/package-b-ac-hover.png` });
  await writeFile(`${SHOTS}/package-b-ac-arcs.json`, JSON.stringify({ arcs }, null, 2));
});

test("Package B role line ends stay outside evidence boxes", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  await upload(page, "fixtures/audit/package-b.json", "16 of 40 incomplete");
  const hidden = await page.evaluate(() => {
    const evidence = [...document.querySelectorAll("[data-evidence-id]")].map((node) => node.getBoundingClientRect());
    const inside = (x: number, y: number) => evidence.some((box) => x > box.left + 1 && x < box.right - 1 && y > box.top + 1 && y < box.bottom - 1);
    const bad: string[] = [];
    let ends = 0;
    for (const path of document.querySelectorAll<SVGPathElement>("svg.pmap-wires path[data-rel='role']")) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!matrix || length <= 0) continue;
      for (const at of [0, Math.min(4, length), Math.max(0, length - 4), length]) {
        const local = path.getPointAtLength(at);
        const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        ends += 1;
        if (inside(point.x, point.y)) bad.push(`${path.getAttribute("data-from")}->${path.getAttribute("data-to")} @${Math.round(at)}`);
      }
    }
    return { ends, bad };
  });
  expect(hidden.ends).toBeGreaterThan(0);
  expect(hidden.bad, hidden.bad.join("; ")).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/package-b-role-lines.png` });
  await writeFile(`${SHOTS}/package-b-role-ends.json`, JSON.stringify(hidden, null, 2));
});
