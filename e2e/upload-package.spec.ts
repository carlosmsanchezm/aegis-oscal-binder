import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { XMLParser } from "fast-xml-parser";
import {
  FIXED_SEEDS,
  SAMPLE_CONTROL_IDS,
  SAMPLE_ROLE_IDS,
  UPLOAD_DOWNLOAD_PATH,
  UPLOAD_FIXTURE,
  annotateSeed,
  describePackage,
  generatePackage,
  packageText,
  relatedPeers,
  stableRunSeed,
  type PackageFacts,
} from "../tests/fixtures/randomPackage.ts";

// Measure exact map geometry with native scrollbars, as map-interactions does.
// Keep reserved-gutter geometry independent of headless scrollbar suppression.
// The exact before/after position assertions remain unchanged.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const RANDOM_SEED = stableRunSeed();
const FIXTURE_PATH = path.join(process.cwd(), UPLOAD_FIXTURE);

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/workspace/reset");
  expect(response.ok()).toBeTruthy();
});

function ignoreConsole(text: string): boolean {
  return /favicon\.ico/i.test(text)
    || /Download the React DevTools/i.test(text)
    || /\[Fast Refresh\]/i.test(text)
    || /webpack-hmr/i.test(text);
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ignoreConsole(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}

async function boxPositions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const layer = document.querySelector(".pmap-layer");
    if (!layer) return [];
    const origin = layer.getBoundingClientRect();
    const nodes = [
      ...document.querySelectorAll("[data-family-box]"),
      ...document.querySelectorAll("[data-control-id]"),
    ];
    return nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const id = node.getAttribute("data-family-box") || node.getAttribute("data-control-id") || "";
      const round = (value: number) => Math.round(value * 100) / 100;
      return `${id}@${round(box.left - origin.left)},${round(box.top - origin.top)},${round(box.width)},${round(box.height)}`;
    });
  });
}

async function upload(page: Page, facts: PackageFacts, file: string | { name: string; mimeType: string; buffer: Buffer }, label: string) {
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await expect(page.getByRole("button", { name: "Stage sample SSP" })).toBeVisible();
  await page.getByLabel("OSCAL package").setInputFiles(file);
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  const loaded = page.getByText(facts.systemName).first();
  const rejected = page.locator(".banner.fail");
  await expect(loaded.or(rejected)).toBeVisible();
  if (await rejected.count()) {
    throw new Error(`seed ${label} upload rejected: ${await rejected.innerText()}`);
  }
  await expect(page.getByRole("status").filter({ hasText: "sample-oscal-ssp-rev5.json" })).toHaveCount(0);
  await expect(page.getByText(facts.gateLabel).first()).toBeVisible();
}

