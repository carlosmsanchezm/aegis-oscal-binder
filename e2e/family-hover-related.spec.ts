import { expect, test, type Page } from "@playwright/test";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const AMBER = "#d99a00";

async function load(page: Page, pkg: "sample" | "gold") {
  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  if (pkg === "gold") {
    await page.getByRole("button", { name: "Load demo sample package" }).click();
    await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
  } else {
    await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
    await page.getByRole("button", { name: "Upload OSCAL" }).click();
    await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
  }
  await page.mouse.move(2, 2);
}

/** Every amber path on the map: family bundles, related arcs, pair arcs. */
async function amberPaths(page: Page) {
  return page.locator("svg.pmap-wires path").evaluateAll((nodes, amber) => nodes
    .filter((node) => node.getAttribute("stroke") === amber)
    .map((node) => ({
      rel: node.getAttribute("data-rel"),
      from: node.getAttribute("data-from")!,
      to: node.getAttribute("data-to")!,
      width: Number(node.getAttribute("stroke-width")),
      opacity: Number(node.getAttribute("opacity")),
    })), AMBER);
}

/** A point inside a family box that is on no control, flag, role or baseline button. */
async function familyHeaderPoint(page: Page, family: string) {
  const box = (await page.locator(`[data-family-box='${family}']`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + 5 };
}

/** Rects plus the inline opacity of everything on the map, to compare before and after a hover. */
async function mapState(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const add = (key: string, node: Element) => {
      const b = node.getBoundingClientRect();
      const style = (node as HTMLElement).style?.opacity ?? "";
      out[key] = [b.left, b.top, b.width, b.height].map((value) => value.toFixed(2)).join(",") + `|${style}|${node.getAttribute("opacity") ?? ""}|${node.getAttribute("stroke") ?? ""}`;
    };
    for (const selector of [".pmap-control", ".pmap-role", ".pmap-pill", ".pmap-lane-label", "[data-evidence-id]", "[data-family-box]", "svg.pmap-wires path[data-rel]"]) {
      document.querySelectorAll(selector).forEach((node, index) => add(`${selector}#${index}`, node));
    }
    add("layer", document.querySelector(".pmap-layer")!);
    return out;
  });
}

async function familyFacts(page: Page, family: string) {
  return page.evaluate((family) => {
    const members = new Set([...document.querySelectorAll(`.pmap-control[data-family='${family}']`)].map((node) => node.getAttribute("data-control-id")!));
    const opacity = (node: Element) => Number((node as HTMLElement).style.opacity || "1");
    const fade = (node: Element) => {
      const style = getComputedStyle(node);
      const names = style.transitionProperty.split(",").map((item) => item.trim());
      const times = style.transitionDuration.split(",").map((item) => item.trim());
      return times[names.indexOf("opacity")] ?? "none";
    };
    const controls = [...document.querySelectorAll(".pmap-control")].map((node) => ({ id: node.getAttribute("data-control-id")!, inFamily: members.has(node.getAttribute("data-control-id")!), opacity: opacity(node) }));
    const evidence = [...document.querySelectorAll("[data-evidence-id]")].map((node) => ({
      id: node.getAttribute("data-evidence-id")!,
      linked: node.getAttribute("data-controls")!.split(" ").some((id) => members.has(id)),
      opacity: opacity(node),
    }));
    const roleWires = [...document.querySelectorAll("svg.pmap-wires path[data-rel='role']")].map((node) => ({ to: node.getAttribute("data-to")!, opacity: Number(node.getAttribute("opacity")) }));
    const boxes = [...document.querySelectorAll("[data-family-box]")].map((node) => ({
      id: node.getAttribute("data-family-box")!,
      hover: node.getAttribute("data-hover"),
      stroke: node.getAttribute("stroke"),
      opacity: Number(getComputedStyle(node).opacity),
      transition: fade(node),
    }));
    const controlTransition = fade(document.querySelector(".pmap-control")!);
    return { members: [...members], controls, evidence, roleWires, boxes, controlTransition };
  }, family);
}

