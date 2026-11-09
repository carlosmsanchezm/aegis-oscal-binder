import { expect, test, type Page } from "@playwright/test";
import {settleMap,expectOwnerFilter,suppliedPackage} from './helpers/map-3b';
import { mapSettleProblems } from "../lib/map-frame-settle";

// Classic scrollbars: Playwright hides scrollbars in headless Chromium unless this flag is dropped.
test.use({
  viewport: { width: 1440, height: 900 },
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

async function load(page: Page, file = "public/samples/sample-oscal-ssp-rev5.json", ready = "1 of 12 incomplete") {
  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles(file);
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText(ready).first()).toBeVisible();
}

type Frame = { t: number; panel: boolean; stage: number | null; svg: number | null; svgH: number | null; layer: number | null; content: number | null };

/** Stage and canvas boxes on every animation frame. `t` counts from the first frame with the side panel open. */
async function sampleFrames(page: Page, ms: number): Promise<Frame[]> {
  const frames = await page.evaluate((duration) => new Promise<Frame[]>((resolve) => {
    const out: Frame[] = [];
    let opened: number | null = null;
    const start = performance.now();
    function tick() {
      const now = performance.now();
      const stage = document.querySelector<HTMLElement>(".pmap-stage") ?? document.querySelector<HTMLElement>(".l2-board");
      const svg = document.querySelector("svg.pmap-wires") ?? document.querySelector("svg.l2-wires");
      const layer = document.querySelector<HTMLElement>(".pmap-layer");
      const panel = Boolean(document.querySelector("aside.panel"));
      if (panel && opened == null) opened = now;
      const box = stage?.getBoundingClientRect();
      const gutter = stage ? stage.offsetWidth - stage.clientWidth : 0;
      out.push({
        t: opened == null ? -1 : now - opened,
        panel,
        stage: box ? Math.round(box.width * 100) / 100 : null,
        svg: svg ? Math.round(svg.getBoundingClientRect().width * 100) / 100 : null,
        svgH: svg ? Math.round(svg.getBoundingClientRect().height * 100) / 100 : null,
        layer: layer ? layer.getBoundingClientRect().width : null,
        content: box ? box.width - gutter : null,
      });
      if ((opened != null && now - opened >= duration) || now - start > duration + 3000) resolve(out);
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), ms);
  return frames.filter((frame) => frame.panel);
}

function assertSettled(frames: Frame[], label: string, durationMs = 1500) {
  expect(mapSettleProblems(frames, durationMs), `${label} layout settle`).toEqual([]);
}

/** A fractional map column, as browser zoom and OS scaling produce, where the old loop showed. */
async function fractionalColumn(page: Page) {
  await page.addStyleTag({ content: ".chrome-main-map .workspace:not(.map-only) { grid-template-columns: minmax(0, 1fr) 329.5px; }" });
}

for (const [width, height] of [[1440, 900], [1366, 768], [1280, 800]] as const) {
  test(`W1 the map settles when the panel opens with classic scrollbars at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await load(page);
    const scrollbar = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
      document.body.appendChild(probe);
      const size = probe.offsetWidth - probe.clientWidth;
      probe.remove();
      return size;
    });
    test.skip(scrollbar === 0, "This host uses overlay scrollbars; classic-scrollbar layout coverage requires a classic-scrollbar host.");
    await fractionalColumn(page);
    const map = page.getByTestId("package-map");
    const opened = sampleFrames(page, 1500);
    await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
    assertSettled(await opened, "Level 1 AC-2");
    await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
    await page.locator("aside.panel").getByRole("button", { name: "Close panel" }).click();
    await expect(page.locator("aside.panel")).toHaveCount(0);
    const levelTwo = sampleFrames(page, 1500);
    await map.getByRole("button", { name: /IA-5 Authenticator/ }).dblclick();
    assertSettled(await levelTwo, "Level 2 IA-5");
    await expect(page.getByTestId("level2-focus")).toBeVisible();
    const frames: Frame[] = [];
    await page.getByRole("button", { name: "Show on map" }).click();
    const switched = page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await switched;
    await map.getByRole("button", { name: /IA-2 Identification/ }).click();
    await expect(page.getByRole("heading", { name: /Identification and Authentication/ })).toBeVisible();
    frames.push(...await sampleFrames(page, 1500));
    assertSettled(frames, "Level 1 IA-2 after Level 2 with the panel open");
    await page.locator("aside.panel").getByRole("button", { name: "Close panel" }).click();
    await expect(page.locator("aside.panel")).toHaveCount(0);
    const fresh = sampleFrames(page, 1500);
    await map.getByRole("button", { name: /IA-2 Identification/ }).click();
    assertSettled(await fresh, "Level 1 IA-2");
  });
}

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
}

async function mapGeometry(page: Page, card: string) {
  return page.evaluate((selector) => {
    const rect = (node: Element) => { const b = node.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const svg = document.querySelector("svg.pmap-wires")!;
    const origin = svg.getBoundingClientRect();
    const ends: Array<{ x: number; y: number }> = [];
    for (const path of svg.querySelectorAll<SVGPathElement>("path[data-rel]")) {
      const nums = (path.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length < 4) continue;
      const matrix = path.getScreenCTM();
      for (const [x, y] of [[nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]]) {
        const point = matrix ? new DOMPoint(x, y).matrixTransform(matrix) : { x: origin.left + x, y: origin.top + y };
        ends.push({ x: point.x, y: point.y });
      }
    }
    const cardNode = document.querySelector(selector);
    const stage = document.querySelector(".pmap-layer")!.getBoundingClientRect();
    return {
      card: cardNode ? rect(cardNode) : null,
      caret: cardNode?.getAttribute("data-caret") ?? null,
      caretX: cardNode ? parseFloat(getComputedStyle(cardNode).getPropertyValue("--caret-x")) : null,
      controls: [...document.querySelectorAll(".pmap-control")].map(rect),
      roles: [...document.querySelectorAll(".pmap-role")].map(rect),
      evidence: [...document.querySelectorAll("[data-evidence-id]")].map((node) => ({ id: node.getAttribute("data-evidence-id"), ...rect(node) })),
      ends,
      canvas: { x: stage.left, y: stage.top, w: stage.width, h: stage.height },
    };
  }, card);
}

function assertClearCard(geometry: Awaited<ReturnType<typeof mapGeometry>>, label: string) {
  const card = geometry.card!;
  expect(card, label).not.toBeNull();
  for (const box of [...geometry.controls, ...geometry.roles, ...geometry.evidence]) {
    expect(overlaps(card, box), `${label} covers a box at ${box.x},${box.y}`).toBe(false);
  }
  for (const end of geometry.ends) {
    const inside = end.x > card.x + 0.5 && end.x < card.x + card.w - 0.5 && end.y > card.y + 0.5 && end.y < card.y + card.h - 0.5;
    expect(inside, `${label} covers a wire end at ${end.x},${end.y}`).toBe(false);
  }
  expect(card.x, `${label} left margin`).toBeGreaterThanOrEqual(geometry.canvas.x + 12 - 0.5);
  expect(card.x + card.w, `${label} right margin`).toBeLessThanOrEqual(geometry.canvas.x + geometry.canvas.w - 12 + 0.5);
}

test("W2 the evidence card sits under the evidence row, clear of every box and wire end", async ({ page }) => {
  await load(page);
  const map = page.getByTestId("package-map");
  for (const id of ["EV-IDP-01", "EV-AC2-01", "EV-SI2-01"]) {
    await map.locator(`[data-evidence-id='${id}']`).click();
    const card = page.getByTestId("evidence-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(id);
    const geometry = await mapGeometry(page, "[data-testid='evidence-card']");
    const box = geometry.evidence.find((item) => item.id === id)!;
    expect(geometry.card!.y, `${id} below its evidence row`).toBeGreaterThanOrEqual(box.y + box.h + 12 - 0.5);
    expect(geometry.caret).toBe("up");
    assertClearCard(geometry, id);
    const center = box.x + box.w / 2;
    expect(Math.abs(geometry.card!.x + geometry.caretX! - center), `${id} caret under its box`).toBeLessThan(1.5);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  }
  await map.locator("[data-evidence-id='EV-IDP-01']").click();
  await expect(page.getByTestId("evidence-card")).toBeVisible();
  const stage = await page.getByTestId("map-stage").boundingBox();
  await page.mouse.click(stage!.x + 8, stage!.y + 20);
  await expect(page.getByTestId("evidence-card")).toHaveCount(0);
  await map.locator("[data-evidence-id='EV-IDP-01']").dblclick();
  await expect(page.getByTestId("evidence-focus")).toBeVisible();
});

test("W6 Owner filtering replaces removed role cards without moving the classic map", async ({ page }) => {
  await load(page);await page.mouse.move(0,0);
  const map=page.getByTestId('package-map'),pkg=await suppliedPackage(page);
  const before=await mapBoxes(page);
  await expect(map.getByLabel('Owner',{exact:true})).toBeVisible();
  const choices=await map.getByLabel('Owner',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(node=>(node as HTMLOptionElement).value).filter(Boolean));
  expect(choices.sort()).toEqual(pkg.roles.map(role=>role.id).sort());
  for(const owner of choices){await expectOwnerFilter(page,pkg,owner);expect(await mapBoxes(page)).toEqual(before);}
  await expectOwnerFilter(page,pkg,'');expect(await mapBoxes(page)).toEqual(before);
  await map.locator("[data-evidence-id='EV-IDP-01']").click();
  const evidence=page.getByTestId('evidence-card');await expect(evidence).toBeVisible();
  const kicker=await evidence.locator('.pmap-card-kicker').evaluate(node=>{const style=getComputedStyle(node);return `${style.fontSize}|${style.fontWeight}`;});
  expect(kicker).toBe('9.5px|700');
  assertClearCard(await mapGeometry(page,"[data-testid='evidence-card']"),'evidence after Owner filtering');
  await page.keyboard.press('Escape');await expect(evidence).toHaveCount(0);
});

async function controlRects(page: Page) {
  return page.locator(".pmap-control").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return `${node.getAttribute("data-control-id")}:${box.left},${box.top},${box.width}`;
  }));
}

test("W3 Related works in both modes and keeps its state when the mode changes", async ({ page }) => {
  await load(page);
  const map = page.getByTestId("package-map");
  const related = page.getByRole("button", { name: "Related", exact: true });
  await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
  await expect(map.locator('path[data-rel="related"][data-line="solid"]')).toHaveCount(4);
  await expect(map.locator('path[data-rel="related"][data-line="dashed"]')).toHaveCount(3);
  await page.mouse.move(5, 890);
  const before = await controlRects(page);
  const dimmed = await map.locator(".pmap-control.l1-dim").count();
  expect(dimmed).toBeGreaterThan(0);
  const evidenceArrows = map.locator('path[data-rel="evidence"][marker-end]');
  const evidenceCount = await evidenceArrows.count();
  expect(evidenceCount).toBeGreaterThan(0);
  await related.click();
  await expect(related).toHaveAttribute("aria-pressed", "false");
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  // Related toggles catalog links only; existing evidence arrows must stay visible.
  await expect(map.locator('path[data-rel="related"][marker-end], path[data-rel="related"][marker-start]')).toHaveCount(0);
  await expect(evidenceArrows).toHaveCount(evidenceCount);
  expect(await controlRects(page)).toEqual(before);
  expect(await map.locator(".pmap-control.l1-dim").count()).toBe(dimmed);
  await related.click();
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
  expect(await controlRects(page)).toEqual(before);

  await related.click();
  await page.getByRole("button", { name: "By family" }).click();
  await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
  await expect(map.locator(".pmap-count")).toHaveCount(0);
  await page.getByRole("button", { name: "Selected control" }).click();
  await expect(related).toHaveAttribute("aria-pressed", "false");
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  await related.click();
  await page.getByRole("button", { name: "By family" }).click();
  await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
  await expect(map.locator(".pmap-count")).toHaveCount(0);
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
});

async function wireStyles(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => ({
    from: node.getAttribute("data-from"),
    to: node.getAttribute("data-to"),
    glyph: node.getAttribute("data-glyph"),
    opacity: Number(node.getAttribute("opacity")),
    width: Number(node.getAttribute("stroke-width")),
    dash: node.getAttribute("stroke-dasharray"),
    marker: node.getAttribute("marker-end"),
    markerStart: node.getAttribute("marker-start"),
  })));
}

test("W5 related lines follow hover like every other edge", async ({ page }) => {
  await load(page);
  const map = page.getByTestId("package-map");
  await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
  const arcs = await wireStyles(page, 'path[data-rel="related"]');
  for (const arc of arcs) {
    expect(arc.from === "AC-2" || arc.to === "AC-2").toBe(true);
    expect(arc.opacity).toBe(1);
    expect(arc.width).toBe(2.5);
    expect(arc.marker).toBe(arc.glyph === "reverse" ? null : "url(#pmap-arrow)");
    expect(arc.markerStart).toBe(arc.glyph === "reverse" || arc.glyph === "mutual" ? "url(#pmap-arrow)" : null);
    if (arc.glyph !== "mutual") expect(arc.dash).toBe("5 3");
  }
  for (const wire of await wireStyles(page, 'path[data-rel="role"]')) expect(wire.opacity).toBeCloseTo(wire.to === "AC-2" ? 0.95 : 0.08, 2);
  await page.mouse.move(5, 890);
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);

  await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await page.mouse.move(5, 890);
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(7);
  for (const arc of await wireStyles(page, 'path[data-rel="related"]')) {
    expect(arc.opacity).toBe(1);
    expect(arc.width, "related arcs at rest match mock 10b").toBe(2);
  }
  await map.getByRole("button", { name: /AU-6 Audit Record Review/ }).hover();
  for (const arc of await wireStyles(page, 'path[data-rel="related"]')) {
    const touches = arc.from === "AU-6" || arc.to === "AU-6";
    expect(arc.opacity).toBeCloseTo(touches ? 1 : 0.35, 2);
    expect(arc.width).toBe(touches ? 2.5 : 2);
  }

  await page.keyboard.press("Escape");
  await expect(page.locator("aside.panel")).toHaveCount(0);
  const pkg=await suppliedPackage(page),before=await mapBoxes(page);
  const owner=pkg.roles.find(role=>role.title==='System Owner')!;expect(owner).toBeTruthy();
  await expectOwnerFilter(page,pkg,owner.id);
  expect(await mapBoxes(page)).toEqual(before);
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  await expectOwnerFilter(page,pkg,'');expect(await mapBoxes(page)).toEqual(before);

});

test("P3 Esc clears the pin first, then the selection, and after Level 2 the next Esc deselects", async ({ page }) => {
  await load(page);
  const map = page.getByTestId("package-map");
  await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await page.getByRole("button", { name: "By family" }).click();
  const within=map.getByRole("button", { name: /^AC .* within$/ });
  await within.focus();await within.press("Enter");
  await page.mouse.move(5, 890);
  await expect(map.locator('path[data-rel="related"][data-from^="AC-"][data-to^="AC-"]')).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(map.locator('path[data-rel="related"][data-from^="AC-"][data-to^="AC-"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.panel")).toHaveCount(0);
  await expect(map.locator(".pmap-control.selected")).toHaveCount(0);

  await map.getByRole("button", { name: /AC-2 Account Management/ }).dblclick();
  await expect(page.getByTestId("level2-focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("level2-focus")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await expect(map.getByRole("button", { name: /AC-2 Account Management/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.panel")).toHaveCount(0);
});

test("P1 the header pill sits 24px from the right edge", async ({ page }) => {
  await load(page);
  const pill = await page.getByTestId("completeness-status").boundingBox();
  expect(1440 - (pill!.x + pill!.width)).toBeCloseTo(24, 0);
});

test("D3 no count badge on the map in any state", async ({ page }) => {
  for (const [file, ready] of [["public/samples/sample-oscal-ssp-rev5.json", "1 of 12 incomplete"], ["fixtures/audit/package-a.json", "5 of 8 incomplete"], ["fixtures/audit/package-b.json", "16 of 40 incomplete"]] as const) {
    await load(page, file, ready);
    const map = page.getByTestId("package-map");
    const check = async () => {
      await expect(map.locator(".pmap-count")).toHaveCount(0);
      await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
    };
    await check();
    await map.locator(".pmap-control").first().hover();
    await check();
    const box = (await map.locator("[data-family-box]").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 5);
    await expect(map.locator("[data-family-box][data-hover='true']")).toHaveCount(1);
    await check();
    await page.mouse.move(5, 890);
  }
});

test("a selected control stays selected while Owner filtering or an evidence card is active", async ({ page }) => {
  await load(page);
  const map = page.getByTestId("package-map");
  const ac2 = map.locator("[data-control-id='AC-2']");
  await ac2.click();
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  const pkg=await suppliedPackage(page),owner=pkg.roles[0].id;
  await expectOwnerFilter(page,pkg,owner);
  await expect(ac2).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('heading',{name:'Account Management'})).toBeVisible();
  await expectOwnerFilter(page,pkg,'');
  await expect(ac2).toHaveAttribute('aria-pressed','true');
  await map.getByLabel('Owner',{exact:true}).press('Tab');
  await map.locator("[data-evidence-id='EV-IDP-01']").click();
  await expect(page.getByTestId("evidence-card")).toBeVisible();
  await expect(ac2).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("evidence-card")).toHaveCount(0);
  await expect(ac2).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.panel")).toHaveCount(0);
});

test("the map fits 1440 for the sample, gold, Package A and Package B", async ({ page }) => {
  const packages: Array<[string | null, string]> = [
    ["public/samples/sample-oscal-ssp-rev5.json", "1 of 12 incomplete"],
    [null, "3 of 12 incomplete"],
    ["fixtures/audit/package-a.json", "5 of 8 incomplete"],
    ["fixtures/audit/package-b.json", "16 of 40 incomplete"],
  ];
  for (const [file, ready] of packages) {
    if (file) await load(page, file, ready);
    else {
      await page.request.post("/api/workspace/reset");
      await page.goto("/workspace?editor=classic");
      await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
      await page.getByRole("button", { name: "Load demo sample package" }).click();
      await expect(page.getByText(ready).first()).toBeVisible();
    }
    const fit = await page.getByTestId("map-stage").evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(fit.scroll, `${file ?? "gold"} spills sideways`).toBeLessThanOrEqual(fit.client);
  }
});

/** Every map box, the canvas size and the stage scroll, rounded to 0.01px. */
async function mapBoxes(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const add = (key: string, node: Element) => {
      const b = node.getBoundingClientRect();
      out[key] = [b.left, b.top, b.width, b.height].map((value) => value.toFixed(2)).join(",");
    };
    for (const selector of [".pmap-control", ".pmap-role", ".pmap-pill", ".pmap-count", ".pmap-lane-label", "[data-evidence-id]", "[data-family-box]"]) {
      document.querySelectorAll(selector).forEach((node, index) => add(`${selector}#${index}`, node));
    }
    add("layer", document.querySelector(".pmap-layer")!);
    out.scroll = `${document.querySelector(".pmap-stage")!.scrollTop},${document.querySelector(".pmap-stage")!.scrollLeft}`;
    out.wires = [...document.querySelectorAll("svg.pmap-wires path[data-rel]")].map((path) => path.getAttribute("d")).join("|");
    return out;
  });
}

for (const [file, ready, label] of [
  ["public/samples/sample-oscal-ssp-rev5.json", "1 of 12 incomplete", "sample"],
  ["fixtures/audit/package-b.json", "16 of 40 incomplete", "Package B"],
] as const) {
  test(`B5 choosing and clearing every owner moves nothing on the map (${label})`, async ({ page }) => {
    await load(page,file,ready);await page.mouse.move(0,0);
    const map=page.getByTestId('package-map'),pkg=await suppliedPackage(page);
    expect(pkg.roles.length).toBeGreaterThan(0);
    const before=await mapBoxes(page);
    for(const role of pkg.roles){
      await expectOwnerFilter(page,pkg,role.id);
      expect(await mapBoxes(page),`${role.id} filter moves a map box or route`).toEqual(before);
      await expect(map.locator('.pmap-tip')).toHaveCount(0);
      await expectOwnerFilter(page,pkg,'');
      expect(await mapBoxes(page),`${role.id} reset leaves a layout diff`).toEqual(before);
    }
  });
}

for (const [width, height] of [[1440, 900], [1366, 768], [1280, 800]] as const) {
  test(`B6 an opened evidence card shows whole inside the map at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await load(page);
    const map = page.getByTestId("package-map");
    for (const id of ["EV-AC2-01", "EV-HR-01", "EV-IDP-01", "EV-SI2-01"]) {
      await map.locator(`[data-evidence-id='${id}']`).click();
      const card = page.getByTestId("evidence-card");
      await expect(card).toBeVisible();
      await expect.poll(async () => page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>(".pmap-stage")!;
        const view = stage.getBoundingClientRect();
        const rect = document.querySelector("[data-testid='evidence-card']")!.getBoundingClientRect();
        return rect.top >= view.top - 0.5 && rect.bottom + 12 <= view.top + stage.clientHeight + 0.5
          && rect.left >= view.left - 0.5 && rect.right <= view.left + stage.clientWidth + 0.5;
      }), `${id} card inside the visible map`).toBe(true);
      const box = await map.locator(`[data-evidence-id='${id}']`).boundingBox();
      const rect = await card.boundingBox();
      expect(rect!.y, `${id} card below its row`).toBeGreaterThanOrEqual(box!.y + box!.height + 12 - 0.5);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }
  });
}

for (const [width, height] of [[1440, 900], [1366, 768], [1280, 800]] as const) {
  test(`N1 every copy of EV-B-08 opens its own card under the clicked box at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await load(page, "fixtures/audit/package-b.json", "16 of 40 incomplete");
    const map = page.getByTestId("package-map");
    const copies = map.locator("[data-evidence-id='EV-B-08']");
    const keys = await copies.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-evidence-key")!));
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(keys.length);
    const card = page.getByTestId("evidence-card");
    for (const key of keys) {
      const copy = map.locator(`[data-evidence-key='${key}']`);
      const controls = (await copy.getAttribute("data-controls"))!.split(" ");
      await copy.click();
      await expect(card).toBeVisible();
      await expect(copy).toHaveAttribute("aria-expanded", "true");
      await page.waitForTimeout(450);
      await expect(page.locator(".pmap-tip"), `${key} hover tip hidden under its own card`).toHaveCount(0);
      await expect(map.locator("[data-evidence-id][aria-expanded='true']")).toHaveCount(1);
      await expect.poll(async () => page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>(".pmap-stage")!;
        const view = stage.getBoundingClientRect();
        const rect = document.querySelector("[data-testid='evidence-card']")!.getBoundingClientRect();
        return rect.top >= view.top - 0.5 && rect.bottom <= view.top + stage.clientHeight + 0.5
          && rect.left >= view.left - 0.5 && rect.right <= view.left + stage.clientWidth + 0.5;
      }), `${key} card inside the visible map`).toBe(true);
      const box = (await copy.boundingBox())!;
      const rect = (await card.boundingBox())!;
      expect(Math.abs(rect.y - (box.y + box.height + 12)), `${key} card 12px under the clicked box`).toBeLessThanOrEqual(0.5);
      const caretX = rect.x + Number.parseFloat(await card.evaluate((node) => getComputedStyle(node).getPropertyValue("--caret-x")));
      expect(caretX, `${key} caret over the clicked box`).toBeGreaterThanOrEqual(box.x);
      expect(caretX, `${key} caret over the clicked box`).toBeLessThanOrEqual(box.x + box.width);
      const kicker = await card.locator(".pmap-card-kicker").innerText();
      const count = Number(/(\d+)\s+controls?/i.exec(kicker)?.[1]);
      const listed = await card.locator(".pmap-chip-row li").allInnerTexts();
      expect(listed.map((text) => text.trim()), `${key} lists its own controls`).toEqual(controls);
      expect(count, `${key} kicker count "${kicker}"`).toBe(listed.length);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }
  });
}