async function assertMap(page: Page, facts: PackageFacts) {
  const map = page.getByTestId("package-map");
  await expect(map.getByText(`Controls · ${facts.controls.length} in scope`)).toBeVisible();
  const families = await page.locator("[data-family-box]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-family-box")));
  expect(families.sort()).toEqual([...facts.families].sort());
  const controlIds = await page.locator("[data-control-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-control-id")));
  expect(controlIds.sort()).toEqual(facts.controls.map((control) => control.id).sort());
  await expect(page.locator(".pmap-role")).toHaveCount(facts.roles.length);
  for (const role of facts.roles) {
    const chip = page.locator(`.pmap-role[data-role-id="${role.id}"]`);
    await expect(chip).toHaveCount(1);
    await expect(chip.locator("strong")).toHaveText(role.label);
    await expect(chip).toHaveAttribute("title", role.title);
  }
  await expect(page.locator(".pmap-evidence")).toHaveCount(facts.evidence.length);
  for (const item of facts.evidence) {
    const card = page.locator(`.pmap-evidence[data-evidence-id="${item.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.locator("strong")).toHaveText(item.title);
    await expect(card).toHaveAttribute("data-controls", item.controlIds.join(" "));
  }
  const bundles = await page.locator('svg.pmap-wires path[data-rel="family-bundle"]').evaluateAll((nodes) => (
    nodes.map((node) => [node.getAttribute("data-from"), node.getAttribute("data-to")])
  ));
  for (const [from, to] of bundles) {
    expect(facts.families, `family bundle ${from} → ${to}`).toContain(from);
    expect(facts.families, `family bundle ${from} → ${to}`).toContain(to);
  }
}

/** Rendered binder markup. Next's flight payload is not part of the map. */
async function renderedHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector(".app");
    if (!root) return "";
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, nextjs-portal, next-route-announcer").forEach((node) => node.remove());
    return clone.innerHTML;
  });
}

async function assertNoSampleLeak(page: Page, facts: PackageFacts) {
  const html = await renderedHtml(page);
  const roles = new Set(facts.roles.map((role) => role.id.toLowerCase()));
  const controls = new Set(facts.controls.map((control) => control.id.toLowerCase()));
  for (const id of SAMPLE_ROLE_IDS) {
    if (roles.has(id)) continue;
    expect(html, `sample role id ${id}`).not.toMatch(new RegExp(`\\b${id}\\b`, "i"));
  }
  for (const id of SAMPLE_CONTROL_IDS) {
    if (controls.has(id.toLowerCase())) continue;
    expect(html, `sample control id ${id}`).not.toMatch(new RegExp(`\\b${id}\\b`, "i"));
  }
}

async function assertCardsStayPut(page: Page, facts: PackageFacts) {
  const before = await boxPositions(page);
  expect(before.length).toBe(facts.families.length + facts.controls.length);
  await page.locator(".pmap-role").first().click();
  await expect(page.getByTestId("role-card")).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  }));
  expect(await boxPositions(page), "opening a role card").toEqual(before);
  await page.getByTestId("role-card").getByRole("button", { name: "Close panel" }).click();
  await expect(page.getByTestId("role-card")).toHaveCount(0);

  if (facts.evidence.length === 0) {
    await expect(page.locator(".pmap-evidence")).toHaveCount(0);
    expect(await boxPositions(page), "no evidence card to open").toEqual(before);
    return;
  }
  const settled = await boxPositions(page);
  await page.locator(".pmap-evidence").first().click();
  await expect(page.getByTestId("evidence-card")).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  }));
  expect(await boxPositions(page), "opening an evidence card").toEqual(settled);
  await page.getByTestId("evidence-card").getByRole("button", { name: "Close panel" }).click();
  await expect(page.getByTestId("evidence-card")).toHaveCount(0);
}

async function editSaveExport(page: Page, facts: PackageFacts, label: string) {
  const control = facts.controls[0];
  if (!control) throw new Error(`seed ${label} has no controls`);
  await page.locator(`[data-control-id="${control.id}"]`).click();
  await expect(page.locator("aside.panel .panel-id")).toHaveText(control.id);
  const peers = await page.locator('svg.pmap-wires path[data-rel="related"]').evaluateAll((nodes) => (
    nodes.map((node) => ({ from: node.getAttribute("data-from"), to: node.getAttribute("data-to") }))
  ));
  const packageIds = new Set(facts.controls.map((item) => item.id));
  for (const peer of peers) {
    expect(packageIds, `related ${peer.from} → ${peer.to}`).toContain(peer.from);
    expect(packageIds, `related ${peer.from} → ${peer.to}`).toContain(peer.to);
  }
  const shown = peers.map((peer) => (peer.from === control.id ? peer.to : peer.from)).filter((id): id is string => Boolean(id));
  expect([...new Set(shown)].sort()).toEqual(relatedPeers(facts, control.id).sort());

  const marker = `Harbor edit ${label}.`;
  const area = page.locator("aside.panel textarea");
  await expect(area).toBeVisible();
  const current = await area.inputValue();
  const next = `${current}${current ? " " : ""}${marker}`.trim();
  await area.fill(next);
  const saveResponse = page.waitForResponse((response) => (
    response.url().includes(`/api/controls/${encodeURIComponent(control.id)}/save`) && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await saveResponse;
  expect(saved.status(), `seed ${label} save`).toBe(200);
  await page.reload();
  await expect(page.getByText(facts.systemName).first()).toBeVisible();
  await expect(page.getByText(facts.gateLabel).first()).toBeVisible();
  await page.locator(`[data-control-id="${control.id}"]`).click();
  await expect(page.locator("aside.panel textarea")).toHaveValue(next);

  await page.getByRole("button", { name: "Export flow" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export OSCAL" }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const xml = readFileSync(filePath!, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => name === "role" || name === "implemented-requirement",
  });
  const doc = parser.parse(xml) as {
    "system-security-plan"?: {
      metadata?: { roles?: { role?: Array<{ "@_id"?: string }> } };
      "control-implementation"?: { "implemented-requirement"?: unknown[] };
    };
  };
  const ssp = doc["system-security-plan"];
  expect(ssp, "export XML has a system-security-plan").toBeTruthy();
  const requirements = ssp?.["control-implementation"]?.["implemented-requirement"] ?? [];
  expect(requirements).toHaveLength(facts.controls.length);
  const exportedIds = [...xml.matchAll(/<implemented-requirement control-id="([^"]+)"/g)].map((match) => match[1]!.toUpperCase());
  expect(exportedIds.sort()).toEqual(facts.controls.map((item) => item.id).sort());
  const roleIds = (ssp?.metadata?.roles?.role ?? []).map((role) => role["@_id"]);
  expect(roleIds).toEqual(facts.roles.map((role) => role.id));
  expect(xml).toContain(marker);
  for (const id of SAMPLE_ROLE_IDS) {
    if (facts.roles.some((role) => role.id === id)) continue;
    expect(xml).not.toContain(`id="${id}"`);
    expect(xml).not.toContain(`role-id="${id}"`);
  }
}

async function exercise(page: Page, facts: PackageFacts, file: string | { name: string; mimeType: string; buffer: Buffer }, label: string) {
  const errors = watchConsole(page);
  try {
    await upload(page, facts, file, label);
    await assertMap(page, facts);
    await assertNoSampleLeak(page, facts);
    await assertCardsStayPut(page, facts);
    await editSaveExport(page, facts, label);
    await assertNoSampleLeak(page, facts);
    expect(errors, `seed ${label} console errors\n${errors.join("\n")}`).toEqual([]);
  } catch (error) {
    throw annotateSeed(label, error);
  }
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const) {
  test.describe(`uploaded packages at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("upload test package", async ({ page }) => {
      const text = readFileSync(FIXTURE_PATH, "utf8");
      const served = await page.request.get(UPLOAD_DOWNLOAD_PATH);
      expect(served.ok()).toBeTruthy();
      expect(await served.text()).toBe(text);
      const facts = describePackage(JSON.parse(text));
      await exercise(page, facts, FIXTURE_PATH, "upload-test");
    });

    for (const seed of FIXED_SEEDS) {
      test(`generated package seed ${seed}`, async ({ page }) => {
        const generated = generatePackage(seed);
        const facts = describePackage(generated.document);
        await exercise(page, facts, {
          name: `generated-ssp-${seed}.json`,
          mimeType: "application/json",
          buffer: Buffer.from(packageText(generated.document)),
        }, String(seed));
      });
    }

    test(`generated package random seed ${RANDOM_SEED}`, async ({ page }) => {
      console.log(`upload package random seed ${RANDOM_SEED}`);
      const generated = generatePackage(RANDOM_SEED);
      const facts = describePackage(generated.document);
      await exercise(page, facts, {
        name: `generated-ssp-${RANDOM_SEED}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(packageText(generated.document)),
      }, String(RANDOM_SEED));
    });
  });
}

async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  }));
}

function familyRows(positions: string[]): number {
  return new Set(positions
    .map((line) => line.split("@"))
    .filter((parts) => parts[0] && !parts[0].includes("-"))
    .map((parts) => Number(parts[1]?.split(",")[1]))).size;
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const) {
  test.describe(`wrapped maps at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const seed of [48, 64, RANDOM_SEED]) {
      test(`opening an evidence card moves 0 boxes on a wrapped map (seed ${seed})`, async ({ page }) => {
        const generated = generatePackage(seed);
        const facts = describePackage(generated.document);
        await upload(page, facts, {
          name: `generated-ssp-${seed}.json`,
          mimeType: "application/json",
          buffer: Buffer.from(packageText(generated.document)),
        }, String(seed));
        const before = await boxPositions(page);
        if (seed !== RANDOM_SEED) expect(familyRows(before), `seed ${seed} wraps onto a second row`).toBeGreaterThan(1);
        const evidence = page.locator(".pmap-evidence");
        const count = await evidence.count();
        for (let index = 0; index < count; index += 1) {
          const id = await evidence.nth(index).getAttribute("data-evidence-id");
          await evidence.nth(index).click();
          await expect(page.getByTestId("evidence-card")).toBeVisible();
          await nextFrames(page);
          expect(await boxPositions(page), `seed ${seed}: opening ${id}`).toEqual(before);
          await page.getByTestId("evidence-card").getByRole("button", { name: "Close panel" }).click();
          await expect(page.getByTestId("evidence-card")).toHaveCount(0);
          await nextFrames(page);
          expect(await boxPositions(page), `seed ${seed}: closing ${id}`).toEqual(before);
        }
        const roles = page.locator(".pmap-role");
        for (let index = 0; index < await roles.count(); index += 1) {
          await roles.nth(index).click();
          await expect(page.getByTestId("role-card")).toBeVisible();
          await nextFrames(page);
          expect(await boxPositions(page), `seed ${seed}: opening role ${index}`).toEqual(before);
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("role-card")).toHaveCount(0);
        }
      });
    }
  });
}