async function assertFamilyLit(page: Page, family: string) {
  await expect(page.locator(`[data-family-box='${family}']`)).toHaveAttribute("data-hover", "true");
  const facts = await familyFacts(page, family);
  expect(facts.members.length).toBeGreaterThan(0);
  for (const box of facts.boxes) {
    expect(box.hover, `${box.id} hover flag`).toBe(box.id === family ? "true" : null);
    expect(box.opacity, `${box.id} box stays at full opacity`).toBeCloseTo(1, 2);
    expect(box.transition, "family boxes fade at the control pace").toBe(facts.controlTransition);
  }
  expect(facts.boxes.find((box) => box.id === family)!.stroke).toBe("#1a1733");
  const arcs = await amberPaths(page);
  for (const control of facts.controls) {
    const related = arcs.some((arc) => arc.from === control.id || arc.to === control.id);
    expect(control.opacity, `${control.id}`).toBeCloseTo(control.inFamily || related ? 1 : 0.5, 2);
  }
  for (const item of facts.evidence) expect(item.opacity, `${item.id}`).toBeCloseTo(item.linked ? 1 : 0.35, 2);
  for (const wire of facts.roleWires) expect(wire.opacity, `role wire to ${wire.to}`).toBeCloseTo(facts.members.includes(wire.to) ? 0.95 : 0.08, 2);
  const related = await amberPaths(page);
  const touching = related.filter((arc) => facts.members.includes(arc.from) || facts.members.includes(arc.to));
  expect(touching.length, `${family} draws its related lines`).toBeGreaterThan(0);
  for (const arc of related) {
    expect(arc.rel).toBe("related");
    expect(arc.width).toBe(2);
    expect(arc.opacity, `${arc.from}->${arc.to}`).toBeCloseTo(touching.includes(arc) ? 1 : 0.35, 2);
  }
  await expect(page.locator(".pmap-count")).toHaveCount(0);
}

/** Control hover dims like family hover: unlinked control cards drop to 0.5, evidence to 0.35; family boxes stay at 1. */
async function assertControlLit(page: Page, controlId: string) {
  const facts = await page.evaluate((id) => {
    const control = document.querySelector(`.pmap-control[data-control-id='${id}']`)!;
    const family = control.getAttribute("data-family");
    const opacity = (node: Element) => Number((node as HTMLElement).style.opacity || "1");
    return {
      family,
      controls: [...document.querySelectorAll(".pmap-control")].map((node) => ({ id: node.getAttribute("data-control-id")!, opacity: opacity(node) })),
      evidence: [...document.querySelectorAll("[data-evidence-id]")].map((node) => ({
        id: node.getAttribute("data-evidence-id")!,
        linked: node.getAttribute("data-controls")!.split(" ").includes(id),
        opacity: opacity(node),
      })),
      boxes: [...document.querySelectorAll("[data-family-box]")].map((node) => ({ id: node.getAttribute("data-family-box")!, opacity: Number(getComputedStyle(node).opacity) })),
      roleWires: [...document.querySelectorAll("svg.pmap-wires path[data-rel='role']")].map((node) => ({ to: node.getAttribute("data-to")!, opacity: Number(node.getAttribute("opacity")) })),
    };
  }, controlId);
  const arcs = await amberPaths(page);
  for (const control of facts.controls) {
    const related = control.id === controlId || arcs.some((arc) => arc.from === control.id || arc.to === control.id);
    expect(control.opacity, control.id).toBeCloseTo(related ? 1 : 0.5, 2);
  }
  for (const item of facts.evidence) expect(item.opacity, item.id).toBeCloseTo(item.linked ? 1 : 0.35, 2);
  for (const box of facts.boxes) expect(box.opacity, `${box.id} box`).toBeCloseTo(1, 2);
  for (const wire of facts.roleWires) expect(wire.opacity, `role wire to ${wire.to}`).toBeCloseTo(wire.to === controlId ? 0.95 : 0.08, 2);
  await expect(page.locator("[data-family-box][data-hover]")).toHaveCount(0);
  expect(arcs.length).toBeGreaterThan(0);
  for (const arc of arcs) expect(arc.from === controlId || arc.to === controlId, `${arc.from}->${arc.to}`).toBe(true);
}

