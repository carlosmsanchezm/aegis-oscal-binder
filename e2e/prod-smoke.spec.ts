import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./helpers/navigation";

test.use({actionTimeout:15_000});

async function chooseSnapshot(page: Page, id: string | null) {
  await page.locator('.round21-snapshot > summary').click();
  await page.getByRole('option').filter({ hasText: id ? `#${id}` : /^None/ }).click();
}
async function snapshot(page: Page, id: string | null) {
  await expect(page.locator('.round21-snapshot > summary')).toHaveAttribute('aria-label', `Release snapshot ${id ? '#'+id : 'None'}`);
}

test('Podinfo retained finding identity, accepted export, return and selected snapshots survive reload', async ({ page, browser }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto('/planning');
  await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");
  await snapshot(page, '2894050908');
  await page.reload();
  await snapshot(page, '2894050908');
  await chooseSnapshot(page, '2908682168');
  await page.reload();
  await snapshot(page, '2908682168');
  await navigateWorkspace(page, 'release');
  await expect(page.getByLabel('Release selection', {exact:true})).toHaveValue(/2908682168/);
  const finding = page.locator('.release-retained-findings article').filter({has:page.getByRole('button',{name:'Open plan of action · draft'})}).first();
  await expect(finding).toContainText('Original failed observation #2894050908');
  await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening'}).click();
  const drawer = page.getByTestId('plan-proposal');
  await expect(drawer).toContainText('Original failed observation #2894050908');
  await expect(drawer).toContainText('Retest #2908682168');
  await drawer.getByRole('button',{name:'Accept proposed draft'}).click();
  const pending = page.waitForEvent('download');
  await drawer.getByRole('button',{name:'Download OSCAL plan of action'}).click();
  const poam = JSON.parse(await readFile((await (await pending).path())!, 'utf8'))['plan-of-action-and-milestones'];
  expect(poam.risks[0].status).toBe('open');
  expect(JSON.stringify(poam)).toContain('CM-6');
  expect(JSON.stringify(poam)).toContain('2894050908');
  expect(JSON.stringify(poam)).toContain('2908682168');
  await drawer.getByRole('button',{name:'Close proposed plan'}).click();
  await page.getByRole('button',{name:/^← Package map/}).click();
  await snapshot(page, '2908682168');
  await page.locator('[data-control-id="CM-6"]').first().click();
  const panel = page.getByTestId('pipeline-control-panel');
  await expect(panel).toContainText('source #2894050908');
  await expect(panel.getByRole('link',{name:'configuration.json ↗',exact:true})).toHaveAttribute('data-source-href', /16910084348\/artifacts\/file\/evidence\/configuration\.json$/);
  await panel.getByRole('button',{name:'Open CM-6 in Level 2 →'}).click();
  await expect(page.getByTestId('selected-statement-detail')).toContainText('#2908682168');
  await expect(page.getByTestId('level2-focus')).toBeVisible();
  await expect(panel.getByRole('link',{name:'configuration.json ↗',exact:true})).toHaveAttribute('data-source-href', /16910084348\/artifacts\/file\/evidence\/configuration\.json$/);

  await navigateWorkspace(page, 'release');
  await page.getByTestId('release-map-return').click();
  await expect(page.getByTestId('level2-focus')).toBeVisible();
  await chooseSnapshot(page, null);
  await page.reload();
  await snapshot(page, null);
  await navigateWorkspace(page, 'connections');
  const history = page.getByRole('complementary',{name:'Retained observation history'});
  await expect(history).toContainText('No pipeline connection observations yet');
  await expect(history).toContainText('Other workspace evidence remains available in Release evidence.');
  await navigateWorkspace(page, 'release');
  await page.reload();
  await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening'}).click();
  await expect(drawer).toContainText('Accepted');
  await drawer.getByRole('button',{name:'Close proposed plan'}).click();
  await page.screenshot({path:info.outputPath('podinfo-retained-source.png')});
  const isolated = await browser.newContext({baseURL:info.project.use.baseURL});
  const other = await isolated.newPage();
  await other.goto('/planning');
  await expect(other.getByRole('button',{name:'Connect a system or load captured evidence'})).toBeVisible();
  await isolated.close();
  expect(errors).toEqual([]);
});

test('connected workspace restores exact earlier receipt, None and per-system isolation', async ({ page }, info) => {
  await page.goto('/planning?view=connections');
  await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();
  await navigateWorkspace(page,"map");
  const summary = await (await page.request.get('/api/builder')).json();
  const observations = summary.connections[0].history;
  // Use actual stored release IDs, including the earlier failure rather than latest PASS.
  const original = observations.find((r: {id:string; checks: {verdict:string}[]}) => r.checks.some(c => c.verdict === 'fail')).id.slice(0,32);
  await chooseSnapshot(page, original);
  await page.reload();
  await snapshot(page, original);
  await navigateWorkspace(page, 'release');
  const sourceId = observations.find((r: {id:string}) => r.id.slice(0,32) === original).id.slice(0,32);
  const sourceLabel = sourceId.slice(0,8)+'…'+sourceId.slice(-8);
  await expect(page.locator('.release-retained-findings')).toContainText(`Original failed observation #${sourceLabel}`);
  await navigateWorkspace(page, 'map');
  await chooseSnapshot(page, null);
  await page.reload();
  await snapshot(page, null);
  await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");
  await chooseSnapshot(page, '2894050908');
  await page.reload();
  await snapshot(page, '2894050908');
  await page.getByLabel('Evidence system').selectOption(summary.connections[0].id);await navigateWorkspace(page,'map');
  await snapshot(page, null);
  await chooseSnapshot(page, original);
  await page.reload();
  await snapshot(page, original);
  await page.screenshot({path:info.outputPath('boutique-restored-original.png')});
});
