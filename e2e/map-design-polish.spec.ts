import { expect, test, type Page } from "@playwright/test";

async function reset(page: Page) {
  const response = await page.request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
}

async function loadSample(page: Page) {
  await reset(page);
  await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
}

test("sample map uses right-angled connectors, nine evidence nodes, and a failing AU-2 gate", async ({ page }) => {
  await loadSample(page);
  const map = page.getByTestId("package-map");
  await map.getByRole("button",{name:"Missing",exact:true}).click();
  for (const wires of await map.locator("svg.pmap-wires").all()) {
    await expect(wires).not.toHaveAttribute("preserveAspectRatio", "none");
  }
  await expect(map.getByRole("button", { name: /AC-2 Account Management, complete/ })).toHaveAttribute("aria-pressed", "false");
  await expect(map.locator("[data-evidence-id]")).toHaveCount(9);
  await expect(map.locator("[data-evidence-id='EV-IDP-01']")).toContainText("4 controls · 2 families");
  await expect(map.locator("[data-evidence-id='EV-IDP-01']")).toHaveAttribute("title", /4 controls · 2 families/);
  await expect(map.locator('path[data-rel="family-bundle"]')).toHaveCount(0);
  await expect(map.locator(".pmap-count")).toHaveCount(0);
  await expect(map.locator('path[data-rel="related"]')).toHaveCount(0);
  await expect(map.getByRole("button", { name: "✕ role" })).toHaveCount(1);
  await expect(map.getByRole("button", { name: "✕ evidence" })).toHaveCount(1);
  await expect(map.locator(".pmap-role,path[data-rel=role]")).toHaveCount(0);
  await expect(map.getByLabel("Owner",{exact:true})).toBeVisible();
  await expect(map.getByLabel("Owner",{exact:true}).locator("option").filter({hasText:"Identity Admin"})).toHaveCount(1);

  const paths = await map.locator("path[data-rel]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      rel: node.getAttribute("data-rel"),
      d: node.getAttribute("d") ?? "",
      width: node.getAttribute("stroke-width"),
    })),
  );
  // Roles were removed; only the two missing-field stubs are present at rest.
  expect(paths.length).toBe(2);
  expect(paths.every(path=>path.rel==="missing")).toBe(true);
  expect(paths.filter((path) => path.rel === "family-bundle")).toEqual([]);
  for (const path of paths) {
    expect(path.d).toContain(" C ");
    const width = Number(path.width);
    if (path.rel === "role" || path.rel === "evidence" || path.rel === "missing") expect(width).toBeLessThanOrEqual(1.25);
  }

  // Preserve evidence-edge coverage formerly hidden by the broad role-wire count.
  for(const id of await map.locator('[data-evidence-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-evidence-id')!))){
    const box=map.locator(`[data-evidence-id="${id}"]`);await box.hover();
    const expected=(await box.getAttribute('data-controls'))!.split(' ').filter(Boolean).sort();
    const lines=map.locator(`path[data-rel="evidence"][data-to="${id}"]`);
    await expect.poll(()=>lines.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-from')!).sort())).toEqual(expected);
    for(const line of await lines.all()) {await expect(line).toHaveAttribute('d',/ C /);expect(Number(await line.getAttribute('stroke-width'))).toBe(1.75);}
  }

  await map.getByRole("button", { name: /AC-2 Account Management, complete/ }).click();
  await expect(map.locator('path[data-rel="related"][data-glyph="mutual"]')).toHaveCount(4);
  await expect(map.locator('path[data-rel="related"][data-glyph="outbound"]')).toHaveCount(2);
  await expect(map.locator('path[data-rel="related"][data-glyph="reverse"]')).toHaveCount(1);
  await expect(map.locator("[data-halo='AC-2']")).toHaveCount(1);
  await expect(map.locator(".l1-card.linked")).toHaveCount(0);
  await expect(page.getByTestId("package-still-fails")).toContainText("AU-2");
  await expect(page.getByTestId("completeness-status")).toContainText("FAIL");
  await expect(page.getByTestId("completeness-status")).toContainText("1 of 12 incomplete");

  await map.getByRole("button", { name: /AC-2 Account Management, complete/ }).dblclick();
  const focus = page.getByTestId("level2-focus");
  await expect(focus).toBeVisible();
  await expect(focus.getByTestId("statement-j")).toHaveAttribute("aria-pressed", "false");
  await expect(focus.locator("[data-item-id]")).toHaveCount(12);
  await expect(focus.locator('path[data-rel="item-evidence"]')).toHaveCount(6);
  await expect(focus.getByTestId("subset-note")).toContainText("Subset of 12 controls");
  await expect(focus.getByTestId("package-still-fails")).toContainText("AU-2 is missing a responsible role and evidence");
  await focus.getByTestId("statement-j").click();
  await expect(focus.getByTestId("statement-j")).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "← Map Esc" }).click();
  await map.locator("[data-evidence-id='EV-IDP-01']").dblclick();
  const evidence = page.getByTestId("evidence-focus");
  await expect(evidence).toBeVisible();
  await expect(evidence.getByText("Level 2 · evidence focus")).toBeVisible();
  await expect(evidence.locator("[data-focus-row]")).toHaveCount(8);
  await expect(evidence.locator('path[data-rel="evidence-focus"]')).toHaveCount(8);
  await expect(evidence).toContainText("bytes are not embedded");
});