for (const pkg of ["sample", "gold"] as const) {
  for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
    test.describe(`${pkg} ${width}x${height}`, () => {
      test.use({ viewport: { width, height } });

      test("Related at rest draws no amber line and no count chip", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        await expect(page.getByRole("button", { name: "Related", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: "By family" })).toHaveAttribute("aria-pressed", "true");
        expect(await amberPaths(page)).toEqual([]);
        await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
        await expect(map.locator(".pmap-count")).toHaveCount(0);
        await expect(page.locator(".pmap-legend")).not.toContainText("(count)");
        await expect(page.locator(".pmap-legend .pmap-mini")).toHaveCount(0);
        await page.getByRole("button", { name: "Selected control" }).click();
        expect(await amberPaths(page)).toEqual([]);
        await expect(map.locator(".pmap-count")).toHaveCount(0);
      });

      test("related lines appear only for the hovered control or family", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
        await expect.poll(async () => (await amberPaths(page)).length).toBeGreaterThan(0);
        for (const arc of await amberPaths(page)) {
          expect(arc.from === "AC-2" || arc.to === "AC-2", `${arc.from}->${arc.to}`).toBe(true);
          expect(arc.width).toBe(2.5);
        }
        await expect(map.locator(".pmap-count")).toHaveCount(0);
        await page.mouse.move(2, 2);
        await expect.poll(async () => (await amberPaths(page)).length).toBe(0);

        const point = await familyHeaderPoint(page, "AC");
        await page.mouse.move(point.x, point.y);
        await expect(page.locator("[data-family-box='AC']")).toHaveAttribute("data-hover", "true");
        const arcs = await amberPaths(page);
        expect(arcs.length).toBe(16);
        await expect(page.locator(".pmap-tip")).toHaveText("AC: related to 4 families, 16 links (3 within AC)");
        await page.mouse.move(2, 2);
        await expect.poll(async () => (await amberPaths(page)).length).toBe(0);
        await expect(page.locator(".pmap-tip")).toHaveCount(0);
      });

      test("family hover lights the family, dims the rest, hands over to a control and restores with a 0px diff", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        const before = await mapState(page);
        const point = await familyHeaderPoint(page, "AC");
        await page.mouse.move(point.x, point.y);
        await assertFamilyLit(page, "AC");

        const box = (await page.locator("[data-family-box='AC']").boundingBox())!;
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
        await assertFamilyLit(page, "AC");

        await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
        await expect(page.locator("[data-family-box='AC']")).not.toHaveAttribute("data-hover", "true");
        await expect(page.locator("[data-family-box][data-hover]")).toHaveCount(0);
        for (const arc of await amberPaths(page)) expect(arc.from === "AC-2" || arc.to === "AC-2").toBe(true);
        await assertControlLit(page, "AC-2");

        await page.mouse.move(point.x, point.y);
        await assertFamilyLit(page, "AC");
        await page.mouse.move(2, 2);
        await expect(page.locator("[data-family-box][data-hover]")).toHaveCount(0);
        await expect.poll(async () => JSON.stringify(await mapState(page))).toBe(JSON.stringify(before));
      });

      test("family hover previews in Selected control mode without clearing the selection", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        await page.getByRole("button", { name: "Selected control" }).click();
        const idle = await familyHeaderPoint(page, "AU");
        await page.mouse.move(idle.x, idle.y);
        await assertFamilyLit(page, "AU");
        await page.mouse.move(2, 2);

        await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
        await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
        await page.mouse.move(2, 2);
        const selectedArcs = (await amberPaths(page)).length;
        expect(selectedArcs).toBeGreaterThan(0);
        const before = await mapState(page);
        const point = await familyHeaderPoint(page, "AU");
        await page.mouse.move(point.x, point.y);
        await assertFamilyLit(page, "AU");
        await expect(map.getByRole("button", { name: /AC-2 Account Management/ })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
        await page.mouse.move(2, 2);
        await expect.poll(async () => JSON.stringify(await mapState(page))).toBe(JSON.stringify(before));
        await expect(map.getByRole("button", { name: /AC-2 Account Management/ })).toHaveAttribute("aria-pressed", "true");
        expect((await amberPaths(page)).length).toBe(selectedArcs);
      });

      test("control hover dims the rest like family hover and shows its related counts", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        const before = await mapState(page);
        await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
        await assertControlLit(page, "AC-2");
        const arcs = await amberPaths(page);
        expect(arcs.length).toBe(7);
        for (const arc of arcs) expect(arc.width).toBe(2.5);
        await expect(page.locator(".pmap-tip")).toHaveText("AC-2: related to 7 controls in 4 families");
        await page.mouse.move(2, 2);
        await expect(page.locator(".pmap-tip")).toHaveCount(0);
        await expect.poll(async () => JSON.stringify(await mapState(page))).toBe(JSON.stringify(before));
      });

      test("clicking a family selects it until empty canvas, Esc or a control clears it", async ({ page }) => {
        await load(page, pkg);
        const map = page.getByTestId("package-map");
        const before = await mapState(page);
        const stage = (await page.getByTestId("map-stage").boundingBox())!;
        const point = await familyHeaderPoint(page, "AC");

        await page.mouse.click(point.x, point.y);
        await page.mouse.move(2, 2);
        await expect(page.locator("[data-family-box='AC']")).toHaveAttribute("data-selected", "true");
        await assertFamilyLit(page, "AC");
        await expect(page.locator(".pmap-tip")).toHaveCount(0);
        await expect(page.locator("aside.panel")).toHaveCount(0);

        await map.getByRole("button", { name: /AC-2 Account Management/ }).hover();
        await assertControlLit(page, "AC-2");
        await page.mouse.move(2, 2);
        await assertFamilyLit(page, "AC");

        const other = await familyHeaderPoint(page, "AU");
        await page.mouse.move(other.x, other.y);
        await assertFamilyLit(page, "AU");
        await page.mouse.move(2, 2);
        await assertFamilyLit(page, "AC");

        await page.mouse.click(stage.x + 8, stage.y + 20);
        await expect(page.locator("[data-family-box][data-selected]")).toHaveCount(0);
        await page.mouse.move(2, 2);
        await expect.poll(async () => JSON.stringify(await mapState(page))).toBe(JSON.stringify(before));

        await page.mouse.click(point.x, point.y);
        await expect(page.locator("[data-family-box='AC']")).toHaveAttribute("data-selected", "true");
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-family-box][data-selected]")).toHaveCount(0);
        await page.mouse.move(2, 2);
        await expect.poll(async () => JSON.stringify(await mapState(page))).toBe(JSON.stringify(before));

        await page.mouse.click(point.x, point.y);
        await expect(page.locator("[data-family-box='AC']")).toHaveAttribute("data-selected", "true");
        await map.getByRole("button", { name: /AC-2 Account Management/ }).click();
        await expect(page.getByRole("heading", { name: "Account Management" })).toBeVisible();
        await expect(page.locator("[data-family-box][data-selected]")).toHaveCount(0);
        await page.mouse.move(2, 2);
        await expect(page.locator("[data-family-box][data-hover]")).toHaveCount(0);
        const selected = await amberPaths(page);
        expect(selected.length).toBe(7);
        for (const arc of selected) expect(arc.width).toBe(2);
      });
    });
  }
}