for (const [pkg, ready] of [["sample", "1 of 12 incomplete"], ["gold", "3 of 12 incomplete"]] as const) {
  for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
    test(`Owner picker replaces role cards and preserves assignments (${pkg} ${width}x${height})`, async ({ page }) => {
      await page.setViewportSize({width,height});
      if(pkg==='gold'){
        const response=await page.request.post('/api/workspace/reset');expect(response.ok()).toBeTruthy();
        await page.goto('/workspace?editor=classic');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
        await page.getByRole('button',{name:'Load demo sample package'}).click();await expect(page.getByText(ready).first()).toBeVisible();
      }else await load(page);
      await page.mouse.move(0,0);
      const map=page.getByTestId('package-map'),state=await suppliedPackage(page),before=await mapBoxes(page);
      expect(state.roles.length).toBeGreaterThan(3);
      const picker=map.getByLabel('Owner',{exact:true});await expect(picker).toBeVisible();
      const bounds=await picker.boundingBox();expect(bounds).not.toBeNull();
      const mapBounds=(await map.boundingBox())!;
      expect(bounds!.x).toBeGreaterThanOrEqual(mapBounds.x);
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(mapBounds.x+mapBounds.width);
      for(const role of state.roles){
        await expectOwnerFilter(page,state,role.id);
        expect(await mapBoxes(page)).toEqual(before);
        expect((await suppliedPackage(page)).controls).toEqual(state.controls);
        await expect(map.locator('.pmap-role,[data-testid="role-card"],.pmap-card-leader')).toHaveCount(0);
      }
      await expectOwnerFilter(page,state,'');expect(await mapBoxes(page)).toEqual(before);
    });
  }
}
